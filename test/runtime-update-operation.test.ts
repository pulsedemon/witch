import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  holdRuntime,
  NativeUpdatePending,
  pendingUpdate,
} from '../src/persistence/runtime-updates.js';
import { RuntimeUpdates } from '../src/core/runtime-updates.js';
import { runtimeUpdateFixture } from './fixtures/runtime-updates.js';

test('an update selects and verifies the confirmed artifact before releasing admission', async () => {
  const f = await runtimeUpdateFixture();
  const verify = f.native.verify;
  f.native.verify = async (...args) => {
    assert.equal((await f.inspect()).version, '2.0.0');
    assert.throws(
      () => holdRuntime(f.root, f.store.directory),
      NativeUpdatePending,
    );
    assert.equal((await f.store.journal(f.root))?.phase, 'verifying');
    return verify(...args);
  };
  await f.updates.apply(f.check, { accountUsage: true });
  const journal = (await f.store.journal(f.root))!;
  assert.equal(journal.phase, 'verified');
  assert.equal(journal.selected?.digest, f.artifacts.get('2.0.0')!.digest);
  assert.deepEqual(f.installs, ['2.0.0']);
  const release = holdRuntime(f.root, f.store.directory);
  release();
  assert.equal(f.updates.snapshot.entries[0]!.installation?.version, '2.0.0');
  f.updates.close();
});

for (const failure of [
  'Native permission check failed',
  'Account usage exhausted',
]) {
  test(`post-install ${failure.toLowerCase()} restores the old artifact`, async () => {
    const f = await runtimeUpdateFixture();
    f.native.verify = async () => {
      throw new Error(failure);
    };
    await assert.rejects(
      f.updates.apply(f.check, { accountUsage: true }),
      new RegExp(failure),
    );
    assert.equal((await f.inspect()).digest, f.artifacts.get('1.0.0')!.digest);
    assert.deepEqual(f.installs, ['2.0.0', '1.0.0']);
    assert.equal((await f.store.journal(f.root))?.phase, 'recovered');
    assert.equal(f.updates.snapshot.entries[0]!.installation?.version, '1.0.0');
    assert.ok(
      !f.notices.some((notice) => notice.includes('installed and verified')),
    );
    f.updates.close();
  });
}

test('a partial installer failure is reconciled and recovered', async () => {
  const f = await runtimeUpdateFixture();
  const install = f.native.install;
  f.native.install = async (...args) => {
    await install(...args);
    if (args[1] === '2.0.0')
      throw new Error('Installer failed after selection');
  };
  await assert.rejects(
    f.updates.apply(f.check, { accountUsage: true }),
    /failed after selection/,
  );
  assert.equal((await f.inspect()).version, '1.0.0');
  assert.equal((await f.store.journal(f.root))?.phase, 'recovered');
  f.updates.close();
});

test('installer success without selecting the target never produces a verified update', async () => {
  const f = await runtimeUpdateFixture();
  f.native.install = async () => {};
  await assert.rejects(
    f.updates.apply(f.check, { accountUsage: true }),
    /did not select/,
  );
  assert.equal((await f.inspect()).version, '1.0.0');
  assert.equal((await f.store.journal(f.root))?.phase, 'recovered');
  f.updates.close();
});

test('a mismatched qualification identity triggers recovery', async () => {
  const f = await runtimeUpdateFixture();
  const verify = f.native.verify;
  f.native.verify = async (...args) => ({
    ...(await verify(...args)),
    candidate: { ...args[1], digest: 'another-build' },
  });
  await assert.rejects(
    f.updates.apply(f.check, { accountUsage: true }),
    /did not verify/,
  );
  assert.equal((await f.inspect()).version, '1.0.0');
  assert.equal((await f.store.journal(f.root))?.phase, 'recovered');
  f.updates.close();
});

test('failed recovery keeps native launches blocked and can be retried without an agent', async () => {
  const f = await runtimeUpdateFixture();
  const install = f.native.install;
  f.native.verify = async () => {
    throw new Error('Candidate failed');
  };
  f.native.install = async (...args) => {
    if (args[1] === '1.0.0') throw new Error('Recovery offline');
    await install(...args);
  };
  await assert.rejects(
    f.updates.apply(f.check, { accountUsage: true }),
    /Recovery failed: Recovery offline/,
  );
  const journal = (await f.store.journal(f.root))!;
  assert.equal(journal.phase, 'failed');
  assert.equal((await f.inspect()).version, '2.0.0');
  assert.throws(
    () => holdRuntime(f.root, f.store.directory),
    NativeUpdatePending,
  );
  f.native.install = install;
  await f.updates.recover(journal);
  assert.equal((await f.inspect()).version, '1.0.0');
  assert.equal((await f.store.journal(f.root))?.phase, 'recovered');
  holdRuntime(f.root, f.store.directory)();
  f.updates.close();
});

test('unfinished journals block startup even after the updater process is gone', async () => {
  const f = await runtimeUpdateFixture();
  f.native.verify = async () => {
    throw new Error('Verification failed');
  };
  f.native.startup = async () => {
    throw new Error('Recovery startup failed');
  };
  await assert.rejects(
    f.updates.apply(f.check, { accountUsage: true }),
    /Recovery startup failed/,
  );
  f.updates.close();
  const next = new RuntimeUpdates(
    {
      maintain: async (_runtime, run) => run(new AbortController().signal),
      notice: () => {},
    },
    f.store,
    f.native,
    async () => [f.registration],
    async () => 'fixture-build',
  );
  await next.check();
  assert.equal(next.snapshot.entries[0]!.installation, undefined);
  assert.ok(pendingUpdate(next.snapshot.entries[0]!.journal!));
  assert.throws(
    () => holdRuntime(f.root, f.store.directory),
    NativeUpdatePending,
  );
  next.close();
});

test('preparation failure leaves the original selection usable', async () => {
  const f = await runtimeUpdateFixture();
  f.native.prepare = async () => {
    throw new Error('No account usage available');
  };
  await assert.rejects(
    f.updates.apply(f.check, { accountUsage: true }),
    /No account usage/,
  );
  assert.deepEqual(f.installs, []);
  assert.equal((await f.inspect()).version, '1.0.0');
  assert.equal((await f.store.journal(f.root))?.phase, 'aborted');
  holdRuntime(f.root, f.store.directory)();
  f.updates.close();
});

test('another transaction cannot overwrite an active update journal', async () => {
  const f = await runtimeUpdateFixture();
  const transaction = await f.store.transaction(f.root);
  try {
    await assert.rejects(
      f.updates.apply(f.check, { accountUsage: true }),
      NativeUpdatePending,
    );
    assert.deepEqual(f.installs, []);
    assert.equal(await f.store.journal(f.root), undefined);
  } finally {
    await transaction.close();
    f.updates.close();
  }
});

test('shared native use excludes installation and closes before a writer acquires it', async () => {
  const f = await runtimeUpdateFixture();
  const reader = holdRuntime(f.root, f.store.directory);
  await assert.rejects(
    f.store.exclusive(f.root, AbortSignal.timeout(30)),
    /aborted|timeout/i,
  );
  reader();
  const writer = await f.store.exclusive(f.root, new AbortController().signal);
  try {
    assert.throws(
      () => holdRuntime(f.root, f.store.directory),
      NativeUpdatePending,
    );
  } finally {
    await writer.close();
    f.updates.close();
  }
});

test('the 24-hour cache still reads installed identity and current policy', async () => {
  const f = await runtimeUpdateFixture();
  assert.equal(f.checks(), 1);
  await f.updates.check();
  assert.equal(f.checks(), 1);
  f.policy.blocked = 'Native updates are disabled';
  await f.updates.check();
  assert.equal(
    f.updates.snapshot.entries[0]!.check?.blocked,
    'Native updates are disabled',
  );
  delete f.policy.blocked;
  await f.updates.check();
  assert.equal(f.updates.snapshot.entries[0]!.check?.blocked, undefined);
  await f.store.cache({
    ...f.check,
    checkedAt: Date.now() - 24 * 60 * 60_000 - 1000,
  });
  await f.updates.check();
  assert.equal(f.checks(), 2);
  await f.updates.check(true);
  assert.equal(f.checks(), 3);
  f.updates.close();
});

test('a release is announced once across successive Witch instances', async () => {
  const f = await runtimeUpdateFixture();
  assert.equal(f.notices.length, 1);
  f.updates.close();
  const notices: string[] = [];
  const next = new RuntimeUpdates(
    {
      maintain: async (_runtime, run) => run(new AbortController().signal),
      notice: (value) => notices.push(value),
    },
    f.store,
    f.native,
    async () => [f.registration],
    async () => 'fixture-build',
  );
  await next.check();
  assert.deepEqual(notices, []);
  next.close();
});

test('an offline refresh reports failure instead of claiming the installed version is current', async () => {
  const f = await runtimeUpdateFixture();
  f.native.check = async () => {
    throw new Error('Network unavailable');
  };
  await f.updates.check(true);
  assert.equal(f.updates.snapshot.entries[0]!.check, undefined);
  assert.equal(f.updates.snapshot.entries[0]!.error, 'Network unavailable');
  f.updates.close();
});

test('a build change during qualification restores the old runtime', async () => {
  const f = await runtimeUpdateFixture();
  const verify = f.native.verify;
  f.native.verify = async (...args) => {
    const result = await verify(...args);
    f.build.current = 'changed';
    return result;
  };
  await assert.rejects(
    f.updates.apply(f.check, { accountUsage: true }),
    /Witch changed during/,
  );
  assert.equal((await f.inspect()).version, '1.0.0');
  assert.equal((await f.store.journal(f.root))?.phase, 'recovered');
  f.updates.close();
});

test('known installation users refuse an update before preparation or mutation', async () => {
  const f = await runtimeUpdateFixture();
  f.native.users = async () => [
    { pid: 1234, reason: 'Native installation is in use' },
  ];
  await assert.rejects(
    f.updates.apply(f.check, { accountUsage: true }),
    /PID 1234/,
  );
  assert.deepEqual(f.installs, []);
  assert.equal((await f.store.journal(f.root))?.phase, 'aborted');
  f.updates.close();
});

test('an omitted required check cannot qualify an update', async () => {
  const f = await runtimeUpdateFixture();
  const verify = f.native.verify;
  f.native.verify = async (...args) => ({
    ...(await verify(...args)),
    completed: ['cross-version resume'],
  });
  try {
    await assert.rejects(
      f.updates.apply(f.check, { accountUsage: true }),
      /did not verify/,
    );
    assert.equal((await f.inspect()).version, '1.0.0');
    assert.equal((await f.store.journal(f.root))?.phase, 'recovered');
  } finally {
    f.updates.close();
  }
});

test('confirmation rechecks native policy in the initiating conversation directory', async () => {
  let cwd = '/project/first';
  const observed: string[] = [];
  const f = await runtimeUpdateFixture({
    cwd: () => cwd,
    maintain: async (_runtime, run) => run(new AbortController().signal),
    notice: () => {},
  });
  f.native.inspect = async (_registration, _signal, directory) => {
    observed.push(directory!);
    return {
      ...(await f.inspect()),
      ...(directory === '/project/second'
        ? { blocked: 'Project update policy forbids this release' }
        : {}),
    };
  };
  try {
    await f.updates.check();
    cwd = '/project/second';
    await assert.rejects(
      f.updates.apply(f.check, { accountUsage: true }),
      /Project update policy/,
    );
    assert.ok(observed.includes('/project/first'));
    assert.ok(observed.includes('/project/second'));
    assert.deepEqual(f.installs, []);
  } finally {
    f.updates.close();
  }
});
