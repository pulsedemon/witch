import { z } from 'zod';
import type { AccountReading, Limit } from '../../agents/types.js';
import type { ModelChoice } from './models.js';
import {
  creditCapacity,
  current,
  currentLimits,
  fundingText,
  headroom,
  over,
  untilReset,
} from './usage.js';

export const work = z.enum([
  'review',
  'planning',
  'implementation',
  'investigation',
]);

export type Work = z.infer<typeof work>;

/** `same`, `other`, `both`, `<runtime>` or `<runtime>:<model-or-family>`; `same` and `other` are relative to the work's producer for review, and `both` sends work to every installed runtime. */
const target = z.string().regex(/^[a-z][\w-]*(:.+)?$/);

export const policySchema = z.object({
  /** the usage percent at which new work shifts to another runtime unless usable credits keep it; `null` turns shifting off. */
  shiftAt: z.number().int().min(1).max(100).nullable(),
  /** each runtime's family for work that names no model. */
  families: z.record(z.string(), z.string()),
  work: z.partialRecord(work, target),
});

export type Policy = z.infer<typeof policySchema>;

/** chosen defaults; `ruleFor` places work that has no rule, and usage at `shiftAt` still shifts new work that usable credits don't keep. */
export const defaultPolicy: Policy = {
  shiftAt: 90,
  families: { claude: 'opus', codex: 'sol' },
  work: {},
};

interface Choice {
  runtime: string;
  model: string;
}

export type Routed = Choice & {
  reason: string;
  /** the runtime its rule named, when usage moved the work off it. */
  from?: string;
};

export type Route =
  | {
      routes: Routed[];
      /** shifted placements that landed on a runtime already routed the same model, so they run once. */
      folded?: Routed[];
    }
  | { refused: string };

/** with no rule, review goes to every installed runtime and other work stays on the runtime asking. */
export function ruleFor(policy: Policy, kind: Work): string {
  return policy.work[kind] ?? (kind === 'review' ? 'both' : 'same');
}

/** families of comparable capability, per each catalog's own descriptions; a shift lands on a runtime's first listed family. */
const tiers: readonly Readonly<Record<string, readonly string[]>>[] = [
  { claude: ['opus', 'fable'], codex: ['astra'] },
  { claude: ['sonnet'], codex: ['sol', 'terra'] },
  { claude: ['haiku'], codex: ['luna'] },
];

/** the family on `to` comparable to a model or family on `from`, matched by a name segment such as `astra` in `gpt-6-astra`. */
export function comparable(
  from: string,
  name: string,
  to: string,
): string | undefined {
  const segments = name.split('-');

  return tiers.find((tier) =>
    tier[from]?.some((family) => segments.includes(family)),
  )?.[to]?.[0];
}

export interface Catalog {
  models: readonly ModelChoice[];
  /** each runtime's family aliases and the concrete model each names; a runtime with aliases resolves every unversioned name through them. */
  latest: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** a name with a version names one model, as does an unversioned id listed by a runtime without aliases; any other name is a family, which resolves to its newest model. */
function exact(runtime: string, name: string, catalog: Catalog): boolean {
  return (
    /\d/.test(name) ||
    (!catalog.latest[runtime] &&
      catalog.models.some(({ agent, id }) => agent === runtime && id === name))
  );
}

function version(text: string): number[] {
  return text.split('.').map(Number);
}

function newer(a: string, b: string): boolean {
  const [left, right] = [version(a), version(b)];

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference) return difference > 0;
  }

  return false;
}

/** a family's newest model: a runtime that reports `latest` aliases resolves only through them, any other its highest-versioned `<prefix>-<version>-<family>` id. */
function newest(
  runtime: string,
  family: string,
  catalog: Catalog,
): string | undefined {
  const aliases = catalog.latest[runtime];

  if (aliases)
    return Object.hasOwn(aliases, family) ? aliases[family] : undefined;

  let best: { id: string; version: string } | undefined;

  for (const { agent, id } of catalog.models) {
    if (agent !== runtime) continue;

    const match = /^[a-z]+-(\d+(?:\.\d+)*)-(.+)$/.exec(id);

    if (match?.[2] !== family) continue;

    if (!best || newer(match[1]!, best.version))
      best = { id, version: match[1]! };
  }

  return best?.id;
}

/** an exact model passes through as named; a family resolves to its newest model, or the reason it can't. */
export function resolve(
  runtime: string,
  name: string,
  catalog: Catalog,
): { model: string } | { refused: string } {
  if (name === 'default')
    return { refused: `name a ${runtime} family or model, not default` };

  if (exact(runtime, name, catalog)) return { model: name };

  const model = newest(runtime, name, catalog);

  return model
    ? { model }
    : { refused: `${runtime} lists no ${name} model to run` };
}

/** for a policy family, which must stay a family so it keeps resolving to the newest model. */
export function family(
  runtime: string,
  name: string,
  catalog: Catalog,
): { model: string } | { refused: string } {
  return exact(runtime, name, catalog)
    ? { refused: `${name} names a model, not a family` }
    : resolve(runtime, name, catalog);
}

/** each window with when it resets, and the funding, since a usage choice weighs all of them. */
function standing(
  runtime: string,
  account: AccountReading,
  now: number,
  limits: readonly Limit[] = account.limits,
): string {
  const parts = limits.map(({ window, percent, resetsAt }) => {
    const left = untilReset(resetsAt, now);

    return `${window} ${Math.round(percent)}%${left && `, resets in ${left}`}`;
  });

  const { funding } = account;

  if (funding) {
    const text =
      funding.kind === 'credits' && funding.balance !== null
        ? `${Number(funding.balance).toFixed(2)} credits`
        : fundingText(funding);

    parts.push(current(funding, now) ? text : `${text}, not current`);
  }

  return `${runtime} (${parts.join(', ')})`;
}

function reading(
  runtime: string,
  account: AccountReading | undefined,
  now: number,
): string {
  if (!account || (!account.limits.length && !account.funding))
    return `${runtime} has no usage reading`;

  const stale = account.limits.filter((limit) => !current(limit, now));

  return stale.length
    ? `${runtime}'s ${stale.map(({ window }) => window).join(' and ')} reading is not current`
    : standing(runtime, account, now);
}

export function route({
  work,
  caller,
  of,
  named,
  policy,
  installed,
  catalog,
  accounts,
  now,
}: {
  work: Work;
  /** the runtime asking. */
  caller: string;
  /** the runtime and model that produced the work under review. */
  of?: Choice;
  /** a model the user or the agent named, which runs as named, or a family, at its newest. */
  named?: Choice;
  policy: Policy;
  installed: readonly string[];
  catalog: Catalog;
  accounts: Readonly<Record<string, AccountReading>>;
  now: number;
}): Route {
  const evidence = (runtime: string) => {
    const state = reading(runtime, accounts[runtime], now);

    return currentLimits(accounts[runtime]?.limits ?? [], now) &&
      !accounts[runtime]!.funding
      ? ''
      : `; ${state}`;
  };

  if (named) {
    if (!installed.includes(named.runtime))
      return { refused: `${named.runtime} is not installed` };

    const resolved = resolve(named.runtime, named.model, catalog);

    if ('refused' in resolved) return resolved;

    return {
      routes: [
        {
          runtime: named.runtime,
          model: resolved.model,
          reason: `named explicitly${evidence(named.runtime)}`,
        },
      ],
    };
  }

  const base = work === 'review' && of ? of.runtime : caller;
  const subject = `${work}${work === 'review' && of ? ` of ${of.runtime} work` : ''}`;

  const place = (
    rule: string,
    why: string,
    mixed = false,
  ): Routed | { refused: string } => {
    const [kind, pinned] = rule.split(/:(.*)/s) as [string, string?];

    const runtime =
      kind === 'same'
        ? base
        : kind === 'other'
          ? installed.find((id) => id !== base)
          : kind;

    if (!runtime || !installed.includes(runtime))
      return {
        refused:
          kind === 'other'
            ? `no runtime besides ${base} is installed`
            : `${runtime ?? kind} is not installed`,
      };

    const choose = (id: string) => {
      if (!pinned)
        return policy.families[id]
          ? family(id, policy.families[id], catalog)
          : { refused: `no family is set for ${id}` };

      if (id === runtime) return resolve(id, pinned, catalog);

      const match = comparable(runtime, pinned, id);

      return match
        ? resolve(id, match, catalog)
        : { refused: `${id} has no model comparable to ${pinned}` };
    };

    const chosen = choose(runtime);

    if ('refused' in chosen) return chosen;

    const { shiftAt } = policy;

    if (
      shiftAt === null ||
      !over(accounts[runtime]?.limits ?? [], shiftAt, now)
    )
      return {
        runtime,
        model: chosen.model,
        reason: `${why}${evidence(runtime)}`,
      };

    const hot = `${standing(
      runtime,
      accounts[runtime]!,
      now,
      accounts[runtime]!.limits.filter(
        (limit) => current(limit, now) && limit.percent >= shiftAt,
      ),
    )} is at or over the ${shiftAt}% shift threshold`;

    if (creditCapacity(accounts[runtime], now) === 'available')
      return {
        runtime,
        model: chosen.model,
        reason: `${why}; ${hot}, but its usable credits keep the work here`,
      };

    // below 100% a runtime still has included usage, so only a spent runtime falls back past headroom and only a spent destination's credits count
    const spent = (id: string) => over(accounts[id]?.limits ?? [], 100, now);
    const blocked: string[] = [];

    // a review the policy sent away from its producer never shifts back onto it, unless the producer reviews too
    const producer =
      !mixed && work === 'review' && of?.runtime !== runtime
        ? of?.runtime
        : undefined;

    for (const fallback of spent(runtime) ? [false, true] : [false]) {
      for (const id of installed) {
        if (id === runtime) continue;

        if (id === producer) {
          if (!fallback) blocked.push(`${id} produced the work`);

          continue;
        }

        if (
          fallback
            ? spent(id)
              ? creditCapacity(accounts[id], now) !== 'available'
              : !currentLimits(accounts[id]?.limits ?? [], now)
            : !headroom(accounts[id]?.limits ?? [], shiftAt, now)
        ) {
          if (fallback) continue;

          blocked.push(
            currentLimits(accounts[id]?.limits ?? [], now)
              ? `${standing(id, accounts[id]!, now)} is at or over it too`
              : reading(id, accounts[id], now),
          );

          continue;
        }

        const shifted = choose(id);

        if ('refused' in shifted) {
          if (!fallback) blocked.push(shifted.refused);

          continue;
        }

        return {
          runtime: id,
          model: shifted.model,
          from: runtime,
          reason: `${hot}, and ${reading(id, accounts[id], now)} has ${!fallback ? 'room under it' : spent(id) ? 'usable credits' : 'included usage left'}${pinned ? `; ${shifted.model} is comparable to ${pinned}` : ''}`,
        };
      }
    }

    return {
      runtime,
      model: chosen.model,
      reason: `${why}; ${hot}, but ${blocked.join(', ') || 'no other runtime is installed'}`,
    };
  };

  const rule = ruleFor(policy, work);

  if (rule === 'both') {
    const placements: Routed[] = [];

    for (const runtime of installed) {
      const placed = place(runtime, `${subject} goes to every runtime`, true);

      if ('refused' in placed) return placed;

      placements.push(placed);
    }

    const routes = placements.filter(({ from }) => !from);
    const folded: Routed[] = [];

    // a shift can land on a runtime that has its own route; one familiar per model is enough
    for (const placed of placements.filter(({ from }) => from)) {
      const taken = routes.some(
        ({ runtime, model }) =>
          runtime === placed.runtime && model === placed.model,
      );

      (taken ? folded : routes).push(placed);
    }

    return folded.length ? { routes, folded } : { routes };
  }

  const why =
    rule === 'same'
      ? work === 'review' && of
        ? `${work} stays on ${of.runtime}, which produced it`
        : `${work} stays on ${caller}`
      : `the policy sends ${subject} to ${rule}`;

  const placed = place(rule, why);

  return 'refused' in placed ? placed : { routes: [placed] };
}
