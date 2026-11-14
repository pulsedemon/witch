import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import type {
  SelectionScope,
  SelectionState,
  TaskClaim,
} from '../src/core/coordination-state.js';
import {
  ClaimConflict,
  CoordinationStore,
} from '../src/persistence/coordination.js';
import { identifyProcess } from '../src/persistence/process.js';
import { StateStore } from '../src/persistence/store.js';
import { record } from './fixtures/coordinator.js';
import { scratch } from './fixtures/scratch.js';
import { within } from './fixtures/within.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import type { RegisterCleanup } from './fixtures/cleanup.js';

const verify = async () => {};

const deadline = () => Date.now() + 5000;

const input = (number: number) => ({
  reference: `https://github.com/acme/queue/issues/${number}`,
  summary: `Issue ${number}`,
});

async function fixture(register: RegisterCleanup) {
  const root = await scratch('witch-selection-');

  const store = await CoordinationStore.open(await StateStore.open(root));

  const identity = (await identifyProcess(process.pid))!;

  const scope = async (conversation: string, project = 'project-p') => {
    const value = {
      owner: { conversation, project },
      activation: randomUUID(),
      turn: randomUUID(),
    };

    const release = await store.holdActivation(value.activation);

    register(release);

    return value;
  };

  return {
    store,
    root,
    identity,
    scope,
    file: join(root, 'coordination', 'claims.json'),
    begin: (scope: SelectionScope) =>
      store.beginSelection(scope, deadline(), verify),
    recommend: (scope: SelectionScope, id: string, number: number) =>
      store.recommend(scope, id, input(number), identity, deadline(), verify),
    claim: (scope: SelectionScope, number: number) =>
      store.claim(scope.owner, input(number), identity, deadline(), verify),
  };
}

function contender(register: RegisterCleanup, root: string, name: string) {
  const child = fork(
    new URL('fixtures/task-selector.mts', import.meta.url),
    [root, name],
    {
      cwd: root,
      execArgv: ['--import', import.meta.resolve('tsx')],
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );

  const exited = once(child, 'exit');

  register(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');

    await exited;
  });

  return {
    ready: within(once(child, 'message'), 5000, 'selector ready'),
    async call(kind: string, issue?: number) {
      const response = within(
        once(child, 'message'),
        5000,
        'selector response',
      );

      child.send({ kind, issue });

      const [message] = (await response) as [
        { value?: SelectionState | TaskClaim; error?: string },
      ];

      assert.equal(message.error, undefined);

      return message.value!;
    },
    async stop() {
      child.kill('SIGKILL');

      await exited;
    },
  };
}

test('three processes advance in enqueue order and reserve distinct tasks', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const f = await fixture(cleanup);

  const a = contender(cleanup, f.root, 'A');

  const b = contender(cleanup, f.root, 'B');

  const c = contender(cleanup, f.root, 'C');

  await Promise.all([a.ready, b.ready, c.ready]);

  const states = [
    await a.call('begin'),
    await b.call('begin'),
    await c.call('begin'),
  ] as SelectionState[];

  assert.deepEqual(
    states.map((state) => state.position),
    [1, 2, 3],
  );

  assert.deepEqual(await a.call('begin'), states[0]);

  for (const [client, position] of [
    [b, 2],
    [c, 3],
    [c, 3],
    [b, 2],
  ] as const)
    assert.equal(
      ((await client.call('status')) as SelectionState).position,
      position,
    );

  const first = await a.call('recommend', 17);

  assert.deepEqual(await a.call('recommend', 17), first);

  assert.equal(((await b.call('status')) as SelectionState).position, 1);

  await b.call('recommend', 18);

  assert.equal(((await c.call('status')) as SelectionState).position, 1);

  await c.call('recommend', 19);

  const state = await f.store.state();

  assert.deepEqual(
    state.claims.map((claim) => claim.references),
    [
      ['github:acme/queue#17'],
      ['github:acme/queue#18'],
      ['github:acme/queue#19'],
    ],
  );

  assert.deepEqual(
    state.claims.map((claim) => claim.owner.conversation),
    ['A', 'B', 'C'],
  );

  assert.deepEqual(state.selections, []);
});

test('a dead head advances the next process while other live claims remain', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const f = await fixture(cleanup);

  const a = contender(cleanup, f.root, 'A');

  const b = contender(cleanup, f.root, 'B');

  await Promise.all([a.ready, b.ready]);

  await a.call('begin');

  assert.equal(((await b.call('begin')) as SelectionState).position, 2);

  const active = await f.store.claim(
    { conversation: 'other-live', project: 'project-p' },
    input(90),
    f.identity,
    deadline(),
    verify,
  );

  await a.stop();

  assert.equal(((await b.call('status')) as SelectionState).position, 1);

  assert.deepEqual(await f.store.claims(), [active]);
});

test('a crashed active owner releases its task while another process keeps its claim', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const f = await fixture(cleanup);

  const a = contender(cleanup, f.root, 'A'),
    b = contender(cleanup, f.root, 'B');

  await Promise.all([a.ready, b.ready]);

  await a.call('claim', 90);

  const live = await b.call('claim', 91);

  assert.equal((await f.store.claims()).length, 2);

  await a.stop();

  assert.deepEqual(await f.store.claims(), [live]);

  const next = await f.scope('C');

  await f.claim(next, 90);

  assert.deepEqual(
    (await f.store.claims()).map((claim) => claim.references[0]),
    ['github:acme/queue#91', 'github:acme/queue#90'],
  );
});

test('non-head and alias-conflicting recommendations preserve every byte and ticket', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const f = await fixture(cleanup);

  const a = await f.scope('A'),
    b = await f.scope('B');

  const first = await f.begin(a),
    second = await f.begin(b);

  await f.store.claim(
    { conversation: 'other', project: 'project-q' },
    input(18),
    f.identity,
    deadline(),
    verify,
  );

  const before = await readFile(f.file, 'utf8');

  await assert.rejects(f.recommend(b, second.ticket.id, 17), /first position/);

  await assert.rejects(
    f.store.recommend(
      a,
      first.ticket.id,
      { ...input(17), aliases: [input(18).reference] },
      f.identity,
      deadline(),
      verify,
    ),
    ClaimConflict,
  );

  assert.equal(await readFile(f.file, 'utf8'), before);

  assert.deepEqual(
    (await f.store.state()).selections.map((ticket) => ticket.id),
    [first.ticket.id, second.ticket.id],
  );
});

test('separate projects choose independently and recommendation retries cannot revise ownership', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const f = await fixture(cleanup);

  const a = await f.scope('A'),
    b = await f.scope('B', 'project-q');

  await f.begin(a);

  const second = await f.begin(b);

  assert.equal(second.position, 1);

  const recommended = await f.recommend(b, second.ticket.id, 18);

  const before = await readFile(f.file, 'utf8');

  assert.deepEqual(await f.recommend(b, second.ticket.id, 18), recommended);

  await assert.rejects(f.recommend(b, second.ticket.id, 19), /does not match/);

  await assert.rejects(f.recommend(a, second.ticket.id, 18), /does not match/);

  await assert.rejects(
    f.store.recommend(
      b,
      second.ticket.id,
      input(18),
      { ...f.identity, started: 'other incarnation' },
      deadline(),
      verify,
    ),
    /does not match/,
  );

  assert.equal(await readFile(f.file, 'utf8'), before);
});

test('owner, activation and turn fence status, recommendation and cancellation', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const f = await fixture(cleanup);

  const a = await f.scope('A');

  const first = await f.begin(a);

  const before = await readFile(f.file, 'utf8');

  for (const wrong of [
    { ...a, owner: { ...a.owner, conversation: 'B' } },
    { ...a, owner: { ...a.owner, project: 'other' } },
    { ...a, activation: randomUUID() },
    { ...a, turn: randomUUID() },
  ]) {
    await assert.rejects(
      f.store.selection(wrong, first.ticket.id, deadline(), verify),
      /no longer current/,
    );

    await assert.rejects(
      f.recommend(wrong, first.ticket.id, 17),
      /no longer current/,
    );

    await assert.rejects(
      f.store.cancelSelection(wrong, first.ticket.id, deadline(), verify),
      /no longer current/,
    );
  }

  assert.equal(await readFile(f.file, 'utf8'), before);

  await f.store.cancelSelection(a, first.ticket.id, deadline(), verify);

  const next = await f.begin(a);

  await f.store.cancelSelection(a, first.ticket.id, deadline(), verify);

  assert.deepEqual((await f.store.state()).selections, [next.ticket]);

  await f.store.cancelSelection(a, undefined, deadline(), verify);

  const later = { ...a, turn: randomUUID() };

  const newest = await f.begin(later);

  await f.store.cancelSelection(a, undefined, deadline(), verify);

  assert.deepEqual((await f.store.state()).selections, [newest.ticket]);

  await assert.rejects(
    f.store.selection(a, first.ticket.id, deadline(), verify),
    /no longer current/,
  );
});

test('promotion keeps identity and aliases while different work replaces a suggestion', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const f = await fixture(cleanup);

  const a = await f.scope('A');

  const first = await f.begin(a);

  const suggestion = await f.store.recommend(
    a,
    first.ticket.id,
    { ...input(17), aliases: ['task:chosen'] },
    f.identity,
    deadline(),
    verify,
  );

  const promoted = await f.claim(a, 17);

  assert.equal(promoted.id, suggestion.id);

  assert.deepEqual(promoted.references, [
    'github:acme/queue#17',
    'task:project-p:chosen',
  ]);

  assert.equal(promoted.suggestion, undefined);

  await assert.rejects(f.begin(a), /Release the current task/);

  await f.store.releaseConversation(a.owner, f.identity, deadline(), verify);

  assert.deepEqual(await f.store.claims(), []);

  const second = await f.begin(a);

  const old = await f.recommend(a, second.ticket.id, 18);

  const replacement = await f.claim(a, 19);

  assert.notEqual(replacement.id, old.id);

  assert.deepEqual(await f.store.claims(), [replacement]);

  assert.equal(replacement.suggestion, undefined);
});

test('failed replacement preserves a suggestion and reselect releases it at the tail', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const f = await fixture(cleanup);

  const a = await f.scope('A'),
    b = await f.scope('B');

  const first = await f.begin(a);

  const suggestion = await f.recommend(a, first.ticket.id, 17);

  const second = await f.begin(b);

  await f.store.claim(
    { conversation: 'other', project: 'project-p' },
    input(18),
    f.identity,
    deadline(),
    verify,
  );

  const before = await readFile(f.file, 'utf8');

  await assert.rejects(f.claim(a, 18), ClaimConflict);

  assert.equal(await readFile(f.file, 'utf8'), before);

  assert.equal((await f.begin(a)).position, 2);

  assert.ok(
    !(await f.store.claims()).some((claim) => claim.id === suggestion.id),
  );

  assert.equal(
    (await f.store.selection(b, second.ticket.id, deadline(), verify)).position,
    1,
  );
});

test('only a successful direct claim removes its selection', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const f = await fixture(cleanup);

  const a = await f.scope('A'),
    b = await f.scope('B');

  const first = await f.begin(a);

  await f.claim(b, 18);

  await assert.rejects(f.claim(a, 18), ClaimConflict);

  assert.deepEqual((await f.store.state()).selections, [first.ticket]);

  const claim = await f.claim(a, 17);

  assert.equal(claim.suggestion, undefined);

  assert.deepEqual((await f.store.state()).selections, []);
});

for (const active of [false, true])
  test(`a ${active ? 'claim' : 'suggestion'} survives activation loss but not a different process incarnation`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);

    const f = await fixture(cleanup);

    const a = {
      owner: { conversation: 'A', project: 'project-p' },
      activation: randomUUID(),
      turn: randomUUID(),
    };

    const release = await f.store.holdActivation(a.activation);

    cleanup(release);

    const first = await f.begin(a);

    const reserved = await f.recommend(a, first.ticket.id, 17);

    const suggestion = active ? await f.claim(a, 17) : reserved;

    await release();

    assert.deepEqual(await f.store.claims(), [suggestion]);

    await f.store.releaseConversation(
      a.owner,
      { ...f.identity, started: 'wrong' },
      deadline(),
      verify,
    );

    assert.deepEqual(await f.store.claims(), [suggestion]);

    await f.store.releaseConversation(
      { ...a.owner, project: 'wrong' },
      f.identity,
      deadline(),
      verify,
    );

    assert.deepEqual(await f.store.claims(), [suggestion]);

    const bytes = JSON.parse(await readFile(f.file, 'utf8'));

    bytes.claims[0].process.started = 'previous incarnation';

    await writeFile(f.file, JSON.stringify(bytes));

    const before = await readFile(f.file, 'utf8');

    assert.deepEqual(await f.store.claims(), []);

    assert.equal(await readFile(f.file, 'utf8'), before);

    await f.claim(a, 18);

    assert.deepEqual(
      (await f.store.claims()).map((claim) => claim.references),
      [['github:acme/queue#18']],
    );
  });

test('deadline and unknown activation failures preserve the ledger', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const f = await fixture(cleanup);

  const a = await f.scope('A');

  const first = await f.begin(a);

  const before = await readFile(f.file, 'utf8');

  const expires = Date.now() + 1000;

  await assert.rejects(
    f.store.recommend(
      a,
      first.ticket.id,
      input(17),
      f.identity,
      expires,
      async () => {
        vi.spyOn(Date, 'now').mockImplementation(() => expires);
      },
    ),
    /expired/,
  );

  vi.restoreAllMocks();

  assert.equal(await readFile(f.file, 'utf8'), before);

  const lock = join(f.root, 'coordination', 'sessions', `${a.activation}.lock`);

  await chmod(lock, 0o000);

  try {
    await assert.rejects(f.store.state(), /EACCES/);

    await assert.rejects(f.recommend(a, first.ticket.id, 17), /EACCES/);

    assert.equal(await readFile(f.file, 'utf8'), before);
  } finally {
    await chmod(lock, 0o600);
  }
});

test('version one migrates only on a change and unsupported ledgers stay untouched', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const f = await fixture(cleanup);

  const conversations = await StateStore.open(f.root);

  const opened = await conversations.create(record('old', f.root));

  cleanup(() => opened.close());

  const old = {
    id: randomUUID(),
    owner: { conversation: 'old', project: 'project-p' },
    references: ['github:acme/queue#90'],
    summary: 'Existing work',
    createdAt: 1,
  };

  const original = JSON.stringify({ version: 1, claims: [old] });

  await writeFile(f.file, original);

  assert.deepEqual(await f.store.state(), { claims: [old], selections: [] });

  assert.equal(await readFile(f.file, 'utf8'), original);

  const a = await f.scope('A');

  const lock = join(f.root, 'conversations', 'old', 'lock');

  await chmod(lock, 0o000);

  try {
    await assert.rejects(f.store.state(), /EACCES/);

    await assert.rejects(f.begin(a), /EACCES/);

    assert.equal(await readFile(f.file, 'utf8'), original);
  } finally {
    await chmod(lock, 0o600);
  }

  await f.begin(a);

  const migrated = JSON.parse(await readFile(f.file, 'utf8'));

  assert.equal(migrated.version, 2);

  assert.deepEqual(migrated.claims, [old]);

  await opened.close();

  await writeFile(f.file, original);

  assert.deepEqual(await f.store.claims(), []);

  assert.equal(await readFile(f.file, 'utf8'), original);

  await f.claim(a, 90);

  assert.deepEqual(
    (await f.store.claims()).map((claim) => claim.owner),
    [a.owner],
  );

  for (const invalid of [
    '{"version":3,"claims":[],"selections":[]}',
    '{"version":2,"claims":[],"selections":[{}]}',
    '{',
  ]) {
    await writeFile(f.file, invalid);

    await assert.rejects(f.begin(a));

    assert.equal(await readFile(f.file, 'utf8'), invalid);
  }
});
