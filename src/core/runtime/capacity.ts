import type { AccountReading, Limit } from '../../agents/types.js';
import type { Demand } from './demand.js';
import { creditCapacity, headroom, over } from './usage.js';

/** relative quota pressure, not a prediction of task cost or equal token allowances. */
function allowance(limits: readonly Limit[], now: number): number {
  return Math.min(
    ...limits.map(({ window, percent, resetsAt }) => {
      const length = /^(\d+)([HD])(?:\s|$)/.exec(window);

      const seconds = length
        ? Number(length[1]) * (length[2] === 'D' ? 86_400 : 3600)
        : 0;

      const remaining =
        seconds && resetsAt !== undefined
          ? Math.min(1, (resetsAt - now / 1000) / seconds)
          : 1;

      return (1 - percent / 100) / remaining;
    }),
  );
}

export function capacity(
  runtime: string,
  limits: readonly Limit[],
  account: AccountReading | undefined,
  demand: Demand | undefined,
  shiftAt: number,
  now: number,
) {
  const credits = creditCapacity(account, now) === 'available';
  const included = headroom(limits, 100, now);
  const spent = over(limits, 100, now);
  const high = over(limits, shiftAt, now);

  // destination credits cannot attract new work until its included window is full
  const reserved =
    high &&
    (!demand ||
      demand.unknown.includes(runtime) ||
      (demand.coordinators[runtime] ?? 0) > 0);

  const comparableLoad = !!demand?.familiars && !demand.unknown.length;

  const workers =
    1 +
    (demand?.coordinators[runtime] ?? 0) +
    (demand?.familiars?.[runtime] ?? 0);

  return {
    credits,
    included,
    spent,
    high,
    reserved,
    comparableLoad,
    priority: included ? (reserved ? 2 : 0) : spent && credits ? 1 : undefined,
    score: included && comparableLoad ? allowance(limits, now) / workers : 0,
  };
}
