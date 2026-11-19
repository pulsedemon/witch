import { setTimeout as delay } from 'node:timers/promises';
import type {
  CoordinationStore,
  Ledger,
  Verify,
} from '../../persistence/coordination.js';
import type { Activation, RequestState } from './coordination.js';
import { taskActivity, taskReference } from './coordination-state.js';
import type {
  ClaimInput,
  TaskClaim,
  TransferField,
} from './coordination-state.js';
import type { Snapshot } from '../snapshot.js';
import { creditCapacity } from '../runtime/usage.js';

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

  if (state.nativeRunning)
    return 'It is running on its own. Wait for it to go idle, then run /task take again.';

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

interface ResponderHost {
  readonly registry: Pick<CoordinationStore, 'handOver'>;
  serialize<T>(work: () => Promise<T>): Promise<T>;

  change<T>(
    state: RequestState | undefined,
    work: (verify: Verify) => Promise<T>,
    verify?: Verify,
  ): Promise<T>;

  admit(): Activation;

  state(): Snapshot | undefined;

  refresh(): Promise<void>;

  admitted(active: Activation): boolean;

  failed(error: unknown): void;

  recovered(): void;
}

/** the owner's Witch answers a transfer request without a model turn. */
export class TransferResponder {
  private handing?: Promise<void>;

  constructor(private readonly host: ResponderHost) {}

  answer(active: Activation, ledger: Ledger): void {
    const claim = ledger.claims.find(
      (claim) =>
        claim.owner.conversation === active.conversation.id &&
        (claim.transfer || claim.automaticTransfer),
    );

    if (!claim) {
      // a request that went away takes its failure with it
      this.settle(active);

      return;
    }

    if (this.handing) return;

    const field = claim.transfer ? 'transfer' : 'automaticTransfer';

    if (claim[field]?.refusal) return;

    const owner = { ...claim.owner, conversation: active.conversation.id };

    this.handing = this.host
      .serialize(async () => {
        const moved = await this.host.change(
          undefined,
          (verify) =>
            this.host.registry.handOver(
              owner,
              claim.id,
              Date.now() + 1000,
              verify,
              () =>
                transferRefusal(
                  this.host.state(),
                  field === 'automaticTransfer',
                ),
              field,
            ),
          async () => {
            if (this.host.admit() !== active)
              throw new Error('Coordination moved.');
          },
        );

        this.settle(active);

        if (moved && !moved.transfer) void this.host.refresh();
      })
      .catch((error: unknown) => {
        // the request stays pending, so the next tick rereads and answers again
        active.observed = undefined;
        this.settle(active, error);
      })
      .finally(() => {
        this.handing = undefined;
      });
  }

  /** records the owner's handover failure, or clears it, while this activation is still admitted: a handover that a switch or close cut short didn't fail. */
  private settle(active: Activation, error?: unknown): void {
    if (!this.host.admitted(active)) return;

    if (error !== undefined) this.host.failed(error);
    else this.host.recovered();
  }
}

export class TransferUnavailable extends Error {
  constructor(
    message: string,
    readonly claim?: TaskClaim,
  ) {
    super(message);
  }
}

/** the longest an owner gets to answer once the request is recorded; a longer request deadline must not hold the requester's other coordination work on an owner that never does. */
const patience = 8000;

interface TransferWait<View> {
  conversation: string;
  activation: string;
  reference: string;
  field: TransferField;
  deadline: number;
  /** `expires` is read when the request is written, so a slow write doesn't spend the owner's time. */
  request: (expires: () => number) => Promise<TaskClaim>;
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
  const latest = request.deadline - 2000;

  const requested = await request.request(() =>
    Math.min(latest, Date.now() + patience),
  );

  const end = requested[request.field]!.expires;

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
      // the read recorded its own failure, and the poll goes on to the deadline
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
