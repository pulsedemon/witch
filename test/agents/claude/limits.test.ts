import assert from 'node:assert/strict';
import { test } from 'vitest';
import { RateLimit } from '../../../src/agents/claude/limits.js';

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

  assert.ok(limit.rejection(1, 'claude-fable-5-1'));
  assert.equal(limit.rejection(1, 'claude-opus-5-5'), undefined);
  assert.equal(limit.rejection(1, 'claude-sonnet-5-5'), undefined);
});

test('a rejection names its window, model, reset and the refused credits', () => {
  const limit = new RateLimit<number>();

  limit.report(
    {
      status: 'rejected',
      rateLimitType: 'seven_day_overage_included',
      overageStatus: 'rejected',
      overageDisabledReason: 'out_of_credits',
      isUsingOverage: false,
      resetsAt: 1795298400,
    },
    1,
  );

  assert.deepEqual(limit.rejection(1, 'claude-fable-5-2', 1795000000000), {
    window: '7D',
    model: 'Fable',
    resetsAt: 1795298400,
    credits: 'out of credits',
  });
});

test('a rejection of a window every model shares names no model', () => {
  const limit = new RateLimit<number>();
  const resetsAt = Date.now() / 1000 + 3600;
  limit.report({ status: 'rejected', rateLimitType: 'seven_day', resetsAt }, 1);

  assert.deepEqual(limit.rejection(1, 'claude-opus-5-5'), {
    window: '7D',
    resetsAt,
  });
});

test('a rejection that names no window still rejects the turn it arrived in', () => {
  const limit = new RateLimit<number>();
  limit.report({ status: 'rejected' }, 1);
  assert.deepEqual(limit.rejection(1, 'claude-opus-5-5'), {});
  assert.equal(limit.rejection(2, 'claude-opus-5-5'), undefined);
});
