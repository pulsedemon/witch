import assert from 'node:assert/strict';
import type { Limit } from '../../src/agents/types.js';

/** the windows without their observation times, each of which must be set. */
export function untimed(
  limits: readonly Limit[] | undefined,
): Omit<Limit, 'observedAt'>[] | undefined {
  return limits?.map(({ observedAt, ...window }) => {
    assert.ok(Number.isFinite(observedAt), `${window.window} has no time`);
    return window;
  });
}
