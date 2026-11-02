import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { constants, promises as files } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { TaskStatus } from '../src/agents/types.js';
import { parseStatus } from '../src/core/repository.js';
import { presenceStatus } from '../src/core/coordination-state.js';
import type {
  TaskClaim,
  SelectionTicket,
} from '../src/core/coordination-state.js';
import { CoordinationStore } from '../src/persistence/coordination.js';
import { callControl } from '../src/persistence/control.js';
import { openLocked } from '../src/persistence/lock.js';
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
import { orderedCleanup } from './fixtures/cleanup.js';

test('discovery batches conversation ownership and keeps only open peers', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const { root, start, store } = await coordinationFixture(cleanup);
  cleanup(() => {
    vi.useRealTimers();
  });
  const a = await start('A'),
    b = await start('B');
  for (const id of ['closed-a', 'closed-b'])
    await (await store.create(record(id, join(root, 'A')))).close();
  const own = a.coordinator.snapshot.conversation!.id;
  const peer = b.coordinator.snapshot.conversation!.id;
  const batch = vi.spyOn(store, 'openConversations');
  const reading = vi.spyOn(files, 'readFile');
  syncBuiltinESMExports();
  try {
    await a.coordination.context();
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  }
  // the ledger's reconcile shares this store and asks about no conversations here
  const lookups = batch.mock.calls.flatMap(([ids], index) =>
    ids === undefined || ids.length ? [batch.mock.results[index]!] : [],
  );
  assert.equal(lookups.length, 1);
  const call = lookups[0]!;
  assert.deepEqual(
    reading.mock.calls
      .map(([path]) => path)
      .filter(
        (path) => typeof path === 'string' && path.endsWith('/state.json'),
      )
      .sort(),
    [own, peer]
      .map((id) => join(store.root, 'conversations', id, 'state.json'))
      .sort(),
  );
  assert.deepEqual(
    await call.value,
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

test('idle discovery without peers probes only conversation ownership', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const { start } = await coordinationFixture(cleanup);
  cleanup(() => {
    vi.useRealTimers();
  });
  const a = await start('A');
  const { ps, perl } = await countProbes(() => a.coordination.context());
  assert.deepEqual({ ps, perl }, { ps: 0, perl: 1 });
});

test('clones expose current task metadata without themselves or another project, and token-only updates do not write presence', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { root, start, registry } = await coordinationFixture(cleanup);
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

test('in-place title, cwd and agent changes publish without a phase change', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { root, start, registry } = await coordinationFixture(cleanup);
  const { coordinator, coordination } = await start();
  const snapshot = coordinator.snapshot;
  const conversation = snapshot.conversation!;
  for (const [field, value] of [
    ['title', 'Changed title'],
    ['cwd', join(root, 'B')],
    ['agent', 'b'],
  ] as const) {
    conversation[field] = value;
    coordination.update(snapshot);
    await until(`published ${field}`, async () =>
      (await registry.presences()).some(
        (presence) =>
          presence.id === conversation.id && presence[field] === value,
      ),
    );
    const presence = (await registry.presences())[0]!;
    assert.equal(presence.phase, snapshot.phase);
    assert.ok(!('sessions' in presence));
    assert.ok(!('createdAt' in presence));
  }
});

for (const assignmentFails of [false, true]) {
  test(`a granted claim survives final cleanup failure ${assignmentFails ? 'with an assignment warning' : 'after successful assignment'}`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);
    let pending: Promise<void> | undefined;
    const { start, registry } = await coordinationFixture(
      cleanup,
      async (references) => {
        pending = owner.coordination.endTurn().catch(() => {});
        return assignmentFails
          ? { assigned: [], failure: 'Injected assignment failure' }
          : {
              assigned: references.filter((reference) =>
                reference.startsWith('github:'),
              ),
            };
      },
    );
    const owner = await start(),
      contender = await start('B');
    const turn = await selectionTurn(cleanup, owner);
    const cancelling = vi
      .spyOn(CoordinationStore.prototype, 'cancelSelection')
      .mockImplementation(async () => {
        throw new Error('Injected selection cleanup failure');
      });
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
      cancelling.mockRestore();
      await pending;
      await owner.coordination.context();
      assert.equal(owner.coordination.snapshot.error, undefined);
      assert.deepEqual(owner.coordination.snapshot.ownClaim, result.claim);
      assert.deepEqual(await registry.claims(), [result.claim]);
    } finally {
      cancelling.mockRestore();
      await pending;
      await turn.finish();
    }
  });
}

test('pre-claim cleanup failure still refuses new ownership', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  let assignments = 0;
  const { start, registry } = await coordinationFixture(cleanup, async () => {
    assignments++;
    return { assigned: [] };
  });
  const owner = await start();
  const turn = await selectionTurn(cleanup, owner);
  const cancelling = vi
    .spyOn(CoordinationStore.prototype, 'cancelSelection')
    .mockImplementation(async () => {
      throw new Error('Injected selection cleanup failure');
    });
  try {
    await assert.rejects(owner.coordination.endTurn(), /cleanup failure/);
    const result = await owner.claim('https://github.com/acme/queue/issues/17');
    if (result.kind !== 'error') assert.fail(JSON.stringify(result));
    assert.equal(result.message, 'Injected selection cleanup failure');
    assert.deepEqual(await registry.claims(), []);
    assert.equal(assignments, 0);
  } finally {
    cancelling.mockRestore();
    await turn.finish();
  }
});

for (const failures of [1, 2]) {
  test(`presence publication recovers after ${failures} failed ${failures === 1 ? 'write' : 'writes'} without another state update`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);
    const { start, registry } = await coordinationFixture(cleanup);
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
    const publication = vi
      .spyOn(CoordinationStore.prototype, 'publish')
      .mockImplementation(async function (
        this: CoordinationStore,
        presence: Parameters<typeof publish>[0],
      ) {
        if (presence.activation === bound.activation && ++attempts <= failures)
          throw new Error('Temporary presence write failure');
        return publish.call(this, presence);
      });
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
      publication.mockRestore();
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

test('a slow presence retry preserves newer state without accumulating retries', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, registry } = await coordinationFixture(cleanup);
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
  const publication = vi
    .spyOn(CoordinationStore.prototype, 'publish')
    .mockImplementation(async function (
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
    });
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
    publication.mockRestore();
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
  test(`a presence retry cannot republish an activation after ${action}`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);
    const { start, registry } = await coordinationFixture(cleanup);
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
    const publication = vi
      .spyOn(CoordinationStore.prototype, 'publish')
      .mockImplementation(async function (
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
      });
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
      publication.mockRestore();
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

test('waiting and idle background work stay visible and retain ownership through refusal, failure and interruption', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, ledger } = await coordinationFixture(cleanup);
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
  assert.equal((await b.query()).peers[0]!.presence.requests, 1);
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
  assert.equal((await b.query()).peers[0]!.presence.brews, 1);
  await assert.rejects(a.coordinator.releaseTask(), /familiars and brews/);
  emit({
    type: 'command',
    command: { id: 'brew', description: 'Work', status: 'completed' },
  });
  emit({
    type: 'subagent',
    subagent: { id: 'f', name: 'Worker', kind: 'review', status: 'running' },
  });
  await until('familiar presence replaces completed brew', async () => {
    const presence = (await b.query()).peers[0]!.presence;
    return (
      presence.familiars === 1 &&
      presence.brews === 0 &&
      presence.requests === 0
    );
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

test('task counts, pentacle and release follow running work', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, registry } = await coordinationFixture(cleanup);
  const a = await start(),
    b = await start('B');
  assert.equal((await a.claim()).kind, 'claimed');
  const claims = await registry.claims();
  const emit = a.a.sessions.at(-1)!.options.onEvent;
  const familiar = (id: string, status: TaskStatus) =>
    emit({
      type: 'subagent',
      subagent: { id, name: id, kind: 'review', status },
    });
  const brew = (id: string, status: TaskStatus) =>
    emit({
      type: 'command',
      command: { id, description: id, status },
    });

  familiar('first', 'running');
  familiar('second', 'running');
  for (const status of ['completed', 'failed', 'stopped'] as const) {
    familiar(status, 'running');
    familiar(status, status);
  }
  for (const id of ['one', 'two', 'three']) brew(id, 'running');
  await until('mixed activity counts', async () => {
    const { familiars, brews } = (await b.query()).peers[0]!.presence;
    return familiars === 2 && brews === 3;
  });
  assert.equal(a.coordinator.pentacle.active, true);
  await assert.rejects(a.coordinator.releaseTask(), /familiars and brews/);
  assert.deepEqual(await registry.claims(), claims);

  familiar('first', 'completed');
  familiar('second', 'stopped');
  for (const id of ['one', 'two', 'three']) brew(id, 'completed');
  await until('finished activity counts', async () => {
    const { familiars, brews } = (await b.query()).peers[0]!.presence;
    return familiars === 0 && brews === 0;
  });
  assert.deepEqual(
    a.coordinator.snapshot.subagents.map(({ status }) => status),
    ['completed', 'stopped', 'completed', 'failed', 'stopped'],
  );
  assert.equal(a.coordinator.pentacle.active, false);
  await a.coordinator.releaseTask();
  assert.deepEqual(await registry.claims(), []);
});

test('a live legacy owner blocks new work until its lock closes, and a reused identity is never treated as registered', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { root, start, store, registry } = await coordinationFixture(cleanup);
  const a = await start();
  // select-next refuses while the legacy lock is held, so the ticket comes first
  const choosing = await selectionTurn(cleanup, a);
  const { ticket } = await choosing.select();
  const legacy = record(randomUUID(), join(root, 'B'));
  await (await store.create(legacy)).close();
  const lock = await legacyLock(store, legacy.id);
  cleanup(() => lock.close());
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
  test(`a missing directory in ${name === 'B' ? 'the same' : 'another'} project preserves claims without blocking discovery or selection`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);
    const { root, start, store, memory, registry } =
      await coordinationFixture(cleanup);
    const a = await start();
    const choosing = await selectionTurn(cleanup, a);
    const cwd = join(root, name);
    const { project } = await memory.scopePaths(cwd);
    const legacy = record(randomUUID(), cwd);
    await (await store.create(legacy)).close();
    const lock = await legacyLock(store, legacy.id);
    cleanup(() => lock.close());
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
  test(`${failure.code} from ${failure.syscall} still blocks discovery and new ownership`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);
    const { root, start, store, memory, registry } =
      await coordinationFixture(cleanup);
    const a = await start();
    const choosing = await selectionTurn(cleanup, a);
    const cwd = join(root, 'B');
    const legacy = record(randomUUID(), cwd);
    await (await store.create(legacy)).close();
    const lock = await legacyLock(store, legacy.id);
    cleanup(() => lock.close());
    const scopePaths = memory.scopePaths.bind(memory);
    const error = Object.assign(new Error('Cannot determine project'), failure);
    vi.spyOn(memory, 'scopePaths').mockImplementation((directory: string) =>
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

test('closing a conversation releases its claim even if its stale presence says it runs', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, registry } = await coordinationFixture(cleanup);
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

test('a failed presence removal cannot register a later legacy lock owner', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, store, registry } = await coordinationFixture(cleanup);
  const a = await start(),
    b = await start('B');
  const old = await a.binding();
  const remove = CoordinationStore.prototype.removePresence;
  vi.spyOn(CoordinationStore.prototype, 'removePresence').mockImplementation(
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
  test(`a peer ${window} a conversation neither refuses a claim nor ends a selection wait`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);
    const { start, store, registry } = await coordinationFixture(cleanup);
    const a = await start(),
      b = await start('B');
    const choosing = await selectionTurn(cleanup, a);
    const { ticket } = await choosing.select();
    const id = b.coordinator.snapshot.conversation!.id;
    const gate = Promise.withResolvers<void>();
    let pending: Promise<void>;
    if (window !== 'closing') {
      const activate = b.coordination.activate.bind(b.coordination);
      vi.spyOn(b.coordination, 'activate').mockImplementation(
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
      vi.spyOn(ConversationStore.prototype, 'close').mockImplementation(
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

test('unknown discovery refuses both a successful query and new ownership', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  pauseDiscovery(vi.spyOn);
  const { start, store, registry } = await coordinationFixture(cleanup);
  const a = await start();
  const id = randomUUID();
  const directory = join(store.root, 'conversations', id);
  const held = await store.create(
    record(id, a.coordinator.snapshot.conversation!.cwd),
  );
  cleanup(() => held.close());
  await files.writeFile(join(directory, 'state.json'), '{broken');
  const bound = await a.binding();
  const query = await measureControl(vi.spyOn, () =>
    callControl(bound, { kind: 'peers' }),
  );
  assert.equal(query.value.kind, 'error');
  assert.equal(query.discoveries, 1);
  const attempt = await measureControl(vi.spyOn, () => a.claim());
  assert.equal(attempt.value.kind, 'error');
  assert.equal(attempt.discoveries, 1);
  assert.deepEqual(await registry.claims(), []);
  const context = await a.coordination.context();
  assert.match(context.context, /Coordination is unavailable/);
  assert.match(context.context, /No selection turn is current/);
  assert.doesNotMatch(context.context, /When asked to choose/);
  assert.match(context.instructions, /When asked to choose/);
});

test('an origin change leaves a discoverable reservation in the original project until explicit release', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { root, start, ledger, registry } = await coordinationFixture(cleanup);
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
  // presence republishes on a 100 ms timer after the origin change
  await until('A presence outside the original project', async () =>
    (await registry.presences()).some(
      (p) =>
        p.id === result.claim.owner.conversation &&
        p.project !== result.claim.owner.project,
    ),
  );
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

test('closing rejects a mutation waiting for the ledger and drains one already committing', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, store, registry } = await coordinationFixture(cleanup);
  const a = await start();
  const bound = await a.binding();
  const lock = await openLocked(
    join(store.root, 'coordination', 'lock'),
    constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK,
    { mode: 0o600 },
  );
  // a request the host hasn't read when it closes gets no reply, so wait for the request's own ledger read
  const deadline = Date.now() + 10_000;
  const waiting = Promise.withResolvers<void>();
  const state = CoordinationStore.prototype.state;
  vi.spyOn(CoordinationStore.prototype, 'state').mockImplementation(function (
    this: CoordinationStore,
    ...args: Parameters<typeof state>
  ) {
    if (args[0] === deadline) waiting.resolve();
    return state.apply(this, args);
  });
  const attempt = callControl(
    bound,
    { kind: 'claim', input: { reference: 'task:shared', summary: 'A task' } },
    deadline,
  );
  let closing: ReturnType<typeof a.coordinator.close> | undefined;
  try {
    await within(waiting.promise, 5000, 'request waiting on lock');
    closing = a.coordinator.close();
    await lock.close();
    assert.equal((await attempt).kind, 'error');
    await within(closing, 5000, 'close');
    assert.deepEqual(await registry.claims(), []);
  } finally {
    await lock.close();
    await Promise.allSettled([attempt, closing]);
  }
  const b = await start('B');
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const rename = files.rename;
  vi.spyOn(files, 'rename').mockImplementation(
    async (...args: Parameters<typeof files.rename>) => {
      if (String(args[1]).endsWith('/coordination/claims.json')) {
        entered.resolve();
        await finish.promise;
      }
      return rename(...args);
    },
  );
  syncBuiltinESMExports();
  cleanup(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });
  const committing = b.claim();
  let draining: ReturnType<typeof b.coordinator.close> | undefined;
  try {
    await within(entered.promise, 5000, 'commit boundary');
    let closed = false;
    draining = b.coordinator.close().then(() => {
      closed = true;
    });
    await delay(50);
    assert.equal(closed, false);
    finish.resolve();
    assert.equal((await committing).kind, 'claimed');
    await within(draining, 5000, 'commit drain');
    assert.deepEqual(await registry.claims(), []);
    assert.deepEqual(await registry.presences(), []);
  } finally {
    finish.resolve();
    await Promise.allSettled([committing, draining]);
  }
});

test('a delayed presence writer drains before replacement activation publishes', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, registry } = await coordinationFixture(cleanup);
  const a = await start();
  const bound = await a.binding();
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const publish = CoordinationStore.prototype.publish;
  let held = false;
  vi.spyOn(CoordinationStore.prototype, 'publish').mockImplementation(
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
  let switching: ReturnType<typeof a.coordinator.newConversation> | undefined;
  try {
    a.a.sessions.at(-1)!.options.onEvent({
      type: 'request',
      request: { id: 'q', kind: 'approval', title: 'Wait', detail: '' },
    });
    await within(entered.promise, 3000, 'delayed presence write');
    switching = a.coordinator.newConversation();
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
  } finally {
    finish.resolve();
    await switching?.catch(() => {});
  }
});

for (const size of [1, 8])
  test(
    'discovery probe counts stay bounded with ' + size + ' owner groups',
    async (t) => {
      const cleanup = orderedCleanup(t.onTestFinished);
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const { root, start, store, registry } =
        await coordinationFixture(cleanup);
      cleanup(() => {
        vi.useRealTimers();
      });
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
        cleanup(async () => {
          child.kill();
          await ended;
        });
        await once(child, 'spawn');
        const identity = (await identifyProcess(child.pid!))!;
        for (const duplicate of [false, true]) {
          const id = 'peer-' + index + '-' + duplicate;
          const held = await store.create(record(id, join(root, 'B')));
          cleanup(() => held.close());
          expectedOpenStatePaths.add(join(held.directory, 'state.json'));
          const activation = randomUUID();
          const release = await registry.holdActivation(activation);
          cleanup(release);
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
        cleanup(() => held.close());
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
      vi.spyOn(files, 'readFile').mockImplementation(
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
          vi.restoreAllMocks();
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
      test(
        action +
          ' with ' +
          (locked ? 'open' : 'closed') +
          ' ' +
          damage +
          ' record',
        async (t) => {
          const cleanup = orderedCleanup(t.onTestFinished);
          const { start, store, root, ledger, registry } =
            await coordinationFixture(cleanup);
          const a = await start();
          await files.writeFile(
            join(store.root, 'coordination', 'claims.json'),
            JSON.stringify({ version: 2, claims: [], selections: [] }),
          );
          const choosing =
            action === 'claim' ? undefined : await selectionTurn(cleanup, a);
          const selection =
            action === 'recommend' ? await choosing!.select() : undefined;
          const id = randomUUID();
          const held = await store.create(record(id, join(root, 'B')));
          cleanup(() => held.close());
          if (!locked) await held.close();
          const path = join(held.directory, 'state.json');
          if (damage === 'JSON') await files.writeFile(path, '{broken');
          else {
            await files.chmod(path, 0);
            cleanup(() => files.chmod(path, 0o600));
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
