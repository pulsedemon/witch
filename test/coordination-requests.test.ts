import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  CoordinationAction,
  TaskClaim,
} from '../src/core/coordination-state.js';
import { CoordinationStore } from '../src/persistence/coordination.js';
import { callControl } from '../src/persistence/control.js';
import { StateStore } from '../src/persistence/store.js';
import {
  coordinationFixture,
  measureControl,
  pauseDiscovery,
} from './fixtures/coordination.js';
import { selectionTurn } from './fixtures/task-selection.js';
import { until, within } from './fixtures/within.js';

for (const kind of [
  'peers',
  'claim',
  'release',
  'select-next',
  'selection-status',
  'recommend',
  'cancel-selection',
] as const)
  await test(`${kind} discovers once and publishes the resulting ownership`, async (t) => {
    pauseDiscovery(t);
    const { start } = await coordinationFixture(t);
    const a = await start(),
      b = await start('B');
    const peer = await b.claim('task:peer', 'Peer work');
    if (peer.kind !== 'claimed') assert.fail(JSON.stringify(peer));
    const turn = await selectionTurn(t, a);
    let action: CoordinationAction;
    let expected: string;
    switch (kind) {
      case 'peers':
        action = { kind };
        expected = 'peers';
        break;
      case 'claim':
        action = {
          kind,
          input: { reference: 'task:chosen', summary: 'Chosen work' },
        };
        expected = 'claimed';
        break;
      case 'release': {
        const claimed = await a.claim('task:chosen', 'Chosen work');
        if (claimed.kind !== 'claimed') assert.fail(JSON.stringify(claimed));
        action = { kind, claim: claimed.claim.id };
        expected = 'released';
        break;
      }
      case 'select-next':
        action = { kind, turn: turn.turn };
        expected = 'selection';
        break;
      case 'recommend':
        action = {
          kind,
          selection: (await turn.select()).ticket.id,
          input: { reference: 'task:chosen', summary: 'Chosen work' },
        };
        expected = 'claimed';
        break;
      default:
        action = { kind, selection: (await turn.select()).ticket.id };
        expected =
          kind === 'selection-status' ? 'selection' : 'selection-cancelled';
    }
    try {
      const { value, discoveries, reads } = await measureControl(t, () =>
        callControl(turn.binding, action),
      );
      assert.equal(value.kind, expected, JSON.stringify(value));
      const snapshot = a.coordination.snapshot;
      assert.deepEqual(snapshot.peers[0]?.claim, peer.claim);
      if (value.kind === 'claimed') {
        assert.equal(value.claim.summary, 'Chosen work');
        assert.deepEqual(value.claim.references, [
          `task:${peer.claim.owner.project}:chosen`,
        ]);
        assert.deepEqual(snapshot.ownClaim, value.claim);
        assert.equal(snapshot.ownSelection, undefined);
      }
      if (value.kind === 'selection') {
        assert.equal(value.selection.position, 1);
        assert.deepEqual(value.snapshot.ownSelection, value.selection);
        assert.deepEqual(snapshot.ownSelection, value.selection);
      }
      if (kind === 'release') assert.equal(snapshot.ownClaim, undefined);
      if (kind === 'cancel-selection')
        assert.equal(snapshot.ownSelection, undefined);
      assert.equal(discoveries, 1);
      assert.ok(reads <= (kind === 'peers' ? 1 : 2), `${reads} ledger reads`);
    } finally {
      await turn.finish();
    }
  });

await test('human release reuses its lookup and publishes the released state', async (t) => {
  pauseDiscovery(t);
  const { start, registry } = await coordinationFixture(t);
  const a = await start();
  assert.equal((await a.claim()).kind, 'claimed');
  const measured = await measureControl(t, () => a.coordination.releaseTask());
  assert.equal(a.coordination.snapshot.ownClaim, undefined);
  assert.deepEqual(await registry.claims(), []);
  assert.equal(measured.discoveries, 1);
  assert.equal(measured.reads, 2);
});

await test('a later query reads the peer reservation made between requests', async (t) => {
  pauseDiscovery(t);
  const { start } = await coordinationFixture(t);
  const a = await start(),
    b = await start('B');
  assert.equal((await a.query()).peers[0]?.claim, undefined);
  const reserved = await b.claim('task:new-owner', 'New reservation');
  if (reserved.kind !== 'claimed') assert.fail(JSON.stringify(reserved));
  const { value, discoveries, reads } = await measureControl(t, () =>
    a.query(),
  );
  assert.deepEqual(value.peers[0]?.claim, reserved.claim);
  assert.equal(discoveries, 1);
  assert.equal(reads, 1);
});

await test('cancellation publishes the next waiter without another discovery', async (t) => {
  pauseDiscovery(t);
  const { start } = await coordinationFixture(t);
  const a = await start(),
    b = await start('B');
  const first = await selectionTurn(t, a),
    second = await selectionTurn(t, b);
  try {
    const head = await first.select(),
      queued = await second.select();
    assert.equal(queued.position, 2);
    const result = await measureControl(t, () =>
      callControl(first.binding, {
        kind: 'cancel-selection',
        selection: head.ticket.id,
      }),
    );
    assert.equal(result.value.kind, 'selection-cancelled');
    assert.equal(result.discoveries, 1);
    assert.equal(a.coordination.snapshot.ownSelection, undefined);
    assert.deepEqual(a.coordination.snapshot.peers[0]?.selection, {
      ticket: queued.ticket,
      position: 1,
    });
  } finally {
    await first.finish();
    await second.finish();
  }
});

await test('claim finalization preserves newer background observations', async (t) => {
  const refreshes = pauseDiscovery(t);
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const { start, registry } = await coordinationFixture(t, async () => {
    entered.resolve();
    await finish.promise;
  });
  const a = await start(),
    b = await start('B');
  const claiming = a.claim('task:chosen');
  try {
    await within(entered.promise, 5000, 'assignment');
    const peer = (await registry.presences()).find(
      (entry) => entry.id === b.coordinator.snapshot.conversation!.id,
    )!;
    await registry.publish({ ...peer, title: 'Changed during assignment' });
    refreshes[0]!();
    await until(
      'new peer title published',
      () =>
        a.coordination.snapshot.peers[0]?.presence.title ===
        'Changed during assignment',
    );
    assert.equal(a.coordination.snapshot.ownClaim?.summary, 'A task');
    finish.resolve();
    const result = await claiming;
    if (result.kind !== 'claimed') assert.fail(JSON.stringify(result));
    assert.deepEqual(a.coordination.snapshot.ownClaim, result.claim);
    assert.equal(
      a.coordination.snapshot.peers[0]?.presence.title,
      'Changed during assignment',
    );
  } finally {
    finish.resolve();
    await claiming;
  }
});

await test('claim finalization preserves a newer discovery failure until recovery', async (t) => {
  const refreshes = pauseDiscovery(t);
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const { start, store } = await coordinationFixture(t, async () => {
    entered.resolve();
    await finish.promise;
  });
  const a = await start(),
    b = await start('B');
  const file = join(
    store.root,
    'conversations',
    b.coordinator.snapshot.conversation!.id,
    'state.json',
  );
  const original = await readFile(file, 'utf8');
  const claiming = a.claim();
  try {
    await within(entered.promise, 5000, 'assignment');
    await writeFile(file, '{broken');
    refreshes[0]!();
    await until('new discovery failure published', () =>
      Boolean(
        a.coordination.snapshot.error?.includes(
          'Cannot determine session ownership',
        ),
      ),
    );
    const error = a.coordination.snapshot.error;
    finish.resolve();
    const result = await claiming;
    if (result.kind !== 'claimed') assert.fail(JSON.stringify(result));
    assert.deepEqual(a.coordination.snapshot.ownClaim, result.claim);
    assert.equal(a.coordination.snapshot.error, error);
    await writeFile(file, original);
    refreshes[0]!();
    await until(
      'discovery failure clears after repair',
      () => a.coordination.snapshot.error === undefined,
    );
    assert.deepEqual(a.coordination.snapshot.ownClaim, result.claim);
  } finally {
    finish.resolve();
    await writeFile(file, original);
    await claiming;
  }
});

await test('a pre-mutation refresh cannot publish old ownership after commit', async (t) => {
  pauseDiscovery(t);
  const { start, registry } = await coordinationFixture(t);
  const a = await start(),
    b = await start('B');
  await a.query();
  await until('peer idle presence written', async () =>
    (await registry.presences()).some(
      (entry) =>
        entry.id === b.coordinator.snapshot.conversation!.id &&
        entry.phase === 'idle',
    ),
  );
  const peer = (await registry.presences()).find(
    (entry) => entry.id === b.coordinator.snapshot.conversation!.id,
  )!;
  await registry.publish({
    ...peer,
    title: 'Changed while the transaction completes',
  });
  const readEntered = Promise.withResolvers<void>(),
    finishRead = Promise.withResolvers<void>(),
    committed = Promise.withResolvers<TaskClaim>(),
    finishMutation = Promise.withResolvers<void>();
  const read = CoordinationStore.prototype.state;
  const claim = CoordinationStore.prototype.claim;
  let reads = 0;
  const reading = t.mock.method(
    CoordinationStore.prototype,
    'state',
    async function (this: CoordinationStore) {
      const ledger = await read.call(this);
      if (++reads === 2) {
        readEntered.resolve();
        await finishRead.promise;
      }
      return ledger;
    },
  );
  const reserving = t.mock.method(
    CoordinationStore.prototype,
    'claim',
    async function (
      this: CoordinationStore,
      ...args: Parameters<typeof claim>
    ) {
      const result = await claim.apply(this, args);
      committed.resolve(result);
      await finishMutation.promise;
      return result;
    },
  );
  const refreshing = a.coordination.context();
  let claiming: ReturnType<typeof a.claim> | undefined;
  let unsubscribe = () => {};
  try {
    await within(readEntered.promise, 5000, 'old refresh read');
    claiming = a.claim('task:chosen');
    const reserved = await within(committed.promise, 5000, 'claim committed');
    assert.deepEqual(
      (await registry.claims()).find((entry) => entry.id === reserved.id),
      reserved,
    );
    const observed: (string | undefined)[] = [];
    unsubscribe = a.coordination.subscribe(() => {
      observed.push(a.coordination.snapshot.ownClaim?.id);
    });
    finishRead.resolve();
    await within(refreshing, 5000, 'old refresh completed');
    finishMutation.resolve();
    const result = await within(claiming, 5000, 'claim completed');
    assert.equal(result.kind, 'claimed');
    assert.deepEqual(a.coordination.snapshot.ownClaim, reserved);
    assert.equal(
      a.coordination.snapshot.peers[0]?.presence.title,
      'Changed while the transaction completes',
    );
    assert.ok(observed.length > 0);
    assert.ok(
      observed.every((id) => id === reserved.id),
      JSON.stringify(observed),
    );
  } finally {
    unsubscribe();
    finishRead.resolve();
    finishMutation.resolve();
    if (claiming) await claiming;
    await refreshing;
    reading.mock.restore();
    reserving.mock.restore();
  }
});

for (const outcome of ['success', 'failure'] as const)
  await test(`newer background discovery ${outcome} survives mutation completion`, async (t) => {
    const refreshes = pauseDiscovery(t);
    const assignmentEntered = Promise.withResolvers<void>(),
      finishAssignment = Promise.withResolvers<void>();
    const { start, store, registry } = await coordinationFixture(
      t,
      async () => {
        assignmentEntered.resolve();
        await finishAssignment.promise;
      },
    );
    const a = await start(),
      b = await start('B');
    const peerId = b.coordinator.snapshot.conversation!.id;
    await until('peer idle presence written', async () =>
      (await registry.presences()).some(
        (peer) => peer.id === peerId && peer.phase === 'idle',
      ),
    );
    const file = join(store.root, 'conversations', peerId, 'state.json');
    const original = await readFile(file, 'utf8');
    const committed = Promise.withResolvers<TaskClaim>(),
      finishMutation = Promise.withResolvers<void>(),
      observed = Promise.withResolvers<void>(),
      finishDiscovery = Promise.withResolvers<void>();
    const claim = CoordinationStore.prototype.claim;
    const reserving = t.mock.method(
      CoordinationStore.prototype,
      'claim',
      async function (
        this: CoordinationStore,
        ...args: Parameters<typeof claim>
      ) {
        const value = await claim.apply(this, args);
        committed.resolve(value);
        await finishMutation.promise;
        return value;
      },
    );
    const records = StateStore.prototype.records;
    let holding = false;
    const reading = t.mock.method(
      StateStore.prototype,
      'records',
      async function (this: StateStore, ...args: Parameters<typeof records>) {
        const result = await records.apply(this, args);
        if (holding) {
          holding = false;
          observed.resolve();
          await finishDiscovery.promise;
        }
        return result;
      },
    );
    const claiming = a.claim('task:chosen');
    try {
      const reserved = await within(committed.promise, 5000, 'claim committed');
      if (outcome === 'failure') await writeFile(file, '{broken');
      else {
        const peer = (await registry.presences()).find(
          (entry) => entry.id === peerId,
        )!;
        await registry.publish({
          ...peer,
          title: 'Newer overlapping observation',
        });
      }
      holding = true;
      refreshes[0]!();
      await within(observed.promise, 5000, 'background discovery observed');
      finishMutation.resolve();
      await within(assignmentEntered.promise, 5000, 'mutation completed');
      finishDiscovery.resolve();
      await until('newer background discovery published', () =>
        outcome === 'failure'
          ? Boolean(
              a.coordination.snapshot.error?.includes(
                'Cannot determine session ownership',
              ),
            )
          : a.coordination.snapshot.peers[0]?.presence.title ===
            'Newer overlapping observation',
      );
      if (outcome === 'success')
        assert.deepEqual(a.coordination.snapshot.ownClaim, reserved);
      finishAssignment.resolve();
      const result = await claiming;
      assert.equal(result.kind, 'claimed');
      assert.deepEqual(a.coordination.snapshot.ownClaim, reserved);
      if (outcome === 'failure') {
        assert.match(
          a.coordination.snapshot.error ?? '',
          /Cannot determine session ownership/,
        );
        await writeFile(file, original);
        refreshes[0]!();
        await until(
          'discovery recovers',
          () => a.coordination.snapshot.error === undefined,
        );
      } else
        assert.equal(
          a.coordination.snapshot.peers[0]?.presence.title,
          'Newer overlapping observation',
        );
    } finally {
      finishDiscovery.resolve();
      finishMutation.resolve();
      finishAssignment.resolve();
      await writeFile(file, original);
      await claiming;
      reading.mock.restore();
      reserving.mock.restore();
    }
  });

await test('a newer discovery survives rejected mutation completion', async (t) => {
  const refreshes = pauseDiscovery(t);
  const { start, registry } = await coordinationFixture(t);
  const a = await start(),
    b = await start('B');
  const peerId = b.coordinator.snapshot.conversation!.id;
  await until('peer idle presence written', async () =>
    (await registry.presences()).some(
      (peer) => peer.id === peerId && peer.phase === 'idle',
    ),
  );
  const verified = Promise.withResolvers<void>(),
    finishMutation = Promise.withResolvers<void>(),
    observed = Promise.withResolvers<void>(),
    finishDiscovery = Promise.withResolvers<void>(),
    finalReadEntered = Promise.withResolvers<void>(),
    finishFinalRead = Promise.withResolvers<void>();
  const claim = CoordinationStore.prototype.claim;
  const reserving = t.mock.method(
    CoordinationStore.prototype,
    'claim',
    async function (
      this: CoordinationStore,
      ...[owner, input, process, deadline, verify]: Parameters<typeof claim>
    ) {
      return claim.call(
        this,
        owner,
        input,
        process,
        deadline,
        async (ledger) => {
          await verify(ledger);
          verified.resolve();
          await finishMutation.promise;
          throw new Error('fixture rejects the mutation after verification');
        },
      );
    },
  );
  const records = StateStore.prototype.records;
  let holding = false;
  const reading = t.mock.method(
    StateStore.prototype,
    'records',
    async function (this: StateStore, ...args: Parameters<typeof records>) {
      const result = await records.apply(this, args);
      if (holding) {
        holding = false;
        observed.resolve();
        await finishDiscovery.promise;
      }
      return result;
    },
  );
  const state = CoordinationStore.prototype.state;
  let finalizing = false;
  const finalRead = t.mock.method(
    CoordinationStore.prototype,
    'state',
    async function (this: CoordinationStore) {
      const waiting = finalizing;
      finalizing = false;
      const result = await state.call(this);
      if (waiting) {
        finalReadEntered.resolve();
        await finishFinalRead.promise;
      }
      return result;
    },
  );
  const claiming = a.claim('task:chosen');
  try {
    await within(verified.promise, 5000, 'request discovery');
    const peer = (await registry.presences()).find(
      (entry) => entry.id === peerId,
    )!;
    await registry.publish({
      ...peer,
      title: 'Observed before rejection finalizes',
    });
    holding = true;
    refreshes[0]!();
    const refreshing = a.coordination['refreshing']!.promise;
    await within(observed.promise, 5000, 'background discovery');
    finalizing = true;
    finishMutation.resolve();
    await within(
      finalReadEntered.promise,
      5000,
      'failed mutation finalization',
    );
    finishDiscovery.resolve();
    await within(refreshing, 5000, 'background refresh completed');
    finishFinalRead.resolve();
    const result = await claiming;
    if (result.kind !== 'error') assert.fail(JSON.stringify(result));
    assert.match(
      result.message,
      /fixture rejects the mutation after verification/,
    );
    assert.equal(a.coordination.snapshot.ownClaim, undefined);
    assert.deepEqual(await registry.claims(), []);
    assert.equal(
      a.coordination.snapshot.peers[0]?.presence.title,
      'Observed before rejection finalizes',
    );
  } finally {
    finishMutation.resolve();
    finishDiscovery.resolve();
    finishFinalRead.resolve();
    await claiming;
    finalRead.mock.restore();
    reading.mock.restore();
    reserving.mock.restore();
  }
});

await test('a refresh that read the old ledger cannot erase a committed claim', async (t) => {
  const refreshes = pauseDiscovery(t);
  const { start } = await coordinationFixture(t);
  const a = await start();
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const read = CoordinationStore.prototype.state;
  let first = true;
  const reading = t.mock.method(
    CoordinationStore.prototype,
    'state',
    async function (this: CoordinationStore) {
      const ledger = await read.call(this);
      if (first) {
        first = false;
        entered.resolve();
        await finish.promise;
      }
      return ledger;
    },
  );
  try {
    refreshes[0]!();
    await within(entered.promise, 5000, 'old ledger read');
    const result = await a.claim();
    if (result.kind !== 'claimed') assert.fail(JSON.stringify(result));
    assert.deepEqual(a.coordination.snapshot.ownClaim, result.claim);
    const observed: (string | undefined)[] = [];
    const unsubscribe = a.coordination.subscribe(() => {
      observed.push(a.coordination.snapshot.ownClaim?.id);
    });
    try {
      finish.resolve();
      await a.coordination.context();
      assert.deepEqual(a.coordination.snapshot.ownClaim, result.claim);
      assert.ok(
        observed.every((id) => id === result.claim.id),
        JSON.stringify(observed),
      );
    } finally {
      unsubscribe();
    }
  } finally {
    finish.resolve();
    reading.mock.restore();
  }
});
