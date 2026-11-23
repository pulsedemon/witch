import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { parseCommand } from '../../../src/cli/cli-control.js';
import type { Limit } from '../../../src/agents/types.js';
import { router } from '../../../src/core/runtime/router.js';
import { defaultPolicy } from '../../../src/core/runtime/routing.js';
import type { Policy } from '../../../src/core/runtime/routing.js';
import { USAGE_CURRENT_MS } from '../../../src/core/runtime/usage.js';
import { callControl } from '../../../src/persistence/control.js';
import { orderedCleanup } from '../../fixtures/cleanup.js';
import { unitCoordinationFixture } from '../../fixtures/coordination.js';
import { TurnGate } from '../../fixtures/agent.js';
import { until } from '../../fixtures/within.js';

const policy: Policy = {
  ...defaultPolicy,
  families: { a: 'model', b: 'model' },
};

const window = (percent: number, observedAt = Date.now()): Limit => ({
  window: '7D',
  percent,
  observedAt,
});

async function start(register: Parameters<typeof orderedCleanup>[0]) {
  const { start } = await unitCoordinationFixture(orderedCleanup(register));
  const session = await start('A');
  session.a.catalog.splice(0, 2, { id: 'a-2-model', label: 'A2', efforts: [] });
  session.b.catalog.splice(0, 2, { id: 'b-3-model', label: 'B3', efforts: [] });
  await session.coordinator.refreshModels();

  session.coordination.router = router(
    session.coordinator,
    { read: async () => policy },
    (deadline) => session.coordination.routingDemand(deadline),
  );

  const route = async (action: Record<string, unknown> = {}) =>
    callControl(await session.binding(), {
      kind: 'route',
      work: 'implementation',
      ...action,
    } as never);

  return { ...session, route };
}

test('a route answers during a running turn with no selection turn, and shows its choice in the transcript', async (t) => {
  const f = await start(t.onTestFinished);
  const gate = new TurnGate();
  f.a.gate = gate;
  const sending = f.coordinator.send('Work');
  await gate.entered;

  try {
    const reply = await f.route();

    assert.deepEqual(
      { ...reply, id: undefined },
      {
        kind: 'route',
        routes: [
          {
            runtime: 'a',
            model: 'a-2-model',
            reason:
              'implementation stays on a; a has no usage reading; a: 1 active coordinator, 0 running familiars',
          },
        ],
        id: undefined,
      },
    );

    assert.ok(
      f.coordinator.snapshot.items.some(
        (item) =>
          item.kind === 'notice' &&
          item.text ===
            'Routed implementation to a · a-2-model: implementation stays on a; a has no usage reading; a: 1 active coordinator, 0 running familiars',
      ),
    );
  } finally {
    gate.open();
    await sending;
  }
});

test('a review with no rule answers a route for each runtime and shows each in the transcript', async (t) => {
  const f = await start(t.onTestFinished);

  const reply = await f.route({
    work: 'review',
    of: { runtime: 'a', model: 'a-2-model' },
  });

  assert.equal(reply.kind, 'route');

  if (reply.kind !== 'route') return;

  assert.deepEqual(
    reply.routes.map(({ runtime, model }) => `${runtime} ${model}`),
    ['a a-2-model', 'b b-3-model'],
  );

  for (const { runtime, model, reason } of reply.routes)
    assert.ok(
      f.coordinator.snapshot.items.some(
        (item) =>
          item.kind === 'notice' &&
          item.text === `Routed review to ${runtime} · ${model}: ${reason}`,
      ),
      runtime,
    );
});

test('automatic placement favors remaining allowance and refreshes stale readings first', async (t) => {
  const f = await start(t.onTestFinished);
  await until('the connect read of b', () => f.b.accountReads.length === 1);
  // past the connect read's back-off
  const now = Date.now() + USAGE_CURRENT_MS + 1;
  vi.spyOn(Date, 'now').mockReturnValue(now);

  t.onTestFinished(() => {
    vi.restoreAllMocks();
  });

  f.coordinator.accountUsage.report('a', { limits: [window(92, now)] });

  f.coordinator.accountUsage.report('b', {
    limits: [window(40, now - USAGE_CURRENT_MS - 1)],
  });

  f.b.accountReading = { limits: [window(40, now)] };
  const reply = await f.route();
  vi.restoreAllMocks();
  assert.equal(f.b.accountReads.length, 2);
  assert.equal(reply.kind, 'route');

  if (reply.kind !== 'route') return;

  const reason =
    'automatic implementation; b (7D 40%); b: 0 active coordinators, 0 running familiars; a (7D 92%); a: 0 active coordinators, 0 running familiars; b has the most remaining allowance per worker among runtimes with the same coordinator protection, accounting for known reset times';

  assert.deepEqual(reply.routes, [
    { runtime: 'b', model: 'b-3-model', from: 'a', reason },
  ]);

  assert.ok(
    f.coordinator.snapshot.items.some(
      (item) =>
        item.kind === 'notice' &&
        item.warning &&
        item.text ===
          `Routed implementation to b · b-3-model, passing over a for capacity: ${reason}`,
    ),
  );
});

test('a route at a tier names it in the transcript, and a runtime with no family at that tier says it ran its policy family', async (t) => {
  const f = await start(t.onTestFinished);
  const reply = await f.route({ work: 'review', tier: 'cheap' });
  assert.equal(reply.kind, 'route');

  if (reply.kind !== 'route') return;

  assert.deepEqual(
    reply.routes.map(({ runtime, model }) => `${runtime} ${model}`),
    ['a a-2-model', 'b b-3-model'],
  );

  for (const { runtime, model, reason } of reply.routes) {
    assert.match(
      reason,
      new RegExp(`; ${runtime} has no cheap family; using its policy family$`),
    );

    assert.ok(
      f.coordinator.snapshot.items.some(
        (item) =>
          item.kind === 'notice' &&
          item.text ===
            `Routed review at the cheap tier to ${runtime} · ${model}: ${reason}`,
      ),
      runtime,
    );
  }
});

test('a review that loses a runtime to usage routes once and says on its own line which runtime it passed over', async (t) => {
  const f = await start(t.onTestFinished);
  f.coordinator.accountUsage.report('a', { limits: [window(95)] });
  f.coordinator.accountUsage.report('b', { limits: [window(40)] });
  const gate = new TurnGate();
  f.a.gate = gate;
  const sending = f.coordinator.send('Review');
  await gate.entered;

  try {
    const reply = await f.route({
      work: 'review',
      of: { runtime: 'a', model: 'a-2-model' },
    });

    assert.equal(reply.kind, 'route');

    if (reply.kind !== 'route') return;

    const reason =
      'review of a work prefers a; a (7D 95%); a: 1 active coordinator, 0 running familiars; b (7D 40%); b: 0 active coordinators, 0 running familiars; a needs a capacity reserve for its active coordinator; b has the most remaining allowance per worker among runtimes with the same coordinator protection, accounting for known reset times';

    assert.deepEqual(reply.routes, [
      {
        runtime: 'b',
        model: 'b-3-model',
        reason:
          'review of a work requests a familiar on each runtime; b (7D 40%); b: 0 active coordinators, 0 running familiars',
      },
    ]);

    assert.deepEqual(reply.folded, [
      { runtime: 'b', model: 'b-3-model', from: 'a', reason },
    ]);

    const notices = f.coordinator.snapshot.items
      .filter(({ kind, text }) => kind === 'notice' && text.includes(' · '))
      .map(({ text, warning }) => ({ text, warning }));

    assert.deepEqual(notices, [
      {
        text: 'Routed review to b · b-3-model: review of a work requests a familiar on each runtime; b (7D 40%); b: 0 active coordinators, 0 running familiars',
        warning: undefined,
      },
      {
        text: `Passed over a for review for capacity; b · b-3-model already has it: ${reason}`,
        warning: true,
      },
    ]);
  } finally {
    gate.open();
    await sending;
  }
});

test('a route after an empty read starts no new one, and says the reading is missing', async (t) => {
  const f = await start(t.onTestFinished);
  await until('the connect read of b', () => f.b.accountReads.length === 1);
  f.coordinator.accountUsage.report('a', { limits: [window(95)] });
  const reply = await f.route();
  assert.equal(f.b.accountReads.length, 1);
  assert.equal(reply.kind, 'route');

  if (reply.kind === 'route')
    assert.equal(
      reply.routes[0]!.reason,
      'automatic implementation; a (7D 95%); a: 0 active coordinators, 0 running familiars; b has no usage reading; b: 0 active coordinators, 0 running familiars; no verified destination capacity; a has the most remaining allowance per worker among runtimes with the same coordinator protection, accounting for known reset times',
    );
});

for (const missing of ['stale credits', 'missing credit access'] as const)
  test(`a route refreshes ${missing} beside current full windows and uses the returned capacity`, async (t) => {
    const f = await start(t.onTestFinished);

    await until(
      'the initial account read',
      () => f.b.accountReads.length === 1,
    );

    const now = Date.now() + USAGE_CURRENT_MS + 1;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    try {
      const funding = {
        kind: 'credits' as const,
        balance: missing === 'stale credits' ? '0' : '27.123400',
        unlimited: false,
        available: missing !== 'stale credits',
        observedAt:
          missing === 'stale credits' ? now - USAGE_CURRENT_MS - 1 : now,
      };

      f.coordinator.accountUsage.report('a', { limits: [window(100, now)] });

      f.coordinator.accountUsage.report('b', {
        limits: [window(100, now)],
        funding,
      });

      f.b.accountReading = {
        limits: [window(100, now)],
        funding: {
          ...funding,
          balance: '27.123400',
          available: true,
          observedAt: now,
        },
        creditAccess: { state: 'available', observedAt: now },
      };

      const result = await f.route();
      assert.equal(result.kind, 'route');

      if (result.kind !== 'route') assert.fail(JSON.stringify(result));

      assert.deepEqual(result.routes, [
        {
          runtime: 'b',
          model: 'b-3-model',
          from: 'a',
          reason:
            'implementation prefers a; a (7D 100%); a: 0 active coordinators, 0 running familiars; b (7D 100%, 27.12 credits); b: 0 active coordinators, 0 running familiars; a has a full applicable usage window; b has usable credits for its full window',
        },
      ]);

      assert.deepEqual(
        f.coordinator.snapshot.accounts.b!.funding,
        f.b.accountReading.funding,
      );

      assert.equal(f.b.accountReads.length, 2);
    } finally {
      vi.restoreAllMocks();
    }
  });

test('a read slower than the wait still gets a reply, routed on what is current', async (t) => {
  const f = await start(t.onTestFinished);
  await until('the connect read of b', () => f.b.accountReads.length === 1);
  const now = Date.now() + USAGE_CURRENT_MS + 1;
  vi.spyOn(Date, 'now').mockReturnValue(now);

  t.onTestFinished(() => {
    vi.restoreAllMocks();
  });

  f.coordinator.accountUsage.report('a', { limits: [window(95, now)] });

  f.coordinator.accountUsage.report('b', {
    limits: [window(10, now - USAGE_CURRENT_MS - 1)],
  });

  // like a native probe, it ends only when aborted
  f.b.accountRead = ({ signal }) =>
    new Promise((_, reject) =>
      signal!.addEventListener('abort', () => reject(signal!.reason)),
    );

  const started = performance.now();
  const reply = await f.route();
  vi.restoreAllMocks();
  assert.equal(f.b.accountReads.length, 2);
  assert.ok(performance.now() - started >= 2900);
  assert.equal(reply.kind, 'route');

  if (reply.kind === 'route') {
    assert.equal(reply.routes[0]!.runtime, 'a');
    assert.match(reply.routes[0]!.reason, /b's 7D reading is not current;/);
  }
});

test('--route takes the kind of work, the producer, a named model and a tier', () => {
  const prefix = [
    '--control-dir',
    '/task/control',
    '--control-conversation',
    'conversation',
    '--control-activation',
    '11111111-1111-4111-8111-111111111111',
  ];

  assert.deepEqual(
    parseCommand([
      ...prefix,
      '--route',
      'review',
      '--of',
      'codex:gpt-6.1-sol',
      '--named',
      'claude:claude-opus-4-1',
    ]).control?.action,
    {
      kind: 'route',
      work: 'review',
      of: { runtime: 'codex', model: 'gpt-6.1-sol' },
      named: { runtime: 'claude', model: 'claude-opus-4-1' },
      tier: undefined,
    },
  );

  assert.deepEqual(
    parseCommand([...prefix, '--route', 'review', '--tier', 'cheap']).control
      ?.action,
    {
      kind: 'route',
      work: 'review',
      of: undefined,
      named: undefined,
      tier: 'cheap',
    },
  );

  for (const option of [
    ['--of', 'a:b'],
    ['--tier', 'cheap'],
  ])
    assert.throws(() => parseCommand([...prefix, '--peers', ...option]), {
      message: '--of, --named and --tier require --route.',
    });

  // without the binding options, only --tier itself marks this as a control command rather than a prompt
  assert.throws(() => parseCommand(['--tier', 'cheap']), {
    message: /^Choose exactly one control action/,
  });

  assert.throws(
    () =>
      parseCommand([
        ...prefix,
        '--route',
        'review',
        '--tier',
        'cheap',
        '--named',
        'claude:haiku',
      ]),
    {
      message:
        "--tier and --named can't be combined; a named model sets its own tier.",
    },
  );

  assert.throws(() =>
    parseCommand([...prefix, '--route', 'review', '--tier', 'cheapest']),
  );

  assert.throws(
    () => parseCommand([...prefix, '--route', 'review', '--of', 'codex']),
    {
      message: 'Name a runtime and model as <runtime>:<model>.',
    },
  );
});

test('a policy that cannot be read refuses the route in the transcript as well as to the agent', async (t) => {
  const f = await start(t.onTestFinished);
  const unreadable = 'The delegation policy at /p/policy.json is unreadable.';

  f.coordination.router = router(
    f.coordinator,
    {
      read: async () => {
        throw new Error(unreadable);
      },
    },
    (deadline) => f.coordination.routingDemand(deadline),
  );

  const reply = await f.route();

  assert.deepEqual(
    { ...reply, id: undefined },
    { kind: 'error', message: unreadable, id: undefined },
  );

  assert.ok(
    f.coordinator.snapshot.items.some(
      (item) =>
        item.kind === 'notice' && item.text === `Route refused: ${unreadable}`,
    ),
  );
});
