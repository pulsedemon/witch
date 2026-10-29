import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Limit } from '../src/agents/types.js';
import {
  current,
  due,
  headroom,
  over,
  USAGE_CURRENT_MS,
} from '../src/core/usage.js';

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
