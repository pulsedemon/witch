import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { CoordinationStore } from '../../../src/persistence/coordination.js';
import { callControl } from '../../../src/persistence/control.js';
import {
  ConversationStore,
  LockedElsewhere,
} from '../../../src/persistence/store.js';
import { TurnGate } from '../../fixtures/agent.js';
import {
  git,
  pauseDiscovery,
  unitCoordinationFixture,
} from '../../fixtures/coordination.js';
import { orderedCleanup } from '../../fixtures/cleanup.js';
import { record } from '../../fixtures/store.js';
import { selectionTurn } from '../../fixtures/task-selection.js';
import { until, within } from '../../fixtures/within.js';

test('switch revokes old authority before native close and releases the departed claim', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, ledger, registry } = await unitCoordinationFixture(cleanup);

  const a = await start(),
    b = await start('B');

  await a.claim();

  const claim = (await registry.claims())[0]!,
    bound = await a.binding();

  const before = await ledger();
  const native = a.a.sessions.at(-1)!;

  native.options.onEvent({
    type: 'command',
    command: { id: 'brew', description: 'Work', status: 'running' },
  });

  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();

  const close = native.session.close.bind(native.session);

  native.session.close = async () => {
    entered.resolve();
    await finish.promise;
    await close();
  };

  const switching = a.coordinator.newConversation();

  try {
    await within(entered.promise, 5000, 'native close');
    assert.equal(a.coordinator.snapshot.backgroundCommands.length, 0);

    assert.equal(
      (await callControl(bound, { kind: 'release', claim: claim.id })).kind,
      'error',
    );

    assert.equal(await ledger(), before);
    assert.notEqual((await b.claim()).kind, 'claimed');
  } finally {
    finish.resolve();
    await switching;
  }

  assert.notEqual((await a.binding()).activation, bound.activation);
  assert.equal((await b.claim()).kind, 'claimed');
  await a.coordinator.selectConversation(bound.conversation);
  assert.equal((await a.query()).ownClaim, undefined);

  assert.equal(
    (await callControl(bound, { kind: 'release', claim: claim.id })).kind,
    'error',
  );
});

for (const replacement of ['handoff', 'origin', 'rollback'] as const) {
  test(`${replacement} replaces native authority without releasing the conversation's task`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);

    const { root, start, registry, ledger, store } =
      await unitCoordinationFixture(cleanup);

    const a = await start();
    const peer = replacement === 'rollback' ? await start('B') : undefined;
    await a.claim();

    const claim = (await registry.claims())[0]!,
      bound = await a.binding();

    const before = await ledger();
    const native = a.a.sessions.at(-1)!.session;
    const close = native.close.bind(native);

    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();

    native.close = async () => {
      entered.resolve();
      await finish.promise;
      await close();
    };

    if (replacement === 'origin')
      await git(
        '-C',
        join(root, 'A'),
        'remote',
        'set-url',
        'origin',
        join(root, 'other'),
      );

    if (replacement === 'rollback') a.b.failConnect = true;

    const replacing =
      replacement === 'origin'
        ? a.coordinator.send('New scope')
        : a.coordinator.selectModel({ agent: 'b', id: 'b-model' });

    const settled = replacing.then(
      () => undefined,
      (error: unknown) => error,
    );

    try {
      await within(entered.promise, 5000, 'native replacement');

      assert.equal(
        (await callControl(bound, { kind: 'release', claim: claim.id })).kind,
        'error',
      );

      assert.equal(await ledger(), before);
    } finally {
      finish.resolve();
    }

    const error = await settled;

    if (replacement === 'rollback')
      assert.match(String(error), /Destination unavailable/);
    else assert.equal(error, undefined);

    const current = await a.binding();
    assert.notEqual(current.activation, bound.activation);
    assert.equal(current.conversation, bound.conversation);

    assert.equal(
      (await callControl(bound, { kind: 'release', claim: claim.id })).kind,
      'error',
    );

    assert.equal(await ledger(), before);

    if (peer) {
      assert.equal(a.coordinator.snapshot.phase, 'idle');
      assert.equal(a.coordinator.snapshot.conversation!.agent, 'a');
      assert.equal(await store.isOpen(bound.conversation), true);
      assert.deepEqual((await peer.query()).unregistered, []);
      assert.equal(a.a.sessions.length, 1);
      assert.deepEqual(a.a.inputs, []);
      assert.deepEqual(a.b.inputs, []);
      assert.equal((await peer.claim('task:independent')).kind, 'claimed');
      assert.deepEqual((await a.query()).ownClaim, claim);
    }

    if (replacement !== 'origin')
      await a.coordinator.send('Check current prefix');

    const active = replacement === 'handoff' ? a.b : a.a;
    assert.ok(active.inputs.at(-1)!.context!.includes(current.activation));

    if (replacement === 'rollback')
      assert.equal(active.inputs.at(-1)!.session, native.info.id);

    await a.coordinator.send('Reuse current prefix');
    assert.doesNotMatch(active.inputs.at(-1)!.context!, /Control command:/);
  });
}

test('an interrupted handoff summary restores registration before source resume', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, store } = await unitCoordinationFixture(cleanup);

  const a = await start(),
    peer = await start('B');

  await a.coordinator.send('Seed source history');
  assert.equal((await a.claim('task:source')).kind, 'claimed');

  const claim = (await a.query()).ownClaim!,
    bound = await a.binding(),
    source = a.a.sessions.at(-1)!.session.info.id;

  const gate = new TurnGate();
  a.a.gate = gate;
  const switching = a.coordinator.selectModel({ agent: 'b', id: 'b-model' });
  const rejected = assert.rejects(switching, /interrupted/);

  try {
    await within(gate.entered, 5000, 'handoff summary');
    const inputs = a.a.inputs.length;
    await a.coordinator.interrupt();
    await rejected;
    assert.equal(a.coordinator.snapshot.phase, 'idle');
    assert.equal(a.coordinator.snapshot.conversation!.agent, 'a');
    assert.equal(await store.isOpen(bound.conversation), true);
    assert.deepEqual((await peer.query()).unregistered, []);
    const current = await a.binding();
    assert.notEqual(current.activation, bound.activation);
    assert.equal(current.conversation, bound.conversation);

    assert.equal(
      (await callControl(bound, { kind: 'release', claim: claim.id })).kind,
      'error',
    );

    assert.deepEqual((await a.query()).ownClaim, claim);
    assert.equal(a.a.sessions.length, 1);
    assert.equal(a.a.inputs.length, inputs);
    assert.deepEqual(a.b.inputs, []);
    const choosing = await selectionTurn(cleanup, peer);
    assert.equal((await choosing.select()).position, 1);
    await choosing.finish();
    assert.equal((await peer.claim('task:independent')).kind, 'claimed');
    assert.deepEqual((await a.query()).ownClaim, claim);
    a.a.gate = undefined;
    await a.coordinator.send('Resume source');
    assert.equal(a.a.inputs.at(-1)!.session, source);
    assert.ok(a.a.inputs.at(-1)!.context!.includes(current.activation));
    assert.match(a.a.inputs.at(-1)!.context!, /^Control command:/m);
    assert.ok(!a.a.inputs.at(-1)!.context!.includes(bound.activation));
    await a.coordinator.send('Continue source');
    assert.doesNotMatch(a.a.inputs.at(-1)!.context!, /Control command:/);
  } finally {
    gate.open();
    await switching.catch(() => {});
  }
});

test('closing during a handoff summary does not restore registration', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, store, registry } = await unitCoordinationFixture(cleanup);

  const a = await start(),
    peer = await start('B');

  await a.coordinator.send('Seed source history');
  assert.equal((await a.claim('task:source')).kind, 'claimed');
  const bound = await a.binding();
  const gate = new TurnGate();
  a.a.gate = gate;
  const switching = a.coordinator.selectModel({ agent: 'b', id: 'b-model' });
  const rejected = assert.rejects(switching, /interrupted/);

  try {
    await within(gate.entered, 5000, 'handoff summary');
    await a.coordinator.close();
    await rejected;

    assert.equal(
      (await registry.presences()).some(
        (entry) => entry.id === bound.conversation,
      ),
      false,
    );

    assert.equal(
      (await registry.activeActivations([bound.activation])).has(
        bound.activation,
      ),
      false,
    );

    assert.equal(
      (await registry.claims()).some(
        (entry) => entry.owner.conversation === bound.conversation,
      ),
      false,
    );

    const acquired = await store.claim(bound.conversation);
    await acquired.close();
    assert.equal((await peer.claim('task:independent')).kind, 'claimed');
  } finally {
    gate.open();
    await switching.catch(() => {});
  }
});

test('reopening starts without a claim and old authority cannot release newly claimed work', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start } = await unitCoordinationFixture(cleanup);
  const a = await start();
  await a.claim();

  const before = (await a.query()).ownClaim!,
    bound = await a.binding();

  await a.coordinator.close();
  const reopened = await start('A', { conversation: bound.conversation });
  const current = await reopened.binding();
  assert.notEqual(current.activation, bound.activation);
  assert.equal((await reopened.query()).ownClaim, undefined);
  const next = await reopened.claim();

  if (next.kind !== 'claimed') assert.fail(JSON.stringify(next));

  assert.notEqual(next.claim.id, before.id);

  const stale = await callControl(
    { ...bound, directory: current.directory },
    { kind: 'release', claim: next.claim.id },
  );

  assert.equal(stale.kind, 'error');
  assert.deepEqual((await reopened.query()).ownClaim, next.claim);
});

test('target lock and preparation failures keep source authority and free a prepared target lock', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { root, start, store } = await unitCoordinationFixture(cleanup);

  const a = await start(),
    bound = await a.binding();

  const target = await store.create(record(randomUUID(), join(root, 'A')));

  try {
    await assert.rejects(
      a.coordinator.selectConversation(target.record.id),
      LockedElsewhere,
    );

    assert.equal((await callControl(bound, { kind: 'peers' })).kind, 'peers');
  } finally {
    await target.close();
  }

  const items = ConversationStore.prototype.items;

  vi.spyOn(ConversationStore.prototype, 'items').mockImplementation(function (
    this: ConversationStore,
  ) {
    return this.record.id === target.record.id
      ? Promise.reject(new Error('target history unreadable'))
      : items.call(this);
  });

  await assert.rejects(
    a.coordinator.selectConversation(target.record.id),
    /target history unreadable/,
  );

  assert.equal((await callControl(bound, { kind: 'peers' })).kind, 'peers');
  const acquired = await store.claim(target.record.id);
  await acquired.close();
  await a.coordinator.send('Source still usable');
  assert.equal(a.a.sessions.length, 1);
  assert.ok(a.a.inputs.at(-1)!.context!.includes(bound.activation));
});

for (const boundary of ['write', 'remove'] as const) {
  for (const preparation of ['ordinary', 'delayed'] as const) {
    test(`a failed source presence ${boundary} still revokes authority and adopts the prepared target (${preparation} preparation)`, async (t) => {
      const cleanup = orderedCleanup(t.onTestFinished);
      const { start, store, registry } = await unitCoordinationFixture(cleanup);

      const a = await start(),
        bound = await a.binding();

      const entered = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<void>(),
        starting = Promise.withResolvers<void>();

      const publish = CoordinationStore.prototype.publish;
      let writes = 0;
      let writesAtRemoval: number | undefined;

      vi.spyOn(CoordinationStore.prototype, 'publish').mockImplementation(
        async function (
          this: CoordinationStore,
          presence: Parameters<typeof publish>[0],
        ) {
          if (presence.activation === bound.activation) {
            writes++;

            if (presence.phase === 'starting' && presence.requests === 1)
              starting.resolve();

            entered.resolve();
            await finish.promise;

            if (boundary === 'write') throw new Error('presence flush failed');
          }

          return publish.call(this, presence);
        },
      );

      const remove = CoordinationStore.prototype.removePresence;

      vi.spyOn(
        CoordinationStore.prototype,
        'removePresence',
      ).mockImplementation(function (
        this: CoordinationStore,
        id: string,
        activation: string,
      ) {
        if (activation === bound.activation) {
          writesAtRemoval = writes;

          if (boundary === 'remove')
            return Promise.reject(new Error('presence removal failed'));
        }

        return remove.call(this, id, activation);
      });

      if (preparation === 'delayed') {
        const create = store.create.bind(store);

        vi.spyOn(store, 'create').mockImplementation(
          async (...args: Parameters<typeof create>) => {
            await within(starting.promise, 5000, 'starting presence');

            return create(...args);
          },
        );
      }

      let switching: Promise<void> | undefined;

      try {
        a.a.sessions.at(-1)!.options.onEvent({
          type: 'request',
          request: { id: 'q', kind: 'approval', title: 'Wait', detail: '' },
        });

        await within(entered.promise, 5000, 'old writer');
        switching = a.coordinator.newConversation();
        finish.resolve();
        await switching;
        const current = await a.binding();
        assert.notEqual(current.conversation, bound.conversation);

        assert.equal(
          (await callControl(bound, { kind: 'peers' })).kind,
          'error',
        );

        assert.equal(
          (await callControl(current, { kind: 'peers' })).kind,
          'peers',
        );

        assert.match(
          a.coordinator.snapshot.error ?? '',
          boundary === 'write'
            ? /presence flush failed/
            : /presence removal failed/,
        );

        const old = await store.claim(bound.conversation);
        await old.close();
        assert.equal(writes, writesAtRemoval);

        assert.ok(
          (await registry.presences()).some(
            (p) => p.activation === current.activation,
          ),
        );
      } finally {
        finish.resolve();
        starting.resolve();
        await switching?.catch(() => {});
      }
    });
  }
}

test('failed target activation holds its selected lock without starting native work and retries with fresh authority', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, store, registry } = await unitCoordinationFixture(cleanup);

  const a = await start(),
    bound = await a.binding();

  await a.claim();
  const publish = CoordinationStore.prototype.publish;

  let failing = true,
    rejected = '';

  vi.spyOn(CoordinationStore.prototype, 'publish').mockImplementation(
    async function (
      this: CoordinationStore,
      presence: Parameters<typeof publish>[0],
    ) {
      await publish.call(this, presence);

      if (failing && presence.id !== bound.conversation) {
        rejected = presence.activation;

        throw new Error('target presence failed');
      }
    },
  );

  await assert.rejects(
    a.coordinator.newConversation(),
    /target presence failed/,
  );

  const target = a.coordinator.snapshot.conversation!.id;
  assert.notEqual(target, bound.conversation);
  assert.equal(a.a.sessions.length, 1);
  assert.equal((await callControl(bound, { kind: 'peers' })).kind, 'error');

  assert.equal(
    (
      await callControl(
        { ...bound, conversation: target, activation: rejected },
        { kind: 'peers' },
      )
    ).kind,
    'error',
  );

  assert.deepEqual(await registry.presences(), []);

  assert.equal(
    (await registry.activeActivations([rejected])).has(rejected),
    false,
  );

  assert.equal(a.coordination.snapshot.ownClaim, undefined);
  assert.deepEqual(await registry.claims(), []);
  const source = await store.claim(bound.conversation);
  await source.close();
  await assert.rejects(store.claim(target), LockedElsewhere);
  failing = false;
  await a.coordinator.send('Retry activation');
  assert.notEqual((await a.binding()).activation, rejected);
  assert.equal(a.a.sessions.length, 2);
  await a.coordinator.close();
  const released = await store.claim(target);
  await released.close();
});

test('compaction publishes a running presence and defers behind a held native turn', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start } = await unitCoordinationFixture(cleanup);

  const a = await start(),
    b = await start('B');

  await a.coordinator.send('seed');
  const gate = new TurnGate();
  a.a.gate = gate;
  const compact = a.coordinator.compact();

  try {
    await within(gate.entered, 3000, 'native compaction');
    assert.equal(a.coordinator.snapshot.phase, 'compacting');

    await until(
      'compatible presence',
      async () => (await b.query()).peers[0]?.presence.phase === 'running',
    );
  } finally {
    gate.open();
    await compact;
  }

  a.a.gate = new TurnGate();
  const sending = a.coordinator.send('held turn');

  try {
    await within(a.a.gate.entered, 3000, 'held native turn');
    a.a.replied = true;
    const compacting = a.coordinator.compact();
    assert.equal(a.coordinator.snapshot.pendingCompaction, true);
    assert.equal(a.a.compactions.length, 1);
    a.a.gate.open();
    assert.equal(await within(compacting, 3000, 'deferred compact'), true);
    assert.equal(a.a.compactions.length, 2);
  } finally {
    a.a.gate.open();
    await sending;
  }
});

test('an idle session whose native agent runs on its own publishes a running presence', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start } = await unitCoordinationFixture(cleanup);

  const a = await start(),
    b = await start('B');

  const phase = async () => (await b.query()).peers[0]?.presence.phase;
  const emit = a.a.sessions.at(-1)!.options.onEvent;
  await until('idle presence', async () => (await phase()) === 'idle');
  emit({ type: 'running', running: true });
  assert.equal(a.coordinator.snapshot.phase, 'idle');
  await until('running presence', async () => (await phase()) === 'running');
  emit({ type: 'running', running: false });
  await until('idle presence again', async () => (await phase()) === 'idle');
});

for (const reconnect of [false, true])
  test(`a ${reconnect ? 'reconnecting' : 'live'} turn reads its project scope once`, async (t) => {
    pauseDiscovery(vi.spyOn);
    const f = await unitCoordinationFixture(orderedCleanup(t.onTestFinished));
    const a = await f.start();

    if (reconnect) await a.a.sessions.at(-1)!.session.close();

    const reads = vi.spyOn(f.memory, 'scopePaths');
    await a.coordinator.send('Inspect current exports');
    assert.equal(a.a.inputs.length, 1);
    assert.equal(a.a.sessions.length, reconnect ? 2 : 1);

    assert.deepEqual(
      reads.mock.calls.map(([directory]) => directory),
      [join(f.root, 'A')],
    );
  });

test('opening a conversation reads its project scope once', async (t) => {
  pauseDiscovery(vi.spyOn);
  const f = await unitCoordinationFixture(orderedCleanup(t.onTestFinished));
  const reads = vi.spyOn(f.memory, 'scopePaths');
  const a = await f.start();
  assert.equal(a.coordinator.snapshot.phase, 'idle');

  assert.deepEqual(
    reads.mock.calls.map(([directory]) => directory),
    [join(f.root, 'A')],
  );
});

test("an idle origin change still compacts from the old session's usage before reconnecting", async (t) => {
  const f = await unitCoordinationFixture(orderedCleanup(t.onTestFinished));
  const a = await f.start();
  await a.coordinator.send('Seed');
  const seeded = a.a.sessions.at(-1)!.session;
  seeded.contextUsage = async () => 80;

  await git(
    '-C',
    join(f.root, 'A'),
    'remote',
    'set-url',
    'origin',
    join(f.root, 'other'),
  );

  await a.coordinator.send('Continue');
  assert.deepEqual(a.a.compactions, [seeded.info.id]);
  assert.equal(a.a.inputs.length, 2);
});
