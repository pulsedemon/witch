import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { NativeStop } from '../src/agents/shutdown.js';
import { CodexAccount } from '../src/agents/codex-limits.js';
import type {
  AccountReading,
  AgentSession,
  Limit,
  ModelDiscoveryOptions,
} from '../src/agents/types.js';
import {
  AccountUsage,
  creditCapacity,
  current,
  due,
  headroom,
  over,
  USAGE_CURRENT_MS,
  USAGE_PROBE_MS,
  usageContext,
} from '../src/core/usage.js';
import { FixtureAgent } from './fixtures/agent.js';

const now = 2_000_000_000_000;

const window = (
  name: string,
  percent: number,
  fields: Partial<Limit> = {},
): Limit => ({
  window: name,
  percent,
  observedAt: now - 1000,
  ...fields,
});

test('a window is current when observed within the bound and before its reset', () => {
  assert.equal(current(window('5H', 10), now), true);

  assert.equal(
    current(window('5H', 10, { observedAt: now - USAGE_CURRENT_MS }), now),
    true,
  );

  assert.equal(
    current(window('5H', 10, { observedAt: now - USAGE_CURRENT_MS - 1 }), now),
    false,
  );

  assert.equal(
    current(window('5H', 10, { resetsAt: now / 1000 + 1 }), now),
    true,
  );

  assert.equal(current(window('5H', 10, { resetsAt: now / 1000 }), now), false);
});

test('only a non-empty reading whose every window is current and under the level has headroom', () => {
  const fresh = [window('5H', 20), window('7D', 40)];

  assert.equal(headroom(fresh, 90, now), true);

  assert.equal(headroom([], 90, now), false);

  assert.equal(headroom([window('5H', 20), window('7D', 90)], 90, now), false);

  assert.equal(
    headroom(
      [
        window('5H', 20),
        window('7D', 10, { observedAt: now - USAGE_CURRENT_MS - 1 }),
      ],
      90,
      now,
    ),
    false,
  );

  assert.equal(
    headroom([window('5H', 20, { resetsAt: now / 1000 - 1 })], 90, now),
    false,
  );
});

test('a current window at the level is over even beside a stale one, and a stale one alone is not', () => {
  const stale = window('7D', 99, { observedAt: now - USAGE_CURRENT_MS - 1 });

  assert.equal(over([window('5H', 90), stale], 90, now), true);

  assert.equal(over([window('5H', 89), stale], 90, now), false);

  assert.equal(over([], 90, now), false);
});

test('a reading is due when it has no window or any window is not current', () => {
  assert.equal(due({ limits: [] }, now), true);

  assert.equal(
    due(
      {
        limits: [window('5H', 20), window('7D', 40)],
        funding: { kind: 'unavailable', observedAt: now },
      },
      now,
    ),
    false,
  );

  assert.equal(
    due(
      {
        limits: [
          window('5H', 20),
          window('7D', 40, { observedAt: now - USAGE_CURRENT_MS - 1 }),
        ],
      },
      now,
    ),
    true,
  );
});

function readings() {
  const b = new FixtureAgent('b');

  const published: Record<string, AccountReading>[] = [];

  const usage = new AccountUsage([{ adapter: b, executable: 'b' }], (limits) =>
    published.push(limits),
  );

  return { b, usage, published };
}

function pending() {
  let settle!: (limits: Limit[]) => void;

  const promise = new Promise<AccountReading>(
    (resolve) => (settle = (limits) => resolve({ limits })),
  );

  return { promise, settle };
}

test('a reading is read once while due, and a read in flight is joined', async () => {
  const { b, usage, published } = readings();

  const read = pending();

  b.accountRead = () => read.promise;

  const first = usage.refresh('b', '/w');

  let joined = false;

  const second = usage.refresh('b', '/w').then(() => (joined = true));

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(joined, false);

  read.settle([window('7D', 40, { observedAt: Date.now() })]);

  await Promise.all([first, second]);

  assert.equal(b.accountReads.length, 1);

  assert.equal(published.at(-1)!.b!.limits[0]!.percent, 40);

  await usage.refresh('b', '/w');

  assert.equal(b.accountReads.length, 1);
});

for (const outcome of ['empty', 'failed'] as const)
  test(`an ${outcome} read is not repeated until the bound has passed`, async (t) => {
    const { b, usage, published } = readings();

    b.accountRead = () =>
      outcome === 'empty'
        ? Promise.resolve({ limits: [] })
        : Promise.reject(new Error('limits need a login'));

    await usage.refresh('b', '/w');

    await usage.refresh('b', '/w');

    assert.equal(b.accountReads.length, 1);

    assert.deepEqual(
      published,
      outcome === 'empty' ? [{ b: { limits: [] } }] : [],
    );

    const later = Date.now() + USAGE_CURRENT_MS + 1;

    vi.spyOn(Date, 'now').mockReturnValue(later);

    t.onTestFinished(() => {
      vi.restoreAllMocks();
    });

    await usage.refresh('b', '/w');

    assert.equal(b.accountReads.length, 2);
  });

test('force rereads a due reading inside the attempt throttle, joins a read in flight, and leaves a reading that is not due', async () => {
  const { b, usage, published } = readings();

  b.accountRead = async () => ({ limits: [] });

  await usage.refresh('b', '/w');

  await usage.refresh('b', '/w');

  assert.equal(b.accountReads.length, 1);

  const read = Promise.withResolvers<AccountReading>();

  b.accountRead = () => read.promise;

  const forced = usage.refresh('b', '/w', { force: true });

  const joined = usage.refresh('b', '/w', { force: true });

  assert.equal(b.accountReads.length, 2);

  read.resolve({
    limits: [window('7D', 40, { observedAt: Date.now() })],
    funding: { kind: 'unavailable', observedAt: Date.now() },
  });

  await Promise.all([forced, joined]);

  assert.equal(published.at(-1)!.b!.limits[0]!.percent, 40);

  await usage.refresh('b', '/w', { force: true });

  assert.equal(b.accountReads.length, 2);
});

test('after rereads a current reading observed before it, and leaves one observed later', async () => {
  const { b, usage, published } = readings();

  const at = Date.now();

  b.accountRead = async () => ({
    limits: [window('7D', 100, { observedAt: at - 1000 })],
    funding: { kind: 'unavailable', observedAt: at - 1000 },
  });

  await usage.refresh('b', '/w');

  assert.equal(b.accountReads.length, 1);

  b.accountRead = async () => ({
    limits: [window('7D', 20, { observedAt: Date.now() + 1 })],
    funding: { kind: 'unavailable', observedAt: Date.now() + 1 },
  });

  await usage.refresh('b', '/w', { force: true });

  assert.equal(b.accountReads.length, 1);

  await usage.refresh('b', '/w', { force: true, after: at });

  assert.equal(b.accountReads.length, 2);

  assert.equal(published.at(-1)!.b!.limits[0]!.percent, 20);

  await usage.refresh('b', '/w', { force: true, after: at });

  assert.equal(b.accountReads.length, 2);
});

test('a report that arrives during a probe keeps its value when the probe finishes', async () => {
  const { b, usage, published } = readings();

  const read = pending();

  b.accountRead = () => read.promise;

  const probing = usage.refresh('b', '/w');

  const reported = [window('7D', 95, { observedAt: Date.now() })];

  usage.report('b', { limits: reported });

  read.settle([window('7D', 40, { observedAt: Date.now() - 1 })]);

  await probing;

  assert.equal(published.at(-1)!.b!.limits, reported);
});

test('fresh rolling credits without access retry a failed read after the attempt throttle', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);

  try {
    const { b, usage, published } = readings();

    b.accountRead = async () => {
      throw new Error('initial account read failed');
    };

    await usage.refresh('b', '/w');

    const native = new CodexAccount();

    const update = {
      limitId: 'codex',
      primary: {
        usedPercent: 100,
        windowDurationMins: 10080,
        resetsAt: null,
      },
      credits: { hasCredits: true, unlimited: false, balance: '27.123400' },
      spendControlReached: false,
      rateLimitReachedType: null,
    };

    usage.report('b', native.update(update));

    b.accountRead = async () => native.update(update, true)!;

    await usage.refresh('b', '/w');

    assert.equal(b.accountReads.length, 1);

    assert.equal(creditCapacity(published.at(-1)!.b, now), 'unknown');

    const later = now + USAGE_CURRENT_MS + 1;

    clock.mockReturnValue(later);

    usage.report('b', native.update(update));

    await usage.refresh('b', '/w');

    assert.equal(b.accountReads.length, 2);

    assert.equal(creditCapacity(published.at(-1)!.b, later), 'available');
  } finally {
    vi.restoreAllMocks();
  }
});

test('a window a report leaves out keeps its earlier reading, and the same report again publishes nothing', () => {
  const { usage, published } = readings();

  const weekly = window('7D', 95);

  usage.report('b', { limits: [window('5H', 30), weekly] });

  const sparse = [window('5H', 31)];

  usage.report('b', { limits: sparse });

  usage.report('b', { limits: sparse });

  assert.equal(published.length, 2);

  assert.deepEqual(published.at(-1)!.b!.limits, [sparse[0], weekly]);

  assert.equal(over(published.at(-1)!.b!.limits, 90, now), true);
});

test('a probe receives the reading it may extend, and an empty report clears headroom', async () => {
  const { b, usage, published } = readings();

  const kept = [
    window('7D', 99, { observedAt: Date.now() - USAGE_CURRENT_MS - 1 }),
  ];

  usage.report('b', { limits: kept });

  let previous: readonly Limit[] | undefined;

  b.accountRead = async (_options, last) => {
    previous = last.limits;

    return { limits: [] };
  };

  await usage.refresh('b', '/w');

  assert.equal(previous, kept);

  assert.deepEqual(published.at(-1)!.b!.limits, []);

  assert.equal(headroom(published.at(-1)!.b!.limits, 90, Date.now()), false);
});

const live = (agent: string, readAccountUsage?: () => Promise<void>) =>
  ({
    info: { agent },
    closed: false,
    readAccountUsage,
  }) as unknown as AgentSession;

test('the live runtime reads through its session once its connect read ages, and a session that cannot read starts nothing', async () => {
  const { b, usage } = readings();

  const { usage: other, b: silent } = readings();

  let reads = 0;

  usage.connected(
    live('b', async () => void reads++),
    '/w',
  );

  other.connected(live('b'), '/w');

  await usage.refresh('b', '/w');

  assert.equal(reads, 0);

  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + USAGE_CURRENT_MS + 1);

  try {
    await usage.refresh('b', '/w');

    assert.equal(reads, 1);

    assert.equal(b.accountReads.length, 0);

    await other.refresh('b', '/w');

    assert.equal(silent.accountReads.length, 0);
  } finally {
    vi.restoreAllMocks();
  }
});

test('a connect reads the other runtimes', async () => {
  const { b, usage } = readings();

  usage.connected(live('a'), '/w');

  await Promise.resolve();

  assert.equal(b.accountReads.length, 1);
});

test('a probe that never answers is stopped at its bound, so a later read starts again', async () => {
  const { b, usage } = readings();

  let signal: AbortSignal | undefined;

  b.accountRead = (options: ModelDiscoveryOptions) => {
    signal = options.signal;

    return new Promise((_, reject) =>
      options.signal!.addEventListener('abort', () =>
        reject(options.signal!.reason),
      ),
    );
  };

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  try {
    const probing = usage.refresh('b', '/w');

    vi.advanceTimersByTime(USAGE_PROBE_MS - 1);

    assert.equal(signal!.aborted, false);

    vi.advanceTimersByTime(1);

    await probing;

    assert.match(String(signal!.reason), /b usage read timed out/);
  } finally {
    vi.useRealTimers();
  }

  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + USAGE_CURRENT_MS + 1);

  try {
    b.accountRead = undefined;

    await usage.refresh('b', '/w');

    assert.equal(b.accountReads.length, 2);
  } finally {
    vi.restoreAllMocks();
  }
});

test('close stops a probe in flight with the stop options, and later reads start nothing', async () => {
  const { b, usage, published } = readings();

  let signal: AbortSignal | undefined;

  b.accountRead = (options: ModelDiscoveryOptions) => {
    signal = options.signal;

    return new Promise((_, reject) =>
      options.signal!.addEventListener('abort', () =>
        reject(options.signal!.reason),
      ),
    );
  };

  const probing = usage.refresh('b', '/w');

  const stop = { deadline: Date.now() + 1000 };

  await usage.close(stop);

  await probing;

  assert.ok(signal!.reason instanceof NativeStop);

  assert.deepEqual((signal!.reason as NativeStop).options, stop);

  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + USAGE_CURRENT_MS + 1);

  try {
    await usage.refresh('b', '/w');
  } finally {
    vi.restoreAllMocks();
  }

  assert.equal(b.accountReads.length, 1);

  assert.deepEqual(published, []);
});

test('the usage line leaves out runtimes without a window and marks one that is not current', () => {
  const agents = [
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'Codex' },
    { id: 'other', label: 'Other' },
  ];

  assert.equal(usageContext({}, agents, now), undefined);

  assert.equal(
    usageContext(
      {
        claude: { limits: [window('5H', 23.5), window('7D', 61)] },
        codex: {
          limits: [window('7D', 49, { observedAt: now - 14 * 60_000 })],
        },
        other: { limits: [] },
      },
      agents,
      now,
    ),
    'Account usage: Claude Code 5H 24%, 7D 61%; Codex 7D 49%, not current (14 minutes old). A reading older than 10 minutes or past its reset is not current.',
  );
});

test('stale funding admits one read beside current windows, and the attempt throttle still applies', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);

  try {
    const { b, usage, published } = readings();

    const windows = [window('7D', 100)];

    const funding = {
      kind: 'credits' as const,
      balance: '10.00',
      unlimited: false,
      available: true,
      observedAt: now - USAGE_CURRENT_MS - 1,
    };

    usage.report('b', { limits: windows, funding });

    const pending = Promise.withResolvers<AccountReading>();

    b.accountRead = () => pending.promise;

    const first = usage.refresh('b', '/w');

    const joined = usage.refresh('b', '/w');

    const updated = { ...funding, balance: '27.123400', observedAt: now };

    pending.resolve({ limits: windows, funding: updated });

    await Promise.all([first, joined]);

    assert.equal(b.accountReads.length, 1);

    assert.deepEqual(published.at(-1)!.b!.funding, updated);

    usage.report('b', { limits: windows, funding });

    await usage.refresh('b', '/w');

    assert.equal(b.accountReads.length, 1);
  } finally {
    vi.restoreAllMocks();
  }
});

test('a newer window does not discard a probe credit update, but newer credits do', async () => {
  const { b, usage, published } = readings();

  const before = {
    kind: 'credits' as const,
    balance: '10',
    unlimited: false,
    available: true,
    observedAt: 1,
  };

  usage.report('b', { limits: [window('7D', 50)], funding: before });

  const pending = Promise.withResolvers<AccountReading>();

  b.accountRead = () => pending.promise;

  const probe = usage.refresh('b', '/w');

  const newerWindow = window('7D', 99);

  usage.report('b', { limits: [newerWindow] });

  const balance = { ...before, balance: '30', observedAt: Date.now() };

  pending.resolve({ limits: [window('7D', 60)], funding: balance });

  await probe;

  assert.equal(published.at(-1)!.b!.limits[0], newerWindow);

  assert.equal(published.at(-1)!.b!.funding, balance);

  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + USAGE_CURRENT_MS + 1);

  try {
    const later = Promise.withResolvers<AccountReading>();

    b.accountRead = () => later.promise;

    const reading = usage.refresh('b', '/w');

    const zero = {
      ...balance,
      balance: '0',
      available: false,
      observedAt: Date.now(),
    };

    usage.report('b', { limits: [newerWindow], funding: zero });

    later.resolve({
      limits: [newerWindow],
      funding: { ...balance, balance: '40', observedAt: Date.now() },
    });

    await reading;

    assert.equal(published.at(-1)!.b!.funding, zero);
  } finally {
    vi.restoreAllMocks();
  }
});

test('a new native account identity cannot inherit another account credits', () => {
  const { usage, published } = readings();

  usage.report('b', {
    identity: 'first',
    limits: [window('7D', 100)],
    funding: {
      kind: 'credits',
      balance: '50',
      unlimited: false,
      available: true,
      observedAt: now,
    },
    creditAccess: { state: 'available', observedAt: now },
  });

  usage.report('b', { identity: 'second', limits: [window('7D', 30)] });

  assert.equal(published.at(-1)!.b!.funding, undefined);

  assert.equal(published.at(-1)!.b!.creditAccess, undefined);

  assert.equal(published.at(-1)!.b!.limits[0]!.percent, 30);
});

test('an empty probe clears unchanged windows while retaining concurrent credit and window observations', async () => {
  for (const changed of [false, true]) {
    const { b, usage, published } = readings();

    const before = window('7D', 100);

    const five = window('5H', 90);

    usage.report('b', { limits: [before, five] });

    const pending = Promise.withResolvers<AccountReading>();

    b.accountRead = () => pending.promise;

    const reading = usage.refresh('b', '/w');

    const newer = window('5H', 50, { observedAt: Date.now() });

    const funding = {
      kind: 'credits' as const,
      balance: '20',
      available: true,
      unlimited: false,
      observedAt: Date.now(),
    };

    usage.report('b', { limits: [before, changed ? newer : five], funding });

    pending.resolve({ limits: [] });

    await reading;

    assert.deepEqual(published.at(-1)!.b!.limits, changed ? [newer] : []);

    assert.equal(published.at(-1)!.b!.funding, funding);
  }
});
