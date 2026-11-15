import type { AccountReading } from '../../agents/types.js';
import {
  defaultPolicy,
  family,
  resolve,
  ruleFor,
  work,
} from '../../core/runtime/routing.js';
import type { Catalog, Policy } from '../../core/runtime/routing.js';
import type { Coordinator } from '../../core/coordinator.js';
import { describeReading } from '../../core/runtime/usage.js';
import type { DelegationStore } from '../../persistence/delegation.js';

const delegationUsage =
  '/delegation <kind> <same|other|both|runtime[:model or family]|clear>, /delegation family <runtime> <family> or /delegation shift <1-100|off>';

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

  if (second !== 'same' && second !== 'other' && second !== 'both') {
    const [runtime = '', model] = second.split(/:(.*)/s);

    if (!runtime || model === '') return `Use ${delegationUsage}.`;

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
  accounts: Readonly<Record<string, AccountReading>>,
  installed: readonly string[],
  now: number,
): string {
  const families = installed.map((runtime) => {
    const name = policy.families[runtime];

    if (!name) return `${runtime}  no family`;

    const resolved = family(runtime, name, catalog);

    return `${runtime}  ${name} → ${'refused' in resolved ? 'unavailable' : resolved.model}`;
  });

  const usage = installed.map(
    (runtime) =>
      describeReading(runtime, accounts[runtime], now) ??
      `${runtime} no reading`,
  );

  return [
    'Work goes where its rule sends it; with no rule, review goes to every runtime and other work stays on the runtime asking.',
    '',
    ...work.options.map((kind) => `${kind.padEnd(16)}${ruleFor(policy, kind)}`),
    '',
    'Families, each at its newest model',
    ...families,
    '',
    policy.shiftAt === null
      ? 'New work never shifts for usage.'
      : `New work shifts to a runtime with room once its own reaches ${policy.shiftAt}% unless usable credits keep it there, onto a comparable model when its rule names one.`,
    '',
    'Usage',
    ...usage,
    '',
    delegationUsage,
  ].join('\n');
}

/** the policy page after applying the argument's change, or `undefined` once a notice says why it was refused. */
export async function delegation(
  argument: string,
  policy: Pick<DelegationStore, 'read' | 'write'> | undefined,
  coordinator: Pick<Coordinator, 'snapshot' | 'notice'>,
): Promise<string | undefined> {
  const { snapshot } = coordinator;

  const installed = snapshot.agents
    .filter((agent) => agent.installed)
    .map(({ id }) => id);

  const catalog = { models: snapshot.models, latest: snapshot.latest };
  let current = (await policy?.read()) ?? defaultPolicy;

  if (argument) {
    const changed = changeDelegation(argument, current, catalog, installed);

    if (typeof changed === 'string' || !policy) {
      coordinator.notice(
        typeof changed === 'string'
          ? changed
          : 'This Witch has no policy file.',
        undefined,
        false,
      );

      return;
    }

    await policy.write(changed);
    current = changed;
  }

  return delegationPage(
    current,
    catalog,
    snapshot.accounts,
    installed,
    Date.now(),
  );
}
