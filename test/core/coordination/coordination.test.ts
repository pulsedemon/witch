import assert from 'node:assert/strict';
import { promises as files } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { TaskStatus } from '../../../src/agents/types.js';
import { parseStatus } from '../../../src/core/repository/repository.js';
import { presenceStatus } from '../../../src/core/coordination/coordination-state.js';
import { CoordinationStore } from '../../../src/persistence/coordination.js';
import { callControl } from '../../../src/persistence/control.js';
import { unitCoordinationFixture } from '../../fixtures/coordination.js';
import { record } from '../../fixtures/coordinator.js';
import { selectionTurn } from '../../fixtures/task-selection.js';
import { until, within } from '../../fixtures/within.js';
import { countProbes } from '../../fixtures/probes.js';
import { orderedCleanup } from '../../fixtures/cleanup.js';

test('discovery batches conversation ownership and keeps only open peers', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const { root, start, store } = await unitCoordinationFixture(cleanup);

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
  const { start } = await unitCoordinationFixture(cleanup);

  cleanup(() => {
    vi.useRealTimers();
  });

  const a = await start('A');
  const { ps, perl } = await countProbes(() => a.coordination.context());
  assert.deepEqual({ ps, perl }, { ps: 0, perl: 1 });
});

test('clones expose current task metadata without themselves or another project, and token-only updates do not write presence', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { root, start, registry } = await unitCoordinationFixture(cleanup);
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
  const { root, start, registry } = await unitCoordinationFixture(cleanup);
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

    const { start, registry } = await unitCoordinationFixture(
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

  const { start, registry } = await unitCoordinationFixture(
    cleanup,
    async () => {
      assignments++;

      return { assigned: [] };
    },
  );

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
    const { start, registry } = await unitCoordinationFixture(cleanup);

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
  const { start, registry } = await unitCoordinationFixture(cleanup);

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
    const { start, registry } = await unitCoordinationFixture(cleanup);
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
  const { start, ledger } = await unitCoordinationFixture(cleanup);

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
  const { start, registry } = await unitCoordinationFixture(cleanup);

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
  emit({ type: 'running', running: true });
  await assert.rejects(a.coordinator.releaseTask(), /Wait for idle/);
  emit({ type: 'running', running: false });
  await a.coordinator.releaseTask();
  assert.deepEqual(await registry.claims(), []);
});
