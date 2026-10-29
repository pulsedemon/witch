import type { Limit } from '../agents/types.js';

/** a chosen bound: usage within a window only grows, so an older reading can hide a limit already reached. */
export const USAGE_CURRENT_MS = 10 * 60_000;

/** observed within `USAGE_CURRENT_MS` and, when the window has a reset, before it. */
export function current(limit: Limit, now: number): boolean {
  return (
    now - limit.observedAt <= USAGE_CURRENT_MS &&
    (limit.resetsAt === undefined || limit.resetsAt * 1000 > now)
  );
}

/** a missing, empty, stale or reset window never counts as room to work. */
export function headroom(
  limits: readonly Limit[],
  shiftAt: number,
  now: number,
): boolean {
  return (
    limits.length > 0 &&
    limits.every((limit) => current(limit, now) && limit.percent < shiftAt)
  );
}

export function over(
  limits: readonly Limit[],
  shiftAt: number,
  now: number,
): boolean {
  return limits.some(
    (limit) => current(limit, now) && limit.percent >= shiftAt,
  );
}

/** no window, or one that isn't current, so another read could change a decision. */
export function due(limits: readonly Limit[], now: number): boolean {
  return limits.length === 0 || limits.some((limit) => !current(limit, now));
}
