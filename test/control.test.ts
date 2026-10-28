import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs, { constants, promises as files } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { onTestFinished, test, vi } from 'vitest';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { callControl, ControlHost } from '../src/persistence/control.js';
import type {
  ControlBinding,
  ControlRequest,
} from '../src/persistence/control.js';
import { CoordinationStore } from '../src/persistence/coordination.js';
import { StateStore } from '../src/persistence/store.js';
import { identifyProcess } from '../src/persistence/process.js';
import { writeJson } from '../src/persistence/json.js';
import { openLocked } from '../src/persistence/lock.js';
import { scratch } from './fixtures/scratch.js';
import { until, within } from './fixtures/within.js';

const identity = (await identifyProcess(process.pid))!;

async function binding(): Promise<ControlBinding> {
  return {
    directory: await scratch('witch-control-'),
    conversation: 'conversation-a',
    activation: randomUUID(),
  };
}

function envelope(bound: ControlBinding): ControlRequest {
  return {
    id: randomUUID(),
    version: 1,
    conversation: bound.conversation,
    activation: bound.activation,
    deadline: Date.now() + 5000,
    action: { kind: 'peers' },
  };
}

const exists = (path: string) =>
  files.access(path).then(
    () => true,
    () => false,
  );

/** on macOS a write just after `ControlHost.open` can send no event, so this waits for one; the host skips names that aren't `.json`. */
async function watching(directory: string): Promise<void> {
  const readdir = vi.spyOn(files, 'readdir');
  const probe = join(directory, 'inbox', 'probe');
  try {
    await until('a live watch', async () => {
      if (readdir.mock.calls.length) return true;
      await files.writeFile(probe, '');
      return false;
    });
    const reads = readdir.mock.calls.length;
    await files.rm(probe);
    await until(
      'the probe removal read',
      () => readdir.mock.calls.length > reads,
    );
  } finally {
    readdir.mockRestore();
  }
}

interface WatchSpy {
  /** events delivered to the host. */
  delivered: number;
  dropping: boolean;
  /** while set, events named after this request id pass only the first named `<id>.json`. */
  only?: string;
  watcher?: fs.FSWatcher;
  closes: number;
  failing: boolean;
}

/** create before any other `files` spy, since the sync rebinds named `node:fs/promises` imports to the spies active then. */
function spyWatch(): WatchSpy {
  const spy: WatchSpy = {
    delivered: 0,
    dropping: false,
    closes: 0,
    failing: false,
  };
  const original = fs.watch;
  vi.spyOn(fs, 'watch').mockImplementation(((
    path: string,
    options: fs.WatchOptions,
    listener: fs.WatchListener<string>,
  ) => {
    if (spy.failing) throw new Error('watch unavailable');
    let passed = false;
    const watcher = original(path, options, (event, received) => {
      // the host's options keep the default utf8 names
      const name = received as string | null;
      if (spy.dropping) return;
      if (spy.only && name?.startsWith(spy.only)) {
        if (passed || name !== `${spy.only}.json`) return;
        passed = true;
      }
      spy.delivered++;
      listener(event, name);
    });
    const close = watcher.close.bind(watcher);
    watcher.close = () => {
      spy.closes++;
      close();
    };
    spy.watcher = watcher;
    return watcher;
  }) as typeof fs.watch);
  syncBuiltinESMExports();
  onTestFinished(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });
  return spy;
}

/** a follow-up read removes a late reply before listing assertions run, so this counts reply creations instead. */
function replyCreations(id: string): () => number {
  const open = vi.spyOn(files, 'open');
  return () =>
    open.mock.calls.filter(
      ([path, flags]) =>
        basename(String(path)) === `${id}.json` &&
        typeof flags === 'number' &&
        (flags & constants.O_CREAT) !== 0,
    ).length;
}

test('control requests preserve their binding and action through a real ledger mutation and acknowledgement', async () => {
  const bound = await binding();
  const directory = join(bound.directory, 'actual');
  const alias = join(bound.directory, 'alias');
  await files.mkdir(directory);
  await files.symlink(directory, alias);
  bound.directory = alias;
  const store = await CoordinationStore.open(
    await StateStore.open(bound.directory),
  );
  const failures: unknown[] = [];
  const host = await ControlHost.open(
    bound.directory,
    async (request) => {
      assert.equal(request.conversation, 'conversation-a');
      assert.equal(request.activation, bound.activation);
      assert.equal(request.action.kind, 'claim');
      if (request.action.kind !== 'claim') throw new Error('Unexpected action');
      return {
        kind: 'claimed',
        claim: await store.claim(
          { conversation: request.conversation, project: 'project-p' },
          request.action.input,
          identity,
          request.deadline,
          async () => {},
        ),
      };
    },
    (error) => failures.push(error),
  );
  try {
    const result = await callControl(bound, {
      kind: 'claim',
      input: {
        reference: 'task:release',
        aliases: ['https://github.com/acme/widget/issues/42'],
        summary: 'Release widget',
      },
    });
    assert.equal(result.kind, 'claimed');
    assert.ok(result.id);
    if (result.kind !== 'claimed') assert.fail('Expected a claim');
    assert.deepEqual(result.claim.references, [
      'task:project-p:release',
      'github:acme/widget#42',
    ]);
    assert.equal(result.claim.summary, 'Release widget');
    assert.deepEqual(result.claim.owner, {
      conversation: 'conversation-a',
      project: 'project-p',
    });
    assert.deepEqual(await store.claims(), [result.claim]);
    assert.deepEqual(await files.readdir(join(bound.directory, 'inbox')), []);
    assert.deepEqual(await files.readdir(join(bound.directory, 'replies')), []);
    assert.deepEqual(failures, []);
  } finally {
    await host.close();
  }
});

test('a reply for another request is not accepted or acknowledged', async () => {
  const bound = await binding();
  await files.mkdir(join(bound.directory, 'inbox'));
  await files.mkdir(join(bound.directory, 'replies'));
  const calling = callControl(bound, { kind: 'peers' });
  const rejected = assert.rejects(calling, /result unknown.*Reply id/s);
  let id = '';
  await until('published request', async () => {
    id =
      (await files.readdir(join(bound.directory, 'inbox')))
        .find((name) => name.endsWith('.json'))
        ?.slice(0, -5) ?? '';
    return !!id;
  });
  await writeJson(join(bound.directory, 'replies', `${id}.json`), {
    id: randomUUID(),
    kind: 'released',
  });
  await rejected;
  assert.deepEqual(await files.readdir(join(bound.directory, 'inbox')), [
    `${id}.json`,
  ]);
  assert.deepEqual(await files.readdir(join(bound.directory, 'replies')), [
    `${id}.json`,
  ]);
});

test('the client waits through an incomplete reply before accepting and acknowledging it', async () => {
  const bound = await binding();
  await files.mkdir(join(bound.directory, 'inbox'));
  await files.mkdir(join(bound.directory, 'replies'));
  const partialRead = Promise.withResolvers<void>();
  const originalRead = files.readFile;
  vi.spyOn(files, 'readFile').mockImplementation(
    async (...args: Parameters<typeof files.readFile>) => {
      const text = await originalRead(...args);
      if (
        String(args[0]).startsWith(join(bound.directory, 'replies')) &&
        text === '{"id":'
      )
        partialRead.resolve();
      return text;
    },
  );
  let settled = false;
  const calling = callControl(bound, { kind: 'peers' });
  void calling.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  let id = '';
  await until('published request', async () => {
    id =
      (await files.readdir(join(bound.directory, 'inbox')))
        .find((name) => name.endsWith('.json'))
        ?.slice(0, -5) ?? '';
    return !!id;
  });
  const reply = join(bound.directory, 'replies', `${id}.json`);
  try {
    await files.writeFile(reply, '{"id":');
    await within(partialRead.promise, 3000, 'partial reply read');
    await setImmediate();
    assert.equal(settled, false);
    await writeJson(reply, { id, kind: 'released' });
    assert.deepEqual(await calling, { id, kind: 'released' });
    assert.deepEqual(await files.readdir(join(bound.directory, 'inbox')), []);
    assert.deepEqual(await files.readdir(join(bound.directory, 'replies')), []);
  } finally {
    if (!settled) await writeJson(reply, { id, kind: 'released' });
    await calling.catch(() => {});
  }
});

for (const redirect of ['file', 'inbox'] as const) {
  test(`the host refuses a request redirected through a symlinked ${redirect}`, async () => {
    const bound = await binding();
    const target = await scratch('witch-control-request-target-');
    const request = envelope(bound);
    let calls = 0;
    const failures: unknown[] = [];
    const host = await ControlHost.open(
      bound.directory,
      async () => {
        calls++;
        return { kind: 'released' };
      },
      (error) => failures.push(error),
    );
    try {
      await host.drain();
      await watching(bound.directory);
      const inbox = join(bound.directory, 'inbox');
      const name = `${request.id}.json`;
      await writeJson(join(target, name), request);
      if (redirect === 'file')
        await files.symlink(join(target, name), join(inbox, name));
      else {
        await files.rename(inbox, join(bound.directory, 'original-inbox'));
        await files.symlink(target, inbox);
      }
      // Linux can read between the rename and the symlink, which fails with ENOENT until the retry
      await until(
        'request read or refused',
        () =>
          calls > 0 ||
          failures.some(
            (error) => (error as NodeJS.ErrnoException).code === 'ELOOP',
          ),
      );
      await host.drain();
      assert.equal(calls, 0);
      assert.deepEqual(
        await files.readdir(join(bound.directory, 'replies')),
        [],
      );
      assert.deepEqual(
        JSON.parse(await files.readFile(join(target, name), 'utf8')),
        request,
      );
    } finally {
      await host.close();
    }
  });
}

test('the host cannot create a reply through a redirected parent', async () => {
  const bound = await binding();
  const target = await scratch('witch-control-reply-target-');
  const failures: unknown[] = [];
  let calls = 0;
  const host = await ControlHost.open(
    bound.directory,
    async () => {
      calls++;
      return { kind: 'released' };
    },
    (error) => failures.push(error),
  );
  try {
    await host.drain();
    await watching(bound.directory);
    const replies = join(bound.directory, 'replies');
    await files.rename(replies, join(bound.directory, 'original-replies'));
    await files.symlink(target, replies);
    const request = envelope(bound);
    await writeJson(
      join(bound.directory, 'inbox', `${request.id}.json`),
      request,
    );
    await until('request handled', () => calls > 0);
    await host.drain();
    assert.deepEqual(await files.readdir(target), []);
    assert.equal((failures[0] as NodeJS.ErrnoException).code, 'ELOOP');
  } finally {
    await host.close();
  }
});

test('replacing a parent after open cannot redirect the request being read', async (t) => {
  const bound = await binding();
  const target = await scratch('witch-control-open-target-');
  const request = envelope(bound);
  request.action = { kind: 'release', claim: randomUUID() };
  const name = `${request.id}.json`;
  const inbox = join(bound.directory, 'inbox');
  const outside = { ...request, action: { kind: 'peers' } };
  await writeJson(join(target, name), outside);
  const failures: unknown[] = [];
  const actions: unknown[] = [];
  const host = await ControlHost.open(
    bound.directory,
    async ({ action }) => {
      actions.push(action);
      return { kind: 'released' };
    },
    (error) => failures.push(error),
  );
  t.onTestFinished(() => host.close());
  await host.drain();
  await watching(bound.directory);
  let redirected = false;
  const originalOpen = files.open;
  vi.spyOn(files, 'open').mockImplementation(
    async (...args: Parameters<typeof files.open>) => {
      const handle = await originalOpen(...args);
      try {
        if (
          !redirected &&
          basename(String(args[0])) ===
            (process.platform === 'linux' ? 'inbox' : name)
        ) {
          redirected = true;
          await files.rename(inbox, `${inbox}-held`);
          await files.symlink(target, inbox);
        }
        return handle;
      } catch (error) {
        await handle.close();
        throw error;
      }
    },
  );
  await writeJson(join(inbox, name), request);
  await until(
    'original request handled',
    () => actions.length > 0 || failures.length > 0,
  );
  await host.close();
  assert.equal(redirected, true);
  assert.deepEqual(actions, [request.action]);
  // the rename starts a read of the replaced inbox, which is refused
  assert.ok(
    failures.every(
      (error) => (error as NodeJS.ErrnoException).code === 'ELOOP',
    ),
  );
  assert.deepEqual(
    JSON.parse(await files.readFile(join(target, name), 'utf8')),
    outside,
  );
  assert.equal(
    JSON.parse(
      await files.readFile(join(bound.directory, 'replies', name), 'utf8'),
    ).kind,
    'released',
  );
});

test('a missing host reply leaves the result unknown and keeps the published request', async () => {
  const bound = await binding();
  await files.mkdir(join(bound.directory, 'inbox'));
  await files.mkdir(join(bound.directory, 'replies'));
  await assert.rejects(
    callControl(bound, {
      kind: 'claim',
      input: { reference: 'task:kept', summary: 'Unknown outcome' },
    }),
    /result unknown.*Query peers before doing work/s,
  );
  assert.equal(
    (await files.readdir(join(bound.directory, 'inbox'))).filter((name) =>
      name.endsWith('.json'),
    ).length,
    1,
  );
});

test('acknowledgement between reply lookup and request read cannot dispatch the request twice', async () => {
  const bound = await binding();
  const replyRead = Promise.withResolvers<void>();
  const lookup = Promise.withResolvers<void>();
  const acknowledge = Promise.withResolvers<void>();
  const resumeLookup = Promise.withResolvers<void>();
  let clientWaiting = false;
  let lookupWaiting = false;
  const originalRead = files.readFile;
  const originalAccess = files.access;
  vi.spyOn(files, 'readFile').mockImplementation(
    async (...args: Parameters<typeof files.readFile>) => {
      const text = await originalRead(...args);
      if (
        String(args[0]).startsWith(join(bound.directory, 'replies')) &&
        !clientWaiting
      ) {
        clientWaiting = true;
        replyRead.resolve();
        await acknowledge.promise;
      }
      return text;
    },
  );
  vi.spyOn(files, 'access').mockImplementation(
    async (...args: Parameters<typeof files.access>) => {
      if (
        clientWaiting &&
        !lookupWaiting &&
        String(args[0]).startsWith(join(bound.directory, 'replies'))
      ) {
        lookupWaiting = true;
        lookup.resolve();
        await resumeLookup.promise;
      }
      return originalAccess(...args);
    },
  );
  const work = join(bound.directory, 'handled');
  const failures: unknown[] = [];
  const host = await ControlHost.open(
    bound.directory,
    async () => {
      await files.appendFile(work, 'handled\n');
      return { kind: 'released' };
    },
    (error) => failures.push(error),
  );
  const calling = callControl(bound, { kind: 'release', claim: randomUUID() });
  try {
    await within(replyRead.promise, 3000, 'reply read');
    // the blocked client can't re-notify, so touch its request to start the host's next lookup
    const [pending] = (
      await files.readdir(join(bound.directory, 'inbox'))
    ).filter((name) => name.endsWith('.json'));
    await files.lutimes(
      join(bound.directory, 'inbox', pending!),
      new Date(),
      new Date(),
    );
    await within(lookup.promise, 3000, 'next reply lookup');
    acknowledge.resolve();
    assert.equal((await calling).kind, 'released');
    resumeLookup.resolve();
    await host.drain();
    assert.equal(await originalRead(work, 'utf8'), 'handled\n');
    assert.deepEqual(failures, []);
  } finally {
    acknowledge.resolve();
    resumeLookup.resolve();
    await calling.catch(() => {});
    await host.close();
  }
});

test('a listed request removed before its read is acknowledged without dispatch or an error reply', async () => {
  const bound = await binding();
  const request = envelope(bound);
  const inbox = join(bound.directory, 'inbox', `${request.id}.json`);
  const reached = Promise.withResolvers<void>();
  const originalOpen = files.open;
  let calls = 0;
  const failures: unknown[] = [];
  vi.spyOn(files, 'open').mockImplementation(
    async (...args: Parameters<typeof files.open>) => {
      if (basename(String(args[0])) === `${request.id}.json`) {
        await files.unlink(inbox);
        reached.resolve();
      }
      return originalOpen(...args);
    },
  );
  const host = await ControlHost.open(
    bound.directory,
    async () => {
      calls++;
      return { kind: 'released' };
    },
    (error) => failures.push(error),
  );
  try {
    await host.drain();
    await watching(bound.directory);
    await writeJson(inbox, request);
    await within(reached.promise, 3000, 'request disappearance');
    await host.drain();
    assert.equal(calls, 0);
    assert.deepEqual(await files.readdir(join(bound.directory, 'replies')), []);
    assert.deepEqual(failures, []);
  } finally {
    await host.close();
  }
});

test('a mutation that expires while waiting for the ledger lock stores no claim', async () => {
  const bound = await binding();
  const store = await CoordinationStore.open(
    await StateStore.open(bound.directory),
  );
  const lock = await openLocked(
    join(bound.directory, 'coordination', 'lock'),
    constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK,
    { mode: 0o600 },
  );
  try {
    await assert.rejects(
      store.claim(
        { conversation: bound.conversation, project: 'project-p' },
        { reference: 'task:expired', summary: 'Expired' },
        identity,
        Date.now() + 100,
        async () => {},
      ),
      /expired/,
    );
    assert.deepEqual(await store.claims(), []);
  } finally {
    await lock.close();
  }
});

test('expiry after asynchronous authority verification removes the exchange without committing the claim', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: 1000 });
  const bound = await binding();
  const store = await CoordinationStore.open(
    await StateStore.open(bound.directory),
  );
  const verified = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const failures: unknown[] = [];
  const host = await ControlHost.open(
    bound.directory,
    async (request) => {
      if (request.action.kind !== 'claim') throw new Error('Expected claim');
      return {
        kind: 'claimed',
        claim: await store.claim(
          { conversation: request.conversation, project: 'project-p' },
          request.action.input,
          identity,
          request.deadline,
          async () => {
            verified.resolve();
            await proceed.promise;
          },
        ),
      };
    },
    (error) => failures.push(error),
  );
  const request = {
    ...envelope(bound),
    action: {
      kind: 'claim',
      input: { reference: 'task:expired', summary: 'Expired' },
    },
  };
  try {
    await host.drain();
    await watching(bound.directory);
    const created = replyCreations(request.id);
    await writeJson(
      join(bound.directory, 'inbox', `${request.id}.json`),
      request,
    );
    await within(verified.promise, 3000, 'authority verification');
    vi.advanceTimersByTime(5001);
    proceed.resolve();
    await host.drain();
    assert.deepEqual(await files.readdir(join(bound.directory, 'inbox')), []);
    assert.deepEqual(await files.readdir(join(bound.directory, 'replies')), []);
    assert.deepEqual(await store.claims(), []);
    assert.equal(created(), 0);
    assert.deepEqual(failures, []);
  } finally {
    proceed.resolve();
    await host.close();
  }
});

test('invalid envelopes never reach the action handler', async () => {
  const bound = await binding();
  let calls = 0;
  const failures: unknown[] = [];
  const host = await ControlHost.open(
    bound.directory,
    async () => {
      calls++;
      return { kind: 'released' };
    },
    (error) => failures.push(error),
  );
  try {
    await host.drain();
    await watching(bound.directory);
    for (const fields of [
      { version: 2 },
      { action: { kind: 'shell', command: 'ignored' } },
      { id: randomUUID() },
    ]) {
      const id = randomUUID();
      const request = { ...envelope(bound), id, ...fields };
      await writeJson(join(bound.directory, 'inbox', `${id}.json`), request);
      const reply = join(bound.directory, 'replies', `${id}.json`);
      await until('error reply', () => exists(reply));
      await host.drain();
      const result = JSON.parse(await files.readFile(reply, 'utf8')) as {
        id: string;
        kind: string;
      };
      assert.equal(result.id, id);
      assert.equal(result.kind, 'error');
    }
    assert.equal(calls, 0);
    assert.deepEqual(failures, []);
  } finally {
    await host.close();
  }
});

test('an unread successful reply expires without undoing its claim', async () => {
  vi.useFakeTimers({
    toFake: [
      'Date',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ],
    now: 1000,
  });
  const spy = spyWatch();
  const bound = await binding();
  const store = await CoordinationStore.open(
    await StateStore.open(bound.directory),
  );
  const failures: unknown[] = [];
  const host = await ControlHost.open(
    bound.directory,
    async (request) => {
      if (request.action.kind !== 'claim') throw new Error('Expected claim');
      return {
        kind: 'claimed',
        claim: await store.claim(
          { conversation: request.conversation, project: 'project-p' },
          request.action.input,
          identity,
          request.deadline,
          async () => {},
        ),
      };
    },
    (error) => failures.push(error),
  );
  try {
    await host.drain();
    await watching(bound.directory);
    const request = {
      ...envelope(bound),
      deadline: 2000,
      action: {
        kind: 'claim',
        input: { reference: 'task:expiry', summary: 'Keep the claim' },
      },
    };
    const name = `${request.id}.json`;
    const inbox = join(bound.directory, 'inbox');
    const replies = join(bound.directory, 'replies');
    // the answering read is the only read, so it alone has to set the expiry wake
    spy.only = request.id;
    await writeJson(join(inbox, name), request);
    await until('reply', () => exists(join(replies, name)));
    await host.drain();
    const claims = await store.claims();
    assert.equal(claims.length, 1);
    assert.deepEqual(claims[0]!.references, ['task:project-p:expiry']);
    assert.deepEqual(await files.readdir(inbox), [name]);
    assert.deepEqual(await files.readdir(replies), [name]);

    vi.advanceTimersByTime(999);
    await host.drain();
    assert.deepEqual(await files.readdir(inbox), [name]);
    assert.deepEqual(await files.readdir(replies), [name]);
    vi.advanceTimersByTime(1);
    await host.drain();
    assert.deepEqual(await files.readdir(inbox), []);
    assert.deepEqual(await files.readdir(replies), []);
    assert.deepEqual(await store.claims(), claims);
    assert.deepEqual(failures, []);
  } finally {
    await host.close();
  }
});

test('an expired unanswered request is removed without dispatch', async () => {
  vi.useFakeTimers({
    toFake: [
      'Date',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ],
    now: 1000,
  });
  const bound = await binding();
  let calls = 0;
  const failures: unknown[] = [];
  const host = await ControlHost.open(
    bound.directory,
    async () => {
      calls++;
      return { kind: 'released' };
    },
    (error) => failures.push(error),
  );
  try {
    await host.drain();
    await watching(bound.directory);
    const request = {
      ...envelope(bound),
      deadline: 1000,
      action: { kind: 'release', claim: randomUUID() },
    };
    const created = replyCreations(request.id);
    await writeJson(
      join(bound.directory, 'inbox', `${request.id}.json`),
      request,
    );
    await until(
      'empty inbox',
      async () =>
        (await files.readdir(join(bound.directory, 'inbox'))).length === 0,
    );
    await host.drain();
    assert.deepEqual(await files.readdir(join(bound.directory, 'replies')), []);
    assert.equal(calls, 0);
    assert.equal(created(), 0);
    assert.deepEqual(failures, []);
  } finally {
    await host.close();
  }
});

test('a handler finishing after expiry leaves no late reply', async () => {
  vi.useFakeTimers({
    toFake: [
      'Date',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ],
    now: 1000,
  });
  const bound = await binding();
  let entered = false;
  const proceed = Promise.withResolvers<void>();
  const work = join(bound.directory, 'handled');
  const failures: unknown[] = [];
  const host = await ControlHost.open(
    bound.directory,
    async () => {
      entered = true;
      await proceed.promise;
      await files.appendFile(work, 'handled\n');
      return { kind: 'released' };
    },
    (error) => failures.push(error),
  );
  try {
    await host.drain();
    await watching(bound.directory);
    const request = {
      ...envelope(bound),
      deadline: 1500,
      action: { kind: 'release', claim: randomUUID() },
    };
    const created = replyCreations(request.id);
    await writeJson(
      join(bound.directory, 'inbox', `${request.id}.json`),
      request,
    );
    await until('handler entry', () => entered);
    vi.advanceTimersByTime(500);
    proceed.resolve();
    await host.drain();
    assert.deepEqual(await files.readdir(join(bound.directory, 'inbox')), []);
    assert.deepEqual(await files.readdir(join(bound.directory, 'replies')), []);
    assert.equal(await files.readFile(work, 'utf8'), 'handled\n');
    assert.equal(created(), 0);
    assert.deepEqual(failures, []);
  } finally {
    proceed.resolve();
    await host.close();
  }
});

test('expiry cleanup tolerates concurrent acknowledgement', async () => {
  vi.useFakeTimers({
    toFake: [
      'Date',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ],
    now: 1000,
  });
  const bound = await binding();
  const inbox = join(bound.directory, 'inbox');
  const replies = join(bound.directory, 'replies');
  const acknowledge = Promise.withResolvers<void>();
  const resumeHost = Promise.withResolvers<void>();
  let clientWaiting = false;
  let hostWaiting = false;
  const originalRead = files.readFile;
  vi.spyOn(files, 'readFile').mockImplementation(
    async (...args: Parameters<typeof files.readFile>) => {
      const text = await originalRead(...args);
      if (String(args[0]).startsWith(replies) && !clientWaiting) {
        clientWaiting = true;
        await acknowledge.promise;
      } else if (
        typeof args[0] === 'object' &&
        'fd' in args[0] &&
        clientWaiting &&
        !hostWaiting
      ) {
        hostWaiting = true;
        await resumeHost.promise;
      }
      return text;
    },
  );
  const work = join(bound.directory, 'handled');
  const failures: unknown[] = [];
  const host = await ControlHost.open(
    bound.directory,
    async () => {
      await files.appendFile(work, 'handled\n');
      return { kind: 'released' };
    },
    (error) => failures.push(error),
  );
  await host.drain();
  const calling = callControl(bound, { kind: 'release', claim: randomUUID() });
  try {
    await until('client reply read', () => clientWaiting);
    // the host's next read comes from its expiry timer or a late event, and either reaches the deadline
    await until(
      'the next host read',
      () => hostWaiting || vi.getTimerCount() === 1,
    );
    vi.advanceTimersByTime(10_000);
    await until('host request read', () => hostWaiting);
    acknowledge.resolve();
    assert.equal((await calling).kind, 'released');
    resumeHost.resolve();
    await host.drain();
    assert.equal(await originalRead(work, 'utf8'), 'handled\n');
    assert.deepEqual(await files.readdir(inbox), []);
    assert.deepEqual(await files.readdir(replies), []);
    assert.deepEqual(failures, []);
  } finally {
    acknowledge.resolve();
    resumeHost.resolve();
    await calling.catch(() => {});
    await host.close();
  }
});

for (const redirect of ['inbox', 'replies', 'reply'] as const)
  test(`expiry cleanup cannot delete through a redirected ${redirect}`, async () => {
    vi.useFakeTimers({
      toFake: [
        'Date',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
      ],
      now: 1000,
    });
    const bound = await binding();
    const target = await scratch('witch-control-expiry-target-');
    const request = { ...envelope(bound), deadline: 1000 };
    const name = `${request.id}.json`;
    const outside = join(target, name);
    const contents =
      redirect === 'inbox' ? JSON.stringify(request) : 'untouched';
    await files.writeFile(outside, contents);
    let calls = 0;
    const failures: unknown[] = [];
    const host = await ControlHost.open(
      bound.directory,
      async () => {
        calls++;
        return { kind: 'released' };
      },
      (error) => failures.push(error),
    );
    try {
      await host.drain();
      await watching(bound.directory);
      // the redirect comes first, so the write's event, or for the inbox the rename's, starts the read
      if (redirect === 'reply')
        await files.symlink(outside, join(bound.directory, 'replies', name));
      else {
        const directory = join(bound.directory, redirect);
        await files.rename(directory, `${directory}-original`);
        await files.symlink(target, directory);
      }
      if (redirect !== 'inbox')
        await writeJson(join(bound.directory, 'inbox', name), request);
      if (redirect === 'inbox')
        // Linux can read between the rename and the symlink, which fails with ENOENT until the retry
        await until('a refused redirect', () => {
          vi.advanceTimersByTime(250);
          return failures.some(
            (error) => (error as NodeJS.ErrnoException).code === 'ELOOP',
          );
        });
      else if (redirect === 'replies')
        await until('a failure', () => failures.length > 0);
      else
        await until(
          'empty inbox',
          async () =>
            (await files.readdir(join(bound.directory, 'inbox'))).length === 0,
        );
      await host.drain();
      assert.equal(await files.readFile(outside, 'utf8'), contents);
      assert.equal(calls, 0);
      if (redirect === 'reply') {
        assert.deepEqual(
          await files.readdir(join(bound.directory, 'inbox')),
          [],
        );
        assert.deepEqual(
          await files.readdir(join(bound.directory, 'replies')),
          [],
        );
        assert.deepEqual(failures, []);
      } else if (redirect === 'replies') assert.equal(failures.length, 1);
    } finally {
      await host.close();
    }
  });

test('a failed expiry deletion leaves the request available for retry', async () => {
  vi.useFakeTimers({
    toFake: [
      'Date',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ],
    now: 1000,
  });
  const spy = spyWatch();
  const bound = await binding();
  const request = { ...envelope(bound), deadline: 1000 };
  const name = `${request.id}.json`;
  let calls = 0;
  const failures: unknown[] = [];
  const host = await ControlHost.open(
    bound.directory,
    async () => {
      calls++;
      return { kind: 'released' };
    },
    (error) => failures.push(error),
  );
  try {
    await host.drain();
    await watching(bound.directory);
    const inbox = join(bound.directory, 'inbox');
    const replies = join(bound.directory, 'replies');
    await files.mkdir(join(replies, name));
    await writeJson(join(inbox, name), request);
    await until('a failure', () => failures.length > 0);
    await host.drain();
    // a change during the backoff starts no read
    const delivered = spy.delivered;
    await files.lutimes(join(inbox, name), new Date(), new Date());
    await until('the touch event', () => spy.delivered > delivered);
    await host.drain();
    assert.equal(failures.length, 1);
    vi.advanceTimersByTime(249);
    await host.drain();
    assert.equal(failures.length, 1);
    assert.deepEqual(
      JSON.parse(await files.readFile(join(inbox, name), 'utf8')),
      request,
    );
    assert.deepEqual(await files.readdir(replies), [name]);
    await files.rmdir(join(replies, name));
    vi.advanceTimersByTime(1);
    await host.drain();
    assert.deepEqual(await files.readdir(inbox), []);
    assert.deepEqual(await files.readdir(replies), []);
    assert.equal(calls, 0);
    assert.equal(failures.length, 1);
  } finally {
    await host.close();
  }
});

const timers = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
] as const;

test('an idle host reads its inbox only after a change', async () => {
  vi.useFakeTimers({ toFake: [...timers] });
  const bound = await binding();
  const host = await ControlHost.open(
    bound.directory,
    async () => ({ kind: 'released' }),
    () => {},
  );
  try {
    await host.drain();
    const readdir = vi.spyOn(files, 'readdir');
    // synchronous, so only a timer could start a read here
    vi.advanceTimersByTime(60_000);
    assert.equal(readdir.mock.calls.length, 0);
  } finally {
    await host.close();
  }
});

test('a request written during a read is answered after it', async () => {
  vi.useFakeTimers({ toFake: [...timers] });
  const spy = spyWatch();
  const bound = await binding();
  const first = {
    ...envelope(bound),
    action: { kind: 'release', claim: randomUUID() },
  };
  const second = envelope(bound);
  const actions: unknown[] = [];
  let blocked = false;
  const release = Promise.withResolvers<void>();
  const failures: unknown[] = [];
  const host = await ControlHost.open(
    bound.directory,
    async ({ action }) => {
      actions.push(action);
      if (action.kind === 'release') {
        blocked = true;
        await release.promise;
      }
      return { kind: 'released' };
    },
    (error) => failures.push(error),
  );
  try {
    await host.drain();
    await watching(bound.directory);
    const inbox = join(bound.directory, 'inbox');
    await writeJson(join(inbox, `${first.id}.json`), first);
    await until('first request handled', () => blocked);
    const delivered = spy.delivered;
    await writeJson(join(inbox, `${second.id}.json`), second);
    await until('an event during the read', () => spy.delivered > delivered);
    spy.dropping = true;
    release.resolve();
    // no until: drain must cover the re-read
    await host.drain();
    for (const request of [first, second])
      assert.ok(
        await exists(join(bound.directory, 'replies', `${request.id}.json`)),
      );
    assert.deepEqual(actions, [first.action, second.action]);
    assert.deepEqual(failures, []);
  } finally {
    release.resolve();
    await host.close();
  }
});

test('a client re-notifies a request whose change event was lost', async () => {
  const spy = spyWatch();
  const bound = await binding();
  const host = await ControlHost.open(
    bound.directory,
    async () => ({ kind: 'released' }),
    () => {},
  );
  const touches: number[] = [];
  const lutimes = files.lutimes;
  vi.spyOn(files, 'lutimes').mockImplementation(
    async (...args: Parameters<typeof files.lutimes>) => {
      touches.push(performance.now());
      if (touches.length === 2) spy.dropping = false;
      return lutimes(...args);
    },
  );
  try {
    await host.drain();
    spy.dropping = true;
    const result = await callControl(
      bound,
      { kind: 'release', claim: randomUUID() },
      Date.now() + 2000,
    );
    assert.equal(result.kind, 'released');
    // the cadence that keeps a lost event's pickup under 250 ms
    assert.ok(touches[1]! - touches[0]! < 200);
  } finally {
    await host.close();
  }
});

for (const failure of ['open', 'error'] as const)
  test(`a host whose watch fails at ${failure} falls back to the 250 ms poll`, async () => {
    vi.useFakeTimers({ toFake: [...timers] });
    const spy = spyWatch();
    spy.failing = failure === 'open';
    const bound = await binding();
    const failures: unknown[] = [];
    const host = await ControlHost.open(
      bound.directory,
      async () => ({ kind: 'released' }),
      (error) => failures.push(error),
    );
    try {
      await host.drain();
      if (failure === 'error') {
        // Node closes an errored watcher before it emits
        spy.watcher!.close();
        spy.watcher!.emit('error', new Error('watch failed'));
        await host.drain();
      }
      // the first reply stays unacknowledged, with its deadline 5 s away
      for (const request of [envelope(bound), envelope(bound)]) {
        const name = `${request.id}.json`;
        await writeJson(join(bound.directory, 'inbox', name), request);
        vi.advanceTimersByTime(250);
        await until('its reply', () =>
          exists(join(bound.directory, 'replies', name)),
        );
        await host.drain();
      }
      assert.deepEqual(failures, []);
    } finally {
      await host.close();
    }
  });

test('a request answered before the host reads it expires at its deadline', async () => {
  vi.useFakeTimers({ toFake: ['Date', ...timers], now: 1000 });
  const bound = await binding();
  let calls = 0;
  const failures: unknown[] = [];
  const host = await ControlHost.open(
    bound.directory,
    async () => {
      calls++;
      return { kind: 'released' };
    },
    (error) => failures.push(error),
  );
  try {
    await host.drain();
    await watching(bound.directory);
    const access = vi.spyOn(files, 'access');
    const inbox = join(bound.directory, 'inbox');
    const replies = join(bound.directory, 'replies');
    const later = { ...envelope(bound), deadline: 3000 };
    const earlier = { ...envelope(bound), deadline: 2000 };
    for (const request of [later, earlier]) {
      const name = `${request.id}.json`;
      await writeJson(join(replies, name), {
        id: request.id,
        kind: 'released',
      });
      await writeJson(join(inbox, name), request);
      // its reply lookup shows the host has listed it
      await until('the host lists it', () =>
        access.mock.calls.some(([path]) =>
          String(path).endsWith(join('replies', name)),
        ),
      );
      await host.drain();
    }
    const names = (requests: ControlRequest[]) =>
      requests.map(({ id }) => `${id}.json`).toSorted();
    vi.advanceTimersByTime(999);
    await host.drain();
    assert.deepEqual(
      (await files.readdir(inbox)).toSorted(),
      names([later, earlier]),
    );
    vi.advanceTimersByTime(1);
    await host.drain();
    assert.deepEqual(await files.readdir(inbox), names([later]));
    assert.deepEqual(await files.readdir(replies), names([later]));
    assert.equal(calls, 0);
    assert.deepEqual(failures, []);
  } finally {
    await host.close();
  }
});

test('a closed host keeps no timer or watch', async () => {
  vi.useFakeTimers({ toFake: [...timers] });
  const spy = spyWatch();
  const bound = await binding();
  const host = await ControlHost.open(
    bound.directory,
    async () => ({ kind: 'released' }),
    () => {},
  );
  let closed = false;
  try {
    await host.drain();
    await watching(bound.directory);
    const request = envelope(bound);
    const name = `${request.id}.json`;
    const inbox = join(bound.directory, 'inbox');
    await writeJson(join(inbox, name), request);
    await until('its reply', () =>
      exists(join(bound.directory, 'replies', name)),
    );
    await host.drain();
    const delivered = spy.delivered;
    await files.lutimes(join(inbox, name), new Date(), new Date());
    await until('the touch event', () => spy.delivered > delivered);
    await host.drain();
    // the re-read replaced the expiry timer rather than adding one
    assert.equal(vi.getTimerCount(), 1);
    await host.close();
    closed = true;
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(spy.closes, 1);
  } finally {
    if (!closed) await host.close();
  }
});

test('a far deadline sets no 1 ms timer', async () => {
  const bound = await binding();
  const host = await ControlHost.open(
    bound.directory,
    async () => ({ kind: 'released' }),
    () => {},
  );
  try {
    await host.drain();
    await watching(bound.directory);
    const request = { ...envelope(bound), deadline: Date.now() + 2 ** 32 };
    const name = `${request.id}.json`;
    await writeJson(join(bound.directory, 'inbox', name), request);
    await until('its reply', () =>
      exists(join(bound.directory, 'replies', name)),
    );
    await host.drain();
    const readdir = vi.spyOn(files, 'readdir');
    await delay(200);
    assert.ok(readdir.mock.calls.length <= 1);
  } finally {
    await host.close();
  }
});
