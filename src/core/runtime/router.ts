import { setTimeout as delay } from 'node:timers/promises';
import { errorMessage } from '../../errors.js';
import type { DelegationStore } from '../../persistence/delegation.js';
import type { ControlOutcome } from '../../persistence/control.js';
import type { RouteAction } from '../coordination/coordination-state.js';
import type { Coordinator } from '../coordinator.js';
import { route } from './routing.js';
import type { Demand } from './demand.js';

/** bounded reads keep a route responsive when a usage probe or session inspection stalls. */
const refreshWait = 3000;

/** cancellation suppresses late notices that would land in another conversation. */
export function router(
  coordinator: Pick<
    Coordinator,
    'snapshot' | 'accountUsage' | 'notice' | 'warning'
  >,
  policy: Pick<DelegationStore, 'read'>,
  readDemand: (deadline: number) => Promise<Demand>,
) {
  return async (
    action: RouteAction,
    signal?: AbortSignal,
  ): Promise<ControlOutcome> => {
    const { snapshot } = coordinator;
    const cwd = snapshot.conversation?.cwd;
    const caller = snapshot.native?.agent ?? snapshot.conversation?.agent;

    if (!cwd || !caller)
      return { kind: 'error', message: 'Witch has no conversation open.' };

    const cancelled: ControlOutcome = {
      kind: 'error',
      message: 'Route cancelled.',
    };

    const refuse = (reason: string): ControlOutcome => {
      if (signal?.aborted) return cancelled;

      coordinator.notice(`Route refused: ${reason}`);

      return { kind: 'error', message: reason };
    };

    const current = await policy.read().catch(errorMessage);

    if (typeof current === 'string') return refuse(current);

    if (signal?.aborted) return cancelled;

    const installed = snapshot.agents
      .filter((agent) => agent.installed)
      .map(({ id }) => id);

    let demand: Demand | undefined;
    let demandFailure: string | undefined;

    await Promise.race([
      Promise.all([
        ...installed.map((id) => coordinator.accountUsage.refresh(id, cwd)),
        readDemand(Date.now() + refreshWait).then(
          (value) => {
            demand = value;
          },
          (error: unknown) => {
            demandFailure = errorMessage(error);
          },
        ),
      ]),
      delay(refreshWait, undefined, { ref: false }),
    ]);

    if (signal?.aborted) return cancelled;

    if (demandFailure)
      coordinator.warning(`Routing workload unavailable: ${demandFailure}`);

    const decision = route({
      ...action,
      caller,
      policy: current,
      installed,
      catalog: {
        models: coordinator.snapshot.models,
        latest: coordinator.snapshot.latest,
      },
      accounts: coordinator.snapshot.accounts,
      demand,
      now: Date.now(),
    });

    if ('refused' in decision) return refuse(decision.refused);

    const label = (runtime: string) =>
      snapshot.agents.find(({ id }) => id === runtime)?.label ?? runtime;

    for (const { runtime, model, reason, from } of decision.routes) {
      const text = `Routed ${action.work} to ${label(runtime)} · ${model}`;

      if (from)
        coordinator.warning(
          `${text}, passing over ${label(from)} for capacity: ${reason}`,
        );
      else coordinator.notice(`${text}: ${reason}`);
    }

    for (const { runtime, model, reason, from } of decision.folded ?? [])
      coordinator.warning(
        `Passed over ${label(from!)} for ${action.work} for capacity; ${label(runtime)} · ${model} already has it: ${reason}`,
      );

    return { kind: 'route', ...decision };
  };
}
