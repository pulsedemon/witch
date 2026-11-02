import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement } from 'react';
import { test, vi } from 'vitest';
import { accountReading } from '../src/agents/claude-usage.js';
import type { AccountReading } from '../src/agents/types.js';
import {
  AccountUsage,
  creditCapacity,
  fundingText,
  usageContext,
  USAGE_CURRENT_MS,
} from '../src/core/usage.js';
import { App } from '../src/ui/app.js';
import { accountRows } from '../src/ui/status-line.js';
import { appears, close, controlledFixture } from './fixtures/codex-adapter.js';
import { ENTER, fake, show } from './fixtures/ui.js';
import { until } from './fixtures/within.js';

test('native Codex credit states reach both rendered layouts beside a full weekly window', async () => {
  const f = await controlledFixture();
  const { app, coordinator } = fake({
    agents: [
      { id: 'codex', label: 'Codex', installed: true },
      { id: 'claude', label: 'Claude', installed: true },
    ],
    accounts: {},
    native: {
      id: 's',
      agent: 'codex',
      model: 'gpt-6.1-sol',
      permissionMode: 'read-only',
      hasHistory: false,
    },
  });
  const store = new AccountUsage([], (accounts) =>
    coordinator.publish({ accounts }),
  );
  store.report(
    'claude',
    accountReading(
      {
        rate_limits_available: true,
        rate_limits: {
          limits: [],
          extra_usage: {
            is_enabled: false,
            used_credits: 651,
            monthly_limit: 10000,
            currency: 'USD',
            decimal_places: 2,
          },
        },
      },
      { limits: [] },
    ),
  );
  const ui = show(
    createElement(App, { coordinator: app, onExit() {} }),
    115,
    40,
  );
  try {
    await f.session.readAccountUsage!();
    for (const [credits, expected, capacity] of [
      [
        { hasCredits: true, unlimited: false, balance: '12345.678900' },
        '12345.678900 credits',
        'available',
      ],
      [
        { hasCredits: true, unlimited: false, balance: '9876.543210' },
        '9876.543210 credits',
        'available',
      ],
      [
        { hasCredits: false, unlimited: false, balance: '0' },
        '0 credits',
        'unavailable',
      ],
      [
        { hasCredits: false, unlimited: true, balance: null },
        'unlimited credits',
        'available',
      ],
      [
        { hasCredits: true, unlimited: false, balance: null },
        'credits available; balance unavailable',
        'available',
      ],
      [
        { hasCredits: false, unlimited: false, balance: null },
        'no credits',
        'unavailable',
      ],
      [null, 'credits unavailable', 'unknown'],
    ] as const) {
      await writeFile(
        join(f.cwd, 'account-usage.json'),
        JSON.stringify({
          accountId: 'test-account',
          rateLimits: {
            limitId: 'codex',
            primary: {
              usedPercent: 100,
              windowDurationMins: 10080,
              resetsAt: 2000000000,
            },
            secondary: null,
            credits,
            spendControlReached: false,
            rateLimitReachedType: 'rate_limit_reached',
          },
        }),
      );
      await f.session.readAccountUsage!();
      const account = f.session.usage.account!;
      store.report('codex', account);
      assert.equal(creditCapacity(account, Date.now()), capacity);
      assert.equal(fundingText(account.funding!), expected);
      for (const width of [115, 80]) {
        ui.resize(width);
        await until(
          expected,
          () =>
            expected.split('; ').every((part) => ui.text().includes(part)) &&
            ui.text().split('\n')[0]!.includes('┃') === (width === 115),
        );
        assert.match(ui.text(), /7D 100%/);
        const accountText = ui
          .text()
          .split('\n')
          .map((line) =>
            width === 115 ? line.slice(line.lastIndexOf('┃') + 1) : line,
          )
          .join(' ')
          .replace(/\s+/g, ' ');
        assert.match(
          accountText,
          /CLAUDE extra off: USD 6.51 spent \/ USD 100.00 cap/,
        );
        for (const old of ['12345.678900', '9876.543210'])
          if (old !== credits?.balance) assert.ok(!ui.text().includes(old));
        assert.equal(ui.text().split('\n').length, 40);
      }
    }
  } finally {
    ui.unmount();
    await close(f.session, f.cwd);
  }
});

test('a rolling update retains the credit timestamp, ignores another quota, and cannot erase a spending denial', async () => {
  const f = await controlledFixture();
  try {
    await f.session.readAccountUsage!();
    await writeFile(
      join(f.cwd, 'account-usage.json'),
      JSON.stringify({
        accountId: 'one',
        rateLimits: {
          limitId: 'codex',
          credits: { hasCredits: true, unlimited: false, balance: '123.456' },
          spendControlReached: false,
          rateLimitReachedType: null,
        },
      }),
    );
    await f.session.readAccountUsage!();
    const initial = f.session.usage.account!;
    await f.emit({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'codex',
          credits: null,
          primary: {
            usedPercent: 100,
            windowDurationMins: 10080,
            resetsAt: 2000000000,
          },
        },
      },
    });
    assert.equal(f.session.usage.account!.funding, initial.funding);
    await f.emit({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'other',
          credits: { hasCredits: false, unlimited: false, balance: '0' },
        },
      },
    });
    assert.equal(f.session.usage.account!.funding, initial.funding);
    await f.emit({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'other',
          rateLimitReachedType: 'workspace_member_credits_depleted',
        },
      },
    });
    assert.equal(f.session.usage.account!.funding, initial.funding);
    assert.equal(
      creditCapacity(f.session.usage.account!, Date.now()),
      'unavailable',
    );
    await f.session.readAccountUsage!();
    assert.equal(
      creditCapacity(f.session.usage.account!, Date.now()),
      'available',
    );

    await f.emit({
      method: 'account/rateLimits/updated',
      params: { rateLimits: { limitId: 'codex', spendControlReached: true } },
    });
    assert.equal(
      creditCapacity(f.session.usage.account, Date.now()),
      'unavailable',
    );
    await f.emit({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'codex',
          credits: { hasCredits: true, unlimited: false, balance: '200.000' },
        },
      },
    });
    assert.equal(
      creditCapacity(f.session.usage.account, Date.now()),
      'unavailable',
    );
    assert.equal(f.session.usage.account!.funding?.kind, 'credits');
    assert.notEqual(f.session.usage.account!.funding, initial.funding);
  } finally {
    await close(f.session, f.cwd);
  }
});

test('a delayed account reply preserves newer native fields and accepts untouched fields', async () => {
  const f = await controlledFixture();
  const response = {
    accountId: 'one',
    rateLimits: {
      limitId: 'codex',
      primary: {
        usedPercent: 10,
        windowDurationMins: 300,
        resetsAt: 2000000000,
      },
      secondary: {
        usedPercent: 35,
        windowDurationMins: 10080,
        resetsAt: 2000500000,
      },
      credits: { hasCredits: true, unlimited: false, balance: '123.456' },
      spendControlReached: false,
      rateLimitReachedType: null,
    },
  };
  try {
    await f.session.readAccountUsage!();
    await writeFile(
      join(f.cwd, 'account-usage.json'),
      JSON.stringify(response),
    );
    await f.session.readAccountUsage!();
    await writeFile(join(f.cwd, 'hold-account'), 'yes');
    const pending = f.session.readAccountUsage!();
    await appears(join(f.cwd, 'account-1.json'));
    await f.emit({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'codex',
          primary: { ...response.rateLimits.primary, usedPercent: 100 },
          credits: { hasCredits: false, unlimited: false, balance: '0' },
          spendControlReached: true,
        },
      },
    });
    const newer = f.session.usage.account!;
    response.rateLimits.secondary.usedPercent = 41;
    await f.reply(1, { result: response }, 'account');
    await pending;
    const reading = f.session.usage.account!;
    assert.equal(reading.funding, newer.funding);
    assert.equal(reading.creditAccess, newer.creditAccess);
    assert.equal(creditCapacity(reading, Date.now()), 'unavailable');
    assert.deepEqual(
      reading.limits.find(({ window }) => window === '5H'),
      newer.limits.find(({ window }) => window === '5H'),
    );
    assert.equal(
      reading.limits.find(({ window }) => window === '7D')?.percent,
      41,
    );

    const next = f.session.readAccountUsage!();
    await appears(join(f.cwd, 'account-2.json'));
    await f.emit({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'other',
          rateLimitReachedType: 'workspace_member_credits_depleted',
        },
      },
    });
    const denial = f.session.usage.account!.creditAccess;
    response.rateLimits.credits.balance = '789.012';
    await f.reply(2, { result: response }, 'account');
    await next;
    assert.equal(
      fundingText(f.session.usage.account!.funding!),
      '789.012 credits',
    );
    assert.equal(f.session.usage.account!.creditAccess, denial);

    await rm(join(f.cwd, 'hold-account'));
    await f.session.readAccountUsage!();
    assert.equal(
      creditCapacity(f.session.usage.account, Date.now()),
      'available',
    );
    await writeFile(join(f.cwd, 'hold-account'), 'yes');
    const switched = f.session.readAccountUsage!();
    await appears(join(f.cwd, 'account-3.json'));
    await f.emit({
      method: 'account/rateLimits/updated',
      params: { rateLimits: { limitId: 'codex', spendControlReached: true } },
    });
    await f.reply(3, { result: { ...response, accountId: 'two' } }, 'account');
    await switched;
    assert.equal(f.session.usage.account!.identity, 'two:codex');
    assert.equal(
      creditCapacity(f.session.usage.account, Date.now()),
      'available',
    );
  } finally {
    await close(f.session, f.cwd);
  }
});

for (const [name, limitId, accountId, minutes, denial, expectedPercent] of [
  ['ignores another quota', 'codex_other', 'one', 60, null, 10],
  ['ignores another quota without identity', 'codex_other', null, 60, null, 10],
  ['keeps its own newer window', 'codex', 'one', 300, null, 70],
  [
    'keeps workspace denial without borrowing quota windows',
    'codex_other',
    'one',
    60,
    'workspace_member_credits_depleted',
    10,
  ],
] as const)
  test(`the first account read ${name}`, async () => {
    const f = await controlledFixture('initial-account');
    try {
      const pending = f.session.readAccountUsage!();
      await appears(join(f.cwd, 'account-1.json'));
      await f.emit({
        method: 'account/rateLimits/updated',
        params: {
          rateLimits: {
            limitId,
            primary: {
              usedPercent: 70,
              windowDurationMins: minutes,
              resetsAt: 2000000000,
            },
            credits: null,
            spendControlReached: null,
            rateLimitReachedType: denial,
          },
        },
      });
      await f.reply(
        1,
        {
          result: {
            accountId,
            rateLimits: {
              limitId: 'codex',
              primary: {
                usedPercent: 10,
                windowDurationMins: 300,
                resetsAt: 2000000000,
              },
              credits: {
                hasCredits: true,
                unlimited: false,
                balance: '123.456',
              },
              spendControlReached: false,
              rateLimitReachedType: null,
            },
          },
        },
        'account',
      );
      await pending;
      const reading = f.session.usage.account!;
      assert.deepEqual(
        reading.limits.map(({ window, percent }) => ({ window, percent })),
        [{ window: '5H', percent: expectedPercent }],
      );
      assert.equal(fundingText(reading.funding!), '123.456 credits');
      assert.equal(
        creditCapacity(reading, Date.now()),
        denial ? 'unavailable' : 'available',
      );
    } finally {
      await close(f.session, f.cwd);
    }
  });

test('Claude spend keeps native units and disabled state, and a cached failure cannot refresh it', () => {
  const now = 2000000000000;
  vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const raw = {
      rate_limits_available: true,
      rate_limits: {
        seven_day: { utilization: 100, resets_at: null },
        limits: [],
        extra_usage: {
          is_enabled: false,
          monthly_limit: 10000,
          used_credits: 651,
          currency: 'USD',
          decimal_places: 2,
        },
      },
    };
    const first = accountReading(raw, { limits: [] })!;
    assert.deepEqual(first.funding, {
      kind: 'extra-usage',
      enabled: false,
      used: 651,
      limit: 10000,
      currency: 'USD',
      decimalPlaces: 2,
      observedAt: now - 60000,
    });
    assert.equal(creditCapacity(first, now), 'unavailable');
    vi.spyOn(Date, 'now').mockReturnValue(now + USAGE_CURRENT_MS + 1);
    const failed = accountReading(
      { ...raw, rate_limits: { ...raw.rate_limits, limits: undefined } },
      first,
    )!;
    assert.equal(failed.limits, first.limits);
    assert.equal(failed.funding, first.funding);
    assert.equal(failed.creditAccess, first.creditAccess);
    assert.equal(creditCapacity(failed, Date.now()), 'unknown');
    const malformed = accountReading(
      {
        ...raw,
        rate_limits: {
          ...raw.rate_limits,
          extra_usage: { is_enabled: 'invalid' },
        },
      },
      first,
    )!;
    assert.equal(malformed.funding, first.funding);
    assert.equal(malformed.limits[0]!.percent, 100);
  } finally {
    vi.restoreAllMocks();
  }
});

test('credit access expires independently of newly observed windows', () => {
  const now = 2000000000000;
  const account: AccountReading = {
    limits: [{ window: '7D', percent: 100, observedAt: now }],
    funding: {
      kind: 'credits',
      balance: '123.00',
      available: true,
      unlimited: false,
      observedAt: now,
    },
    creditAccess: {
      state: 'available',
      observedAt: now - USAGE_CURRENT_MS - 1,
    },
  };
  assert.equal(creditCapacity(account, now), 'unknown');
});

test('funding retained during an account read expires before its later access observation', async () => {
  const f = await controlledFixture();
  try {
    await f.session.readAccountUsage!();
    await writeFile(join(f.cwd, 'hold-account'), 'yes');
    const pending = f.session.readAccountUsage!();
    await appears(join(f.cwd, 'account-1.json'));
    const now = 2_000_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const rateLimits = {
      limitId: 'codex',
      credits: { hasCredits: true, unlimited: false, balance: '123.456' },
      spendControlReached: false,
      rateLimitReachedType: null,
    };
    await f.emit({
      method: 'account/rateLimits/updated',
      params: { rateLimits },
    });
    clock.mockReturnValue(now + 1000);
    await f.reply(1, { result: { rateLimits } }, 'account');
    await pending;
    const reading = f.session.usage.account!;
    assert.equal(reading.funding!.observedAt, now);
    assert.equal(reading.creditAccess!.observedAt, now + 1000);
    assert.equal(creditCapacity(reading, now + USAGE_CURRENT_MS), 'available');
    assert.equal(
      creditCapacity(reading, now + USAGE_CURRENT_MS + 1),
      'unknown',
    );
  } finally {
    vi.restoreAllMocks();
    await close(f.session, f.cwd);
  }
});

test('currency formatting preserves minor-unit precision, zero-decimal units, and unlimited caps', () => {
  for (const [amount, currency, decimalPlaces, expected] of [
    [651, 'USD', 2, 'USD 6.51'],
    [651.7, 'USD', 2, 'USD 6.517'],
    [651, 'JPY', 0, 'JPY 651'],
    [0, 'USD', 2, 'USD 0.00'],
    [1e-7, 'USD', 2, 'USD 0.000000001'],
    [651, 'KWD', 2, 'KWD 6.51'],
    [651, 'USD', null, 'USD 651 minor units'],
  ] as const) {
    assert.equal(
      fundingText({
        kind: 'extra-usage',
        enabled: true,
        used: amount,
        limit: null,
        currency,
        decimalPlaces,
        observedAt: 1,
      }),
      `extra on: ${expected} spent / unlimited cap`,
    );
  }
});

test('credit-only stale readings retain the full amount and age at wide, narrow and short terminal sizes', async () => {
  const now = Date.now();
  const reading: AccountReading = {
    limits: [],
    funding: {
      kind: 'credits',
      balance: '42886.6046410000',
      available: true,
      unlimited: false,
      observedAt: now - 11 * 60000,
    },
    creditAccess: { state: 'available', observedAt: now - 11 * 60000 },
  };
  const { app } = fake({
    agents: [{ id: 'codex', label: 'Codex', installed: true }],
    native: {
      id: 's',
      agent: 'codex',
      model: 'gpt-6.1-sol',
      permissionMode: 'read-only',
      hasHistory: false,
    },
    accounts: { codex: reading },
  });
  for (const [width, height] of [
    [115, 40],
    [80, 40],
    [115, 15],
    [30, 20],
  ] as const) {
    const ui = show(
      createElement(App, { coordinator: app, onExit() {} }),
      width,
      height,
    );
    try {
      await until(
        'complete stale credits',
        () =>
          ui.text().includes('42886.6046410000 credits') &&
          /11M\s+OLD/.test(ui.text()),
      );
      assert.equal(ui.text().split('\n').length, height);
      assert.match(ui.text(), /CTX/);
    } finally {
      ui.unmount();
    }
  }
  assert.equal(
    usageContext({ codex: reading }, [{ id: 'codex', label: 'Codex' }], now),
    'Account usage: Codex 42886.6046410000 credits, not current (11 minutes old), credit execution unknown. A reading older than 10 minutes or past its reset is not current.',
  );
});

test('a tiny terminal preserves the composer and live balance beside two accounts and a long error', async () => {
  const now = Date.now();
  const { app, coordinator, calls } = fake({
    error:
      'A long error which wraps onto several rows in a narrow terminal. '.repeat(
        3,
      ),
    agents: [
      { id: 'codex', label: 'Codex', installed: true },
      { id: 'claude', label: 'Claude', installed: true },
    ],
    native: {
      id: 's',
      agent: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
      permissionMode: 'read-only',
      hasHistory: false,
    },
    accounts: {
      codex: {
        limits: [{ window: '7D', percent: 100, observedAt: now }],
        funding: {
          kind: 'credits',
          balance: '42886.6046410000',
          available: true,
          unlimited: false,
          observedAt: now,
        },
      },
      claude: {
        limits: [],
        funding: {
          kind: 'extra-usage',
          enabled: false,
          used: 651,
          limit: 10000,
          currency: 'USD',
          decimalPlaces: 2,
          observedAt: now,
        },
      },
    },
  });
  const ui = show(
    createElement(App, { coordinator: app, onExit() {} }),
    30,
    12,
  );
  try {
    await until('live balance', () =>
      ui.text().includes('42886.6046410000 credits'),
    );
    assert.equal(ui.text().split('\n').length, 12);
    assert.match(ui.text(), /Ask the agent/);
    assert.match(ui.text(), /\/delegation/);
    for (const [funding, expected] of [
      [
        { balance: '42886.6046410000', available: true, unlimited: false },
        '42886.6046410000 credits',
      ],
      [
        { balance: null, available: false, unlimited: true },
        'unlimited credits',
      ],
    ] as const) {
      coordinator.publish({
        accounts: {
          ...coordinator.snapshot.accounts,
          codex: {
            limits: [{ window: '7D', percent: 100, observedAt: now }],
            funding: { kind: 'credits', ...funding, observedAt: now },
            creditAccess: { state: 'unavailable', observedAt: now },
          },
        },
      });
      await until(
        'blocked live balance',
        () => ui.text().includes(expected) && ui.text().includes('BLOCKED'),
      );
      assert.equal(ui.text().split('\n').length, 12);
      assert.match(ui.text(), /Ask the agent/);
    }
    const draft = 'first line\nsecond line\nthird line\nfourth line';
    ui.stdin.write(`\u001b[200~${draft}\u001b[201~`);
    await until('multiline draft', () => ui.text().includes('fourth line'));
    for (const [phase, pendingCompaction] of [
      ['idle', false],
      ['running', false],
      ['running', true],
    ] as const) {
      coordinator.publish({
        phase,
        pendingCompaction,
        native: { ...coordinator.snapshot.native!, agent: 'claude' },
        accounts: {
          ...coordinator.snapshot.accounts,
          claude: {
            limits: [],
            funding: {
              kind: 'extra-usage',
              enabled: false,
              used: 651,
              limit: 10000,
              currency: 'USD',
              decimalPlaces: null,
              observedAt: now,
            },
          },
        },
      });
      await until('live raw-unit spending', () => {
        const text = ui.text();
        return (
          text.startsWith(phase.toUpperCase()) &&
          text.includes('Pending: /compact') === pendingCompaction &&
          /extra off: USD 651 minor\s+units spent \/ USD 10000\s+minor units cap/.test(
            text,
          )
        );
      });
      assert.equal(ui.text().split('\n').length, 12);
      assert.match(ui.text(), /^ ┃ fourth line\s+┃$/m);
      assert.match(ui.text(), /^ ┗━+┛$/m);
      if (pendingCompaction) assert.match(ui.text(), /^ Pending: \/compact$/m);
    }
    coordinator.publish({ phase: 'idle', pendingCompaction: false });
    await until('idle composer', () => ui.text().startsWith('IDLE'));
    ui.stdin.write(ENTER);
    await until('complete draft sent', () =>
      calls.some(([method]) => method === 'send'),
    );
    assert.deepEqual(
      calls.find(([method]) => method === 'send'),
      ['send', draft, { composer: true }],
    );
  } finally {
    ui.unmount();
  }
});

test('an unlimited grant still displays a native spending denial', () => {
  const now = Date.now();
  assert.deepEqual(
    accountRows(
      {
        limits: [],
        funding: {
          kind: 'credits',
          balance: null,
          available: false,
          unlimited: true,
          observedAt: now,
        },
        creditAccess: { state: 'unavailable', observedAt: now },
      },
      now,
      false,
    ),
    ['unlimited credits', 'credit spending blocked'],
  );
});
