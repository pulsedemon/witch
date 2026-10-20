import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants, promises as files } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { callControl, ControlHost } from '../src/persistence/control.js';
import type {
  ControlBinding,
  ControlRequest,
} from '../src/persistence/control.js';
import { CoordinationStore } from '../src/persistence/coordination.js';
import { writeJson } from '../src/persistence/json.js';
import { exclusiveLock } from '../src/persistence/lock.js';
import { scratch } from './fixtures/scratch.js';
import { until, within } from './fixtures/within.js';

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

await test('control requests preserve their binding and action through a real ledger mutation and acknowledgement', async () => {
  const bound = await binding();
  const directory = join(bound.directory, 'actual');
  const alias = join(bound.directory, 'alias');
  await files.mkdir(directory);
  await files.symlink(directory, alias);
  bound.directory = alias;
  const store = await CoordinationStore.open(bound.directory);
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

await test('a reply for another request is not accepted or acknowledged', async () => {
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

await test('the client waits through an incomplete reply before accepting and acknowledging it', async (t) => {
  const bound = await binding();
  await files.mkdir(join(bound.directory, 'inbox'));
  await files.mkdir(join(bound.directory, 'replies'));
  const partialRead = Promise.withResolvers<void>();
  const originalRead = files.readFile;
  t.mock.method(
    files,
    'readFile',
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
  await test(`the host refuses a request redirected through a symlinked ${redirect}`, async () => {
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

await test('the host cannot create a reply through a redirected parent', async () => {
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

await test('a missing host reply leaves the result unknown and keeps the published request', async () => {
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

await test('acknowledgement between reply lookup and request read cannot dispatch the request twice', async (t) => {
  const bound = await binding();
  const replyRead = Promise.withResolvers<void>();
  const lookup = Promise.withResolvers<void>();
  const acknowledge = Promise.withResolvers<void>();
  const resumeLookup = Promise.withResolvers<void>();
  let clientWaiting = false;
  let lookupWaiting = false;
  const originalRead = files.readFile;
  const originalAccess = files.access;
  t.mock.method(
    files,
    'readFile',
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
  t.mock.method(
    files,
    'access',
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

await test('a listed request removed before its read is acknowledged without dispatch or an error reply', async (t) => {
  const bound = await binding();
  const request = envelope(bound);
  const inbox = join(bound.directory, 'inbox', `${request.id}.json`);
  const reached = Promise.withResolvers<void>();
  const originalRead = files.readFile;
  let calls = 0;
  const failures: unknown[] = [];
  t.mock.method(
    files,
    'readFile',
    async (...args: Parameters<typeof files.readFile>) => {
      if (args[0] === inbox) {
        await files.unlink(inbox);
        reached.resolve();
      }
      return originalRead(...args);
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

await test('a mutation that expires while waiting for the ledger lock stores no claim', async () => {
  const bound = await binding();
  const store = await CoordinationStore.open(bound.directory);
  const lock = await files.open(
    join(bound.directory, 'coordination', 'lock'),
    constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | exclusiveLock,
    0o600,
  );
  try {
    await assert.rejects(
      store.claim(
        { conversation: bound.conversation, project: 'project-p' },
        { reference: 'task:expired', summary: 'Expired' },
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

await test('the host reports expiry after asynchronous authority verification without committing the claim', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const bound = await binding();
  const store = await CoordinationStore.open(bound.directory);
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
    t.mock.timers.tick(5001);
    proceed.resolve();
    await host.drain();
    const result = JSON.parse(
      await files.readFile(
        join(bound.directory, 'replies', `${request.id}.json`),
        'utf8',
      ),
    ) as { kind: string; message: string };
    assert.equal(result.kind, 'error');
    assert.match(result.message, /expired/);
    assert.deepEqual(await store.claims(), []);
    assert.deepEqual(failures, []);
  } finally {
    proceed.resolve();
    await host.close();
  }
});

await test('invalid and expired envelopes never reach the action handler', async () => {
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
      { deadline: Date.now() - 1 },
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
