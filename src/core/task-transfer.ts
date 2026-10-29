import { setTimeout as delay } from 'node:timers/promises';
import type { Ledger } from '../persistence/coordination.js';
import { taskActivity } from './coordination-state.js';
import type { TaskClaim } from './coordination-state.js';
import type { Snapshot } from './coordinator.js';

/** tells a previous owner's agent, on every turn while the claim lives, which tasks the user moved away. */
export function movedNotices(ledger: Ledger, conversation: string): string[] {
  return ledger.claims.flatMap((claim) =>
    claim.movedFrom?.conversation === conversation
      ? [
          `The user moved ${claim.references.join(', ')} to conversation ${claim.owner.conversation}. Do not continue that task.`,
        ]
      : [],
  );
}

/** why the owner keeps a claim another conversation asked for, with the user's next step. */
export function transferRefusal(state?: Snapshot): string | undefined {
  if (state?.recovery)
    return 'It has unresolved memory recovery. Resolve it there, then run /task take again.';
  if (state?.phase === 'error')
    return 'It stopped with an error. Restart Witch there, then run /task take again.';
  if (state?.phase !== 'idle')
    return `It is ${state?.phase ?? 'starting'}. Wait for it to go idle or stop its turn there, then run /task take again.`;
  if (taskActivity(state).running)
    return 'It has running familiars or brews. Stop them there, then run /task take again.';
  return undefined;
}

interface TransferWait<View> {
  id: string;
  conversation: string;
  activation: string;
  reference: string;
  title: string;
  end: number;
  admit: () => void;
  read: (deadline: number) => Promise<View>;
  withdraw: () => Promise<TaskClaim | undefined>;
}

/** waits until the owner's Witch moves claim `id` to `conversation`; any other exit withdraws the request and throws the user's next step. */
export async function awaitTransfer<View extends { ledger: Ledger }>(
  request: TransferWait<View>,
): Promise<{ claim: TaskClaim; view?: View }> {
  try {
    return await poll(request);
  } catch (error) {
    const left = await request.withdraw().catch(() => undefined);
    // a hand-over can land between the last poll and the withdrawal
    if (left?.owner.conversation === request.conversation)
      return { claim: left };
    throw error;
  }
}

async function poll<View extends { ledger: Ledger }>(
  request: TransferWait<View>,
): Promise<{ claim: TaskClaim; view: View }> {
  const { id, reference, title, end } = request;
  while (Date.now() < end) {
    await delay(250);
    request.admit();
    // a read whose deadline already passed would record a ledger failure
    if (Date.now() >= end) break;
    let view: View;
    try {
      view = await request.read(Math.min(Date.now() + 1000, end));
    } catch {
      continue;
    }
    const claim = view.ledger.claims.find((claim) => claim.id === id);
    if (!claim) throw new Error(`${reference} was released. Claim it again.`);
    if (claim.owner.conversation === request.conversation)
      return { claim, view };
    if (claim.transfer?.activation !== request.activation) break;
    if (claim.transfer.refusal)
      throw new Error(
        `${title} still holds ${reference}. ${claim.transfer.refusal}`,
      );
  }
  throw new Error(
    `${title} did not answer. Restart Witch in that conversation or close it, then run /task take again.`,
  );
}
