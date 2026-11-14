import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as files } from 'node:fs';
import { basename, join } from 'node:path';
import { test, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import {
  callControl,
  ControlHost,
  ControlTimeoutError,
} from '../../src/persistence/control.js';
import type { ControlBinding } from '../../src/persistence/control.js';
import { CoordinationStore } from '../../src/persistence/coordination.js';
import { StateStore } from '../../src/persistence/store.js';
import { writeJson } from '../../src/persistence/json.js';
import { scratch } from '../fixtures/scratch.js';
import { settled, until, within } from '../fixtures/within.js';
import {
  binding,
  countingHost,
  envelope,
  identity,
  watching,
} from '../fixtures/control-host.js';

async function exchange(bound: ControlBinding): Promise<void> {
  await files.mkdir(join(bound.directory, 'inbox'));

  await files.mkdir(join(bound.directory, 'replies'));
}

/** the id of the request a client published to the inbox. */
async function published(bound: ControlBinding): Promise<string> {
  let id = '';

  await until('published request', async () => {
    id =
      (await files.readdir(join(bound.directory, 'inbox')))
        .find((name) => name.endsWith('.json'))
        ?.slice(0, -5) ?? '';

    return !!id;
  });

  return id;
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

  await exchange(bound);

  const calling = callControl(bound, { kind: 'peers' });

  const rejected = assert.rejects(calling, (error: unknown) => {
    assert.ok(error instanceof Error);

    assert.equal(error instanceof ControlTimeoutError, false);

    assert.match(error.message, /result unknown.*Reply id/s);

    return true;
  });

  const id = await published(bound);

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

  await exchange(bound);

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

  const calling = callControl(bound, { kind: 'peers' });
  const isSettled = settled(calling);
  const id = await published(bound);
  const reply = join(bound.directory, 'replies', `${id}.json`);

  try {
    await files.writeFile(reply, '{"id":');

    await within(partialRead.promise, 3000, 'partial reply read');

    await setImmediate();

    assert.equal(isSettled(), false);

    await writeJson(reply, { id, kind: 'released' });

    assert.deepEqual(await calling, { id, kind: 'released' });

    assert.deepEqual(await files.readdir(join(bound.directory, 'inbox')), []);

    assert.deepEqual(await files.readdir(join(bound.directory, 'replies')), []);
  } finally {
    if (!isSettled()) await writeJson(reply, { id, kind: 'released' });

    await calling.catch(() => {});
  }
});

for (const redirect of ['file', 'inbox'] as const) {
  test(`the host refuses a request redirected through a symlinked ${redirect}`, async () => {
    const bound = await binding();
    const target = await scratch('witch-control-request-target-');
    const request = envelope(bound);
    const { host, failures, calls } = await countingHost(bound);

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
          calls() > 0 ||
          failures.some(
            (error) => (error as NodeJS.ErrnoException).code === 'ELOOP',
          ),
      );

      await host.drain();

      assert.equal(calls(), 0);

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
  const { host, failures, calls } = await countingHost(bound);

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

    await until('request handled', () => calls() > 0);

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

  await exchange(bound);

  await assert.rejects(
    callControl(bound, {
      kind: 'claim',
      input: { reference: 'task:kept', summary: 'Unknown outcome' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ControlTimeoutError);

      assert.match(
        error.message,
        /result unknown.*Query peers before doing work/s,
      );

      return true;
    },
  );

  assert.equal(
    (await files.readdir(join(bound.directory, 'inbox'))).filter((name) =>
      name.endsWith('.json'),
    ).length,
    1,
  );
});

for (const { code, expired } of [
  { code: 'ENOENT', expired: true },
  { code: 'ENOENT', expired: false },
  { code: 'EACCES', expired: true },
])
  test(`re-notification ${code} ${expired ? 'after' : 'before'} expiry preserves its failure kind`, async () => {
    const bound = await binding();

    await exchange(bound);

    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const failure = Object.assign(new Error('Cannot touch request'), { code });

    vi.spyOn(files, 'lutimes').mockImplementation(async () => {
      now.mockReturnValue(expired ? 2001 : 1500);

      throw failure;
    });

    await assert.rejects(
      callControl(bound, { kind: 'peers' }, 2000),
      (error: unknown) => {
        assert.ok(error instanceof Error);

        assert.equal(
          error instanceof ControlTimeoutError,
          code === 'ENOENT' && expired,
        );

        assert.match(error.message, /Coordination result unknown/);

        if (error instanceof ControlTimeoutError)
          assert.match(error.message, /host did not reply before the deadline/);
        else assert.equal(error.cause, failure);

        return true;
      },
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

  vi.spyOn(files, 'open').mockImplementation(
    async (...args: Parameters<typeof files.open>) => {
      if (basename(String(args[0])) === `${request.id}.json`) {
        await files.unlink(inbox);

        reached.resolve();
      }

      return originalOpen(...args);
    },
  );

  const { host, failures, calls } = await countingHost(bound);

  try {
    await host.drain();

    await watching(bound.directory);

    await writeJson(inbox, request);

    await within(reached.promise, 3000, 'request disappearance');

    await host.drain();

    assert.equal(calls(), 0);

    assert.deepEqual(await files.readdir(join(bound.directory, 'replies')), []);

    assert.deepEqual(failures, []);
  } finally {
    await host.close();
  }
});
