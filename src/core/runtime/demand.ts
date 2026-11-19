import type { Subagent } from '../../agents/types.js';
import type { SessionPresence } from '../coordination/coordination-state.js';
import type { Discovery } from '../coordination/discovery.js';
import { agentWorking } from '../state.js';

export interface Demand {
  coordinators: Readonly<Record<string, number>>;
  /** open sessions whose coordinator activity could not be verified. */
  unknown: readonly string[];
  /** omitted when an older session has running familiars without runtime attribution. */
  familiars?: Readonly<Record<string, number>>;
}

/** native familiars without a runtime identity run on their coordinator's runtime. */
export function familiarRuntimes(
  subagents: readonly Subagent[],
  coordinator: string,
): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const familiar of subagents) {
    if (familiar.status !== 'running') continue;

    const runtime = familiar.runtime ?? coordinator;
    counts[runtime] = (counts[runtime] ?? 0) + 1;
  }

  return counts;
}

/** the current local presence replaces its possibly coalesced disk record. */
export function collectDemand(
  discovery: Pick<Discovery, 'live' | 'opened' | 'records'>,
  own: SessionPresence,
): Demand {
  const live = new Map(discovery.live).set(own.id, own);
  const unknown = new Set<string>();
  const coordinators: Record<string, number> = {};
  let familiars: Record<string, number> | undefined = {};

  for (const record of discovery.records)
    if (discovery.opened.has(record.id) && !live.has(record.id))
      unknown.add(record.agent);

  for (const presence of live.values()) {
    if (
      agentWorking(presence.phase) ||
      presence.requests ||
      presence.familiars ||
      presence.brews
    )
      coordinators[presence.agent] = (coordinators[presence.agent] ?? 0) + 1;

    if (presence.familiars && !presence.familiarRuntimes) familiars = undefined;

    if (familiars)
      for (const [runtime, count] of Object.entries(
        presence.familiarRuntimes ?? {},
      ))
        familiars[runtime] = (familiars[runtime] ?? 0) + count;
  }

  return { coordinators, familiars, unknown: [...unknown] };
}

export function demandText(
  runtime: string,
  demand: Demand | undefined,
): string {
  if (!demand || demand.unknown.includes(runtime))
    return `${runtime} workload unknown`;

  const coordinators = demand.coordinators[runtime] ?? 0;
  const familiars = demand.familiars?.[runtime] ?? 0;

  return `${runtime}: ${coordinators} active coordinator${coordinators === 1 ? '' : 's'}, ${demand.familiars ? `${familiars} running familiar${familiars === 1 ? '' : 's'}` : 'familiar load unknown'}`;
}
