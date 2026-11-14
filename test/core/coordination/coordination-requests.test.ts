import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import type { CoordinationAction } from '../../../src/core/coordination/coordination-state.js';
import { CoordinationStore } from '../../../src/persistence/coordination.js';
import { callControl } from '../../../src/persistence/control.js';
import {
  measureControl,
  pauseDiscovery,
  unitCoordinationFixture,
} from '../../fixtures/coordination.js';
import { selectionTurn } from '../../fixtures/task-selection.js';
import { until, within } from '../../fixtures/within.js';
import { orderedCleanup } from '../../fixtures/cleanup.js';
import { resume } from '../../fixtures/coordination-request-races.js';

for (const kind of [
  'peers',
  'claim',
  'release',
  'select-next',
  'selection-status',
  'recommend',
  'cancel-selection',
  'ask',
  'answer',
  'peer-request',
] as const)
  test(`${kind} discovers once and publishes the resulting ownership`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);

    pauseDiscovery(vi.spyOn);

    const { start } = await unitCoordinationFixture(cleanup);

    const a = await start(),
      b = await start('B');

    const peer = await b.claim('task:peer', 'Peer work');

    if (peer.kind !== 'claimed') assert.fail(JSON.stringify(peer));

    const turn = await selectionTurn(cleanup, a);
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

      case 'ask':
        action = { kind, claim: peer.claim.id, message: 'Which port?' };
        expected = 'peer-request';

        break;

      case 'answer': {
        const claimed = await a.claim('task:chosen', 'Chosen work');

        if (claimed.kind !== 'claimed') assert.fail(JSON.stringify(claimed));

        const asked = await callControl(await b.binding(), {
          kind: 'ask',
          claim: claimed.claim.id,
          message: 'Which port?',
        });

        if (asked.kind !== 'peer-request') assert.fail(JSON.stringify(asked));

        action = { kind, request: asked.request.id, message: '4000' };
        expected = 'peer-request';

        break;
      }

      case 'peer-request': {
        const asked = await callControl(turn.binding, {
          kind: 'ask',
          claim: peer.claim.id,
          message: 'Which port?',
        });

        if (asked.kind !== 'peer-request') assert.fail(JSON.stringify(asked));

        action = { kind, request: asked.request.id };
        expected = 'peer-request';

        break;
      }

      default:
        action = { kind, selection: (await turn.select()).ticket.id };

        expected =
          kind === 'selection-status' ? 'selection' : 'selection-cancelled';
    }

    try {
      const { value, discoveries, reads } = await measureControl(vi.spyOn, () =>
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

test('human release reuses its lookup and publishes the released state', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const { start, registry } = await unitCoordinationFixture(cleanup);
  const a = await start();

  assert.equal((await a.claim()).kind, 'claimed');

  const measured = await measureControl(vi.spyOn, () =>
    a.coordination.releaseTask(),
  );

  assert.equal(a.coordination.snapshot.ownClaim, undefined);

  assert.deepEqual(await registry.claims(), []);

  assert.equal(measured.discoveries, 1);

  assert.equal(measured.reads, 2);
});

test('a later query reads the peer reservation made between requests', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const { start } = await unitCoordinationFixture(cleanup);

  const a = await start(),
    b = await start('B');

  assert.equal((await a.query()).peers[0]?.claim, undefined);

  const reserved = await b.claim('task:new-owner', 'New reservation');

  if (reserved.kind !== 'claimed') assert.fail(JSON.stringify(reserved));

  const { value, discoveries, reads } = await measureControl(vi.spyOn, () =>
    a.query(),
  );

  assert.deepEqual(value.peers[0]?.claim, reserved.claim);

  assert.equal(discoveries, 1);

  assert.equal(reads, 1);
});

for (const stage of ['acquisition', 'completion'] as const)
  test(`peer claims survive delayed read ${stage}`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);
    const refreshes = pauseDiscovery(vi.spyOn);
    const { start, store } = await unitCoordinationFixture(cleanup);

    const a = await start(),
      b = await start('B');

    const peerId = b.coordinator.snapshot.conversation!.id;

    const entered = Promise.withResolvers<void>(),
      finishRead = Promise.withResolvers<void>(),
      requestRead = Promise.withResolvers<void>(),
      discovering = Promise.withResolvers<void>(),
      finishDiscovery = Promise.withResolvers<void>();

    const state = CoordinationStore.prototype.state;
    let first = true;

    const reading = vi
      .spyOn(CoordinationStore.prototype, 'state')
      .mockImplementation(async function (
        this: CoordinationStore,
        ...args: Parameters<typeof state>
      ) {
        const background = first;
        first = false;

        if (background && stage === 'acquisition') {
          entered.resolve();

          await resume(finishRead.promise, args);
        }

        const ledger = await state.apply(this, args);

        if (background && stage === 'completion') {
          entered.resolve();

          await finishRead.promise;
        }

        if (!background) requestRead.resolve();

        return ledger;
      });

    const open = store.openConversations.bind(store);
    let discoveries = 0;

    const observing = vi
      .spyOn(store, 'openConversations')
      .mockImplementation(async (...args: Parameters<typeof open>) => {
        if (
          stage === 'acquisition' &&
          args[0] === undefined &&
          ++discoveries === 2
        ) {
          discovering.resolve();

          await finishDiscovery.promise;
        }

        return open(...args);
      });

    let request: ReturnType<typeof a.query> | undefined;
    let unsubscribe = () => {};

    refreshes[0]!();

    const refreshing = a.coordination['refreshing']!.promise;

    try {
      await within(entered.promise, 5000, 'background read paused');

      if (stage === 'acquisition') {
        request = a.query();

        await within(
          Promise.all([requestRead.promise, discovering.promise]),
          5000,
          'request reads before background',
        );
      }

      const claimed = await b.claim('task:ordered-read', 'Latest peer claim');

      if (claimed.kind !== 'claimed') assert.fail(JSON.stringify(claimed));

      request ??= a.query();

      if (stage === 'completion') await request;
      else {
        finishRead.resolve();

        await within(refreshing, 5000, 'background reads the latest ledger');
      }

      const peerClaim = () =>
        a.coordination.snapshot.peers.find(
          (peer) => peer.presence.id === peerId,
        )?.claim;

      assert.deepEqual(peerClaim(), claimed.claim);

      const publications: (string | undefined)[] = [];

      unsubscribe = a.coordination.subscribe(() => {
        publications.push(peerClaim()?.id);
      });

      finishRead.resolve();

      finishDiscovery.resolve();

      await within(refreshing, 5000, 'background refresh completes');

      const response = await request;

      assert.deepEqual(
        response.peers.find((peer) => peer.presence.id === peerId)?.claim,
        claimed.claim,
      );

      assert.deepEqual(peerClaim(), claimed.claim);

      assert.ok(publications.every((id) => id === claimed.claim.id));
    } finally {
      unsubscribe();

      finishRead.resolve();

      finishDiscovery.resolve();

      await request?.catch(() => {});

      await refreshing;

      observing.mockRestore();

      reading.mockRestore();
    }
  });

test('an older successful ledger read cannot clear a later read failure', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const refreshes = pauseDiscovery(vi.spyOn);
  const { start, store } = await unitCoordinationFixture(cleanup);
  const a = await start();
  const reserved = await a.claim('task:known', 'Known work');

  if (reserved.kind !== 'claimed') assert.fail(JSON.stringify(reserved));

  const binding = await a.binding();
  const file = join(store.root, 'coordination', 'claims.json');
  const original = await readFile(file, 'utf8');

  const entered = Promise.withResolvers<void>(),
    finishRead = Promise.withResolvers<void>(),
    requestRead = Promise.withResolvers<void>(),
    discovering = Promise.withResolvers<void>(),
    finishDiscovery = Promise.withResolvers<void>();

  const local = a.coordination['registry'];
  const lock = local['lock'];
  let first = true;

  local['lock'] = async (...args: Parameters<typeof lock>) => {
    if (first) {
      first = false;

      entered.resolve();

      await resume(finishRead.promise, args);
    }

    return lock.call(local, ...args);
  };

  const state = local.state.bind(local);
  let failure: unknown;

  const reading = vi
    .spyOn(local, 'state')
    .mockImplementation(async (...args: Parameters<typeof state>) => {
      try {
        const ledger = await state(...args);

        requestRead.resolve();

        return ledger;
      } catch (error) {
        failure = error;

        throw error;
      }
    });

  const open = store.openConversations.bind(store);
  let discoveries = 0;

  const observing = vi
    .spyOn(store, 'openConversations')
    .mockImplementation(async (...args: Parameters<typeof open>) => {
      if (args[0] === undefined && ++discoveries === 2) {
        discovering.resolve();

        await finishDiscovery.promise;
      }

      return open(...args);
    });

  let request: ReturnType<typeof callControl> | undefined;

  refreshes[0]!();

  const refreshing = a.coordination['refreshing']!.promise;

  try {
    await within(entered.promise, 5000, 'background read paused');

    request = callControl(binding, { kind: 'peers' });

    await within(
      Promise.all([requestRead.promise, discovering.promise]),
      5000,
      'request read before background',
    );

    await writeFile(file, '{broken');

    finishRead.resolve();

    await within(refreshing, 5000, 'later ledger read fails');

    assert.ok(failure instanceof SyntaxError);

    const error = a.coordination.snapshot.error;

    assert.ok(error, 'ledger read failure is visible');

    finishDiscovery.resolve();

    const result = await within(
      request,
      5000,
      'request completes after failed read',
    );

    if (result.kind !== 'error') assert.fail(JSON.stringify(result));

    assert.equal(result.message, error);

    assert.equal(a.coordination.snapshot.error, error);

    assert.deepEqual(a.coordination.snapshot.ownClaim, reserved.claim);

    await writeFile(file, original);

    const recovered = await a.query();

    assert.equal(recovered.error, undefined);

    assert.deepEqual(recovered.ownClaim, reserved.claim);
  } finally {
    finishRead.resolve();

    finishDiscovery.resolve();

    await writeFile(file, original);

    await request;

    await refreshing;

    observing.mockRestore();

    reading.mockRestore();

    local['lock'] = lock;
  }
});

test('an older ledger failure cannot replace a later successful observation', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const refreshes = pauseDiscovery(vi.spyOn);
  const { start, store } = await unitCoordinationFixture(cleanup);
  const a = await start();
  const reserved = await a.claim('task:known', 'Known work');

  if (reserved.kind !== 'claimed') assert.fail(JSON.stringify(reserved));

  const file = join(store.root, 'coordination', 'claims.json');
  const original = await readFile(file, 'utf8');

  const failed = Promise.withResolvers<unknown>(),
    finishFailure = Promise.withResolvers<void>();

  const local = a.coordination['registry'];
  const state = local.state.bind(local);
  let first = true;

  const reading = vi
    .spyOn(local, 'state')
    .mockImplementation(async (...args: Parameters<typeof state>) => {
      const background = first;
      first = false;

      try {
        return await state(...args);
      } catch (error) {
        if (background) {
          failed.resolve(error);

          await finishFailure.promise;
        }

        throw error;
      }
    });

  let refreshing: Promise<void> | undefined;

  try {
    await writeFile(file, '{broken');

    refreshes[0]!();

    refreshing = a.coordination['refreshing']!.promise;

    assert.ok(
      (await within(
        failed.promise,
        5000,
        'background ledger read fails',
      )) instanceof SyntaxError,
    );

    await writeFile(file, original);

    const recovered = await a.query();

    assert.equal(recovered.error, undefined);

    assert.deepEqual(recovered.ownClaim, reserved.claim);

    finishFailure.resolve();

    await within(refreshing, 5000, 'older failure completes');

    assert.equal(a.coordination.snapshot.error, undefined);

    assert.deepEqual(a.coordination.snapshot.ownClaim, reserved.claim);
  } finally {
    finishFailure.resolve();

    await writeFile(file, original);

    await refreshing;

    reading.mockRestore();
  }
});

test('cancellation publishes the next waiter without another discovery', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const { start } = await unitCoordinationFixture(cleanup);

  const a = await start(),
    b = await start('B');

  const first = await selectionTurn(cleanup, a),
    second = await selectionTurn(cleanup, b);

  try {
    const head = await first.select(),
      queued = await second.select();

    assert.equal(queued.position, 2);

    const result = await measureControl(vi.spyOn, () =>
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

test('claim finalization preserves newer background observations', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const refreshes = pauseDiscovery(vi.spyOn);

  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();

  const { start, registry } = await unitCoordinationFixture(
    cleanup,
    async () => {
      entered.resolve();

      await finish.promise;

      return { assigned: [] };
    },
  );

  const a = await start(),
    b = await start('B');

  const peerId = b.coordinator.snapshot.conversation!.id;

  // the peer's own idle write would otherwise replace the title written below
  await until('peer idle presence written', async () =>
    (await registry.presences()).some(
      (peer) => peer.id === peerId && peer.phase === 'idle',
    ),
  );

  const claiming = a.claim('task:chosen');

  try {
    await within(entered.promise, 5000, 'assignment');

    const peer = (await registry.presences()).find(
      (entry) => entry.id === peerId,
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

test('claim finalization preserves a newer discovery failure until recovery', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const refreshes = pauseDiscovery(vi.spyOn);

  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();

  const { start, store } = await unitCoordinationFixture(cleanup, async () => {
    entered.resolve();

    await finish.promise;

    return { assigned: [] };
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
