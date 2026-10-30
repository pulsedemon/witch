import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { NativeStop } from '../src/agents/shutdown.js';
import type {
  AgentSession,
  Limit,
  ModelDiscoveryOptions,
} from '../src/agents/types.js';
import {
  AccountUsage,
  current,
  due,
  headroom,
  over,
  USAGE_CURRENT_MS,
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
  assert.equal(due([], now), true);
  assert.equal(due([window('5H', 20), window('7D', 40)], now), false);
  assert.equal(
    due(
      [
        window('5H', 20),
        window('7D', 40, { observedAt: now - USAGE_CURRENT_MS - 1 }),
      ],
      now,
    ),
    true,
  );
});

function readings() {
  const b = new FixtureAgent('b');
  const published: Record<string, Limit[]>[] = [];
  const usage = new AccountUsage([{ adapter: b, executable: 'b' }], (limits) =>
    published.push(limits),
  );
  return { b, usage, published };
}

function pending() {
  let settle!: (limits: Limit[]) => void;
  const promise = new Promise<Limit[]>((resolve) => (settle = resolve));
  return { promise, settle };
}

test('a reading is read once while due, and a read in flight is joined', async () => {
  const { b, usage, published } = readings();
  const read = pending();
  b.limitsRead = () => read.promise;
  const first = usage.refresh('b', '/w');
  const second = usage.refresh('b', '/w');
  read.settle([window('7D', 40, { observedAt: Date.now() })]);
  await Promise.all([first, second]);
  assert.equal(b.limitReads.length, 1);
  assert.equal(published.at(-1)!.b![0]!.percent, 40);
  await usage.refresh('b', '/w');
  assert.equal(b.limitReads.length, 1);
});

for (const outcome of ['empty', 'failed'] as const)
  test(`an ${outcome} read is not repeated until the bound has passed`, async (t) => {
    const { b, usage, published } = readings();
    b.limitsRead = () =>
      outcome === 'empty'
        ? Promise.resolve([])
        : Promise.reject(new Error('limits need a login'));
    await usage.refresh('b', '/w');
    await usage.refresh('b', '/w');
    assert.equal(b.limitReads.length, 1);
    assert.deepEqual(published, outcome === 'empty' ? [{ b: [] }] : []);
    const later = Date.now() + USAGE_CURRENT_MS + 1;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    t.onTestFinished(() => {
      vi.restoreAllMocks();
    });
    await usage.refresh('b', '/w');
    assert.equal(b.limitReads.length, 2);
  });

test('a report that arrives during a probe keeps its value when the probe finishes', async () => {
  const { b, usage, published } = readings();
  const read = pending();
  b.limitsRead = () => read.promise;
  const probing = usage.refresh('b', '/w');
  const reported = [window('7D', 95, { observedAt: Date.now() })];
  usage.report('b', reported);
  read.settle([window('7D', 40, { observedAt: Date.now() - 1 })]);
  await probing;
  assert.equal(published.at(-1)!.b, reported);
});

test('a probe receives the reading it may extend, and an empty report clears headroom', async () => {
  const { b, usage, published } = readings();
  const kept = [
    window('7D', 99, { observedAt: Date.now() - USAGE_CURRENT_MS - 1 }),
  ];
  usage.report('b', kept);
  let previous: readonly Limit[] | undefined;
  b.limitsRead = async (_options, last) => {
    previous = last;
    return [];
  };
  await usage.refresh('b', '/w');
  assert.equal(previous, kept);
  assert.deepEqual(published.at(-1)!.b, []);
  assert.equal(headroom(published.at(-1)!.b!, 90, Date.now()), false);
});

const live = (agent: string, readLimits?: () => Promise<void>) =>
  ({ info: { agent }, closed: false, readLimits }) as unknown as AgentSession;

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
    assert.equal(b.limitReads.length, 0);
    await other.refresh('b', '/w');
    assert.equal(silent.limitReads.length, 0);
  } finally {
    vi.restoreAllMocks();
  }
});

test('a connect counts as the live runtime attempt and reads the others', async () => {
  const { b, usage } = readings();
  usage.connected(live('a'), '/w');
  await Promise.resolve();
  assert.equal(b.limitReads.length, 1);
});

test('close stops a probe in flight with the stop options, and later reads start nothing', async () => {
  const { b, usage, published } = readings();
  let signal: AbortSignal | undefined;
  b.limitsRead = (options: ModelDiscoveryOptions) => {
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
  assert.equal(b.limitReads.length, 1);
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
        claude: [window('5H', 23.5), window('7D', 61)],
        codex: [window('7D', 49, { observedAt: now - 14 * 60_000 })],
        other: [],
      },
      agents,
      now,
    ),
    'Account usage: Claude Code 5H 24%, 7D 61%; Codex 7D 49%, not current (14 minutes old). A reading older than 10 minutes or past its reset is not current.',
  );
});
