import { setTimeout as delay } from 'node:timers/promises';
import { errorMessage } from '../agents/stderr.js';
import type { DelegationStore } from '../persistence/delegation.js';
import type { ControlOutcome } from '../persistence/control.js';
import type { RouteAction } from './coordination-state.js';
import type { Coordinator } from './coordinator.js';
import { route } from './routing.js';

/** the longest a route waits for usage reads, since claims queue behind it in the control mailbox. */
const refreshWait = 3000;

/** answers `--route` from the policy, the catalog and each runtime's usage, and shows the choice in the transcript. once `signal` aborts it posts nothing, since a later notice would land in whatever conversation is open by then. */
export function router(
  coordinator: Pick<Coordinator, 'snapshot' | 'accountUsage' | 'notice'>,
  policy: Pick<DelegationStore, 'read'>,
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
    await Promise.race([
      Promise.all(
        installed.map((id) => coordinator.accountUsage.refresh(id, cwd)),
      ),
      delay(refreshWait, undefined, { ref: false }),
    ]);
    if (signal?.aborted) return cancelled;
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
      now: Date.now(),
    });
    if ('refused' in decision) return refuse(decision.refused);
    for (const { runtime, model, reason } of decision.routes) {
      const label =
        snapshot.agents.find(({ id }) => id === runtime)?.label ?? runtime;
      coordinator.notice(
        `Routed ${action.work} to ${label} · ${model}: ${reason}`,
      );
    }
    return { kind: 'route', ...decision };
  };
}
