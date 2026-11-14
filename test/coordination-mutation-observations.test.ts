import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import type {
  CoordinationAction,
  TaskClaim,
} from '../src/core/coordination-state.js';
import { CoordinationStore } from '../src/persistence/coordination.js';
import type { Ledger } from '../src/persistence/coordination.js';
import { callControl } from '../src/persistence/control.js';
import { StateStore } from '../src/persistence/store.js';
import {
  pauseDiscovery,
  unitCoordinationFixture,
} from './fixtures/coordination.js';
import { until, within } from './fixtures/within.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import { resume } from './fixtures/coordination-request-races.js';

/** a discovery read that, once armed, signals `observed` and waits for `finish` before returning. */
function holdDiscovery(observed: { resolve(): void }, finish: Promise<void>) {
  const records = StateStore.prototype.records;

  let holding = false;

  const spy = vi
    .spyOn(StateStore.prototype, 'records')
    .mockImplementation(async function (
      this: StateStore,
      ...args: Parameters<typeof records>
    ) {
      const result = await records.apply(this, args);

      if (holding) {
        holding = false;

        observed.resolve();

        await finish;
      }

      return result;
    });

  return {
    arm: () => {
      holding = true;
    },
    mockRestore: () => spy.mockRestore(),
  };
}

test('a pre-mutation refresh cannot publish old ownership after commit', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const { start, registry } = await unitCoordinationFixture(cleanup);

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

  const reading = vi
    .spyOn(CoordinationStore.prototype, 'state')
    .mockImplementation(async function (
      this: CoordinationStore,
      ...args: Parameters<typeof read>
    ) {
      const ledger = await read.apply(this, args);

      if (++reads === 2) {
        readEntered.resolve();

        await finishRead.promise;
      }

      return ledger;
    });

  const reserving = vi
    .spyOn(CoordinationStore.prototype, 'claim')
    .mockImplementation(async function (
      this: CoordinationStore,
      ...args: Parameters<typeof claim>
    ) {
      const result = await claim.apply(this, args);

      committed.resolve(result);

      await finishMutation.promise;

      return result;
    });

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

    reading.mockRestore();

    reserving.mockRestore();
  }
});

for (const outcome of ['success', 'failure'] as const)
  test(`newer background discovery ${outcome} survives mutation completion`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);

    const refreshes = pauseDiscovery(vi.spyOn);

    const assignmentEntered = Promise.withResolvers<void>(),
      finishAssignment = Promise.withResolvers<void>();

    const { start, store, registry } = await unitCoordinationFixture(
      cleanup,
      async () => {
        assignmentEntered.resolve();

        await finishAssignment.promise;

        return { assigned: [] };
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

    const reserving = vi
      .spyOn(CoordinationStore.prototype, 'claim')
      .mockImplementation(async function (
        this: CoordinationStore,
        ...args: Parameters<typeof claim>
      ) {
        const value = await claim.apply(this, args);

        committed.resolve(value);

        await finishMutation.promise;

        return value;
      });

    const reading = holdDiscovery(observed, finishDiscovery.promise);

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

      reading.arm();

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

      reading.mockRestore();

      reserving.mockRestore();
    }
  });

for (const stage of ['waiting', 'verifying'] as const)
  test(`a refresh started while ${stage} never publishes ownership older than the commit`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);

    const refreshes = pauseDiscovery(vi.spyOn);

    const { start, registry } = await unitCoordinationFixture(cleanup);

    const a = await start(),
      b = await start('B');

    const peerId = b.coordinator.snapshot.conversation!.id;

    await until('peer idle presence written', async () =>
      (await registry.presences()).some(
        (peer) => peer.id === peerId && peer.phase === 'idle',
      ),
    );

    const entered = Promise.withResolvers<void>(),
      proceed = Promise.withResolvers<void>(),
      committed = Promise.withResolvers<TaskClaim>(),
      finishMutation = Promise.withResolvers<void>(),
      readEntered = Promise.withResolvers<void>(),
      readCompleted = Promise.withResolvers<void>(),
      observed = Promise.withResolvers<void>(),
      finishDiscovery = Promise.withResolvers<void>();

    const claim = CoordinationStore.prototype.claim;

    const reserving = vi
      .spyOn(CoordinationStore.prototype, 'claim')
      .mockImplementation(async function (
        this: CoordinationStore,
        ...[owner, input, process, deadline, verify]: Parameters<typeof claim>
      ) {
        if (stage === 'waiting') {
          entered.resolve();

          await proceed.promise;
        }

        const value = await claim.call(
          this,
          owner,
          input,
          process,
          deadline,
          async (ledger) => {
            await verify(ledger);

            if (stage === 'verifying') {
              entered.resolve();

              await proceed.promise;
            }
          },
        );

        committed.resolve(value);

        await finishMutation.promise;

        return value;
      });

    let capture = false;

    const state = CoordinationStore.prototype.state;

    const reading = vi
      .spyOn(CoordinationStore.prototype, 'state')
      .mockImplementation(async function (
        this: CoordinationStore,
        ...args: Parameters<typeof state>
      ) {
        const pending = state.apply(this, args);

        if (!capture) return pending;

        capture = false;

        readEntered.resolve();

        const value = await pending;

        readCompleted.resolve();

        return value;
      });

    const discovering = holdDiscovery(observed, finishDiscovery.promise);

    const claiming = a.claim('task:chosen');

    let unsubscribe = () => {};

    try {
      await within(entered.promise, 5000, 'mutation entered');

      const peer = (await registry.presences()).find(
        (entry) => entry.id === peerId,
      )!;

      await registry.publish({ ...peer, title: 'Observed while pending' });

      capture = true;

      discovering.arm();

      refreshes[0]!();

      const refreshing = a.coordination['refreshing']!.promise;

      await within(
        Promise.all([readEntered.promise, observed.promise]),
        5000,
        'refresh started',
      );

      if (stage === 'waiting')
        await within(
          readCompleted.promise,
          5000,
          'pre-verification ledger read',
        );

      proceed.resolve();

      const own = await within(committed.promise, 5000, 'claim committed');

      assert.deepEqual((await state.call(registry)).claims, [own]);

      const publications: (string | undefined)[] = [];

      unsubscribe = a.coordination.subscribe(() => {
        publications.push(a.coordination.snapshot.ownClaim?.id);
      });

      finishDiscovery.resolve();

      await within(refreshing, 5000, 'post-commit refresh');

      if (stage === 'waiting') assert.deepEqual(publications, []);
      else {
        assert.deepEqual(a.coordination.snapshot.ownClaim, own);

        assert.ok(publications.length > 0);
      }

      finishMutation.resolve();

      const result = await claiming;

      if (result.kind !== 'claimed') assert.fail(JSON.stringify(result));

      assert.deepEqual(result.claim, own);

      assert.deepEqual(a.coordination.snapshot.ownClaim, own);

      assert.ok(publications.length > 0);

      assert.ok(publications.every((id) => id === own.id));

      assert.equal(
        a.coordination.snapshot.peers[0]?.presence.title,
        'Observed while pending',
      );
    } finally {
      unsubscribe();

      proceed.resolve();

      finishDiscovery.resolve();

      finishMutation.resolve();

      await claiming;

      discovering.mockRestore();

      reading.mockRestore();

      reserving.mockRestore();
    }
  });

test('a refresh started during verification retains peer claims after mutation completion', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const refreshes = pauseDiscovery(vi.spyOn);

  const assignmentEntered = Promise.withResolvers<void>(),
    finishAssignment = Promise.withResolvers<void>();

  const { start, registry } = await unitCoordinationFixture(
    cleanup,
    async (references) => {
      if (!references.some((reference) => reference.endsWith(':chosen')))
        return { assigned: [] };

      assignmentEntered.resolve();

      await finishAssignment.promise;

      return { assigned: [] };
    },
  );

  const a = await start(),
    b = await start('B');

  const local = a.coordination['registry'];

  const entered = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>(),
    readEntered = Promise.withResolvers<void>(),
    finishRead = Promise.withResolvers<void>(),
    readCompleted = Promise.withResolvers<Ledger>(),
    finishRefresh = Promise.withResolvers<void>(),
    committed = Promise.withResolvers<TaskClaim>(),
    finishMutation = Promise.withResolvers<void>();

  const claim = local.claim.bind(local);

  const reserving = vi
    .spyOn(local, 'claim')
    .mockImplementation(
      async (
        ...[owner, input, process, deadline, verify]: Parameters<typeof claim>
      ) => {
        const result = await claim(
          owner,
          input,
          process,
          deadline,
          async (ledger) => {
            await verify(ledger);

            entered.resolve();

            await proceed.promise;
          },
        );

        committed.resolve(result);

        await finishMutation.promise;

        return result;
      },
    );

  const state = local.state.bind(local);

  let background = false;

  const reading = vi
    .spyOn(local, 'state')
    .mockImplementation(async (...args: Parameters<typeof state>) => {
      if (background) {
        background = false;

        readEntered.resolve();

        await resume(finishRead.promise, args);

        const ledger = await state(...args);

        readCompleted.resolve(ledger);

        await finishRefresh.promise;

        return ledger;
      }

      return state(...args);
    });

  const claiming = a.claim('task:chosen', 'Own work');

  let refreshing: Promise<void> | undefined;

  try {
    await within(entered.promise, 5000, 'mutation verification');

    background = true;

    refreshes[0]!();

    refreshing = a.coordination['refreshing']!.promise;

    await within(readEntered.promise, 5000, 'background read started');

    proceed.resolve();

    const own = await within(committed.promise, 5000, 'own claim committed');

    const peerResult = await b.claim('task:peer', 'Later peer work');

    if (peerResult.kind !== 'claimed') assert.fail(JSON.stringify(peerResult));

    const peer = peerResult.claim;

    finishRead.resolve();

    assert.deepEqual(
      (await within(readCompleted.promise, 5000, 'newer background ledger'))
        .claims,
      [own, peer],
    );

    finishMutation.resolve();

    await within(assignmentEntered.promise, 5000, 'mutation completion');

    finishRefresh.resolve();

    await within(refreshing, 5000, 'refresh completes after mutation');

    finishAssignment.resolve();

    const result = await within(claiming, 5000, 'claim finalized');

    assert.equal(result.kind, 'claimed');

    assert.deepEqual(a.coordination.snapshot.ownClaim, own);

    assert.deepEqual(a.coordination.snapshot.peers[0]?.claim, peer);

    assert.deepEqual((await registry.state()).claims, [own, peer]);
  } finally {
    proceed.resolve();

    finishRead.resolve();

    finishMutation.resolve();

    finishRefresh.resolve();

    finishAssignment.resolve();

    await claiming;

    await refreshing;

    reading.mockRestore();

    reserving.mockRestore();
  }
});

for (const readFails of [false, true])
  test(`post-commit finalization preserves peer claims${readFails ? ' after a later read fails' : ''}`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);

    const refreshes = pauseDiscovery(vi.spyOn);

    const { start, registry } = await unitCoordinationFixture(cleanup);

    const a = await start(),
      b = await start('B');

    const owner = a.coordinator.snapshot.conversation!.id;

    const committed = Promise.withResolvers<TaskClaim>(),
      finishMutation = Promise.withResolvers<void>();

    const claim = CoordinationStore.prototype.claim;

    const reserving = vi
      .spyOn(CoordinationStore.prototype, 'claim')
      .mockImplementation(async function (
        this: CoordinationStore,
        ...args: Parameters<typeof claim>
      ) {
        const value = await claim.apply(this, args);

        if (args[0].conversation === owner) {
          committed.resolve(value);

          await finishMutation.promise;
        }

        return value;
      });

    const state = CoordinationStore.prototype.state;

    let failing = false;

    const reading = vi
      .spyOn(CoordinationStore.prototype, 'state')
      .mockImplementation(async function (
        this: CoordinationStore,
        ...args: Parameters<typeof state>
      ) {
        if (failing) throw new Error('fixture cannot read the ledger');

        return state.apply(this, args);
      });

    const claiming = a.claim('task:chosen');

    let unsubscribe = () => {};

    try {
      const own = await within(committed.promise, 5000, 'own claim committed');

      const peer = await b.claim('task:peer', 'Peer work after commit');

      if (peer.kind !== 'claimed') assert.fail(JSON.stringify(peer));

      refreshes[0]!();

      await within(
        a.coordination['refreshing']!.promise,
        5000,
        'overlapping refresh',
      );

      assert.deepEqual(a.coordination.snapshot.ownClaim, own);

      assert.deepEqual(a.coordination.snapshot.peers[0]?.claim, peer.claim);

      const observed: (string | undefined)[][] = [];

      unsubscribe = a.coordination.subscribe(() => {
        observed.push([
          a.coordination.snapshot.ownClaim?.id,
          a.coordination.snapshot.peers[0]?.claim?.id,
        ]);
      });

      failing = readFails;

      if (readFails) {
        // nothing changed since the last tick, so the gated tick would start no refresh
        void a.coordination['refresh']();

        await within(
          a.coordination['refreshing']!.promise,
          5000,
          'later ledger read fails',
        );
      }

      finishMutation.resolve();

      const result = await within(claiming, 5000, 'claim finalized');

      if (result.kind !== 'claimed') assert.fail(JSON.stringify(result));

      assert.deepEqual(result.claim, own);

      assert.deepEqual((await state.call(registry)).claims, [own, peer.claim]);

      assert.deepEqual(a.coordination.snapshot.ownClaim, own);

      assert.deepEqual(a.coordination.snapshot.peers[0]?.claim, peer.claim);

      assert.ok(
        observed.every(
          ([ownId, peerId]) => ownId === own.id && peerId === peer.claim.id,
        ),
        JSON.stringify(observed),
      );

      if (readFails) {
        assert.match(
          a.coordination.snapshot.error ?? '',
          /fixture cannot read the ledger/,
        );

        failing = false;

        await a.coordination.context();
      }

      assert.equal(a.coordination.snapshot.error, undefined);
    } finally {
      failing = false;

      unsubscribe();

      finishMutation.resolve();

      await claiming;

      reading.mockRestore();

      reserving.mockRestore();
    }
  });

for (const kind of ['claim', 'release'] as const)
  test(`committed ${kind} remains published after an overlapping ledger read fails`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);

    const refreshes = pauseDiscovery(vi.spyOn);

    const { start, store } = await unitCoordinationFixture(cleanup);

    const a = await start();

    const binding = await a.binding();

    let action: CoordinationAction = {
      kind: 'claim',
      input: { reference: 'task:chosen', summary: 'Chosen work' },
    };

    if (kind === 'release') {
      const owned = await a.claim('task:chosen');

      if (owned.kind !== 'claimed') assert.fail(JSON.stringify(owned));

      action = { kind: 'release', claim: owned.claim.id };
    }

    const local = a.coordination['registry'];

    const entered = Promise.withResolvers<void>(),
      finishRead = Promise.withResolvers<void>(),
      committed = Promise.withResolvers<void>(),
      finishMutation = Promise.withResolvers<void>();

    const state = local.state.bind(local);

    let first = true;

    const reading = vi
      .spyOn(local, 'state')
      .mockImplementation(async (...args: Parameters<typeof state>) => {
        if (first) {
          first = false;

          entered.resolve();

          await resume(finishRead.promise, args);
        }

        return state(...args);
      });

    const hold = async <T>(operation: Promise<T>): Promise<T> => {
      const result = await operation;

      committed.resolve();

      await finishMutation.promise;

      return result;
    };

    const claim = local.claim.bind(local);

    const release = local.release.bind(local);

    const changing =
      kind === 'claim'
        ? vi
            .spyOn(local, 'claim')
            .mockImplementation((...args: Parameters<typeof claim>) =>
              hold(claim(...args)),
            )
        : vi
            .spyOn(local, 'release')
            .mockImplementation((...args: Parameters<typeof release>) =>
              hold(release(...args)),
            );

    const file = join(store.root, 'coordination', 'claims.json');

    let saved: string | undefined;

    let request: ReturnType<typeof callControl> | undefined;

    refreshes[0]!();

    const refreshing = a.coordination['refreshing']!.promise;

    try {
      await within(entered.promise, 5000, 'background read begins');

      request = callControl(binding, action);

      await within(committed.promise, 5000, 'mutation commits');

      saved = await readFile(file, 'utf8');

      await writeFile(file, '{broken');

      finishRead.resolve();

      await within(refreshing, 5000, 'background ledger read fails');

      const failure = a.coordination.snapshot.error;

      assert.ok(failure);

      finishMutation.resolve();

      const result = await within(request, 5000, 'control result');

      assert.equal(result.kind, kind === 'claim' ? 'claimed' : 'released');

      const expected = result.kind === 'claimed' ? result.claim : undefined;

      assert.deepEqual(a.coordination.snapshot.ownClaim, expected);

      assert.equal(a.coordination.snapshot.error, failure);

      await writeFile(file, saved);

      assert.deepEqual((await state()).claims, expected ? [expected] : []);

      const recovered = await a.query();

      assert.equal(recovered.error, undefined);

      assert.deepEqual(recovered.ownClaim, expected);
    } finally {
      finishRead.resolve();

      finishMutation.resolve();

      await request;

      await refreshing;

      if (saved !== undefined) await writeFile(file, saved);

      reading.mockRestore();

      changing.mockRestore();
    }
  });

test('a newer discovery survives rejected mutation completion', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const refreshes = pauseDiscovery(vi.spyOn);

  const { start, registry } = await unitCoordinationFixture(cleanup);

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

  const reserving = vi
    .spyOn(CoordinationStore.prototype, 'claim')
    .mockImplementation(async function (
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
    });

  const reading = holdDiscovery(observed, finishDiscovery.promise);

  const state = CoordinationStore.prototype.state;

  let finalizing = false;

  const finalRead = vi
    .spyOn(CoordinationStore.prototype, 'state')
    .mockImplementation(async function (
      this: CoordinationStore,
      ...args: Parameters<typeof state>
    ) {
      const waiting = finalizing;

      finalizing = false;

      const result = await state.apply(this, args);

      if (waiting) {
        finalReadEntered.resolve();

        await finishFinalRead.promise;
      }

      return result;
    });

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

    reading.arm();

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

    finalRead.mockRestore();

    reading.mockRestore();

    reserving.mockRestore();
  }
});

test('a refresh that read the old ledger cannot erase a committed claim', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const refreshes = pauseDiscovery(vi.spyOn);

  const { start } = await unitCoordinationFixture(cleanup);

  const a = await start();

  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();

  const read = CoordinationStore.prototype.state;

  let first = true;

  const reading = vi
    .spyOn(CoordinationStore.prototype, 'state')
    .mockImplementation(async function (
      this: CoordinationStore,
      ...args: Parameters<typeof read>
    ) {
      const ledger = await read.apply(this, args);

      if (first) {
        first = false;

        entered.resolve();

        await finish.promise;
      }

      return ledger;
    });

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

    reading.mockRestore();
  }
});
