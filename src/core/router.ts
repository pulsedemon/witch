import { setTimeout as delay } from 'node:timers/promises';
import type { DelegationStore } from '../persistence/delegation.js';
import type { ControlOutcome } from '../persistence/control.js';
import type { RouteAction } from './coordination-state.js';
import type { Coordinator } from './coordinator.js';
import { route } from './routing.js';

/** the longest a route waits for usage reads, since claims queue behind it in the control mailbox. */
const refreshWait = 3000;

/** answers `--route` from the policy, the catalog and each runtime's usage, and shows the choice in the transcript. */
export function router(
  coordinator: Pick<Coordinator, 'snapshot' | 'accountUsage' | 'notice'>,
  policy: Pick<DelegationStore, 'read'>,
) {
  return async (action: RouteAction): Promise<ControlOutcome> => {
    const { snapshot } = coordinator;
    const cwd = snapshot.conversation?.cwd;
    const caller = snapshot.native?.agent ?? snapshot.conversation?.agent;
    if (!cwd || !caller)
      return { kind: 'error', message: 'Witch has no conversation open.' };
    const installed = snapshot.agents
      .filter((agent) => agent.installed)
      .map(({ id }) => id);
    await Promise.race([
      Promise.all(
        installed.map((id) => coordinator.accountUsage.refresh(id, cwd)),
      ),
      delay(refreshWait, undefined, { ref: false }),
    ]);
    const decision = route({
      ...action,
      caller,
      policy: await policy.read(),
      installed,
      catalog: {
        models: coordinator.snapshot.models,
        latest: coordinator.snapshot.latest,
      },
      limits: coordinator.snapshot.limits,
      now: Date.now(),
    });
    if ('refused' in decision) {
      coordinator.notice(`Route refused: ${decision.refused}`);
      return { kind: 'error', message: decision.refused };
    }
    const label =
      snapshot.agents.find(({ id }) => id === decision.runtime)?.label ??
      decision.runtime;
    coordinator.notice(
      `Routed ${action.work} to ${label} · ${decision.model}: ${decision.reason}`,
    );
    return { kind: 'route', ...decision };
  };
}
