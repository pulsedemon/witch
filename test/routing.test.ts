import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AccountReading, Limit } from '../src/agents/types.js';
import type { Catalog, Policy, Route, Work } from '../src/core/routing.js';
import { defaultPolicy, family, resolve, route } from '../src/core/routing.js';
import { USAGE_CURRENT_MS } from '../src/core/usage.js';

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
    reason:
      'claude 7D 100% is at or over 90%, and codex 7D 100%, 12345.678900 credits has usable credits',
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
        'implementation stays on codex; codex 7D 100%, 12345.678900 credits has usable credits',
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
    assert.equal(
      (
        ask({
          accounts: { ...accounts, codex: { ...funded, creditAccess } },
        }) as { runtime: string }
      ).runtime,
      'claude',
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
      reason: 'the policy sends implementation to codex:gpt-reserve',
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

test('with no rule, work stays on the caller with its family at the newest version', () => {
  assert.deepEqual(ask(), {
    runtime: 'claude',
    model: 'claude-opus-5-5',
    reason: 'implementation stays on claude',
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
      reason: 'the policy sends review of codex work to other',
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
      reason: 'review stays on codex, which produced it',
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

test('work shifts to the runtime with room once the chosen one is over the level, in either direction', () => {
  assert.deepEqual(
    ask({
      limits: {
        claude: [window('5H', 20), window('7D', 92)],
        codex: [window('7D', 49)],
      },
    }),
    {
      runtime: 'codex',
      model: 'gpt-6.1-sol',
      reason: 'claude 7D 92% is at or over 90%, and codex 7D 49% has room',
    },
  );
  // the reason names the current window that is over, not a stale one beside it
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
      reason: 'claude 5H 95% is at or over 90%, and codex 5H 10% has room',
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
      reason: 'codex 7D 92% is at or over 90%, and claude 7D 40% has room',
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
        'the policy sends review of codex work to other; claude 7D 92% is at or over 90%, but codex produced the work',
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
        reason: `implementation stays on claude; claude 7D 92% is at or over 90%, but ${missing}`,
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
        'implementation stays on claude; claude 7D 92% is at or over 90%, but codex lists no sol model to run',
    },
  );
  // the reason names the current window that is over, not a stale one beside it
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
        "implementation stays on claude; claude 5H 95% is at or over 90%, but codex's 7D reading is not current",
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
        "implementation stays on claude; claude's 7D reading is not current",
    },
  );
  assert.match(
    (
      ask({
        limits: { claude: [window('7D', 92)], codex: [window('7D', 95)] },
      }) as { reason: string }
    ).reason,
    /but codex is at 90% or more too$/,
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
        'implementation stays on claude; claude 7D 95% is at or over 90%, but no other runtime is installed',
    },
  );
});

test('with no rule, review goes to every runtime, and a reviewer over the level shifts even onto the producer', () => {
  const of = { runtime: 'claude', model: 'claude-opus-5-5' };
  const reason = 'review of claude work goes to every runtime';
  assert.deepEqual(ask({ work: 'review', of }), [
    { runtime: 'claude', model: 'claude-opus-5-5', reason },
    { runtime: 'codex', model: 'gpt-6.1-sol', reason },
  ]);
  assert.deepEqual(
    ask({
      work: 'review',
      of,
      limits: { claude: [window('7D', 40)], codex: [window('7D', 92)] },
    }),
    [
      { runtime: 'claude', model: 'claude-opus-5-5', reason },
      {
        runtime: 'claude',
        model: 'claude-opus-5-5',
        reason: 'codex 7D 92% is at or over 90%, and claude 7D 40% has room',
      },
    ],
  );
  assert.deepEqual(ask({ work: 'review', of, installed: ['claude'] }), {
    runtime: 'claude',
    model: 'claude-opus-5-5',
    reason,
  });
});

test('a rule that names a model or family shifts to the comparable model on a runtime with room, and stays when there is none', () => {
  const claudeHot = { claude: [window('7D', 99)], codex: [window('7D', 1)] };
  const codexHot = { claude: [window('7D', 1)], codex: [window('7D', 99)] };
  for (const [rule, limits, model, from] of [
    ['claude:claude-opus-5', claudeHot, 'gpt-6-astra', 'claude-opus-5'],
    ['claude:fable', claudeHot, 'gpt-6-astra', 'fable'],
    ['codex:astra', codexHot, 'claude-opus-5-5', 'astra'],
    ['claude:sonnet', claudeHot, 'gpt-6.1-sol', 'sonnet'],
    ['codex:gpt-6.1-terra', codexHot, 'claude-sonnet-5-5', 'gpt-6.1-terra'],
    ['codex:luna', codexHot, 'claude-haiku-5-5', 'luna'],
  ] as const)
    assert.deepEqual(
      ask({ policy: { work: { implementation: rule } }, limits }),
      {
        runtime: limits === claudeHot ? 'codex' : 'claude',
        model,
        reason: `${limits === claudeHot ? 'claude 7D 99% is at or over 90%, and codex 7D 1%' : 'codex 7D 99% is at or over 90%, and claude 7D 1%'} has room; ${model} is comparable to ${from}`,
      },
      rule,
    );
  assert.deepEqual(
    ask({
      policy: { work: { implementation: 'codex:gpt-6-nova' } },
      limits: codexHot,
    }),
    {
      runtime: 'codex',
      model: 'gpt-6-nova',
      reason:
        'the policy sends implementation to codex:gpt-6-nova; codex 7D 99% is at or over 90%, but claude has no model comparable to gpt-6-nova',
    },
  );
  assert.deepEqual(
    ask({ policy: { work: { implementation: 'claude:claude-opus-5' } } }),
    {
      runtime: 'claude',
      model: 'claude-opus-5',
      reason: 'the policy sends implementation to claude:claude-opus-5',
    },
  );
});
