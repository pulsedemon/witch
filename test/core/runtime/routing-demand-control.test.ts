import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Work, Policy } from '../../../src/core/runtime/routing.js';
import { defaultPolicy } from '../../../src/core/runtime/routing.js';
import { router } from '../../../src/core/runtime/router.js';
import type { Coordinator } from '../../../src/core/coordinator.js';
import { callControl } from '../../../src/persistence/control.js';
import {
  coordinationFixture,
  unitCoordinationFixture,
} from '../../fixtures/coordination.js';
import {
  orderedCleanup,
  type RegisterCleanup,
} from '../../fixtures/cleanup.js';
import { TurnGate } from '../../fixtures/agent.js';
import { until } from '../../fixtures/within.js';

async function setup(
  register: RegisterCleanup,
  fixture = unitCoordinationFixture,
) {
  const f = await fixture(orderedCleanup(register));
  const session = await f.start('A');
  const peer = await f.start('C');
  session.a.catalog.splice(0, 2, { id: 'a-2-model', label: 'A2', efforts: [] });
  session.b.catalog.splice(0, 2, { id: 'b-3-model', label: 'B3', efforts: [] });
  await session.coordinator.refreshModels();
  await session.coordinator.selectModel({ agent: 'b', id: 'b-3-model' });
  assert.equal(session.coordinator.snapshot.native!.agent, 'b');

  await until('initialized peers are idle', async () =>
    (await f.registry.presences()).every(({ phase }) => phase === 'idle'),
  );

  const policy: Policy = {
    ...defaultPolicy,
    families: { a: 'model', b: 'model' },
  };

  session.coordination.router = router(
    session.coordinator,
    { read: async () => policy },
    (deadline) => session.coordination.routingDemand(deadline),
  );

  const report = (a = 93, b = 70, aHours = 67, bHours = 141) => {
    const now = Date.now();

    for (const [runtime, percent, hours] of [
      ['a', a, aHours],
      ['b', b, bHours],
    ] as const)
      session.coordinator.accountUsage.report(runtime, {
        limits: [
          {
            window: '7D',
            percent,
            observedAt: now,
            resetsAt: now / 1000 + hours * 3600,
          },
        ],
      });
  };

  report();

  const route = async (work: Work = 'review') => {
    const result = await callControl(await session.binding(), {
      kind: 'route',
      work,
      of: { runtime: 'b', model: 'b-3-model' },
    });

    if (result.kind !== 'route') assert.fail(JSON.stringify(result));

    return result;
  };

  return { session, peer, registry: f.registry, report, route, policy };
}

test('a coordinator in another project protects its runtime only while active and under pressure', async (t) => {
  const f = await setup(t.onTestFinished);
  const peerId = f.peer.coordinator.snapshot.conversation!.id;

  assert.deepEqual(
    (await f.route()).routes.map(({ runtime }) => runtime),
    ['a', 'b'],
  );

  const gate = new TurnGate();
  f.peer.a.gate = gate;
  const sending = f.peer.coordinator.send('Work');
  await gate.entered;

  try {
    await until('active peer', async () =>
      (await f.registry.presences()).some(
        (p) => p.id === peerId && p.phase === 'running',
      ),
    );

    const protectedRoute = await f.route();

    assert.deepEqual(
      protectedRoute.routes.map(({ runtime }) => runtime),
      ['b'],
    );

    assert.equal(protectedRoute.folded?.[0]?.from, 'a');
    assert.match(protectedRoute.folded![0]!.reason, /a: 1 active coordinator/);
    assert.match(protectedRoute.folded![0]!.reason, /reserving a capacity/);
    f.report(40, 70);

    assert.deepEqual(
      (await f.route()).routes.map(({ runtime }) => runtime),
      ['a', 'b'],
    );
  } finally {
    gate.open();
    await sending;
  }

  f.report();

  await until('idle peer', async () =>
    (await f.registry.presences()).some(
      (p) => p.id === peerId && p.phase === 'idle',
    ),
  );

  assert.deepEqual(
    (await f.route()).routes.map(({ runtime }) => runtime),
    ['a', 'b'],
  );
});

test('the current caller counts once and observed familiar runtime load changes later automatic placements', async (t) => {
  const f = await setup(t.onTestFinished);
  const gate = new TurnGate();
  f.session.b.gate = gate;
  const sending = f.session.coordinator.send('Work');
  await gate.entered;

  try {
    assert.equal(
      (await f.session.coordination.routingDemand(Date.now() + 3000))
        .coordinators.b,
      1,
    );
  } finally {
    gate.open();
    await sending;
  }

  f.report(80, 60, 24, 144);

  const concurrent = await Promise.all([
    f.route('implementation'),
    f.route('implementation'),
  ]);

  assert.ok(concurrent.every(({ routes }) => routes[0]!.runtime === 'a'));
  const emit = f.peer.a.sessions.at(-1)!.options.onEvent;
  const peerId = f.peer.coordinator.snapshot.conversation!.id;

  for (const status of ['running', 'completed'] as const) {
    for (let i = 0; i < 3; i++)
      emit({
        type: 'subagent',
        subagent: {
          id: `load-${i}`,
          name: 'load',
          kind: 'review',
          runtime: 'a',
          model: 'a-2-model',
          status,
        },
      });

    await until('familiar counts published', async () =>
      (await f.registry.presences()).some(
        (p) =>
          p.id === peerId && p.familiars === (status === 'running' ? 3 : 0),
      ),
    );

    const result = await f.route('implementation');
    assert.equal(result.routes[0]!.runtime, status === 'running' ? 'b' : 'a');

    if (status === 'running')
      assert.match(
        result.routes[0]!.reason,
        /a: 1 active coordinator, 3 running familiars/,
      );
  }
});

test('native background work retains its reserve while a memory edit holds the operation phase', async (t) => {
  const f = await setup(t.onTestFinished, coordinationFixture);
  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();

  const editFile: ConstructorParameters<typeof Coordinator>[4] = async () => {
    opened.resolve();
    await closed.promise;
  };

  Object.defineProperty(f.peer.coordinator, 'editFile', { value: editFile });
  const editing = f.peer.coordinator.editMemory();
  void editing.catch(opened.reject);
  await opened.promise;
  const emit = f.peer.a.sessions.at(-1)!.options.onEvent;
  const id = f.peer.coordinator.snapshot.conversation!.id;

  try {
    for (const running of [false, true, false]) {
      emit({ type: 'running', running });

      await until('native activity published beside the edit', async () =>
        (await f.registry.presences()).some(
          (p) =>
            p.id === id && p.phase === 'editing' && p.nativeRunning === running,
        ),
      );

      const result = await f.route();

      assert.deepEqual(
        result.routes.map(({ runtime }) => runtime),
        running ? ['b'] : ['a', 'b'],
      );

      if (running)
        assert.match(result.folded![0]!.reason, /a: 1 active coordinator/);
    }
  } finally {
    emit({ type: 'running', running: false });
    closed.resolve();
    await editing;
  }
});

test('unregistered owners and legacy activity records keep workload uncertain instead of making a runtime idle', async (t) => {
  const f = await setup(t.onTestFinished);
  const id = f.peer.coordinator.snapshot.conversation!.id;
  const presence = (await f.registry.presences()).find((p) => p.id === id)!;

  await f.registry.publish({
    ...presence,
    familiars: 1,
    familiarRuntimes: undefined,
  });

  const legacy = await f.route();

  assert.deepEqual(
    legacy.routes.map(({ runtime }) => runtime),
    ['b'],
  );

  assert.match(legacy.folded![0]!.reason, /familiar load unknown/);

  await f.registry.publish({
    ...presence,
    phase: 'editing',
    nativeRunning: undefined,
  });

  const unknownNative = await f.route();

  assert.deepEqual(
    unknownNative.routes.map(({ runtime }) => runtime),
    ['b'],
  );

  assert.match(unknownNative.folded![0]!.reason, /a workload unknown/);
  await f.registry.removePresence(id, presence.activation);
  const unknown = await f.route();

  assert.deepEqual(
    unknown.routes.map(({ runtime }) => runtime),
    ['b'],
  );

  assert.match(unknown.folded![0]!.reason, /a workload unknown/);
  await f.registry.publish(presence);

  assert.deepEqual(
    (await f.route()).routes.map(({ runtime }) => runtime),
    ['a', 'b'],
  );
});

test('failed and slow workload reads preserve protection and return through the control mailbox', async (t) => {
  const f = await setup(t.onTestFinished);

  f.session.coordination.router = router(
    f.session.coordinator,
    { read: async () => f.policy },
    async () => {
      throw new Error('workload read failed');
    },
  );

  assert.deepEqual(
    (await f.route()).routes.map(({ runtime }) => runtime),
    ['b'],
  );

  assert.ok(
    f.session.coordinator.snapshot.items.some(({ text }) =>
      text.includes('Routing workload unavailable: workload read failed'),
    ),
  );

  f.session.coordination.router = router(
    f.session.coordinator,
    { read: async () => f.policy },
    () => new Promise<never>(() => {}),
  );

  const started = performance.now();
  const slow = await f.route();

  assert.deepEqual(
    slow.routes.map(({ runtime }) => runtime),
    ['b'],
  );

  assert.ok(performance.now() - started >= 2900);
  assert.match(slow.folded![0]!.reason, /coordinator activity is unknown/);
});
