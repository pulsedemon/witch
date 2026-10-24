import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { constants, promises as files } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { parseStatus } from '../src/core/repository.js';
import { presenceStatus } from '../src/core/coordination-state.js';
import type {
  TaskClaim,
  SelectionTicket,
} from '../src/core/coordination-state.js';
import { CoordinationStore } from '../src/persistence/coordination.js';
import { callControl } from '../src/persistence/control.js';
import { exclusiveLock } from '../src/persistence/lock.js';
import { ConversationStore } from '../src/persistence/store.js';
import { identifyProcess } from '../src/persistence/process.js';
import {
  coordinationFixture,
  git,
  legacyLock,
  measureControl,
  pauseDiscovery,
} from './fixtures/coordination.js';
import { record } from './fixtures/coordinator.js';
import { selectionTurn } from './fixtures/task-selection.js';
import { until, within } from './fixtures/within.js';
import { countProbes } from './fixtures/probes.js';

await test('discovery batches conversation ownership and keeps only open peers', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { root, start, store } = await coordinationFixture(t);
  t.after(() => t.mock.timers.reset());
  const a = await start('A'),
    b = await start('B');
  for (const id of ['closed-a', 'closed-b'])
    await (await store.create(record(id, join(root, 'A')))).close();
  const own = a.coordinator.snapshot.conversation!.id;
  const peer = b.coordinator.snapshot.conversation!.id;
  const batch = t.mock.method(store, 'openConversations');
  const reading = t.mock.method(files, 'readFile');
  syncBuiltinESMExports();
  try {
    await a.coordination.context();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(batch.mock.callCount(), 1);
  const call = batch.mock.calls[0]!;
  assert.deepEqual(
    reading.mock.calls
      .map(({ arguments: [path] }) => path)
      .filter(
        (path) => typeof path === 'string' && path.endsWith('/state.json'),
      )
      .sort(),
    [own, peer]
      .map((id) => join(store.root, 'conversations', id, 'state.json'))
      .sort(),
  );
  assert.deepEqual(
    await call.result,
    new Map([
      [own, { coordinated: true }],
      [peer, { coordinated: true }],
    ]),
  );
  assert.deepEqual(
    a.coordination.snapshot.peers.map(({ presence }) => presence.id),
    [peer],
  );
  assert.deepEqual(a.coordination.snapshot.unregistered, []);
});

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
  a.a.sessions
    .at(-1)!
    .options.onEvent({ type: 'usage', usage: { context: 42 } });
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

for (const assignmentFails of [false, true]) {
  await test(`a granted claim survives final cleanup failure ${assignmentFails ? 'with an assignment warning' : 'after successful assignment'}`, async (t) => {
    let pending: Promise<void> | undefined;
    const { start, registry } = await coordinationFixture(t, async () => {
      pending = owner.coordination.endTurn().catch(() => {});
      if (assignmentFails) throw new Error('Injected assignment failure');
    });
    const owner = await start(),
      contender = await start('B');
    const turn = await selectionTurn(t, owner);
    const cancelling = t.mock.method(
      CoordinationStore.prototype,
      'cancelSelection',
      async () => {
        throw new Error('Injected selection cleanup failure');
      },
    );
    try {
      const reference = 'https://github.com/acme/queue/issues/17';
      const result = await owner.claim(reference);
      if (result.kind !== 'claimed') assert.fail(JSON.stringify(result));
      assert.deepEqual(await registry.claims(), [result.claim]);
      assert.deepEqual(owner.coordination.snapshot.ownClaim, result.claim);
      assert.equal(
        owner.coordination.snapshot.error,
        'Injected selection cleanup failure',
      );
      if (assignmentFails) {
        assert.match(result.warning ?? '', /GitHub assignment failed/);
        assert.match(result.warning ?? '', /Injected assignment failure/);
      } else assert.equal(result.warning, undefined);
      const duplicate = await contender.claim(reference);
      if (duplicate.kind !== 'conflict') assert.fail(JSON.stringify(duplicate));
      assert.deepEqual(duplicate.claim, result.claim);
      cancelling.mock.restore();
      await pending;
      await owner.coordination.context();
      assert.equal(owner.coordination.snapshot.error, undefined);
      assert.deepEqual(owner.coordination.snapshot.ownClaim, result.claim);
      assert.deepEqual(await registry.claims(), [result.claim]);
    } finally {
      cancelling.mock.restore();
      await pending;
      await turn.finish();
    }
  });
}

await test('pre-claim cleanup failure still refuses new ownership', async (t) => {
  let assignments = 0;
  const { start, registry } = await coordinationFixture(t, async () => {
    assignments++;
  });
  const owner = await start();
  const turn = await selectionTurn(t, owner);
  const cancelling = t.mock.method(
    CoordinationStore.prototype,
    'cancelSelection',
    async () => {
      throw new Error('Injected selection cleanup failure');
    },
  );
  try {
    await assert.rejects(owner.coordination.endTurn(), /cleanup failure/);
    const result = await owner.claim('https://github.com/acme/queue/issues/17');
    if (result.kind !== 'error') assert.fail(JSON.stringify(result));
    assert.equal(result.message, 'Injected selection cleanup failure');
    assert.deepEqual(await registry.claims(), []);
    assert.equal(assignments, 0);
  } finally {
    cancelling.mock.restore();
    await turn.finish();
  }
});

for (const failures of [1, 2]) {
  await test(`presence publication recovers after ${failures} failed ${failures === 1 ? 'write' : 'writes'} without another state update`, async (t) => {
    const { start, registry } = await coordinationFixture(t);
    const a = await start(),
      b = await start('B');
    const bound = await a.binding();
    await until('initial idle presence', async () =>
      (await registry.presences()).some(
        (p) => p.activation === bound.activation && p.phase === 'idle',
      ),
    );
    const publish = CoordinationStore.prototype.publish;
    let attempts = 0;
    const publication = t.mock.method(
      CoordinationStore.prototype,
      'publish',
      async function (
        this: CoordinationStore,
        presence: Parameters<typeof publish>[0],
      ) {
        if (presence.activation === bound.activation && ++attempts <= failures)
          throw new Error('Temporary presence write failure');
        return publish.call(this, presence);
      },
    );
    const failed = Promise.withResolvers<void>(),
      recovered = Promise.withResolvers<void>();
    const unsubscribe = a.coordination.subscribe(() => {
      if (a.coordination.snapshot.error?.includes('Temporary presence'))
        failed.resolve();
      else if (attempts > failures) recovered.resolve();
    });
    try {
      a.a.sessions.at(-1)!.options.onEvent({
        type: 'request',
        request: { id: 'q', kind: 'approval', title: 'Wait', detail: '' },
      });
      await within(failed.promise, 3000, 'presence write failure');
      await within(recovered.promise, 7000, 'automatic presence recovery');
      assert.equal(a.coordination.snapshot.error, undefined);
      assert.equal(attempts, failures + 1);
      const peer = (await b.query()).peers.find(
        ({ presence }) => presence.id === bound.conversation,
      );
      assert.equal(peer?.presence.requests, 1);
      const result = await a.claim();
      if (result.kind !== 'claimed') assert.fail(JSON.stringify(result));
      assert.deepEqual(await registry.claims(), [result.claim]);

      const before = await registry.presences();
      a.a.sessions
        .at(-1)!
        .options.onEvent({ type: 'usage', usage: { context: 42 } });
      await delay(2100);
      assert.equal(attempts, failures + 1);
      assert.deepEqual(await registry.presences(), before);
    } finally {
      unsubscribe();
      publication.mock.restore();
      if (a.coordination.snapshot.error) {
        a.coordination.updateRepository(parseStatus('# branch.head cleanup'));
        await until(
          'cleanup presence write',
          () => !a.coordination.snapshot.error,
        );
      }
    }
  });
}

await test('a slow presence retry preserves newer state without accumulating retries', async (t) => {
  const { start, registry } = await coordinationFixture(t);
  const a = await start(),
    b = await start('B');
  const bound = await a.binding();
  await until('initial idle presence', async () =>
    (await registry.presences()).some(
      (p) => p.activation === bound.activation && p.phase === 'idle',
    ),
  );
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    latest = Promise.withResolvers<void>();
  const publish = CoordinationStore.prototype.publish;
  const requests: number[] = [];
  let inFlight = 0,
    peak = 0;
  const publication = t.mock.method(
    CoordinationStore.prototype,
    'publish',
    async function (
      this: CoordinationStore,
      presence: Parameters<typeof publish>[0],
    ) {
      if (presence.activation !== bound.activation)
        return publish.call(this, presence);
      requests.push(presence.requests);
      if (requests.length === 1)
        throw new Error('Temporary presence write failure');
      peak = Math.max(peak, ++inFlight);
      try {
        if (requests.length === 2) {
          entered.resolve();
          await release.promise;
        }
        await publish.call(this, presence);
        if (presence.requests === 2) latest.resolve();
      } finally {
        inFlight--;
      }
    },
  );
  try {
    const emit = a.a.sessions.at(-1)!.options.onEvent;
    emit({
      type: 'request',
      request: { id: 'first', kind: 'approval', title: 'First', detail: '' },
    });
    await within(entered.promise, 5000, 'presence retry');
    await delay(4100);
    assert.deepEqual(requests, [1, 1]);
    const query = await within(
      callControl(bound, { kind: 'peers' }),
      3000,
      'control reply during a slow presence write',
    );
    assert.equal(query.kind, 'error');
    emit({
      type: 'request',
      request: { id: 'second', kind: 'approval', title: 'Second', detail: '' },
    });
    await delay(150);
    release.resolve();
    await within(latest.promise, 3000, 'newer presence write');
    await delay(2100);
    const peer = (await b.query()).peers.find(
      ({ presence }) => presence.id === bound.conversation,
    );
    assert.equal(peer?.presence.requests, 2);
    assert.equal(
      (await registry.presences()).find(
        (p) => p.activation === bound.activation,
      )?.requests,
      2,
    );
    assert.equal(peak, 1);
    assert.deepEqual(requests, [1, 1, 2]);
    assert.equal(a.coordination.snapshot.error, undefined);
  } finally {
    release.resolve();
    publication.mock.restore();
    if (a.coordination.snapshot.error) {
      a.coordination.updateRepository(parseStatus('# branch.head cleanup'));
      await until(
        'cleanup presence write',
        () => !a.coordination.snapshot.error,
      );
    }
  }
});

for (const action of ['switch', 'close'] as const) {
  await test(`a presence retry cannot republish an activation after ${action}`, async (t) => {
    const { start, registry } = await coordinationFixture(t);
    const a = await start();
    const bound = await a.binding();
    await until('initial idle presence', async () =>
      (await registry.presences()).some(
        (p) => p.activation === bound.activation && p.phase === 'idle',
      ),
    );
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const publish = CoordinationStore.prototype.publish;
    let attempts = 0;
    const publication = t.mock.method(
      CoordinationStore.prototype,
      'publish',
      async function (
        this: CoordinationStore,
        presence: Parameters<typeof publish>[0],
      ) {
        if (presence.activation === bound.activation) {
          attempts++;
          if (attempts === 1)
            throw new Error('Temporary presence write failure');
          if (attempts === 2) {
            entered.resolve();
            await release.promise;
          }
        }
        return publish.call(this, presence);
      },
    );
    let transitioning: Promise<void> | undefined;
    try {
      a.a.sessions.at(-1)!.options.onEvent({
        type: 'request',
        request: { id: 'q', kind: 'approval', title: 'Wait', detail: '' },
      });
      await within(entered.promise, 5000, 'presence retry');
      let finished = false;
      transitioning = (
        action === 'switch'
          ? a.coordinator.newConversation()
          : a.coordinator.close()
      ).then(() => {
        finished = true;
      });
      assert.equal((await callControl(bound, { kind: 'peers' })).kind, 'error');
      assert.equal(finished, false);
      release.resolve();
      await within(transitioning, 5000, 'activation retirement');
      const retiredAttempts = attempts;
      const next = action === 'switch' ? await a.binding() : undefined;
      await delay(2100);
      assert.equal(attempts, retiredAttempts);
      assert.equal(
        (await registry.activeActivations([bound.activation])).has(
          bound.activation,
        ),
        false,
      );
      assert.deepEqual(
        (await registry.presences()).map((p) => p.activation),
        next ? [next.activation] : [],
      );
      if (next) assert.notEqual(next.activation, bound.activation);
    } finally {
      release.resolve();
      publication.mock.restore();
      await transitioning?.catch(() => {});
      if (
        a.coordinator.snapshot.phase !== 'closing' &&
        a.coordination.snapshot.error
      ) {
        a.coordination.updateRepository(parseStatus('# branch.head cleanup'));
        await until(
          'cleanup presence write',
          () => !a.coordination.snapshot.error,
        );
      }
    }
  });
}

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
  // select-next refuses while the legacy lock is held, so the ticket comes first
  const choosing = await selectionTurn(t, a);
  const { ticket } = await choosing.select();
  const legacy = record(randomUUID(), join(root, 'B'));
  await (await store.create(legacy)).close();
  const lock = await legacyLock(store, legacy.id);
  t.after(() => lock.close());
  const snapshot = await a.query();
  assert.deepEqual(
    snapshot.unregistered.map((p) => p.id),
    [legacy.id],
  );
  const waiting = await callControl(choosing.binding, {
    kind: 'selection-status',
    selection: ticket.id,
  });
  if (waiting.kind !== 'error') assert.fail(JSON.stringify(waiting));
  assert.match(waiting.message, /unregistered/);
  const blocked = await a.claim();
  assert.equal(blocked.kind, 'error');
  assert.deepEqual(await registry.claims(), []);
  const own = (await registry.presences())[0]!;
  await registry.publish({
    ...own,
    id: legacy.id,
    cwd: legacy.cwd,
    process: { ...own.process, started: 'wrong start time' },
  });
  assert.deepEqual(
    (await a.query()).unregistered.map((p) => p.id),
    [legacy.id],
  );
  await lock.close();
  assert.equal((await a.claim()).kind, 'claimed');
  assert.deepEqual((await a.query()).peers, []);
});

for (const name of ['B', 'C']) {
  await test(`a missing directory in ${name === 'B' ? 'the same' : 'another'} project preserves claims without blocking discovery or selection`, async (t) => {
    const { root, start, store, memory, registry } =
      await coordinationFixture(t);
    const a = await start();
    const choosing = await selectionTurn(t, a);
    const cwd = join(root, name);
    const { project } = await memory.scopePaths(cwd);
    const legacy = record(randomUUID(), cwd);
    await (await store.create(legacy)).close();
    const lock = await legacyLock(store, legacy.id);
    t.after(() => lock.close());
    const reference = 'https://github.com/acme/queue/issues/17';
    const held = await registry.claim(
      { conversation: legacy.id, project },
      { reference, summary: 'Existing task' },
      (await registry.presences())[0]!.process,
      Date.now() + 1000,
      async () => {},
    );
    await files.rename(cwd, `${cwd}-moved`);

    const snapshot = await a.query();
    assert.deepEqual(snapshot.unregistered, []);
    assert.deepEqual(
      snapshot.reservations,
      name === 'B' ? [{ claim: held, status: 'unknown' }] : [],
    );
    const duplicate = await a.claim(reference);
    if (duplicate.kind !== 'conflict') assert.fail(JSON.stringify(duplicate));
    assert.deepEqual(duplicate.claim, held);
    const available = await a.claim('task:available');
    if (available.kind !== 'claimed') assert.fail(JSON.stringify(available));
    assert.deepEqual(await registry.claims(), [held, available.claim]);
    const released = await callControl(choosing.binding, {
      kind: 'release',
      claim: available.claim.id,
    });
    assert.equal(released.kind, 'released');
    const selection = await choosing.select();
    assert.equal(selection.position, 1);
    assert.deepEqual((await registry.state()).selections, [selection.ticket]);
    assert.deepEqual(await registry.claims(), [held]);
    assert.equal(await store.isOpen(legacy.id), true);
  });
}

for (const failure of [
  { code: 'EACCES', syscall: 'realpath' },
  { code: 'ENOENT', syscall: 'spawn git' },
]) {
  await test(`${failure.code} from ${failure.syscall} still blocks discovery and new ownership`, async (t) => {
    const { root, start, store, memory, registry } =
      await coordinationFixture(t);
    const a = await start();
    const choosing = await selectionTurn(t, a);
    const cwd = join(root, 'B');
    const legacy = record(randomUUID(), cwd);
    await (await store.create(legacy)).close();
    const lock = await legacyLock(store, legacy.id);
    t.after(() => lock.close());
    const scopePaths = memory.scopePaths.bind(memory);
    const error = Object.assign(new Error('Cannot determine project'), failure);
    t.mock.method(memory, 'scopePaths', (directory: string) =>
      directory === cwd ? Promise.reject(error) : scopePaths(directory),
    );

    const query = await callControl(await a.binding(), { kind: 'peers' });
    assert.equal(query.kind, 'error');
    if (query.kind === 'error')
      assert.match(query.message, /Cannot determine project/);
    assert.equal((await a.claim()).kind, 'error');
    const selection = await callControl(choosing.binding, {
      kind: 'select-next',
      turn: choosing.turn,
    });
    assert.equal(selection.kind, 'error');
    assert.deepEqual(await registry.state(), { claims: [], selections: [] });
  });
}

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
  assert.equal(
    (await registry.activeActivations([old.activation])).has(old.activation),
    false,
  );
  const legacy = await legacyLock(store, old.conversation);
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

for (const window of ['opening', 'closing', 'reconnecting'] as const) {
  await test(`a peer ${window} a conversation neither refuses a claim nor ends a selection wait`, async (t) => {
    const { start, store, registry } = await coordinationFixture(t);
    const a = await start(),
      b = await start('B');
    const choosing = await selectionTurn(t, a);
    const { ticket } = await choosing.select();
    const id = b.coordinator.snapshot.conversation!.id;
    const gate = Promise.withResolvers<void>();
    let pending: Promise<void>;
    if (window !== 'closing') {
      const activate = b.coordination.activate.bind(b.coordination);
      t.mock.method(
        b.coordination,
        'activate',
        async (...args: Parameters<typeof activate>) => {
          await gate.promise;
          return activate(...args);
        },
      );
      pending =
        window === 'opening'
          ? b.coordinator.newConversation()
          : b.coordinator.selectModel({ agent: 'b', id: 'b-model' });
    } else {
      const close = ConversationStore.prototype.close;
      t.mock.method(
        ConversationStore.prototype,
        'close',
        async function (this: ConversationStore) {
          if (this.record.id === id) await gate.promise;
          return close.call(this);
        },
      );
      pending = b.coordinator.close();
    }
    // the fixture's teardown would close B while it waits on the gate
    try {
      // opening holds a new conversation; closing and reconnecting keep the original
      const held = () => b.coordinator.snapshot.conversation!.id;
      await until('B holding a conversation without presence', async () => {
        const presences = await registry.presences();
        return (
          (window !== 'opening' || held() !== id) &&
          presences.every((p) => p.id !== id && p.id !== held())
        );
      });
      assert.equal(await store.isOpen(held()), true);
      assert.deepEqual((await a.query()).unregistered, []);
      const waiting = await callControl(choosing.binding, {
        kind: 'selection-status',
        selection: ticket.id,
      });
      assert.equal(waiting.kind, 'selection', JSON.stringify(waiting));
      assert.equal((await a.claim(`task:${window}`)).kind, 'claimed');
    } finally {
      gate.resolve();
      await pending;
    }
  });
}

await test('unknown discovery refuses both a successful query and new ownership', async (t) => {
  pauseDiscovery(t);
  const { start, store, registry } = await coordinationFixture(t);
  const a = await start();
  const id = randomUUID();
  const directory = join(store.root, 'conversations', id);
  const held = await store.create(
    record(id, a.coordinator.snapshot.conversation!.cwd),
  );
  t.after(() => held.close());
  await files.writeFile(join(directory, 'state.json'), '{broken');
  const bound = await a.binding();
  const query = await measureControl(t, () =>
    callControl(bound, { kind: 'peers' }),
  );
  assert.equal(query.value.kind, 'error');
  assert.equal(query.discoveries, 1);
  const attempt = await measureControl(t, () => a.claim());
  assert.equal(attempt.value.kind, 'error');
  assert.equal(attempt.discoveries, 1);
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

for (const size of [1, 8])
  await test(
    'discovery probe counts stay bounded with ' + size + ' owner groups',
    async (t) => {
      t.mock.timers.enable({ apis: ['setInterval'] });
      const { root, start, store, registry } = await coordinationFixture(t);
      t.after(() => t.mock.timers.reset());
      const a = await start();
      const own = (await registry.presences())[0]!;
      const claims: TaskClaim[] = [],
        tickets: SelectionTicket[] = [];
      const expectedPeers: string[] = [],
        legacyClaims: TaskClaim[] = [];
      const expectedOpenStatePaths = new Set([
        join(store.root, 'conversations', own.id, 'state.json'),
      ]);
      for (let index = 0; index < size; index++) {
        const child = spawn('/bin/sleep', ['60']);
        const ended = once(child, 'close');
        t.after(async () => {
          child.kill();
          await ended;
        });
        await once(child, 'spawn');
        const identity = (await identifyProcess(child.pid!))!;
        for (const duplicate of [false, true]) {
          const id = 'peer-' + index + '-' + duplicate;
          const held = await store.create(record(id, join(root, 'B')));
          t.after(() => held.close());
          expectedOpenStatePaths.add(join(held.directory, 'state.json'));
          const activation = randomUUID();
          const release = await registry.holdActivation(activation);
          t.after(release);
          await registry.publish({
            ...own,
            id,
            title: id,
            cwd: join(root, 'B'),
            activation,
            process: identity,
            openedAt: index * 2 + Number(duplicate),
          });
          expectedPeers.push(id);
          claims.push({
            id: randomUUID(),
            owner: { conversation: id, project: own.project },
            references: ['named:' + own.project + ':' + id],
            summary: id,
            createdAt: index,
            process: identity,
          });
          tickets.push({
            id: randomUUID(),
            owner: { conversation: id, project: own.project },
            activation,
            turn: randomUUID(),
          });
        }
        const id = 'legacy-' + index;
        const held = await store.create(record(id, join(root, 'B')));
        t.after(() => held.close());
        expectedOpenStatePaths.add(join(held.directory, 'state.json'));
        const legacy = {
          id: randomUUID(),
          owner: { conversation: id, project: own.project },
          references: ['named:' + own.project + ':' + id],
          summary: id,
          createdAt: index,
        };
        claims.push(legacy);
        legacyClaims.push(legacy);
        tickets.push({
          id: randomUUID(),
          owner: { conversation: 'released-' + index, project: own.project },
          activation: randomUUID(),
          turn: randomUUID(),
        });
      }
      for (let index = 0; index < (size === 1 ? 1 : 100); index++)
        await (
          await store.create(record('closed-' + index, join(root, 'B')))
        ).close();
      await files.writeFile(
        join(store.root, 'coordination', 'claims.json'),
        JSON.stringify({ version: 2, claims, selections: tickets }),
      );
      const readStatePaths: string[] = [];
      const read = files.readFile;
      t.mock.method(
        files,
        'readFile',
        (...args: Parameters<typeof files.readFile>) => {
          if (
            typeof args[0] === 'string' &&
            args[0].startsWith(store.root) &&
            args[0].endsWith('/state.json')
          )
            readStatePaths.push(args[0]);
          return read(...args);
        },
      );
      syncBuiltinESMExports();
      const probes = await countProbes(() => a.coordination.context()).finally(
        () => {
          t.mock.restoreAll();
          syncBuiltinESMExports();
        },
      );
      assert.deepEqual(
        a.coordination.snapshot.peers.map(({ presence }) => presence.id),
        expectedPeers,
      );
      assert.deepEqual(
        a.coordination.snapshot.peers.map(({ claim }) => claim),
        claims.filter((c) => c.process),
      );
      assert.deepEqual(
        a.coordination.snapshot.reservations,
        legacyClaims.map((claim) => ({ claim, status: 'unknown' })),
      );
      assert.deepEqual(
        a.coordination.snapshot.peers.map(({ selection }) => selection?.ticket),
        tickets.filter(
          (ticket) => !ticket.owner.conversation.startsWith('released-'),
        ),
      );
      assert.ok(probes.ps <= 3, probes.ps + ' process probes');
      assert.ok(probes.perl <= 6, probes.perl + ' lock probes');
      assert.deepEqual(new Set(readStatePaths), expectedOpenStatePaths);
      assert.equal(readStatePaths.length, expectedOpenStatePaths.size);
    },
  );

for (const damage of ['JSON', 'EACCES'])
  for (const locked of [false, true])
    for (const action of ['claim', 'select-next', 'recommend'])
      await test(
        action +
          ' with ' +
          (locked ? 'open' : 'closed') +
          ' ' +
          damage +
          ' record',
        async (t) => {
          const { start, store, root, ledger, registry } =
            await coordinationFixture(t);
          const a = await start();
          await files.writeFile(
            join(store.root, 'coordination', 'claims.json'),
            JSON.stringify({ version: 2, claims: [], selections: [] }),
          );
          const choosing =
            action === 'claim' ? undefined : await selectionTurn(t, a);
          const selection =
            action === 'recommend' ? await choosing!.select() : undefined;
          const id = randomUUID();
          const held = await store.create(record(id, join(root, 'B')));
          t.after(() => held.close());
          if (!locked) await held.close();
          const path = join(held.directory, 'state.json');
          if (damage === 'JSON') await files.writeFile(path, '{broken');
          else {
            await files.chmod(path, 0);
            t.after(() => files.chmod(path, 0o600));
          }
          await files.writeFile(
            join(store.root, 'conversations', '.DS_Store'),
            'finder',
          );
          const before = await ledger();
          const result =
            action === 'claim'
              ? await a.claim('task:admission')
              : await callControl(
                  choosing!.binding,
                  action === 'select-next'
                    ? { kind: 'select-next', turn: choosing!.turn }
                    : {
                        kind: 'recommend',
                        selection: selection!.ticket.id,
                        input: {
                          reference: 'task:admission',
                          summary: 'Admission',
                        },
                      },
                );
          if (locked) {
            if (result.kind !== 'error') assert.fail(JSON.stringify(result));
            assert.match(result.message, /Cannot determine session ownership/);
            assert.ok(result.message.includes(id + '/state.json'));
            assert.equal(await ledger(), before);
          } else if (action === 'select-next') {
            if (result.kind !== 'selection')
              assert.fail(JSON.stringify(result));
            assert.equal(result.selection.position, 1);
            assert.equal(
              result.selection.ticket.owner.conversation,
              a.coordinator.snapshot.conversation!.id,
            );
            assert.deepEqual((await registry.state()).selections, [
              result.selection.ticket,
            ]);
          } else {
            if (result.kind !== 'claimed') assert.fail(JSON.stringify(result));
            assert.equal(
              result.claim.owner.conversation,
              a.coordinator.snapshot.conversation!.id,
            );
            assert.deepEqual((await registry.state()).claims, [result.claim]);
            assert.deepEqual((await registry.state()).selections, []);
          }
        },
      );
