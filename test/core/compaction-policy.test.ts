import assert from 'node:assert/strict';
import { test } from 'vitest';
import { compactionThreshold } from '../../src/core/compaction-policy.js';

test('automatic compaction retains smaller windows and caps larger ones at 600k tokens', () => {
  for (const [window, tokens, percent] of [
    [200_000, 160_000, 80],
    [400_000, 320_000, 80],
    [750_000, 600_000, 80],
    [1_000_000, 600_000, 60],
  ] as const)
    assert.deepEqual(compactionThreshold(window), { tokens, percent });

  const effectiveCodex = compactionThreshold(828_400);

  assert.equal(effectiveCodex.tokens, 600_000);

  assert.ok(Math.abs(effectiveCodex.percent - 72.42877836793819) < 0.000001);
});

test('the token limit remains continuous at the cap and rounds down fractional tokens', () => {
  assert.equal(compactionThreshold(749_999).tokens, 599_999);

  assert.equal(compactionThreshold(750_001).tokens, 600_000);

  assert.equal(compactionThreshold(200_001).tokens, 160_000);
});
