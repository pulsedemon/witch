import { z } from 'zod';
import type { AccountReading, Limit } from '../../agents/types.js';
import type { ModelChoice } from './models.js';
import { capacity } from './capacity.js';
import { demandText, type Demand } from './demand.js';
import {
  current,
  currentLimits,
  fundingText,
  limitsFor,
  refused,
  untilReset,
} from './usage.js';

export const work = z.enum([
  'review',
  'planning',
  'implementation',
  'investigation',
]);

export type Work = z.infer<typeof work>;

export const tier = z.enum(['strong', 'standard', 'cheap']);

export type Tier = z.infer<typeof tier>;

/** `auto` balances single-runtime work; `same` and `other` use a review's producer when supplied, or the caller otherwise. `both` targets each installed runtime; `<runtime>[:<model-or-family>]` selects a placement. */
const target = z.string().regex(/^[a-z][\w-]*(:.+)?$/);

export const policySchema = z.object({
  /** reserve included allowance for active coordinators at this usage percent; `null` disables automatic movement. */
  shiftAt: z.number().int().min(1).max(100).nullable(),
  /** each runtime's family for work that names no model or tier. */
  families: z.record(z.string(), z.string()),
  work: z.partialRecord(work, target),
});

export type Policy = z.infer<typeof policySchema>;

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
  /** the runtime passed over when capacity moves the work. */
  from?: string;
};

export type Route =
  | {
      routes: Routed[];
      /** shifted placements that landed on a runtime already routed the same model, so they run once. */
      folded?: Routed[];
    }
  | { refused: string };

/** defaults request independent review coverage and balance other work by budget and demand. */
export function ruleFor(policy: Policy, kind: Work): string {
  return policy.work[kind] ?? (kind === 'review' ? 'both' : 'auto');
}

/** families of comparable capability, per each catalog's own descriptions; a shift lands on a runtime's first listed family, and `--tier` tries a row in order. */
const tiers: Readonly<
  Record<Tier, Readonly<Record<string, readonly string[]>>>
> = {
  strong: { claude: ['opus', 'fable'], codex: ['astra'] },
  standard: { claude: ['sonnet'], codex: ['sol', 'terra'] },
  cheap: { claude: ['haiku'], codex: ['luna'] },
};

/** the family on `to` comparable to a model or family on `from`, matched by a name segment such as `astra` in `gpt-6-astra`. */
export function comparable(
  from: string,
  name: string,
  to: string,
): string | undefined {
  const segments = name.split('-');

  return Object.values(tiers).find((row) =>
    row[from]?.some((family) => segments.includes(family)),
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

function standing(
  runtime: string,
  account: AccountReading,
  now: number,
  limits: readonly Limit[],
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

/** `''` unless a confirmed refusal still blocks `model`. */
function outOfUsage(
  runtime: string,
  account: AccountReading | undefined,
  model: string,
  now: number,
): string {
  if (!refused(account, model, now)) return '';

  const left = untilReset(account!.exhausted!.limit?.resetsAt, now);

  return `${runtime} ran out of usage${left && `, resets in ${left}`}`;
}

function reading(
  runtime: string,
  account: AccountReading | undefined,
  model: string,
  now: number,
  limits: readonly Limit[],
): string {
  const stale = limits.filter((limit) => !current(limit, now));

  const state =
    !account || (!limits.length && !account.funding)
      ? `${runtime} has no usage reading`
      : stale.length
        ? `${runtime}'s ${stale.map(({ window }) => window).join(' and ')} reading is not current`
        : standing(runtime, account, now, limits);

  return [state, outOfUsage(runtime, account, model, now)]
    .filter(Boolean)
    .join('; ');
}

export function route({
  work,
  caller,
  of,
  named,
  tier,
  policy,
  installed,
  catalog,
  accounts,
  demand,
  now,
}: {
  work: Work;
  /** the runtime asking. */
  caller: string;
  /** the runtime and model that produced the work under review. */
  of?: Choice;
  /** a model the user or the agent named, which runs as named, or a family, at its newest. */
  named?: Choice;
  /** the capability tier for work that names no model; a pinned rule keeps its model. */
  tier?: Tier;
  policy: Policy;
  installed: readonly string[];
  catalog: Catalog;
  accounts: Readonly<Record<string, AccountReading>>;
  demand?: Demand;
  now: number;
}): Route {
  const evidence = (runtime: string, model: string) => {
    const limits = limitsFor(accounts[runtime], model);
    const state = reading(runtime, accounts[runtime], model, now, limits);

    return currentLimits(limits, now) &&
      !accounts[runtime]!.funding &&
      !refused(accounts[runtime], model, now)
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
          reason: `named explicitly${evidence(named.runtime, resolved.model)}`,
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

    if (kind === 'auto' && work === 'review')
      return {
        refused:
          'auto is for planning, implementation and investigation; use both for review',
      };

    const runtime =
      kind === 'same' || kind === 'auto'
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

    /** the model for `id`, with a note on how the tier applied, which only that runtime's reason carries. */
    const choose = (
      id: string,
    ): { model: string; note?: string } | { refused: string } => {
      if (pinned) {
        const match = id === runtime ? pinned : comparable(runtime, pinned, id);

        if (!match)
          return { refused: `${id} has no model comparable to ${pinned}` };

        const resolved = resolve(id, match, catalog);

        return tier && 'model' in resolved
          ? {
              ...resolved,
              note: `the policy pins ${pinned}; the ${tier} tier does not apply`,
            }
          : resolved;
      }

      const policyFamily = policy.families[id];
      let note: string | undefined;

      if (tier) {
        const row = tiers[tier][id];

        if (row) {
          const ordered =
            policyFamily && row.includes(policyFamily)
              ? [policyFamily, ...row.filter((name) => name !== policyFamily)]
              : row;

          let refusal = '';

          for (const name of ordered) {
            const resolved = family(id, name, catalog);

            if ('model' in resolved) return resolved;

            refusal ||= resolved.refused;
          }

          note = `${id} has no ${tier} family it can run: ${refusal}; using its policy family`;
        } else note = `${id} has no ${tier} family; using its policy family`;
      }

      if (!policyFamily) return { refused: `no family is set for ${id}` };

      const resolved = family(id, policyFamily, catalog);

      return note && 'model' in resolved ? { ...resolved, note } : resolved;
    };

    const chosen = choose(runtime);

    if ('refused' in chosen) return chosen;

    const { shiftAt } = policy;

    const describe = (id: string, model: string) => {
      const limits = limitsFor(accounts[id], model);
      const fresh = limits.filter((limit) => current(limit, now));

      const partial =
        fresh.length && fresh.length < limits.length
          ? `${standing(id, accounts[id]!, now, fresh)}; `
          : '';

      return `${partial}${reading(id, accounts[id], model, now, limits)}; ${demandText(id, demand)}`;
    };

    const keep = (reason: string): Routed => ({
      runtime,
      model: chosen.model,
      reason: [why, describe(runtime, chosen.model), reason, chosen.note]
        .filter(Boolean)
        .join('; '),
    });

    if (shiftAt === null)
      return refused(accounts[runtime], chosen.model, now)
        ? {
            refused: `${describe(runtime, chosen.model)}; automatic movement is off`,
          }
        : keep('automatic movement is off');

    const candidate = (
      id: string,
      { model, note }: { model: string; note?: string },
    ) => ({
      runtime: id,
      model,
      note,
      capacity: capacity(id, model, accounts[id], demand, shiftAt, now),
    });

    const own = candidate(runtime, chosen);
    const state = own.capacity;

    if (state.high && state.credits)
      return keep('its usable credits keep the work here');

    const automatic = kind === 'auto' && state.comparableLoad && state.included;

    if (!automatic && !state.reserved && !state.spent)
      return keep(
        state.high
          ? 'no active coordinator needs a reserve'
          : kind === 'auto' && !state.comparableLoad
            ? 'comparative workload is unknown; retaining the caller'
            : '',
      );

    const candidates = automatic ? [own] : [];
    const blocked: string[] = [];

    // a review the policy sent away from its producer never shifts back onto it, unless the producer reviews too
    const producer =
      !mixed && work === 'review' && of?.runtime !== runtime
        ? of?.runtime
        : undefined;

    for (const id of installed) {
      if (id === runtime) continue;

      if (id === producer) {
        blocked.push(`${id} produced the work`);

        continue;
      }

      const shifted = choose(id);

      if ('refused' in shifted) {
        blocked.push(shifted.refused);

        continue;
      }

      const next = candidate(id, shifted);
      const { priority } = next.capacity;

      if (
        priority === undefined ||
        (priority === 2 && !automatic && !state.spent)
      ) {
        blocked.push(
          `${describe(id, shifted.model)}${priority === 2 ? '; coordinator capacity is reserved' : '; no verified destination capacity'}`,
        );

        continue;
      }

      candidates.push(next);
    }

    candidates.sort(
      (left, right) =>
        left.capacity.priority! - right.capacity.priority! ||
        right.capacity.score - left.capacity.score,
    );

    const selected = candidates[0];

    // describe() already says a refused runtime ran out
    const protection = state.out
      ? ''
      : state.spent
        ? `${runtime} has a full applicable usage window`
        : state.reserved
          ? !demand || demand.unknown.includes(runtime)
            ? `${runtime} needs a capacity reserve while coordinator activity is unknown`
            : `${runtime} needs a capacity reserve for its active coordinator${(demand.coordinators[runtime] ?? 0) === 1 ? '' : 's'}`
          : '';

    if (!selected) {
      const reasons = blocked.join(', ') || 'no other runtime is installed';

      return state.out
        ? { refused: `${describe(runtime, chosen.model)}; ${reasons}` }
        : keep(`${protection}; ${reasons}`);
    }

    const compared = automatic ? candidates : [own, selected];

    const explanation = [
      automatic ? `automatic ${work}` : `${subject} prefers ${runtime}`,
      ...compared.map(({ runtime: id, model }) => describe(id, model)),
      ...(protection ? [protection] : []),
      ...blocked,
      selected.capacity.priority === 1
        ? `${selected.runtime} has usable credits for its full window`
        : automatic || state.comparableLoad
          ? `${selected.runtime} has the most remaining allowance per worker among runtimes with the same coordinator protection, accounting for known reset times`
          : `${selected.runtime} has included usage left`,
      ...(pinned && selected.runtime !== runtime
        ? [`${selected.model} is comparable to ${pinned}`]
        : []),
      ...(selected.note ? [selected.note] : []),
    ];

    return {
      runtime: selected.runtime,
      model: selected.model,
      ...(selected.runtime === runtime ? {} : { from: runtime }),
      reason: explanation.join('; '),
    };
  };

  const rule = ruleFor(policy, work);

  if (rule === 'both') {
    const placements: Routed[] = [];

    for (const runtime of installed) {
      const placed = place(
        runtime,
        `${subject} requests a familiar on each runtime`,
        true,
      );

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
    rule === 'same' || rule === 'auto'
      ? work === 'review' && of
        ? `${work} stays on ${of.runtime}, which produced it`
        : `${work} stays on ${caller}`
      : `the policy sends ${subject} to ${rule}`;

  const placed = place(rule, why);

  return 'refused' in placed ? placed : { routes: [placed] };
}
