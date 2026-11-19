import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AccountReading } from '../../../src/agents/types.js';
import { defaultPolicy, route } from '../../../src/core/runtime/routing.js';
import type { Work } from '../../../src/core/runtime/routing.js';
import type { Demand } from '../../../src/core/runtime/demand.js';
import { USAGE_CURRENT_MS } from '../../../src/core/runtime/usage.js';

const now = 2_000_000_000_000;
const empty: Demand = { coordinators: {}, familiars: {}, unknown: [] };

const account = (percent: number, hours: number): AccountReading => ({
  limits: [
    {
      window: '7D',
      percent,
      observedAt: now,
      resetsAt: now / 1000 + hours * 3600,
    },
  ],
});

const base: Parameters<typeof route>[0] = {
  work: 'review',
  caller: 'codex',
  of: { runtime: 'codex', model: 'gpt-6-astra' },
  policy: defaultPolicy,
  installed: ['codex', 'claude'],
  catalog: {
    models: ['gpt-6.1-sol', 'gpt-6-astra'].map((id) => ({
      agent: 'codex',
      id,
      label: id,
      efforts: [],
    })),
    latest: { claude: { opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' } },
  },
  accounts: { claude: account(93, 67), codex: account(70, 141) },
  demand: { ...empty, coordinators: { codex: 4 } },
  now,
};

function ask(options: Partial<typeof base> = {}) {
  const result = route({ ...base, ...options });

  if ('refused' in result) assert.fail(result.refused);

  return result;
}

test('review retains an idle runtime above the reserve threshold and protects an active coordinator only under pressure', () => {
  const free = ask();

  assert.deepEqual(
    free.routes.map(({ runtime }) => runtime),
    ['codex', 'claude'],
  );

  assert.match(free.routes[1]!.reason, /claude: 0 active coordinators/);
  assert.match(free.routes[1]!.reason, /7D 93%, resets in 2d19h/);
  const demand = { ...empty, coordinators: { codex: 4, claude: 1 } };
  const protectedReview = ask({ demand });

  assert.deepEqual(
    protectedReview.routes.map(({ runtime }) => runtime),
    ['codex'],
  );

  assert.equal(protectedReview.folded?.[0]?.from, 'claude');

  assert.match(
    protectedReview.folded![0]!.reason,
    /claude needs a capacity reserve for its active coordinator/,
  );

  const ample = ask({
    demand,
    accounts: { ...base.accounts, claude: account(40, 67) },
  });

  assert.deepEqual(
    ample.routes.map(({ runtime }) => runtime),
    ['codex', 'claude'],
  );
});

test('single-work placement uses reset timing and running demand before the percentage threshold', () => {
  const accounts = { claude: account(80, 24), codex: account(60, 144) };
  const demand = { ...empty, coordinators: { claude: 1 } };

  for (const work of [
    'planning',
    'implementation',
    'investigation',
  ] satisfies Work[]) {
    const available = ask({ work, accounts, demand });
    assert.equal(available.routes[0]!.runtime, 'claude');
    assert.equal(available.routes[0]!.model, 'claude-opus-5-5');
    assert.equal(available.routes[0]!.from, 'codex');

    const loaded = ask({
      work,
      accounts,
      demand: { ...demand, familiars: { claude: 3 } },
    });

    assert.equal(loaded.routes[0]!.runtime, 'codex');

    assert.match(
      loaded.routes[0]!.reason,
      /codex: 0 active coordinators, 0 running familiars/,
    );
  }
});

test('coordinator protection takes priority over a larger reset-adjusted allowance', () => {
  const result = ask({
    work: 'implementation',
    caller: 'claude',
    demand: { ...empty, coordinators: { claude: 1 } },
    accounts: { claude: account(93, 1), codex: account(70, 141) },
  });

  assert.equal(result.routes[0]!.runtime, 'codex');
  assert.match(result.routes[0]!.reason, /claude needs a capacity reserve/);
});

test('verified destination credits take priority over a protected coordinator below full usage', () => {
  const codex: AccountReading = {
    ...account(100, 144),
    funding: {
      kind: 'credits',
      balance: '42',
      unlimited: false,
      available: true,
      observedAt: now,
    },
    creditAccess: { state: 'available', observedAt: now },
  };

  for (const implementation of ['auto', 'same']) {
    const result = ask({
      work: 'implementation',
      caller: 'claude',
      policy: { ...defaultPolicy, work: { implementation } },
      accounts: { claude: account(93, 67), codex },
      demand: { ...empty, coordinators: { claude: 1 } },
    });

    assert.equal(result.routes[0]!.runtime, 'codex');
    assert.equal(result.routes[0]!.model, 'gpt-6.1-sol');
    assert.equal(result.routes[0]!.from, 'claude');
  }
});

test('unknown coordinator activity prevents automatic placement onto apparent spare capacity', () => {
  const result = ask({
    work: 'implementation',
    caller: 'claude',
    accounts: { claude: account(50, 24), codex: account(10, 24) },
    demand: { ...empty, unknown: ['codex'] },
  });

  assert.equal(result.routes[0]!.runtime, 'claude');
  assert.equal(result.routes[0]!.from, undefined);
  assert.match(result.routes[0]!.reason, /comparative workload is unknown/);
});

test('equal budgets and demand retain the intended runtime in either installed order', () => {
  for (const installed of [
    ['claude', 'codex'],
    ['codex', 'claude'],
  ]) {
    const result = ask({
      work: 'implementation',
      caller: 'claude',
      installed,
      demand: empty,
      accounts: { claude: account(50, 24), codex: account(50, 24) },
    });

    assert.equal(result.routes[0]!.runtime, 'claude');
    assert.equal(result.routes[0]!.from, undefined);
  }
});

test('both policies describe non-review placements as familiars', () => {
  for (const work of [
    'planning',
    'implementation',
    'investigation',
  ] satisfies Work[]) {
    const result = ask({
      work,
      demand: empty,
      policy: { ...defaultPolicy, work: { [work]: 'both' } },
    });

    assert.deepEqual(
      result.routes.map(({ runtime }) => runtime),
      ['codex', 'claude'],
    );

    for (const { reason } of result.routes)
      assert.match(
        reason,
        new RegExp(`^${work} requests a familiar on each runtime;`),
      );
  }
});

test('the strictest applicable window limits automatic placement without applying another model family window', () => {
  const claude = account(20, 24);

  const scoped = {
    ...claude,
    modelLimits: [{ ...account(100, 24).limits[0]!, model: 'Fable' }],
  };

  const options = {
    work: 'implementation' as const,
    demand: empty,
    accounts: { claude: scoped, codex: account(70, 141) },
  };

  assert.equal(ask(options).routes[0]!.runtime, 'claude');

  const short = {
    window: '5H',
    percent: 89,
    observedAt: now,
    resetsAt: now / 1000 + 4 * 3600,
  };

  const constrained = ask({
    ...options,
    accounts: {
      ...options.accounts,
      claude: { ...scoped, limits: [...claude.limits, short] },
    },
  });

  assert.equal(constrained.routes[0]!.runtime, 'codex');

  const fable = ask({
    ...options,
    policy: { ...defaultPolicy, work: { implementation: 'claude:fable' } },
  });

  assert.equal(fable.routes[0]!.runtime, 'codex');
  assert.equal(fable.routes[0]!.model, 'gpt-6-astra');
});

test('unknown coordinator activity preserves reserve and missing familiar attribution prevents automatic ranking', () => {
  for (const demand of [undefined, { ...empty, unknown: ['claude'] }]) {
    const result = ask({ demand });

    assert.deepEqual(
      result.routes.map(({ runtime }) => runtime),
      ['codex'],
    );

    assert.match(result.folded![0]!.reason, /claude workload unknown/);
  }

  const result = ask({
    work: 'implementation',
    caller: 'claude',
    accounts: { claude: account(70, 140), codex: account(20, 24) },
    demand: { coordinators: { codex: 1 }, unknown: [] },
  });

  assert.equal(result.routes[0]!.runtime, 'claude');
  assert.match(result.routes[0]!.reason, /familiar load unknown/);
  assert.match(result.routes[0]!.reason, /comparative workload is unknown/);
});

test('stale and reset windows do not attract automatic placements', () => {
  for (const stale of [
    { ...account(1, 24).limits[0]!, observedAt: now - USAGE_CURRENT_MS - 1 },
    { ...account(1, 24).limits[0]!, resetsAt: now / 1000 },
  ]) {
    const result = ask({
      work: 'implementation',
      demand: empty,
      accounts: { claude: { limits: [stale] }, codex: account(70, 141) },
    });

    assert.equal(result.routes[0]!.runtime, 'codex');

    assert.match(
      result.routes[0]!.reason,
      /claude's 7D reading is not current/,
    );
  }
});

test('explicit rules retain placement until protection is needed and shift off and named models bypass balancing', () => {
  const options = {
    work: 'implementation' as const,
    caller: 'claude',
    demand: { ...empty, coordinators: { claude: 1 } },
  };

  const idle = ask({
    ...options,
    demand: empty,
    policy: { ...defaultPolicy, work: { implementation: 'same' } },
  });

  assert.equal(idle.routes[0]!.runtime, 'claude');

  const protectedRoute = ask({
    ...options,
    policy: { ...defaultPolicy, work: { implementation: 'same' } },
  });

  assert.equal(protectedRoute.routes[0]!.runtime, 'codex');

  assert.equal(
    ask({ ...options, policy: { ...defaultPolicy, shiftAt: null } }).routes[0]!
      .runtime,
    'claude',
  );

  assert.equal(
    ask({ ...options, named: { runtime: 'claude', model: 'claude-opus-5' } })
      .routes[0]!.model,
    'claude-opus-5',
  );

  for (const review of ['auto', 'auto:sol'])
    assert.deepEqual(
      route({ ...base, policy: { ...defaultPolicy, work: { review } } }),
      {
        refused:
          'auto is for planning, implementation and investigation; use both for review',
      },
    );
});
