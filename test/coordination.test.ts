import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants, promises as files } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { parseStatus } from '../src/core/repository.js';
import { presenceStatus } from '../src/core/coordination-state.js';
import { CoordinationStore } from '../src/persistence/coordination.js';
import { callControl } from '../src/persistence/control.js';
import { exclusiveLock } from '../src/persistence/lock.js';
import { coordinationFixture, git } from './fixtures/coordination.js';
import { record } from './fixtures/coordinator.js';
import { until, within } from './fixtures/within.js';

await test('clones expose current task metadata without themselves or another project, and token-only updates do not write presence', async (t) => {
  const { root, start, registry } = await coordinationFixture(t);
  const a = await start();
  const b = await start('B');
  await start('C');
  const title = a.coordinator.snapshot.conversation!.title;
  const first = await a.claim();
  assert.equal(first.kind, 'claimed');
  assert.equal(
    (await a.claim('task:shared', 'Changed summary')).kind,
    'claimed',
  );
  const peers = (await b.query()).peers;
  assert.deepEqual(
    peers.map(({ presence, claim }) => [
      presence.cwd,
      presence.agent,
      presence.title,
      claim?.summary,
    ]),
    [[join(root, 'A'), 'a', title, 'Changed summary']],
  );
  assert.deepEqual(
    (await a.query()).peers.map(({ presence }) => presence.cwd),
    [join(root, 'B')],
  );
  await delay(150);
  const before = await registry.presences();
  a.a.sessions.at(-1)!.options.onEvent({ type: 'usage', usage: { cost: 42 } });
  await delay(150);
  assert.deepEqual(await registry.presences(), before);
  const peerText = JSON.stringify(before);
  assert.ok(!peerText.includes('Changed summary'));
  assert.ok(!peerText.includes('"sessions"'));
  a.coordination.updateRepository(parseStatus('# branch.head feature-one'));
  await until('branch published', async () =>
    (await registry.presences()).some((p) => p.branch === 'feature-one'),
  );
  a.coordination.updateRepository(undefined);
  await until('failed repository read clears branch', async () =>
    (await registry.presences()).every((p) => p.branch === undefined),
  );
});

await test('waiting and idle background work stay visible and retain ownership through refusal, failure and interruption', async (t) => {
  const { start, ledger } = await coordinationFixture(t);
  const a = await start(),
    b = await start('B');
  await a.claim();
  const before = await ledger();
  const emit = a.a.sessions.at(-1)!.options.onEvent;
  emit({
    type: 'request',
    request: {
      id: 'q',
      kind: 'question',
      title: 'Choose',
      detail: 'Secret detail',
    },
  });
  await until(
    'waiting presence',
    async () =>
      presenceStatus((await b.query()).peers[0]!.presence) === 'waiting',
  );
  emit({ type: 'request-resolved', id: 'q' });
  emit({
    type: 'command',
    command: { id: 'brew', description: 'Work', status: 'running' },
  });
  await until(
    'background presence',
    async () =>
      presenceStatus((await b.query()).peers[0]!.presence) === 'background',
  );
  await assert.rejects(a.coordinator.releaseTask(), /familiars and brews/);
  emit({
    type: 'command',
    command: { id: 'brew', description: 'Work', status: 'completed' },
  });
  emit({
    type: 'subagent',
    subagent: { id: 'f', name: 'Worker', kind: 'review', status: 'running' },
  });
  await assert.rejects(a.coordinator.releaseTask(), /familiars and brews/);
  emit({
    type: 'subagent',
    subagent: { id: 'f', name: 'Worker', kind: 'review', status: 'completed' },
  });
  a.a.failNext = true;
  await a.coordinator.send('failed turn');
  assert.match(
    a.coordinator.snapshot.error ??
      a.coordinator.snapshot.items
        .map((i) => (i.kind === 'notice' ? i.text : ''))
        .join(),
    /Overloaded/,
  );
  assert.equal(await ledger(), before);
  a.a.interruptNext = true;
  await a.coordinator.send('interrupted turn');
  assert.equal(await ledger(), before);
});

await test('a live legacy owner blocks new work until its lock closes, and a reused identity is never treated as registered', async (t) => {
  const { root, start, store, registry } = await coordinationFixture(t);
  const a = await start();
  const legacy = await store.create(record(randomUUID(), join(root, 'B')));
  t.after(() => legacy.close());
  const snapshot = await a.query();
  assert.deepEqual(
    snapshot.unregistered.map((p) => p.id),
    [legacy.record.id],
  );
  const blocked = await a.claim();
  assert.equal(blocked.kind, 'error');
  assert.deepEqual(await registry.claims(), []);
  const own = (await registry.presences())[0]!;
  await registry.publish({
    ...own,
    id: legacy.record.id,
    cwd: legacy.record.cwd,
    process: { ...own.process, started: 'wrong start time' },
  });
  assert.deepEqual(
    (await a.query()).unregistered.map((p) => p.id),
    [legacy.record.id],
  );
  await legacy.close();
  assert.equal((await a.claim()).kind, 'claimed');
  assert.deepEqual((await a.query()).peers, []);
});

await test('closing a conversation releases its claim even if its stale presence says it runs', async (t) => {
  const { start, registry } = await coordinationFixture(t);
  const a = await start(),
    b = await start('B');
  const result = await a.claim();
  assert.equal(result.kind, 'claimed');
  const stale = (await registry.presences()).find(
    (p) => p.id === a.coordinator.snapshot.conversation!.id,
  )!;
  await a.coordinator.close();
  await registry.publish(stale);
  const snapshot = await b.query();
  assert.deepEqual(snapshot.peers, []);
  assert.deepEqual(snapshot.reservations, []);
  assert.equal((await b.claim()).kind, 'claimed');
});

await test('a failed presence removal cannot register a later legacy lock owner', async (t) => {
  const { start, store, registry } = await coordinationFixture(t);
  const a = await start(),
    b = await start('B');
  const old = await a.binding();
  const remove = CoordinationStore.prototype.removePresence;
  t.mock.method(
    CoordinationStore.prototype,
    'removePresence',
    function (this: CoordinationStore, id: string, activation: string) {
      return id === old.conversation
        ? Promise.reject(new Error('presence removal failed'))
        : remove.call(this, id, activation);
    },
  );
  await a.coordinator.newConversation();
  assert.ok(
    (await registry.presences()).some((p) => p.id === old.conversation),
  );
  assert.equal(await registry.isActive(old.activation), false);
  const legacy = await store.claim(old.conversation);
  try {
    assert.equal((await b.claim('task:other')).kind, 'error');
    const snapshot = await b.query();
    assert.deepEqual(
      snapshot.unregistered.map((p) => p.id),
      [old.conversation],
    );
    assert.ok(snapshot.peers.every((p) => p.presence.id !== old.conversation));
    assert.deepEqual(await registry.claims(), []);
  } finally {
    await legacy.close();
  }
  assert.equal((await b.claim('task:other')).kind, 'claimed');
});

await test('unknown discovery refuses both a successful query and new ownership', async (t) => {
  const { start, store, registry } = await coordinationFixture(t);
  const a = await start();
  const id = randomUUID();
  const directory = join(store.root, 'conversations', id);
  await files.mkdir(directory);
  await files.writeFile(join(directory, 'state.json'), '{broken');
  const bound = await a.binding();
  const query = await callControl(bound, { kind: 'peers' });
  assert.equal(query.kind, 'error');
  const attempt = await a.claim();
  assert.equal(attempt.kind, 'error');
  assert.deepEqual(await registry.claims(), []);
  assert.match(await a.coordination.context(), /Coordination is unavailable/);
});

await test('an origin change leaves a discoverable reservation in the original project until explicit release', async (t) => {
  const { root, start, ledger } = await coordinationFixture(t);
  const a = await start(),
    b = await start('B');
  const result = await a.claim();
  assert.equal(result.kind, 'claimed');
  if (result.kind !== 'claimed') assert.fail();
  const before = await ledger(),
    bound = await a.binding();
  await git(
    '-C',
    join(root, 'A'),
    'remote',
    'set-url',
    'origin',
    join(root, 'other'),
  );
  const refused = await a.claim('task:new', 'New project');
  assert.equal(refused.kind, 'error');
  assert.equal(await ledger(), before);
  assert.deepEqual((await a.query()).ownClaim, result.claim);
  const observer = await b.query();
  assert.deepEqual(observer.peers, []);
  assert.deepEqual(observer.reservations, [
    { claim: result.claim, status: 'owner-outside-project' },
  ]);
  assert.equal(
    (await callControl(bound, { kind: 'release', claim: result.claim.id }))
      .kind,
    'released',
  );
  const next = await a.claim('task:new');
  assert.equal(next.kind, 'claimed');
  if (next.kind !== 'claimed') assert.fail();
  assert.notEqual(next.claim.owner.project, result.claim.owner.project);
  assert.equal(
    (await callControl(bound, { kind: 'release', claim: result.claim.id }))
      .kind,
    'released',
  );
  assert.deepEqual((await a.query()).ownClaim, next.claim);
});

await test('closing rejects a mutation waiting for the ledger and drains one already committing', async (t) => {
  const { start, store, registry } = await coordinationFixture(t);
  const a = await start();
  const bound = await a.binding();
  const lock = await files.open(
    join(store.root, 'coordination', 'lock'),
    constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | exclusiveLock,
    0o600,
  );
  t.after(() => lock.close());
  const attempt = a.claim();
  await until('request waiting on lock', async () =>
    (await files.readdir(join(bound.directory, 'inbox'))).some((f) =>
      f.endsWith('.json'),
    ),
  );
  await delay(300);
  const closing = a.coordinator.close();
  await lock.close();
  assert.equal((await attempt).kind, 'error');
  await within(closing, 5000, 'close');
  assert.deepEqual(await registry.claims(), []);
  const b = await start('B');
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const rename = files.rename;
  t.mock.method(
    files,
    'rename',
    async (...args: Parameters<typeof files.rename>) => {
      if (String(args[1]).endsWith('/coordination/claims.json')) {
        entered.resolve();
        await finish.promise;
      }
      return rename(...args);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    finish.resolve();
  });
  const committing = b.claim();
  await within(entered.promise, 5000, 'commit boundary');
  let closed = false;
  const draining = b.coordinator.close().then(() => {
    closed = true;
  });
  await delay(50);
  assert.equal(closed, false);
  finish.resolve();
  assert.equal((await committing).kind, 'claimed');
  await within(draining, 5000, 'commit drain');
  assert.deepEqual(await registry.claims(), []);
  assert.deepEqual(await registry.presences(), []);
});

await test('a delayed presence writer drains before replacement activation publishes', async (t) => {
  const { start, registry } = await coordinationFixture(t);
  const a = await start();
  const bound = await a.binding();
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const publish = CoordinationStore.prototype.publish;
  let held = false;
  t.mock.method(
    CoordinationStore.prototype,
    'publish',
    async function (
      this: CoordinationStore,
      presence: Parameters<typeof publish>[0],
    ) {
      if (!held && presence.activation === bound.activation) {
        held = true;
        entered.resolve();
        await finish.promise;
      }
      return publish.call(this, presence);
    },
  );
  t.after(() => finish.resolve());
  a.a.sessions.at(-1)!.options.onEvent({
    type: 'request',
    request: { id: 'q', kind: 'approval', title: 'Wait', detail: '' },
  });
  await within(entered.promise, 3000, 'delayed presence write');
  const switching = a.coordinator.newConversation();
  await delay(50);
  assert.equal((await callControl(bound, { kind: 'peers' })).kind, 'error');
  finish.resolve();
  await switching;
  const next = await a.binding();
  assert.notEqual(next.activation, bound.activation);
  assert.deepEqual(
    (await registry.presences()).map((p) => p.activation),
    [next.activation],
  );
  await a.coordinator.close();
  await delay(150);
  assert.deepEqual(await registry.presences(), []);
});
