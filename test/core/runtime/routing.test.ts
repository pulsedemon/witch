import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AccountReading, Limit } from '../../../src/agents/types.js';
import type {
  Catalog,
  Policy,
  Route,
  Tier,
  Work,
} from '../../../src/core/runtime/routing.js';
import {
  defaultPolicy,
  family,
  resolve,
  route,
} from '../../../src/core/runtime/routing.js';
import { USAGE_CURRENT_MS } from '../../../src/core/runtime/usage.js';

const now = 2_000_000_000_000;

const codexIds = [
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6.1-terra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
];

const catalog: Catalog = {
  models: [
    ...['default', 'opus', 'sonnet', 'claude-opus-5', 'claude-opus-4-8'].map(
      (id) => ({ agent: 'claude', id, label: id, efforts: [] }),
    ),
    ...codexIds.map((id) => ({ agent: 'codex', id, label: id, efforts: [] })),
  ],
  latest: {
    claude: {
      opus: 'claude-opus-5-5',
      sonnet: 'claude-sonnet-5-5',
      haiku: 'claude-haiku-5-5',
      fable: 'claude-fable-5-1',
    },
  },
};

const installed = ['claude', 'codex'];

const window = (
  name: string,
  percent: number,
  observedAt = now - 1000,
): Limit => ({ window: name, percent, observedAt });

const credited = (percent: number): AccountReading => ({
  limits: [window('7D', percent)],
  funding: {
    kind: 'credits',
    balance: '25966.049947',
    unlimited: false,
    available: true,
    observedAt: now,
  },
  creditAccess: { state: 'available', observedAt: now },
});

const fresh = {
  claude: [window('5H', 20), window('7D', 61)],
  codex: [window('7D', 49)],
};

/** a single route as itself, so a result with an unexpected number of routes fails as an array. */
function unwrap(result: Route) {
  if ('refused' in result) return result;

  return result.routes.length === 1 ? result.routes[0]! : result.routes;
}

function ask(
  fields: {
    work?: Work;
    caller?: string;
    of?: { runtime: string; model: string };
    named?: { runtime: string; model: string };
    tier?: Tier;
    policy?: Partial<Policy>;
    limits?: Record<string, Limit[]>;
    accounts?: Record<string, AccountReading>;
    catalog?: Catalog;
    installed?: string[];
  } = {},
) {
  return unwrap(
    route({
      work: fields.work ?? 'implementation',
      caller: fields.caller ?? 'claude',
      of: fields.of,
      named: fields.named,
      tier: fields.tier,
      policy: { ...defaultPolicy, ...fields.policy },
      installed: fields.installed ?? installed,
      catalog: fields.catalog ?? catalog,
      accounts:
        fields.accounts ??
        Object.fromEntries(
          Object.entries(fields.limits ?? fresh).map(([id, limits]) => [
            id,
            { limits },
          ]),
        ),
      now,
    }),
  );
}

test('credit capacity keeps a runtime at full weekly usage ahead of another runtime with headroom, and supplies a destination', () => {
  const funded: AccountReading = {
    limits: [window('7D', 100)],
    funding: {
      kind: 'credits',
      balance: '12345.678900',
      unlimited: false,
      available: true,
      observedAt: now,
    },
    creditAccess: { state: 'available', observedAt: now },
  };

  const accounts = { claude: { limits: [window('7D', 100)] }, codex: funded };

  assert.deepEqual(ask({ accounts }), {
    runtime: 'codex',
    model: 'gpt-6.1-sol',
    from: 'claude',
    reason:
      'implementation prefers claude; claude (7D 100%); claude workload unknown; codex (7D 100%, 12345.68 credits); codex workload unknown; claude has a full applicable usage window; codex has usable credits for its full window',
  });

  assert.deepEqual(
    ask({
      caller: 'codex',
      accounts: { ...accounts, claude: { limits: [window('7D', 40)] } },
    }),
    {
      runtime: 'codex',
      model: 'gpt-6.1-sol',
      reason:
        'implementation stays on codex; codex (7D 100%, 12345.68 credits); codex workload unknown; its usable credits keep the work here',
    },
  );

  assert.equal(
    (ask({ caller: 'codex', accounts }) as { runtime: string }).runtime,
    'codex',
  );

  assert.equal(
    (
      ask({
        accounts,
        named: { runtime: 'claude', model: 'claude-opus-5-5' },
      }) as { runtime: string }
    ).runtime,
    'claude',
  );

  for (const creditAccess of [
    { state: 'unavailable' as const, observedAt: now },
    { state: 'unknown' as const, observedAt: now },
    { state: 'available' as const, observedAt: now - USAGE_CURRENT_MS - 1 },
  ]) {
    const result = ask({
      accounts: { ...accounts, codex: { ...funded, creditAccess } },
    });

    assert.ok('runtime' in result);
    assert.equal(result.runtime, 'claude');

    assert.match(
      result.reason,
      /codex workload unknown; no verified destination capacity$/,
    );

    assert.equal(
      (
        ask({
          caller: 'codex',
          accounts: {
            claude: { limits: [window('7D', 40)] },
            codex: { ...funded, creditAccess },
          },
        }) as { runtime: string }
      ).runtime,
      'claude',
    );
  }

  assert.equal(
    (
      ask({
        accounts: {
          ...accounts,
          codex: {
            ...funded,
            funding: {
              ...funded.funding!,
              observedAt: now - USAGE_CURRENT_MS - 1,
            },
          },
        },
      }) as { runtime: string }
    ).runtime,
    'claude',
  );
});

test('credits draw work onto another runtime only at 100%, and a spent runtime without them hands work to one still under 100%', () => {
  assert.deepEqual(
    ask({
      work: 'review',
      of: { runtime: 'claude', model: 'claude-opus-5-5' },
      accounts: { claude: { limits: [window('7D', 90)] }, codex: credited(94) },
    }),
    [
      {
        runtime: 'claude',
        model: 'claude-opus-5-5',
        reason:
          'review of claude work requests a familiar on each runtime; claude (7D 90%); claude workload unknown; claude needs a capacity reserve while coordinator activity is unknown; codex (7D 94%, 25966.05 credits); codex workload unknown; coordinator capacity is reserved',
      },
      {
        runtime: 'codex',
        model: 'gpt-6.1-sol',
        reason:
          'review of claude work requests a familiar on each runtime; codex (7D 94%, 25966.05 credits); codex workload unknown; its usable credits keep the work here',
      },
    ],
  );

  assert.deepEqual(
    ask({
      limits: { claude: [window('7D', 100)], codex: [window('7D', 96)] },
    }),
    {
      runtime: 'codex',
      model: 'gpt-6.1-sol',
      from: 'claude',
      reason:
        'implementation prefers claude; claude (7D 100%); claude workload unknown; codex (7D 96%); codex workload unknown; claude has a full applicable usage window; codex has included usage left',
    },
  );
});

test('usable credits keep a runtime past the shift threshold on its own placement, and stale, unknown or unusable ones do not', () => {
  const review = (codex: AccountReading) =>
    ask({
      work: 'review',
      of: { runtime: 'claude', model: 'claude-opus-5-5' },
      accounts: { claude: { limits: [window('7D', 19)] }, codex },
    });

  for (const codex of [
    {
      ...credited(99),
      creditAccess: { state: 'unavailable' as const, observedAt: now },
    },
    {
      ...credited(99),
      creditAccess: { state: 'unknown' as const, observedAt: now },
    },
    {
      ...credited(99),
      creditAccess: {
        state: 'available' as const,
        observedAt: now - USAGE_CURRENT_MS - 1,
      },
    },
    {
      ...credited(99),
      funding: {
        ...credited(99).funding!,
        observedAt: now - USAGE_CURRENT_MS - 1,
      },
    },
  ])
    assert.deepEqual(review(codex), {
      runtime: 'claude',
      model: 'claude-opus-5-5',
      reason:
        'review of claude work requests a familiar on each runtime; claude (7D 19%); claude workload unknown',
    });

  assert.deepEqual(review(credited(99)), [
    {
      runtime: 'claude',
      model: 'claude-opus-5-5',
      reason:
        'review of claude work requests a familiar on each runtime; claude (7D 19%); claude workload unknown',
    },
    {
      runtime: 'codex',
      model: 'gpt-6.1-sol',
      reason:
        'review of claude work requests a familiar on each runtime; codex (7D 99%, 25966.05 credits); codex workload unknown; its usable credits keep the work here',
    },
  ]);
});

test('a versioned model runs as named, even absent from the catalog, and the reason says when usage is not current', () => {
  assert.deepEqual(
    ask({
      named: { runtime: 'claude', model: 'claude-opus-5-5' },
      limits: {
        ...fresh,
        claude: [window('7D', 61, now - USAGE_CURRENT_MS - 1)],
      },
    }),
    {
      runtime: 'claude',
      model: 'claude-opus-5-5',
      reason: "named explicitly; claude's 7D reading is not current",
    },
  );

  assert.deepEqual(ask({ named: { runtime: 'codex', model: 'gpt-6-sol' } }), {
    runtime: 'codex',
    model: 'gpt-6-sol',
    reason: 'named explicitly',
  });
});

test('a family resolves to its newest version, comparing versions numerically', () => {
  assert.deepEqual(resolve('codex', 'sol', catalog), { model: 'gpt-6.1-sol' });

  assert.deepEqual(resolve('codex', 'astra', catalog), {
    model: 'gpt-6-astra',
  });

  const later: Catalog = {
    ...catalog,
    models: ['gpt-6.9-sol', 'gpt-6.10-sol'].map((id) => ({
      agent: 'codex',
      id,
      label: id,
      efforts: [],
    })),
  };

  assert.deepEqual(resolve('codex', 'sol', later), { model: 'gpt-6.10-sol' });

  assert.deepEqual(resolve('claude', 'opus', catalog), {
    model: 'claude-opus-5-5',
  });
});

test('a named family with no model in the catalog is refused rather than run by name', () => {
  for (const models of [
    [],
    [{ agent: 'codex', id: 'gpt-6-astra', label: 'astra', efforts: [] }],
  ])
    assert.deepEqual(
      ask({
        named: { runtime: 'codex', model: 'sol' },
        catalog: { ...catalog, models },
      }),
      { refused: 'codex lists no sol model to run' },
    );

  assert.deepEqual(
    ask({
      named: { runtime: 'claude', model: 'opus' },
      catalog: { ...catalog, latest: { claude: {} } },
    }),
    { refused: 'claude lists no opus model to run' },
  );
});

test('an unversioned model a runtime without aliases lists runs as named, by name or rule, and is not a family', () => {
  const listed: Catalog = {
    ...catalog,
    models: [
      ...catalog.models,
      { agent: 'codex', id: 'gpt-reserve', label: 'reserve', efforts: [] },
    ],
  };

  assert.deepEqual(
    ask({
      named: { runtime: 'codex', model: 'gpt-reserve' },
      catalog: listed,
    }),
    { runtime: 'codex', model: 'gpt-reserve', reason: 'named explicitly' },
  );

  assert.deepEqual(
    ask({
      policy: { work: { implementation: 'codex:gpt-reserve' } },
      catalog: listed,
    }),
    {
      runtime: 'codex',
      model: 'gpt-reserve',
      reason:
        'the policy sends implementation to codex:gpt-reserve; codex (7D 49%); codex workload unknown',
    },
  );

  assert.deepEqual(family('codex', 'gpt-reserve', listed), {
    refused: 'gpt-reserve names a model, not a family',
  });

  assert.deepEqual(resolve('codex', 'gpt-reserve', catalog), {
    refused: 'codex lists no gpt-reserve model to run',
  });
});

test('default and names that are not Claude families are refused, and a policy family must stay a family', () => {
  assert.deepEqual(resolve('claude', 'default', catalog), {
    refused: 'name a claude family or model, not default',
  });

  assert.deepEqual(resolve('claude', 'gpt', catalog), {
    refused: 'claude lists no gpt model to run',
  });

  assert.deepEqual(family('codex', 'gpt-6-sol', catalog), {
    refused: 'gpt-6-sol names a model, not a family',
  });

  assert.deepEqual(
    ask({
      policy: { families: { claude: 'opus', codex: 'sol' } },
      catalog: { ...catalog, models: [] },
      caller: 'codex',
    }),
    { refused: 'codex lists no sol model to run' },
  );
});

test('unknown workload keeps unspecified work on the caller with its newest family model', () => {
  assert.deepEqual(ask(), {
    runtime: 'claude',
    model: 'claude-opus-5-5',
    reason:
      'implementation stays on claude; claude (5H 20%, 7D 61%); claude workload unknown; comparative workload is unknown; retaining the caller',
  });
});

test('review routes relative to the runtime that produced the work', () => {
  const codexWork = { runtime: 'codex', model: 'gpt-6.1-sol' };

  assert.deepEqual(
    ask({
      work: 'review',
      of: codexWork,
      policy: { work: { review: 'other' } },
    }),
    {
      runtime: 'claude',
      model: 'claude-opus-5-5',
      reason:
        'the policy sends review of codex work to other; claude (5H 20%, 7D 61%); claude workload unknown',
    },
  );

  assert.deepEqual(
    ask({
      work: 'review',
      of: codexWork,
      policy: { work: { review: 'same' } },
    }),
    {
      runtime: 'codex',
      model: 'gpt-6.1-sol',
      reason:
        'review stays on codex, which produced it; codex (7D 49%); codex workload unknown',
    },
  );

  assert.equal(
    (
      ask({ work: 'review', policy: { work: { review: 'other' } } }) as {
        runtime: string;
      }
    ).runtime,
    'codex',
  );
});

test('unknown activity preserves threshold protection in either direction', () => {
  const hours = (count: number) => now / 1000 + count * 3600;

  assert.deepEqual(
    ask({
      limits: {
        claude: [
          window('5H', 20),
          { ...window('7D', 92), resetsAt: hours(26.5) },
        ],
        codex: [{ ...window('7D', 49), resetsAt: hours(100) }],
      },
    }),
    {
      runtime: 'codex',
      model: 'gpt-6.1-sol',
      from: 'claude',
      reason:
        'implementation prefers claude; claude (5H 20%, 7D 92%, resets in 1d2h); claude workload unknown; codex (7D 49%, resets in 4d4h); codex workload unknown; claude needs a capacity reserve while coordinator activity is unknown; codex has included usage left',
    },
  );

  assert.deepEqual(
    ask({
      limits: {
        claude: [
          window('5H', 95),
          window('7D', 40, now - USAGE_CURRENT_MS - 1),
        ],
        codex: [window('5H', 10)],
      },
    }),
    {
      runtime: 'codex',
      model: 'gpt-6.1-sol',
      from: 'claude',
      reason:
        "implementation prefers claude; claude (5H 95%); claude's 7D reading is not current; claude workload unknown; codex (5H 10%); codex workload unknown; claude needs a capacity reserve while coordinator activity is unknown; codex has included usage left",
    },
  );

  assert.deepEqual(
    ask({
      caller: 'codex',
      limits: { claude: [window('7D', 40)], codex: [window('7D', 92)] },
    }),
    {
      runtime: 'claude',
      model: 'claude-opus-5-5',
      from: 'codex',
      reason:
        'implementation prefers codex; codex (7D 92%); codex workload unknown; claude (7D 40%); claude workload unknown; codex needs a capacity reserve while coordinator activity is unknown; claude has included usage left',
    },
  );
});

test('a review the policy sent away from its producer stays off the producer when the reviewer is over the level, and other work does not', () => {
  const of = { runtime: 'codex', model: 'gpt-6.1-sol' };
  const limits = { claude: [window('7D', 92)], codex: [window('7D', 49)] };

  assert.deepEqual(
    ask({ work: 'review', of, policy: { work: { review: 'other' } }, limits }),
    {
      runtime: 'claude',
      model: 'claude-opus-5-5',
      reason:
        'the policy sends review of codex work to other; claude (7D 92%); claude workload unknown; claude needs a capacity reserve while coordinator activity is unknown; codex produced the work',
    },
  );

  // a review kept on its producer may shift away
  assert.equal(
    (
      ask({
        work: 'review',
        of,
        policy: { work: { review: 'same' } },
        limits: { claude: [window('7D', 40)], codex: [window('7D', 92)] },
      }) as { runtime: string }
    ).runtime,
    'claude',
  );

  // `--of` is accepted with any work, but only a review stays off its producer
  assert.equal((ask({ of, limits }) as { runtime: string }).runtime, 'codex');
});

test('no shift happens without current evidence of room, and the reason says which reading is missing', () => {
  const over = [window('7D', 92)];

  const cases: [Limit[] | undefined, string][] = [
    [
      [window('7D', 49, now - USAGE_CURRENT_MS - 1)],
      "codex's 7D reading is not current",
    ],
    [[], 'codex has no usage reading'],
    [undefined, 'codex has no usage reading'],
    [
      [window('5H', 10), window('7D', 49, now - USAGE_CURRENT_MS - 1)],
      "codex's 7D reading is not current",
    ],
  ];

  for (const [codex, missing] of cases)
    assert.deepEqual(
      ask({ limits: { claude: over, ...(codex ? { codex } : {}) } }),
      {
        runtime: 'claude',
        model: 'claude-opus-5-5',
        reason: `implementation stays on claude; claude (7D 92%); claude workload unknown; claude needs a capacity reserve while coordinator activity is unknown; ${codex?.some(({ window }) => window === '5H') ? 'codex (5H 10%); ' : ''}${missing}; codex workload unknown; no verified destination capacity`,
      },
    );

  assert.deepEqual(
    ask({
      limits: { claude: over, codex: [window('7D', 49)] },
      catalog: {
        ...catalog,
        models: catalog.models.filter(({ agent }) => agent === 'claude'),
      },
    }),
    {
      runtime: 'claude',
      model: 'claude-opus-5-5',
      reason:
        'implementation stays on claude; claude (7D 92%); claude workload unknown; claude needs a capacity reserve while coordinator activity is unknown; codex lists no sol model to run',
    },
  );

  assert.deepEqual(
    ask({
      limits: {
        claude: [
          window('5H', 95),
          window('7D', 40, now - USAGE_CURRENT_MS - 1),
        ],
        codex: [window('7D', 49, now - USAGE_CURRENT_MS - 1)],
      },
    }),
    {
      runtime: 'claude',
      model: 'claude-opus-5-5',
      reason:
        "implementation stays on claude; claude (5H 95%); claude's 7D reading is not current; claude workload unknown; claude needs a capacity reserve while coordinator activity is unknown; codex's 7D reading is not current; codex workload unknown; no verified destination capacity",
    },
  );
});

test('no shift happens when the chosen runtime has no current window over the level, both are over, or shifting is off', () => {
  assert.deepEqual(
    ask({
      limits: {
        claude: [window('7D', 95, now - USAGE_CURRENT_MS - 1)],
        codex: [window('7D', 10)],
      },
    }),
    {
      runtime: 'claude',
      model: 'claude-opus-5-5',
      reason:
        "implementation stays on claude; claude's 7D reading is not current; claude workload unknown; comparative workload is unknown; retaining the caller",
    },
  );

  assert.match(
    (
      ask({
        limits: { claude: [window('7D', 92)], codex: [window('7D', 95)] },
      }) as { reason: string }
    ).reason,
    /codex \(7D 95%\); codex workload unknown; coordinator capacity is reserved$/,
  );

  assert.equal(
    (
      ask({
        policy: { shiftAt: null },
        limits: { claude: [window('7D', 99)], codex: [window('7D', 1)] },
      }) as { runtime: string }
    ).runtime,
    'claude',
  );
});

test('a runtime that is not installed, a missing other runtime and an unset family are refused', () => {
  const alone = { installed: ['claude'] };

  for (const [fields, refused] of [
    [
      { named: { runtime: 'codex', model: 'gpt-6-sol' } },
      'codex is not installed',
    ],
    [
      { policy: { work: { review: 'codex' } }, work: 'review' },
      'codex is not installed',
    ],
    [
      {
        work: 'review',
        of: { runtime: 'codex', model: 'gpt-6-sol' },
        policy: { work: { review: 'same' } },
      },
      'codex is not installed',
    ],
    [
      { policy: { work: { review: 'other' } }, work: 'review' },
      'no runtime besides claude is installed',
    ],
  ] as const)
    assert.deepEqual(ask({ ...alone, ...fields }), { refused }, refused);

  assert.deepEqual(ask({ policy: { families: { codex: 'sol' } } }), {
    refused: 'no family is set for claude',
  });
});

test('a runtime over the level stays when no other runtime is installed, and the reason says so', () => {
  assert.deepEqual(
    ask({ installed: ['claude'], limits: { claude: [window('7D', 95)] } }),
    {
      runtime: 'claude',
      model: 'claude-opus-5-5',
      reason:
        'implementation stays on claude; claude (7D 95%); claude workload unknown; claude needs a capacity reserve while coordinator activity is unknown; no other runtime is installed',
    },
  );
});

test('with no rule, review goes to every runtime, and a reviewer over the level folds into the route of the runtime it shifts onto', () => {
  const of = { runtime: 'claude', model: 'claude-opus-5-5' };
  const reason = 'review of claude work requests a familiar on each runtime';

  assert.deepEqual(ask({ work: 'review', of }), [
    {
      runtime: 'claude',
      model: 'claude-opus-5-5',
      reason: `${reason}; claude (5H 20%, 7D 61%); claude workload unknown`,
    },
    {
      runtime: 'codex',
      model: 'gpt-6.1-sol',
      reason: `${reason}; codex (7D 49%); codex workload unknown`,
    },
  ]);

  assert.deepEqual(
    route({
      work: 'review',
      caller: 'claude',
      of,
      policy: defaultPolicy,
      installed,
      catalog,
      accounts: {
        claude: {
          limits: [{ ...window('7D', 40), resetsAt: now / 1000 + 7200 }],
        },
        codex: {
          limits: [{ ...window('7D', 92), resetsAt: now / 1000 + 90_000 }],
          funding: {
            kind: 'credits',
            balance: '25966.0499470000',
            unlimited: false,
            available: true,
            observedAt: now,
          },
        },
      },
      now,
    }),
    {
      routes: [
        {
          runtime: 'claude',
          model: 'claude-opus-5-5',
          reason: `${reason}; claude (7D 40%, resets in 2h0m); claude workload unknown`,
        },
      ],
      folded: [
        {
          runtime: 'claude',
          model: 'claude-opus-5-5',
          from: 'codex',
          reason:
            'review of claude work prefers codex; codex (7D 92%, resets in 1d1h, 25966.05 credits); codex workload unknown; claude (7D 40%, resets in 2h0m); claude workload unknown; codex needs a capacity reserve while coordinator activity is unknown; claude has included usage left',
        },
      ],
    },
  );

  assert.deepEqual(ask({ work: 'review', of, installed: ['claude'] }), {
    runtime: 'claude',
    model: 'claude-opus-5-5',
    reason: `${reason}; claude (5H 20%, 7D 61%); claude workload unknown`,
  });
});

test("a review whose first runtime is over the level folds its shift into the next runtime's route", () => {
  assert.deepEqual(
    route({
      work: 'review',
      caller: 'claude',
      of: { runtime: 'claude', model: 'claude-opus-5-5' },
      policy: defaultPolicy,
      installed,
      catalog,
      accounts: {
        claude: { limits: [window('7D', 95)] },
        codex: { limits: [window('7D', 40)] },
      },
      now,
    }),
    {
      routes: [
        {
          runtime: 'codex',
          model: 'gpt-6.1-sol',
          reason:
            'review of claude work requests a familiar on each runtime; codex (7D 40%); codex workload unknown',
        },
      ],
      folded: [
        {
          runtime: 'codex',
          model: 'gpt-6.1-sol',
          from: 'claude',
          reason:
            'review of claude work prefers claude; claude (7D 95%); claude workload unknown; codex (7D 40%); codex workload unknown; claude needs a capacity reserve while coordinator activity is unknown; codex has included usage left',
        },
      ],
    },
  );
});

test('a rule that names a model or family shifts to the comparable model on a runtime with room, and stays when there is none', () => {
  const claudeHot = { claude: [window('7D', 99)], codex: [window('7D', 1)] };
  const codexHot = { claude: [window('7D', 1)], codex: [window('7D', 99)] };

  for (const [rule, limits, model, sourceModel] of [
    ['claude:claude-opus-5', claudeHot, 'gpt-6-astra', 'claude-opus-5'],
    ['claude:fable', claudeHot, 'gpt-6-astra', 'fable'],
    ['codex:astra', codexHot, 'claude-opus-5-5', 'astra'],
    ['claude:sonnet', claudeHot, 'gpt-6.1-sol', 'sonnet'],
    ['codex:gpt-6.1-terra', codexHot, 'claude-sonnet-5-5', 'gpt-6.1-terra'],
    ['codex:luna', codexHot, 'claude-haiku-5-5', 'luna'],
  ] as const) {
    const source = limits === claudeHot ? 'claude' : 'codex';
    const destination = source === 'claude' ? 'codex' : 'claude';

    assert.deepEqual(
      ask({ policy: { work: { implementation: rule } }, limits }),
      {
        runtime: destination,
        model,
        from: source,
        reason: `implementation prefers ${source}; ${source} (7D 99%); ${source} workload unknown; ${destination} (7D 1%); ${destination} workload unknown; ${source} needs a capacity reserve while coordinator activity is unknown; ${destination} has included usage left; ${model} is comparable to ${sourceModel}`,
      },
      rule,
    );
  }

  assert.deepEqual(
    ask({
      policy: { work: { implementation: 'codex:gpt-6-nova' } },
      limits: codexHot,
    }),
    {
      runtime: 'codex',
      model: 'gpt-6-nova',
      reason:
        'the policy sends implementation to codex:gpt-6-nova; codex (7D 99%); codex workload unknown; codex needs a capacity reserve while coordinator activity is unknown; claude has no model comparable to gpt-6-nova',
    },
  );

  assert.deepEqual(
    ask({ policy: { work: { implementation: 'claude:claude-opus-5' } } }),
    {
      runtime: 'claude',
      model: 'claude-opus-5',
      reason:
        'the policy sends implementation to claude:claude-opus-5; claude (5H 20%, 7D 61%); claude workload unknown',
    },
  );
});

test('a model whose own weekly window is over the level shifts like a runtime over it, and other models on that runtime do not', () => {
  const scoped = (model: string, percent: number, limits = fresh) => ({
    claude: {
      limits: limits.claude,
      modelLimits: [{ ...window('7D', percent), model }],
    },
    codex: { limits: limits.codex },
  });

  const fable = { work: { implementation: 'claude:fable' } };

  assert.deepEqual(ask({ policy: fable, accounts: scoped('Fable', 100) }), {
    runtime: 'codex',
    model: 'gpt-6-astra',
    from: 'claude',
    reason:
      'implementation prefers claude; claude (5H 20%, 7D 61%, 7D Fable 100%); claude workload unknown; codex (7D 49%); codex workload unknown; claude has a full applicable usage window; codex has included usage left; gpt-6-astra is comparable to fable',
  });

  assert.deepEqual(ask({ accounts: scoped('Fable', 100) }), {
    runtime: 'claude',
    model: 'claude-opus-5-5',
    reason:
      'implementation stays on claude; claude (5H 20%, 7D 61%); claude workload unknown; comparative workload is unknown; retaining the caller',
  });

  // a spent model with no runtime under the level falls back to one with included usage left, as a spent runtime does
  assert.deepEqual(
    ask({
      policy: fable,
      accounts: scoped('Fable', 100, {
        claude: fresh.claude,
        codex: [window('7D', 95)],
      }),
    }),
    {
      runtime: 'codex',
      model: 'gpt-6-astra',
      from: 'claude',
      reason:
        'implementation prefers claude; claude (5H 20%, 7D 61%, 7D Fable 100%); claude workload unknown; codex (7D 95%); codex workload unknown; claude has a full applicable usage window; codex has included usage left; gpt-6-astra is comparable to fable',
    },
  );

  assert.deepEqual(
    ask({
      caller: 'codex',
      accounts: scoped('Opus', 95, {
        claude: [window('7D', 40)],
        codex: [window('7D', 92)],
      }),
    }),
    {
      runtime: 'codex',
      model: 'gpt-6.1-sol',
      reason:
        'implementation stays on codex; codex (7D 92%); codex workload unknown; codex needs a capacity reserve while coordinator activity is unknown; claude (7D 40%, 7D Opus 95%); claude workload unknown; coordinator capacity is reserved',
    },
  );
});

test('a named model runs as named with its own weekly window in the reason', () => {
  const funding = {
    kind: 'extra-usage' as const,
    enabled: false,
    used: 0,
    limit: 10000,
    currency: 'USD',
    decimalPlaces: 2,
    observedAt: now,
  };

  assert.deepEqual(
    ask({
      named: { runtime: 'claude', model: 'fable' },
      accounts: {
        claude: {
          limits: [window('7D', 61)],
          modelLimits: [{ ...window('7D', 100), model: 'Fable' }],
          funding,
        },
      },
    }),
    {
      runtime: 'claude',
      model: 'claude-fable-5-1',
      reason:
        'named explicitly; claude (7D 61%, 7D Fable 100%, extra off: USD 0.00 spent / USD 100.00 cap)',
    },
  );
});

/** the test catalog with every codex model of a family removed. */
const without = (family: string): Catalog => ({
  ...catalog,
  models: catalog.models.filter(
    ({ agent, id }) => agent !== 'codex' || !id.endsWith(`-${family}`),
  ),
});

test("a tier picks each runtime's family at that tier, on every placement path", () => {
  const of = { runtime: 'claude', model: 'claude-opus-5-5' };
  const reason = 'review of claude work requests a familiar on each runtime';

  assert.deepEqual(ask({ work: 'review', of, tier: 'cheap' }), [
    {
      runtime: 'claude',
      model: 'claude-haiku-5-5',
      reason: `${reason}; claude (5H 20%, 7D 61%); claude workload unknown`,
    },
    {
      runtime: 'codex',
      model: 'gpt-6-luna',
      reason: `${reason}; codex (7D 49%); codex workload unknown`,
    },
  ]);

  assert.deepEqual(ask({ work: 'planning', caller: 'codex', tier: 'strong' }), {
    runtime: 'codex',
    model: 'gpt-6-astra',
    reason:
      'planning stays on codex; codex (7D 49%); codex workload unknown; comparative workload is unknown; retaining the caller',
  });

  const shifted = ask({
    tier: 'cheap',
    limits: { claude: [window('7D', 100)], codex: [window('7D', 49)] },
  });

  assert.ok(!('refused' in shifted) && !Array.isArray(shifted));

  assert.deepEqual(
    { runtime: shifted.runtime, model: shifted.model, from: shifted.from },
    { runtime: 'codex', model: 'gpt-6-luna', from: 'claude' },
  );
});

test("a tier keeps the user's family when it is in that tier, and tries the tier's other families before falling back", () => {
  const model = (fields: Parameters<typeof ask>[0]) => {
    const routed = ask(fields);
    assert.ok(!('refused' in routed) && !Array.isArray(routed));

    return routed.model;
  };

  assert.equal(
    model({
      caller: 'codex',
      tier: 'standard',
      policy: { families: { claude: 'opus', codex: 'terra' } },
    }),
    'gpt-6.1-terra',
  );

  assert.equal(
    model({
      tier: 'strong',
      policy: { families: { claude: 'fable', codex: 'sol' } },
    }),
    'claude-fable-5-1',
  );

  assert.equal(
    model({
      caller: 'codex',
      tier: 'standard',
      catalog: without('sol'),
      policy: { families: { claude: 'opus', codex: 'astra' } },
    }),
    'gpt-6.1-terra',
  );
});

test('a runtime with no runnable family at the tier runs its policy family, and only its own placements say so', () => {
  const note =
    'codex has no cheap family it can run: codex lists no luna model to run; using its policy family';

  assert.deepEqual(
    route({
      work: 'review',
      caller: 'claude',
      tier: 'cheap',
      policy: defaultPolicy,
      installed,
      catalog: without('luna'),
      accounts: {
        claude: { limits: [window('7D', 100)] },
        codex: { limits: [window('7D', 49)] },
      },
      now,
    }),
    {
      routes: [
        {
          runtime: 'codex',
          model: 'gpt-6.1-sol',
          reason: `review requests a familiar on each runtime; codex (7D 49%); codex workload unknown; ${note}`,
        },
      ],
      folded: [
        {
          runtime: 'codex',
          model: 'gpt-6.1-sol',
          from: 'claude',
          reason: `review prefers claude; claude (7D 100%); claude workload unknown; codex (7D 49%); codex workload unknown; claude has a full applicable usage window; codex has included usage left; ${note}`,
        },
      ],
    },
  );

  // a placement that leaves codex for claude carries no codex note
  const moved = route({
    work: 'review',
    caller: 'claude',
    tier: 'cheap',
    policy: defaultPolicy,
    installed,
    catalog: without('luna'),
    accounts: {
      claude: { limits: [window('7D', 49)] },
      codex: { limits: [window('7D', 100)] },
    },
    now,
  });

  assert.ok(!('refused' in moved));

  assert.deepEqual(
    [...moved.routes, ...(moved.folded ?? [])].map(
      ({ runtime, model, from, reason }) => ({
        runtime,
        model,
        from,
        noted: reason.includes('has no cheap family'),
      }),
    ),
    [
      {
        runtime: 'claude',
        model: 'claude-haiku-5-5',
        from: undefined,
        noted: false,
      },
      {
        runtime: 'claude',
        model: 'claude-haiku-5-5',
        from: 'codex',
        noted: false,
      },
    ],
  );
});

test('a rule that pins a model keeps it under a tier, and says the tier did not apply', () => {
  assert.deepEqual(
    ask({
      work: 'review',
      tier: 'cheap',
      policy: { work: { review: 'claude:opus' } },
    }),
    {
      runtime: 'claude',
      model: 'claude-opus-5-5',
      reason:
        'the policy sends review to claude:opus; claude (5H 20%, 7D 61%); claude workload unknown; the policy pins opus; the cheap tier does not apply',
    },
  );
});
