import assert from 'node:assert/strict';
import { test } from 'vitest';
import { execFile } from 'node:child_process';
import {
  appendFile,
  cp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import type { NativeVerificationReport } from '../../../src/agents/updates/native-verification.js';
import { artifactDigest } from '../../../src/agents/updates/runtime-updates.js';
import {
  holdRuntime,
  NativeUpdatePending,
  pendingUpdate,
} from '../../../src/persistence/runtime-updates.js';
import { RuntimeUpdates } from '../../../src/core/runtime/runtime-updates.js';
import { runtimeUpdateFixture } from '../../fixtures/runtime-updates.js';
import { compiledCli } from '../../fixtures/compiled-cli.js';
import { scratch } from '../../fixtures/scratch.js';

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

  assert.deepEqual(
    f.notices.filter((notice) => notice.includes('verified')),
    [
      `codex 2.0.0 installed and verified. Evidence: ${f.store.operation(journal)}`,
    ],
  );

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

  assert.deepEqual(f.notices, [
    'Fixture Codex 2.0.0 is available. Open /updates to review it.',
  ]);

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

test('a cached release keeps freshly inspected installation policy through apply', async () => {
  const f = await runtimeUpdateFixture();
  f.policy.blocked = 'Old native update policy';
  f.policy.automatic = true;
  await f.updates.check(true);
  const checks = f.checks();
  delete f.policy.blocked;
  f.policy.automatic = false;
  await f.updates.check();
  const fresh = f.updates.snapshot.entries[0]!.check!;
  assert.equal(f.checks(), checks);
  assert.equal(fresh.installation.blocked, undefined);
  assert.equal(fresh.installation.automatic, false);
  const install = f.native.install;

  f.native.install = async (...args) => {
    assert.equal(args[0].blocked, undefined);
    assert.equal(args[0].automatic, false);
    await install(...args);
  };

  try {
    await f.updates.apply(fresh, { accountUsage: true });
    assert.equal((await f.store.journal(f.root))?.phase, 'verified');
    assert.deepEqual(f.installs, ['2.0.0']);
  } finally {
    f.updates.close();
  }
});

test('recovery refuses the previous version when its artifact bytes differ', async () => {
  const f = await runtimeUpdateFixture();

  f.native.verify = async () => {
    throw new Error('Candidate failed');
  };

  f.native.startup = async () => {};
  const install = f.native.install;

  f.native.install = async (...args) => {
    await install(...args);

    if (args[1] === '1.0.0') {
      const artifact = f.artifacts.get('1.0.0')!;
      await appendFile(artifact.executable, '\n# different artifact bytes\n');
      artifact.digest = await artifactDigest('codex', artifact.executable);
    }
  };

  try {
    await assert.rejects(
      f.updates.apply(f.check, { accountUsage: true }),
      /Recovery did not restore the previous native artifact/,
    );

    const restored = await f.inspect();
    assert.equal(restored.version, '1.0.0');
    assert.notEqual(restored.digest, f.check.installation.digest);
    assert.equal((await f.store.journal(f.root))?.phase, 'failed');

    assert.throws(
      () => holdRuntime(f.root, f.store.directory),
      NativeUpdatePending,
    );
  } finally {
    f.updates.close();
  }
});

for (const fails of [false, true]) {
  test(
    'the update transaction stays owned through ' +
      (fails ? 'failed' : 'successful') +
      ' reconnect',
    async () => {
      const reconnect = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const notices: string[] = [];

      const f = await runtimeUpdateFixture({
        maintain: async (_runtime, run) => {
          await run(new AbortController().signal);
          reconnect.resolve();
          await finish.promise;

          if (fails) throw new Error('Reconnect failed');
        },
        notice: (message) => notices.push(message),
      });

      const applying = f.updates.apply(f.check, { accountUsage: true });

      const completed = fails
        ? assert.rejects(applying, /Reconnect failed/)
        : applying;

      try {
        await reconnect.promise;
        const journal = (await f.store.journal(f.root))!;
        assert.equal(journal.phase, 'verified');

        await assert.rejects(async () => {
          const successor = await f.store.transaction(f.root);
          await successor.close();
        }, NativeUpdatePending);

        finish.resolve();
        await completed;
        const final = (await f.store.journal(f.root))!;
        assert.equal(final.id, journal.id);
        assert.equal(final.phase, fails ? 'failed' : 'verified');

        assert.equal(
          notices.some((notice) => notice.includes('verified')),
          !fails,
        );

        const next = await f.store.transaction(f.root);
        await next.close();
      } finally {
        finish.resolve();
        await completed.catch(() => {});
        f.updates.close();
      }
    },
  );
}

/** a second Witch over the fixture's store and operations, with its own build, notices and cancellation. */
function successor(
  f: Awaited<ReturnType<typeof runtimeUpdateFixture>>,
  identifyBuild: () => Promise<string>,
) {
  const abort = new AbortController();
  const notices: string[] = [];

  const updates = new RuntimeUpdates(
    {
      maintain: async (_runtime, run) => run(abort.signal),
      notice: (message) => notices.push(message),
    },
    f.store,
    f.native,
    async () => [f.registration],
    identifyBuild,
  );

  return { updates, abort, notices };
}

test('qualifying the installed version records it verified without installing or excluding other users', async () => {
  const f = await runtimeUpdateFixture(undefined, '2.0.0');
  assert.equal(f.updates.snapshot.entries[0]!.earlier, '1.0.0');
  const lease = holdRuntime(f.root, f.store.directory);
  f.native.users = async () => [{ pid: 1, reason: 'active session' }];

  const admitted = async () => {
    holdRuntime(f.root, f.store.directory)();
    assert.equal(await f.store.journal(f.root), undefined);
  };

  const prepare = f.native.prepare;

  f.native.prepare = async (...args) => {
    await admitted();

    assert.match(
      f.updates.snapshot.progress ?? '',
      /^Qualifying codex 2\.0\.0/,
    );

    await assert.rejects(f.store.transaction(f.root), (error) => {
      assert.ok(error instanceof NativeUpdatePending);
      assert.match(error.message, /holds this installation/);

      return true;
    });

    return prepare(...args);
  };

  const verify = f.native.verify;

  f.native.verify = async (...args) => {
    await admitted();

    return verify(...args);
  };

  try {
    await f.updates.apply(f.check, { accountUsage: true });
  } finally {
    lease();
  }

  const journal = (await f.store.journal(f.root))!;
  assert.equal(journal.phase, 'verified');
  assert.equal(journal.target, '2.0.0');
  assert.equal(journal.previous.digest, f.artifacts.get('1.0.0')!.digest);
  assert.equal(journal.previous.launcher, f.launcher);
  assert.equal(journal.selected?.digest, f.artifacts.get('2.0.0')!.digest);
  assert.deepEqual(f.installs, []);

  assert.deepEqual(f.notices, [
    `codex 2.0.0 verified. Evidence: ${f.store.operation(journal)}`,
  ]);

  assert.equal(f.updates.snapshot.progress, undefined);
  f.updates.close();
});

test('a blocked check restricts installing, not qualifying the installed version', async () => {
  const f = await runtimeUpdateFixture(undefined, '2.0.0');
  f.policy.blocked = 'Native policy blocks installs';
  await f.updates.check(true);
  const check = f.updates.snapshot.entries[0]!.check!;
  assert.equal(check.blocked, 'Native policy blocks installs');
  await f.updates.apply(check, { accountUsage: true });
  assert.equal((await f.store.journal(f.root))?.phase, 'verified');
  f.updates.close();
  const update = await runtimeUpdateFixture();

  await assert.rejects(
    update.updates.apply(
      { ...update.check, blocked: 'Native policy blocks installs' },
      { accountUsage: true },
    ),
    /Native policy blocks installs/,
  );

  assert.deepEqual(update.installs, []);
  assert.equal(await update.store.journal(update.root), undefined);
  update.updates.close();
});

for (const failure of ['a failed check', 'cancellation'] as const) {
  test(`${failure} while qualifying changes nothing and reports its evidence`, async () => {
    const f = await runtimeUpdateFixture(undefined, '2.0.0');
    await f.updates.apply(f.check, { accountUsage: true });
    const seeded = (await f.store.journal(f.root))!;
    f.updates.close();
    const next = successor(f, async () => 'another-build');
    await next.updates.check();

    if (failure === 'a failed check')
      f.native.verify = async () => {
        throw new Error('Native permission check failed');
      };
    else
      f.native.prepare = async (_previous, options) => {
        next.abort.abort(new Error('Cancelled by the user'));
        options.signal.throwIfAborted();

        throw new Error('The cancelled signal did not stop preparation');
      };

    await assert.rejects(
      next.updates.apply(next.updates.snapshot.entries[0]!.check!, {
        accountUsage: true,
      }),
      (error) => {
        assert.ok(error instanceof Error);

        assert.match(
          error.message,
          failure === 'a failed check'
            ? /Native permission check failed/
            : /Cancelled by the user/,
        );

        assert.ok(
          error.message.includes(
            `Evidence: ${join(f.store.directory, 'operations')}`,
          ),
        );

        return true;
      },
    );

    assert.deepEqual(await f.store.journal(f.root), seeded);
    assert.equal((await f.inspect()).version, '2.0.0');
    assert.deepEqual(f.installs, []);
    assert.deepEqual(next.notices, []);
    assert.equal(next.updates.snapshot.progress, undefined);
    holdRuntime(f.root, f.store.directory)();
    await (await f.store.transaction(f.root)).close();
    next.updates.close();
  });
}

test('qualifying refuses before preparation when the earlier artifact is gone', async () => {
  const f = await runtimeUpdateFixture(undefined, '2.0.0');

  await rm(dirname(dirname(f.artifacts.get('1.0.0')!.executable)), {
    recursive: true,
  });

  let prepared = false;

  f.native.prepare = async () => {
    prepared = true;

    throw new Error('Preparation ran without an earlier artifact');
  };

  await assert.rejects(
    f.updates.apply(f.check, { accountUsage: true }),
    /No earlier codex version is installed/,
  );

  assert.equal(prepared, false);
  assert.equal(await f.store.journal(f.root), undefined);
  f.updates.close();
});

for (const [name, mismatch] of [
  ['another version', { version: '0.9.0' }],
  ['another installation', { root: '/another/installation' }],
] as const) {
  test(`qualifying refuses an earlier artifact that reports ${name}`, async () => {
    const f = await runtimeUpdateFixture(undefined, '2.0.0');
    const inspect = f.native.inspect;

    f.native.inspect = async (registration, ...rest) => {
      const artifact = await inspect(registration, ...rest);

      return registration.executable === f.launcher
        ? artifact
        : { ...artifact, ...mismatch };
    };

    let prepared = false;

    f.native.prepare = async () => {
      prepared = true;

      throw new Error('Preparation ran against a mismatched artifact');
    };

    await assert.rejects(
      f.updates.apply(f.check, { accountUsage: true }),
      /is not version 1\.0\.0 of this installation/,
    );

    assert.equal(prepared, false);
    f.updates.close();
  });
}

test('a verified version is refused a second qualification until the Witch build changes', async () => {
  const f = await runtimeUpdateFixture(undefined, '2.0.0');
  await f.updates.apply(f.check, { accountUsage: true });
  const first = (await f.store.journal(f.root))!;

  await assert.rejects(
    f.updates.apply(f.updates.snapshot.entries[0]!.check!, {
      accountUsage: true,
    }),
    /already verified with this Witch build/,
  );

  assert.equal((await f.store.journal(f.root))!.id, first.id);
  f.updates.close();
  const rebuilt = successor(f, async () => 'rebuilt-witch');
  await rebuilt.updates.check();

  await rebuilt.updates.apply(rebuilt.updates.snapshot.entries[0]!.check!, {
    accountUsage: true,
  });

  const second = (await f.store.journal(f.root))!;
  assert.notEqual(second.id, first.id);
  assert.equal(second.build, 'rebuilt-witch');
  assert.equal(second.phase, 'verified');
  rebuilt.updates.close();
});

test('a cancellation that arrives after the last check keeps the passed qualification', async () => {
  const f = await runtimeUpdateFixture(undefined, '2.0.0');
  f.updates.close();
  let identified = 0;

  // the constructor and the start of apply identify the build first; the third call is the final check
  const late = successor(f, async () => {
    if (++identified === 3) late.abort.abort(new Error('Cancelled late'));

    return 'fixture-build';
  });

  await late.updates.check();

  await late.updates.apply(late.updates.snapshot.entries[0]!.check!, {
    accountUsage: true,
  });

  assert.equal(identified, 3);
  assert.equal((await f.store.journal(f.root))?.phase, 'verified');
  late.updates.close();
});

test('a failed reconnect after a passed qualification keeps the record, its notice and every diagnostic', async () => {
  const f = await runtimeUpdateFixture(undefined, '2.0.0');
  f.updates.close();
  let reconnecting = false;
  const notices: string[] = [];

  const updates = new RuntimeUpdates(
    {
      maintain: async (_runtime, run) => {
        await run(new AbortController().signal);
        reconnecting = true;

        throw new Error('Reconnect failed');
      },
      notice: (message) => notices.push(message),
    },
    f.store,
    f.native,
    async () => {
      if (reconnecting) throw new Error('Inventory offline');

      return [f.registration];
    },
    async () => 'fixture-build',
  );

  await updates.check();

  await assert.rejects(
    updates.apply(updates.snapshot.entries[0]!.check!, { accountUsage: true }),
    { message: 'Reconnect failed' },
  );

  const journal = (await f.store.journal(f.root))!;
  assert.equal(journal.phase, 'verified');
  holdRuntime(f.root, f.store.directory)();

  assert.equal(
    updates.snapshot.error,
    'Reconnect failed\nStatus refresh failed: Inventory offline',
  );

  assert.deepEqual(notices, [
    `codex 2.0.0 verified. Evidence: ${f.store.operation(journal)}`,
  ]);

  updates.close();
});

test('a failed build identity is reported by the operation instead of hiding the inventory', async () => {
  const f = await runtimeUpdateFixture(undefined, '2.0.0');
  f.updates.close();

  const broken = successor(f, async () => {
    throw new Error('Build tree unreadable');
  });

  await broken.updates.check();
  const entry = broken.updates.snapshot.entries[0]!;
  assert.equal(entry.installation?.version, '2.0.0');

  await assert.rejects(
    broken.updates.apply(entry.check!, { accountUsage: true }),
    /Build tree unreadable/,
  );

  assert.equal(broken.updates.snapshot.progress, undefined);
  assert.equal(broken.updates.snapshot.buildError, 'Build tree unreadable');
  assert.equal(await f.store.journal(f.root), undefined);
  broken.updates.close();
});

test('qualifying refuses an installation that changed since it was offered', async () => {
  const f = await runtimeUpdateFixture(undefined, '2.0.0');
  let prepared = false;

  f.native.prepare = async () => {
    prepared = true;

    throw new Error('Preparation ran for a changed installation');
  };

  await assert.rejects(
    f.updates.apply(
      {
        ...f.check,
        installation: { ...f.check.installation, digest: 'offered-artifact' },
      },
      { accountUsage: true },
    ),
    /installation changed/,
  );

  assert.equal(prepared, false);
  assert.equal(await f.store.journal(f.root), undefined);
  f.updates.close();
});

for (const [name, tamper] of [
  [
    'did not pass',
    (report: NativeVerificationReport) => ({ ...report, passed: false }),
  ],
  [
    'names another candidate',
    (report: NativeVerificationReport) => ({
      ...report,
      candidate: { ...report.candidate, digest: 'another-artifact' },
    }),
  ],
  [
    'names another previous artifact',
    (report: NativeVerificationReport) => ({
      ...report,
      previous: { ...report.previous, digest: 'another-artifact' },
    }),
  ],
] as const) {
  test(`a qualification report that ${name} records nothing`, async () => {
    const f = await runtimeUpdateFixture(undefined, '2.0.0');
    const verify = f.native.verify;
    f.native.verify = async (...args) => tamper(await verify(...args));

    await assert.rejects(
      f.updates.apply(f.check, { accountUsage: true }),
      /did not verify this version/,
    );

    assert.equal(await f.store.journal(f.root), undefined);
    assert.deepEqual(f.notices, []);
    holdRuntime(f.root, f.store.directory)();
    f.updates.close();
  });
}

for (const [tree, extension] of [
  ['src', 'ts'],
  ['dist', 'js'],
] as const) {
  test(`${tree} build identity covers files outside the runtime directory`, async () => {
    const root = await scratch('witch-build-identity-');
    const repository = fileURLToPath(new URL('../../../', import.meta.url));

    const original =
      tree === 'src' ? join(repository, tree) : dirname(await compiledCli());

    await cp(original, join(root, tree), { recursive: true });
    await symlink(join(repository, 'node_modules'), join(root, 'node_modules'));

    for (const name of ['package.json', 'pnpm-lock.yaml'])
      await cp(join(repository, name), join(root, name));

    const entry = pathToFileURL(
      join(root, tree, 'core/runtime', `runtime-updates.${extension}`),
    );

    const execute = promisify(execFile);

    const identify = async () => {
      const { stdout } = await execute(
        process.execPath,
        [
          ...(tree === 'src' ? ['--import', import.meta.resolve('tsx')] : []),
          '--input-type=module',
          '--eval',
          `const { runtimeBuildIdentity } = await import(${JSON.stringify(entry.href)}); console.log(await runtimeBuildIdentity());`,
        ],
        { cwd: root },
      );

      return stdout.trim();
    };

    const before = await identify();
    const file = join(root, tree, `errors.${extension}`);
    const content = await readFile(file, 'utf8');
    assert.match(before, /^[a-f0-9]{64}$/);
    await appendFile(file, '\n');
    assert.notEqual(await identify(), before);
    await writeFile(file, content);
    assert.equal(await identify(), before);
  });
}
