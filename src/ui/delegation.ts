import type { Limit } from '../agents/types.js';
import { family, resolve, work } from '../core/routing.js';
import type { Catalog, Policy } from '../core/routing.js';
import { current } from '../core/usage.js';

export const delegationUsage =
  '/delegation <kind> <same|other|runtime[:model or family]|clear>, /delegation family <runtime> <family> or /delegation shift <1-100|off>';

/** the policy with one change from `/delegation`'s argument, or what is wrong with it. */
export function changeDelegation(
  argument: string,
  policy: Policy,
  catalog: Catalog,
  installed: readonly string[],
): Policy | string {
  const [first = '', second, third, ...rest] = argument.trim().split(/\s+/);
  if (rest.length) return `Use ${delegationUsage}.`;
  if (first === 'shift' && second && !third) {
    if (second === 'off') return { ...policy, shiftAt: null };
    const level = Number(second);
    return Number.isInteger(level) && level >= 1 && level <= 100
      ? { ...policy, shiftAt: level }
      : 'Use a whole percent from 1 to 100, or off.';
  }
  if (first === 'family' && second && third) {
    if (!installed.includes(second)) return `${second} is not installed.`;
    const resolved = family(second, third, catalog);
    return 'refused' in resolved
      ? `${resolved.refused}.`
      : { ...policy, families: { ...policy.families, [second]: third } };
  }
  const kind = work.safeParse(first);
  if (!kind.success || !second || third) return `Use ${delegationUsage}.`;
  const rules = { ...policy.work };
  if (second === 'clear') {
    delete rules[kind.data];
    return { ...policy, work: rules };
  }
  if (second !== 'same' && second !== 'other') {
    const [runtime = '', model] = second.split(/:(.*)/s);
    if (!installed.includes(runtime)) return `${runtime} is not installed.`;
    const resolved = model
      ? resolve(runtime, model, catalog)
      : policy.families[runtime]
        ? family(runtime, policy.families[runtime], catalog)
        : { refused: `no family is set for ${runtime}` };
    if ('refused' in resolved) return `${resolved.refused}.`;
  }
  return { ...policy, work: { ...rules, [kind.data]: second } };
}

/** the policy as it routes now, with each runtime's usage and age. */
export function delegationPage(
  policy: Policy,
  catalog: Catalog,
  limits: Readonly<Record<string, readonly Limit[]>>,
  installed: readonly string[],
  now: number,
): string {
  const families = installed.map((runtime) => {
    const name = policy.families[runtime];
    if (!name) return `${runtime}  no family`;
    const resolved = family(runtime, name, catalog);
    return `${runtime}  ${name} → ${'refused' in resolved ? 'unavailable' : resolved.model}`;
  });
  const usage = installed.map((runtime) => {
    const reading = limits[runtime];
    if (!reading?.length) return `${runtime}  no reading`;
    return `${runtime}  ${reading
      .map(
        (limit) =>
          `${limit.window} ${Math.round(limit.percent)}%${current(limit, now) ? '' : `, ${Math.floor((now - limit.observedAt) / 60_000)} minutes old`}`,
      )
      .join(', ')}`;
  });
  return [
    'Work goes where its rule sends it; with no rule it stays on the runtime asking, or for review on the runtime that produced the work.',
    '',
    ...work.options.map(
      (kind) => `${kind.padEnd(16)}${policy.work[kind] ?? 'same'}`,
    ),
    '',
    'Families, each at its newest model',
    ...families,
    '',
    policy.shiftAt === null
      ? 'New work never shifts for usage.'
      : `New work shifts to a runtime with room once its own reaches ${policy.shiftAt}%.`,
    '',
    'Usage',
    ...usage,
    '',
    delegationUsage,
  ].join('\n');
}
