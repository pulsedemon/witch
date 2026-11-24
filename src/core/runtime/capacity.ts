import type { AccountReading, Limit } from '../../agents/types.js';
import type { Demand } from './demand.js';
import { creditCapacity, headroom, limitsFor, over, refused } from './usage.js';

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
  model: string,
  account: AccountReading | undefined,
  demand: Demand | undefined,
  shiftAt: number,
  now: number,
) {
  const limits = limitsFor(account, model);
  // a refused runtime has no room whatever its windows say until a later reading shows it recovered
  const out = refused(account, model, now);
  const credits = !out && creditCapacity(account, now) === 'available';
  const included = !out && headroom(limits, 100, now);
  const spent = out || over(limits, 100, now);
  const high = out || over(limits, shiftAt, now);

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
    out,
    credits,
    included,
    spent,
    high,
    reserved,
    comparableLoad,
    // destination credits cannot attract new work until its included window is full
    priority: included ? (reserved ? 2 : 0) : spent && credits ? 1 : undefined,
    score: included && comparableLoad ? allowance(limits, now) / workers : 0,
  };
}
