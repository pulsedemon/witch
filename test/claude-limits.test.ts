import assert from 'node:assert/strict';
import { test } from 'vitest';
import { RateLimit } from '../src/agents/claude-limits.js';

test('a rejection of the Fable limit blocks Fable and no other family', () => {
  const limit = new RateLimit<number>();
  limit.report(
    {
      status: 'rejected',
      rateLimitType: 'seven_day_overage_included',
      resetsAt: Date.now() / 1000 + 3600,
    },
    1,
  );
  assert.equal(limit.rejects(1, 'claude-fable-5-1'), true);
  assert.equal(limit.rejects(1, 'claude-opus-5-5'), false);
  assert.equal(limit.rejects(1, 'claude-sonnet-5-5'), false);
});
