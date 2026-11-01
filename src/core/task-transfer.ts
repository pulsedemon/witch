import { setTimeout as delay } from 'node:timers/promises';
import type { Ledger } from '../persistence/coordination.js';
import { taskActivity, taskReference } from './coordination-state.js';
import type {
  ClaimInput,
  TaskClaim,
  TransferField,
} from './coordination-state.js';
import type { Snapshot } from './snapshot.js';
import { creditCapacity } from './usage.js';

/** keeps the previous owner from continuing work after its claim moves. */
export function movedNotices(ledger: Ledger, conversation: string): string[] {
  return ledger.claims.flatMap((claim) =>
    claim.movedFrom?.conversation === conversation
      ? [
          `Task ${claim.references.join(', ')} moved to conversation ${claim.owner.conversation}. Do not continue that task.`,
        ]
      : [],
  );
}

export function takeReference(
  input: ClaimInput,
  claim: TaskClaim,
  project: string,
): string {
  return [input.reference, ...(input.aliases ?? [])].find((reference) =>
    claim.references.includes(taskReference(reference, project)),
  )!;
}

/** why the owner keeps a claim another conversation asked for, with the user's next step. */
export function transferRefusal(
  state?: Snapshot,
  automatic = false,
  now = Date.now(),
): string | undefined {
  if (state?.recovery)
    return 'It has unresolved memory recovery. Resolve it there, then run /task take again.';
  if (state?.phase === 'error')
    return 'It stopped with an error. Restart Witch there, then run /task take again.';
  if (state?.phase !== 'idle')
    return `It is ${state?.phase ?? 'starting'}. Wait for it to go idle or stop its turn there, then run /task take again.`;
  if (taskActivity(state).running)
    return 'It has running familiars or brews. Stop them there, then run /task take again.';
  const runtime = state.native?.agent ?? state.conversation?.agent;
  const account = runtime ? state.accounts[runtime] : undefined;
  if (automatic && creditCapacity(account, now) === 'available')
    return 'It has current usable credits. Use /task take for a manual transfer.';
  if (
    automatic &&
    !state.usage.account?.limits.some(
      ({ percent, resetsAt }) => percent >= 100 && (resetsAt ?? 0) > now / 1000,
    )
  )
    return 'It has no reported exhausted limit awaiting reset.';
  return undefined;
}

export class TransferUnavailable extends Error {
  constructor(
    message: string,
    readonly claim?: TaskClaim,
  ) {
    super(message);
  }
}

interface TransferWait<View> {
  conversation: string;
  activation: string;
  reference: string;
  field: TransferField;
  deadline: number;
  request: (expires: number) => Promise<TaskClaim>;
  title: (conversation: string) => Promise<string | undefined>;
  admit: () => void;
  read: (deadline: number) => Promise<View>;
  withdraw: (id: string) => Promise<TaskClaim | undefined>;
}

/** withdraws unsuccessful requests and reconciles handovers before reporting their outcome. */
export async function awaitTransfer<View extends { ledger: Ledger }>(
  request: TransferWait<View>,
): Promise<{ claim: TaskClaim; view?: View }> {
  // leave time for withdrawal, the final peer refresh and the control reply.
  const end = request.deadline - 2000;
  const requested = await request.request(end);
  try {
    const title =
      (await request.title(requested.owner.conversation)) ??
      requested.owner.conversation;
    return await poll(request, requested.id, title, end);
  } catch (error) {
    const left = await request
      .withdraw(requested.id)
      .catch((cause: unknown) => {
        throw new Error(
          'Coordination result unknown. Query peers before doing work.',
          {
            cause,
          },
        );
      });
    // a hand-over can land between the last poll and the withdrawal
    if (left?.owner.conversation === request.conversation)
      return { claim: left };
    if (error instanceof TransferUnavailable)
      throw new TransferUnavailable(error.message, left);
    throw error;
  }
}

async function poll<View extends { ledger: Ledger }>(
  request: TransferWait<View>,
  id: string,
  title: string,
  end: number,
): Promise<{ claim: TaskClaim; view: View }> {
  const { reference, field } = request;
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
    if (!claim)
      throw new TransferUnavailable(
        `${reference} was released. Claim it again.`,
      );
    if (claim.owner.conversation === request.conversation)
      return { claim, view };
    const transfer = claim[field];
    if (transfer?.activation !== request.activation) break;
    if (transfer.refusal)
      throw new TransferUnavailable(
        `${title} still holds ${reference}. ${transfer.refusal}`,
      );
  }
  throw new TransferUnavailable(
    `${title} did not answer. Restart Witch in that conversation or close it, then run /task take again.`,
  );
}
