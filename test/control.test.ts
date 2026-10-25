import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants, promises as files } from 'node:fs';
import { basename, join } from 'node:path';
import { test, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
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
      const inbox = join(bound.directory, 'inbox');
      const name = `${request.id}.json`;
      await writeJson(join(target, name), request);
      if (redirect === 'file')
        await files.symlink(join(target, name), join(inbox, name));
      else {
        await files.rename(inbox, join(bound.directory, 'original-inbox'));
        await files.symlink(target, inbox);
      }
      await until(
        'request read or rejected',
        () => calls > 0 || failures.length > 0,
      );
      await host.drain();
      assert.equal(calls, 0);
      assert.equal((failures[0] as NodeJS.ErrnoException).code, 'ELOOP');
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
  assert.deepEqual(failures, []);
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
    for (const fields of [
      { version: 2 },
      { action: { kind: 'shell', command: 'ignored' } },
    ]) {
      const request = { ...envelope(bound), ...fields };
      await writeJson(
        join(bound.directory, 'inbox', `${request.id}.json`),
        request,
      );
      const reply = join(bound.directory, 'replies', `${request.id}.json`);
      await until('error reply', async () =>
        files.access(reply).then(
          () => true,
          () => false,
        ),
      );
      await host.drain();
      const result = JSON.parse(await files.readFile(reply, 'utf8')) as {
        id: string;
        kind: string;
      };
      assert.equal(result.id, request.id);
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
    toFake: ['Date', 'setInterval', 'clearInterval'],
    now: 1000,
  });
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
    await writeJson(join(inbox, name), request);
    vi.advanceTimersByTime(250);
    await host.drain();
    const claims = await store.claims();
    assert.equal(claims.length, 1);
    assert.deepEqual(claims[0]!.references, ['task:project-p:expiry']);
    assert.deepEqual(await files.readdir(inbox), [name]);
    assert.deepEqual(await files.readdir(replies), [name]);

    vi.advanceTimersByTime(749);
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
    toFake: ['Date', 'setInterval', 'clearInterval'],
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
    const request = {
      ...envelope(bound),
      deadline: 1250,
      action: { kind: 'release', claim: randomUUID() },
    };
    await writeJson(
      join(bound.directory, 'inbox', `${request.id}.json`),
      request,
    );
    vi.advanceTimersByTime(250);
    await host.drain();
    assert.deepEqual(await files.readdir(join(bound.directory, 'inbox')), []);
    assert.deepEqual(await files.readdir(join(bound.directory, 'replies')), []);
    assert.equal(calls, 0);
    assert.deepEqual(failures, []);
  } finally {
    await host.close();
  }
});

test('a handler finishing after expiry leaves no late reply', async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'setInterval', 'clearInterval'],
    now: 1000,
  });
  const bound = await binding();
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const work = join(bound.directory, 'handled');
  const failures: unknown[] = [];
  const host = await ControlHost.open(
    bound.directory,
    async () => {
      entered.resolve();
      await proceed.promise;
      await files.appendFile(work, 'handled\n');
      return { kind: 'released' };
    },
    (error) => failures.push(error),
  );
  try {
    await host.drain();
    const request = {
      ...envelope(bound),
      deadline: 1500,
      action: { kind: 'release', claim: randomUUID() },
    };
    await writeJson(
      join(bound.directory, 'inbox', `${request.id}.json`),
      request,
    );
    vi.advanceTimersByTime(250);
    await within(entered.promise, 3000, 'handler entry');
    vi.advanceTimersByTime(250);
    proceed.resolve();
    await host.drain();
    assert.deepEqual(await files.readdir(join(bound.directory, 'inbox')), []);
    assert.deepEqual(await files.readdir(join(bound.directory, 'replies')), []);
    assert.equal(await files.readFile(work, 'utf8'), 'handled\n');
    assert.deepEqual(failures, []);
  } finally {
    proceed.resolve();
    await host.close();
  }
});

test('expiry cleanup tolerates concurrent acknowledgement', async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'setInterval', 'clearInterval'],
    now: 1000,
  });
  const bound = await binding();
  const inbox = join(bound.directory, 'inbox');
  const replies = join(bound.directory, 'replies');
  const replyRead = Promise.withResolvers<void>();
  const requestRead = Promise.withResolvers<void>();
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
        replyRead.resolve();
        await acknowledge.promise;
      } else if (
        typeof args[0] === 'object' &&
        'fd' in args[0] &&
        clientWaiting &&
        !hostWaiting
      ) {
        hostWaiting = true;
        requestRead.resolve();
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
    await until('published request', async () =>
      (await files.readdir(inbox)).some((name) => name.endsWith('.json')),
    );
    vi.advanceTimersByTime(250);
    await host.drain();
    await within(replyRead.promise, 3000, 'client reply read');
    vi.advanceTimersByTime(250);
    await within(requestRead.promise, 3000, 'host request read');
    vi.advanceTimersByTime(9500);
    acknowledge.resolve();
    assert.equal(
      (await within(calling, 3000, 'acknowledgement')).kind,
      'released',
    );
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
      toFake: ['Date', 'setInterval', 'clearInterval'],
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
      if (redirect !== 'inbox')
        await writeJson(join(bound.directory, 'inbox', name), request);
      if (redirect === 'reply')
        await files.symlink(outside, join(bound.directory, 'replies', name));
      else {
        const directory = join(bound.directory, redirect);
        await files.rename(directory, `${directory}-original`);
        await files.symlink(target, directory);
      }
      vi.advanceTimersByTime(250);
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
      } else assert.equal(failures.length, 1);
    } finally {
      await host.close();
    }
  });

test('a failed expiry deletion leaves the request available for retry', async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'setInterval', 'clearInterval'],
    now: 1000,
  });
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
    const inbox = join(bound.directory, 'inbox');
    const replies = join(bound.directory, 'replies');
    await writeJson(join(inbox, name), request);
    await files.mkdir(join(replies, name));
    vi.advanceTimersByTime(250);
    await host.drain();
    assert.equal(failures.length, 1);
    assert.deepEqual(
      JSON.parse(await files.readFile(join(inbox, name), 'utf8')),
      request,
    );
    assert.deepEqual(await files.readdir(replies), [name]);
    await files.rmdir(join(replies, name));
    vi.advanceTimersByTime(250);
    await host.drain();
    assert.deepEqual(await files.readdir(inbox), []);
    assert.deepEqual(await files.readdir(replies), []);
    assert.equal(calls, 0);
    assert.equal(failures.length, 1);
  } finally {
    await host.close();
  }
});
