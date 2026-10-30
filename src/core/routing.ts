import { z } from 'zod';
import type { Limit } from '../agents/types.js';
import type { ModelChoice } from './models.js';
import { current, describeReading, headroom, over } from './usage.js';

export const work = z.enum([
  'review',
  'planning',
  'implementation',
  'investigation',
]);
export type Work = z.infer<typeof work>;

/** `same`, `other`, `<runtime>` or `<runtime>:<model-or-family>`; `same` and `other` are relative to the work's producer for review. */
const target = z.string().regex(/^[a-z][\w-]*(:.+)?$/);

export const policySchema = z.object({
  /** the usage percent at which new work shifts to another runtime; `null` turns shifting off. */
  shiftAt: z.number().int().min(1).max(100).nullable(),
  /** each runtime's family for work that names no model. */
  families: z.record(z.string(), z.string()),
  work: z.partialRecord(work, target),
});
export type Policy = z.infer<typeof policySchema>;

/** chosen defaults; no kind of work is sent to another runtime until the user says so, but usage at `shiftAt` still shifts new work. */
export const defaultPolicy: Policy = {
  shiftAt: 90,
  families: { claude: 'opus', codex: 'sol' },
  work: {},
};

export interface Choice {
  runtime: string;
  model: string;
}

export type Route = (Choice & { reason: string }) | { refused: string };

export interface Catalog {
  models: readonly ModelChoice[];
  /** each runtime's family aliases and the concrete model each names. */
  latest: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** a name with a version names one model; any other name is a family, which resolves to its newest model. */
function exact(name: string): boolean {
  return /\d/.test(name);
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
  if (exact(name)) return { model: name };
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
  return exact(name)
    ? { refused: `${name} names a model, not a family` }
    : resolve(runtime, name, catalog);
}

function reading(
  runtime: string,
  limits: readonly Limit[] | undefined,
  now: number,
): string {
  if (!limits?.length) return `${runtime} has no usage reading`;
  const stale = limits.filter((limit) => !current(limit, now));
  return stale.length
    ? `${runtime}'s ${stale.map(({ window }) => window).join(' and ')} reading is not current`
    : describeReading(runtime, limits, now)!;
}

export function route({
  work,
  caller,
  of,
  named,
  policy,
  installed,
  catalog,
  limits,
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
  limits: Readonly<Record<string, readonly Limit[]>>;
  now: number;
}): Route {
  const evidence = (runtime: string) => {
    const state = reading(runtime, limits[runtime], now);
    return limits[runtime]?.every((limit) => current(limit, now)) &&
      limits[runtime].length
      ? ''
      : `; ${state}`;
  };
  if (named) {
    if (!installed.includes(named.runtime))
      return { refused: `${named.runtime} is not installed` };
    const resolved = resolve(named.runtime, named.model, catalog);
    if ('refused' in resolved) return resolved;
    return {
      runtime: named.runtime,
      model: resolved.model,
      reason: `named explicitly${evidence(named.runtime)}`,
    };
  }
  const base = work === 'review' && of ? of.runtime : caller;
  const other = installed.find((id) => id !== base);
  const rule = policy.work[work] ?? 'same';
  const [kind, pinned] = rule.split(/:(.*)/s) as [string, string?];
  const runtime = kind === 'same' ? base : kind === 'other' ? other : kind;
  if (!runtime || !installed.includes(runtime))
    return {
      refused:
        kind === 'other'
          ? `no runtime besides ${base} is installed`
          : `${runtime ?? kind} is not installed`,
    };
  const choose = (id: string) =>
    pinned && id === runtime
      ? resolve(id, pinned, catalog)
      : policy.families[id]
        ? family(id, policy.families[id], catalog)
        : { refused: `no family is set for ${id}` };
  const chosen = choose(runtime);
  if ('refused' in chosen) return chosen;
  const why =
    rule === 'same'
      ? work === 'review' && of
        ? `${work} stays on ${of.runtime}, which produced it`
        : `${work} stays on ${caller}`
      : `the policy sends ${work}${work === 'review' && of ? ` of ${of.runtime} work` : ''} to ${rule}`;
  const exactPin = pinned !== undefined && exact(pinned);
  const { shiftAt } = policy;
  if (shiftAt === null || exactPin)
    return {
      runtime,
      model: chosen.model,
      reason: `${why}${evidence(runtime)}`,
    };
  if (!over(limits[runtime] ?? [], shiftAt, now))
    return {
      runtime,
      model: chosen.model,
      reason: `${why}${evidence(runtime)}`,
    };
  const hot = describeReading(
    runtime,
    limits[runtime]!.filter(
      (limit) => current(limit, now) && limit.percent >= shiftAt,
    ),
    now,
  )!;
  const blocked: string[] = [];
  for (const id of installed) {
    if (id === runtime) continue;
    if (!headroom(limits[id] ?? [], shiftAt, now)) {
      blocked.push(
        limits[id]?.length && limits[id].every((limit) => current(limit, now))
          ? `${id} is at ${shiftAt}% or more too`
          : reading(id, limits[id], now),
      );
      continue;
    }
    const shifted = choose(id);
    if ('refused' in shifted) {
      blocked.push(shifted.refused);
      continue;
    }
    return {
      runtime: id,
      model: shifted.model,
      reason: `${hot} is at or over ${shiftAt}%, and ${reading(id, limits[id], now)} has room`,
    };
  }
  return {
    runtime,
    model: chosen.model,
    reason: `${why}; ${hot} is at or over ${shiftAt}%, but ${blocked.join(', ') || 'no other runtime is installed'}`,
  };
}
