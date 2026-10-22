import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  ClaimInput,
  ClaimOwner,
  SessionPresence,
  TaskClaim,
} from '../src/core/coordination-state.js';
import {
  ClaimConflict,
  CoordinationStore,
} from '../src/persistence/coordination.js';
import { StateStore } from '../src/persistence/store.js';
import { identifyProcess } from '../src/persistence/process.js';
import { record } from './fixtures/coordinator.js';
import { scratch } from './fixtures/scratch.js';
import { within } from './fixtures/within.js';

const identity = (await identifyProcess(process.pid))!;
const owner = { conversation: 'a', project: 'project-p' };
const input = { reference: 'task:shared', summary: 'First task' };
const verify = async () => {};
const claim = (
  store: CoordinationStore,
  givenOwner: ClaimOwner = owner,
  givenInput: ClaimInput = input,
) => store.claim(givenOwner, givenInput, identity, Date.now() + 5000, verify);
const release = (
  store: CoordinationStore,
  givenOwner: ClaimOwner,
  id: string,
) => store.release(givenOwner, id, Date.now() + 5000, verify);

await test('activation observation follows release without retaining ownership', async () => {
  const root = await scratch('witch-activation-observation-');
  const store = await CoordinationStore.open(root);
  const activation = randomUUID();
  const close = await store.holdActivation(activation);
  try {
    assert.deepEqual(
      await Promise.all([
        store.isActive(activation),
        store.isActive(activation),
      ]),
      [true, true],
    );
  } finally {
    await close();
  }
  assert.deepEqual(
    await Promise.all([store.isActive(activation), store.isActive(activation)]),
    [false, false],
  );
  await assert.rejects(
    access(join(root, 'coordination', 'sessions', `${activation}.lock`)),
    { code: 'ENOENT' },
  );
});

function contender(t: TestContext, root: string, conversation: string) {
  const child = fork(
    fileURLToPath(new URL('fixtures/coordination-owner.mts', import.meta.url)),
    [root, conversation],
    {
      cwd: root,
      execArgv: ['--import', import.meta.resolve('tsx')],
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
  const ended = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await ended;
  });
  const ready = within(once(child, 'message'), 5000, 'owner ready');
  return {
    ready,
    claim: async () => {
      const reply = within(once(child, 'message'), 7000, 'owner response');
      child.send('claim');
      const [message] = await reply;
      return message as { kind: string; claim: TaskClaim };
    },
  };
}

await test('two independent claimants have one owner and only its work starts', async (t) => {
  const root = await scratch('witch-coordination-race-');
  const a = contender(t, root, 'a');
  const b = contender(t, root, 'b');
  await Promise.all([a.ready, b.ready]);
  const results = await Promise.all([a.claim(), b.claim()]);
  assert.deepEqual(results.map(({ kind }) => kind).sort(), [
    'claimed',
    'conflict',
  ]);
  const winner = results.find(({ kind }) => kind === 'claimed')!.claim;
  const loser = results.find(({ kind }) => kind === 'conflict')!.claim;
  assert.deepEqual(loser, winner);
  const store = await CoordinationStore.open(root);
  assert.deepEqual(await store.claims(), [winner]);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.endsWith('.worked')),
    [`${winner.owner.conversation}.worked`],
  );
});

await test('an alias collision stores none of the requested references', async () => {
  const root = await scratch('witch-coordination-alias-');
  const store = await CoordinationStore.open(root);
  const reserved = await claim(store);
  const file = join(root, 'coordination', 'claims.json');
  const before = await readFile(file, 'utf8');
  await assert.rejects(
    claim(
      store,
      { ...owner, conversation: 'b' },
      {
        reference: 'task:free',
        aliases: ['task:shared'],
        summary: 'Losing task',
      },
    ),
    (error) => error instanceof ClaimConflict && error.claim.id === reserved.id,
  );
  assert.equal(await readFile(file, 'utf8'), before);
});

await test('a retry preserves identity while updating its summary and merging aliases', async () => {
  const store = await CoordinationStore.open(
    await scratch('witch-coordination-retry-'),
  );
  const first = await claim(store, owner, {
    reference: 'https://github.com/Acme/Kit/issues/17?view=one#comment',
    summary: 'First summary',
  });
  const retried = await claim(store, owner, {
    reference: 'https://github.com/acme/kit/pull/17/',
    aliases: ['task:  Release   PATCH  ', 'task:release patch'],
    summary: 'Second summary',
  });
  assert.deepEqual(retried, {
    ...first,
    references: ['github:acme/kit#17', 'task:project-p:release patch'],
    summary: 'Second summary',
  });
  assert.deepEqual(await store.claims(), [retried]);
  await assert.rejects(
    claim(store, owner, {
      reference: 'task:separate',
      summary: 'Another task',
    }),
    /Release the current task/,
  );
  await assert.rejects(
    claim(store, { ...owner, project: 'project-q' }),
    /Release/,
  );
  assert.deepEqual(await store.claims(), [retried]);
});

await test('only the matching owner and exact claim id can release a reservation', async () => {
  const root = await scratch('witch-coordination-release-');
  const store = await CoordinationStore.open(root);
  const first = await claim(store);
  const file = join(root, 'coordination', 'claims.json');
  const before = await readFile(file, 'utf8');
  for (const wrong of [
    { ...owner, conversation: 'b' },
    { ...owner, project: 'project-q' },
  ])
    await assert.rejects(release(store, wrong, first.id), /Only the owning/);
  assert.equal(await readFile(file, 'utf8'), before);
  await release(store, owner, first.id);
  const next = await claim(store, owner, {
    reference: 'task:next',
    summary: 'Next',
  });
  assert.notEqual(next.id, first.id);
  await release(store, owner, first.id);
  assert.deepEqual(await store.claims(), [next]);
});

await test('normalized named tasks conflict within a project and stay separate across projects', async () => {
  const store = await CoordinationStore.open(
    await scratch('witch-coordination-projects-'),
  );
  await claim(store);
  await assert.rejects(
    claim(
      store,
      { ...owner, conversation: 'b' },
      {
        reference: 'task: SHARED ',
        summary: 'Duplicate',
      },
    ),
    ClaimConflict,
  );
  await claim(store, { conversation: 'b', project: 'project-q' });
  assert.deepEqual(
    (await store.claims()).map((entry) => entry.references),
    [['task:project-p:shared'], ['task:project-q:shared']],
  );
});

for (const variant of [
  'https://github.com/ACME/KIT/issues/17',
  'https://github.com/acme/kit/issues/17/?q=one#two',
  'https://github.com/acme/kit/pull/17/',
  'https://github.com/%61cme/kit/issues/17',
]) {
  await test(`GitHub spelling ${variant} conflicts with its existing number`, async () => {
    const store = await CoordinationStore.open(
      await scratch('witch-coordination-url-'),
    );
    await claim(store, owner, {
      reference: 'https://github.com/acme/kit/issues/17',
      summary: 'Reserved',
    });
    await assert.rejects(
      claim(
        store,
        { conversation: 'b', project: 'project-q' },
        {
          reference: variant,
          summary: 'Duplicate',
        },
      ),
      ClaimConflict,
    );
  });
}

for (const damage of ['invalid JSON', 'unreadable'] as const) {
  await test(`an ${damage} ledger refuses mutations without replacing its bytes`, async () => {
    const root = await scratch('witch-coordination-damaged-');
    const store = await CoordinationStore.open(root);
    await claim(store);
    const file = join(root, 'coordination', 'claims.json');
    if (damage === 'invalid JSON') await writeFile(file, '{');
    const before = await readFile(file, 'utf8');
    if (damage === 'unreadable') await chmod(file, 0o000);
    try {
      await assert.rejects(claim(store, { ...owner, conversation: 'b' }));
      await assert.rejects(release(store, owner, randomUUID()));
    } finally {
      await chmod(file, 0o600);
    }
    assert.equal(await readFile(file, 'utf8'), before);
  });
}

await test('failed authority verification releases the ledger lock for another process', async (t) => {
  const root = await scratch('witch-coordination-authority-');
  const store = await CoordinationStore.open(root);
  await assert.rejects(
    store.claim(owner, input, identity, Date.now() + 5000, async () => {
      throw new Error('Revoked');
    }),
    /Revoked/,
  );
  assert.deepEqual(await store.claims(), []);
  const next = contender(t, root, 'b');
  await next.ready;
  const result = await next.claim();
  assert.equal(result.kind, 'claimed');
  assert.equal(result.claim.owner.conversation, 'b');
});

await test('a failed mutation releases the ledger lock without releasing the task', async (t) => {
  const root = await scratch('witch-coordination-failure-');
  const store = await CoordinationStore.open(root);
  const held = await claim(store);
  await assert.rejects(
    release(store, { ...owner, conversation: 'b' }, held.id),
  );
  const next = contender(t, root, 'b');
  await next.ready;
  const result = await next.claim();
  assert.equal(result.kind, 'conflict');
  assert.deepEqual(result.claim, held);
});

await test('presence removal cannot delete a newer activation or its task claim', async () => {
  const root = await scratch('witch-coordination-presence-');
  const conversations = await StateStore.open(root);
  const files = await conversations.create(record('a', root));
  try {
    const store = await CoordinationStore.open(root);
    const held = await claim(store);
    const first: SessionPresence = {
      id: 'a',
      title: 'First',
      cwd: root,
      agent: 'codex',
      project: 'project-p',
      version: 1,
      activation: randomUUID(),
      process: (await identifyProcess(process.pid))!,
      phase: 'idle',
      requests: 0,
      familiars: 0,
      brews: 0,
      openedAt: 1,
      updatedAt: 2,
    };
    await store.publish(first);
    const next = {
      ...first,
      activation: randomUUID(),
      title: 'Second',
      updatedAt: 3,
    };
    await store.publish(next);
    await store.removePresence('a', first.activation);
    assert.deepEqual(await store.presences(), [next]);
    await store.removePresence('a', next.activation);
    assert.deepEqual(await store.presences(), []);
    assert.deepEqual(await store.claims(), [held]);
  } finally {
    await files.close();
  }
});
