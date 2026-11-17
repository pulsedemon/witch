import { randomUUID } from 'node:crypto';
import { constants, statSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  claimInputSchema,
  sessionPresenceSchema,
  selectionTicketSchema,
  selectionStates,
  taskClaimSchema,
  taskReference,
} from '../core/coordination/coordination-state.js';
import type {
  ClaimInput,
  ClaimOwner,
  SessionPresence,
  SelectionScope,
  SelectionState,
  SelectionTicket,
  TaskClaim,
  Transfer,
  TransferField,
  TransferTarget,
} from '../core/coordination/coordination-state.js';
import type { ProcessIdentity } from '../core/state.js';
import {
  mergeEventId,
  mergeEventSchema,
} from '../core/repository/merge-events.js';
import type { MergeEvent } from '../core/repository/merge-events.js';
import {
  answerable,
  peerRequestSchema,
} from '../core/coordination/peer-requests.js';
import type { PeerRequest } from '../core/coordination/peer-requests.js';
import type { PeerAnswer } from '../core/coordination/peer-answers.js';
import {
  entry,
  pauseSchema,
  sameRequest,
} from '../core/coordination/pauses.js';
import type { Pause, PauseRecipient } from '../core/coordination/pauses.js';
import type { PullRequest } from '../core/repository/repository.js';
import { identifyProcesses, sameProcess } from './process.js';
import { lockedFiles, openLocked, tryOpenLocked } from './lock.js';
import { readJson, writeJson } from './json.js';
import type { StateStore } from './store.js';

const ledgerSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), claims: z.array(taskClaimSchema) }),
  z.object({
    version: z.literal(2),
    claims: z.array(taskClaimSchema),
    selections: z.array(selectionTicketSchema),
  }),
]);

export type Ledger = { claims: TaskClaim[]; selections: SelectionTicket[] };

/** runs under the coordination lock with the reconciled ledger, throwing to refuse the operation. */
export type Verify = (ledger: Ledger) => Promise<void>;

/** a JSON list in the coordination directory; `transact` writes it under the lock. */
interface StoredList<T> {
  file: string;
  schema: z.ZodType<T[]>;
}

const merges: StoredList<MergeEvent> = {
  file: 'merges.json',
  schema: z.array(mergeEventSchema),
};

const peerRequests: StoredList<PeerRequest> = {
  file: 'peer-requests.json',
  schema: z.array(peerRequestSchema),
};

const pauses: StoredList<Pause> = {
  file: 'pauses.json',
  schema: z.array(pauseSchema),
};

function sameOwner(left: ClaimOwner, right: ClaimOwner): boolean {
  return (
    left.conversation === right.conversation && left.project === right.project
  );
}

function sameScope(left: SelectionScope, right: SelectionScope): boolean {
  return (
    sameOwner(left.owner, right.owner) &&
    left.activation === right.activation &&
    left.turn === right.turn
  );
}

function claimInput(owner: ClaimOwner, input: ClaimInput) {
  const { reference, aliases = [], summary } = claimInputSchema.parse(input);

  return {
    references: [
      ...new Set(
        [reference, ...aliases].map((value) =>
          taskReference(value, owner.project),
        ),
      ),
    ],
    summary,
  };
}

function reserve(
  ledger: Ledger,
  owner: ClaimOwner,
  input: ReturnType<typeof claimInput>,
  process: ProcessIdentity,
): TaskClaim {
  const conflict = ledger.claims.find(
    (claim) =>
      claim.owner.conversation !== owner.conversation &&
      claim.references.some((value) => input.references.includes(value)),
  );

  if (conflict) throw new ClaimConflict(conflict);

  const existing = ledger.claims.find(
    (claim) => claim.owner.conversation === owner.conversation,
  );

  if (existing) {
    if (
      sameOwner(existing.owner, owner) &&
      input.references.some((value) => existing.references.includes(value))
    ) {
      existing.references = [
        ...new Set([...existing.references, ...input.references]),
      ];

      existing.summary = input.summary;
      existing.process = process;
      delete existing.suggestion;

      return existing;
    }

    if (!existing.suggestion)
      throw new Error('Release the current task before claiming another.');

    ledger.claims.splice(ledger.claims.indexOf(existing), 1);
  }

  const claim: TaskClaim = {
    id: randomUUID(),
    owner,
    ...input,
    createdAt: Date.now(),
    process,
  };

  ledger.claims.push(claim);

  return claim;
}

function selection(
  ledger: Ledger,
  scope: SelectionScope,
  id: string,
): SelectionState {
  const state = selectionStates(ledger.selections).find(
    (state) => state.ticket.id === id,
  );

  if (!state || !sameScope(state.ticket, scope))
    throw new Error('This selection is no longer current.');

  return state;
}

export class ClaimConflict extends Error {
  constructor(readonly claim: TaskClaim) {
    super(
      `Task already reserved by ${claim.owner.conversation}: ${claim.summary}`,
    );
  }
}

function parties(
  requests: readonly PeerRequest[],
  project: string,
  conversation: string,
): PeerRequest[] {
  return requests.filter(
    (request) =>
      request.project === project &&
      (request.from === conversation || request.to === conversation),
  );
}

/** a caller ran out of its own time; it says nothing about what it was reading. */
export class DeadlineExpired extends Error {
  constructor() {
    super('Coordination request expired.');
  }
}

export function checkDeadline(deadline: number): number {
  const remaining = deadline - Date.now();

  if (remaining <= 0) throw new DeadlineExpired();

  return remaining;
}

export class CoordinationStore {
  private constructor(
    private readonly directory: string,
    private readonly store: StateStore,
  ) {}

  static async open(store: StateStore): Promise<CoordinationStore> {
    const directory = join(store.root, 'coordination');
    await mkdir(join(directory, 'sessions'), { recursive: true, mode: 0o700 });

    return new CoordinationStore(directory, store);
  }

  /** changes with every presence, claim, merge, peer request, pause and activation write, each a rename, creation or removal in these directories. */
  signature(): string | undefined {
    try {
      return [this.directory, join(this.directory, 'sessions')]
        .map((directory) => statSync(directory, { bigint: true }).mtimeNs)
        .join(':');
    } catch {
      // no signature makes the caller refresh for real
      return undefined;
    }
  }

  async presences(): Promise<SessionPresence[]> {
    const directory = join(this.directory, 'sessions');
    const result: SessionPresence[] = [];

    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) continue;

      const presence = await readJson(
        join(directory, name),
        sessionPresenceSchema,
      );

      if (presence) result.push(presence);
    }

    return result;
  }

  async mergeEvents(
    project: string,
    conversation: string,
  ): Promise<MergeEvent[]> {
    return (await this.list(merges)).filter(
      (event) =>
        event.project === project && event.recipients.includes(conversation),
    );
  }

  async recordMerge(
    project: string,
    pullRequest: PullRequest,
    source: string,
    recipients: readonly string[],
  ): Promise<MergeEvent> {
    const id = mergeEventId(project, pullRequest);

    return this.transact(merges, Date.now() + 1000, async (events) => {
      const existing = events.find((event) => event.id === id);

      if (existing) return { result: existing };

      const event = mergeEventSchema.parse({
        id,
        project,
        source,
        observedAt: new Date().toISOString(),
        pullRequest,
        recipients: [...new Set(recipients)],
      });

      return { result: event, next: [...events, event] };
    });
  }

  async peerRequests(
    project: string,
    conversation: string,
  ): Promise<PeerRequest[]> {
    return parties(await this.list(peerRequests), project, conversation);
  }

  async peerRequest(owner: ClaimOwner, id: string): Promise<PeerRequest> {
    const found = (
      await this.peerRequests(owner.project, owner.conversation)
    ).find((request) => request.id === id);

    if (!found)
      throw new Error(
        `Peer request ${id} was not sent to or by this conversation.`,
      );

    return found;
  }

  /** a repeated ask returns the recorded request, whatever its status, so a retry can't buy a second answer turn. */
  async askPeer(
    sender: ClaimOwner,
    claim: string,
    message: string,
    deadline: number,
    verify: Verify,
  ): Promise<PeerRequest> {
    return this.transact(peerRequests, deadline, async (requests) => {
      const existing = requests.find(
        (request) =>
          request.project === sender.project &&
          request.from === sender.conversation &&
          request.claim === claim &&
          request.message === message.trim(),
      );

      if (existing) return { result: existing };

      const ledger = await this.reconcile(await this.read(), deadline);
      const owned = ledger.claims.find(({ id }) => id === claim);

      if (!owned)
        throw new Error(
          `No session claims ${claim}. Query --peers --json for claim ids.`,
        );

      if (owned.owner.conversation === sender.conversation)
        throw new Error('This conversation owns that claim.');

      await verify(ledger);

      const request = peerRequestSchema.parse({
        id: randomUUID(),
        project: sender.project,
        from: sender.conversation,
        to: owned.owner.conversation,
        claim,
        reference: owned.references[0],
        message,
        askedAt: new Date().toISOString(),
      });

      return { result: request, next: [...requests, request] };
    });
  }

  /** stamps the conversation's answerable requests so each gets one automatic answer attempt. */
  async attemptPeerRequests(
    project: string,
    conversation: string,
    deadline: number,
    verify: Verify,
  ): Promise<{ attempted: PeerRequest[]; requests: PeerRequest[] }> {
    return this.transact(peerRequests, deadline, async (stored) => {
      const ledger = await this.reconcile(await this.read(), deadline);
      await verify(ledger);

      const batch = new Set(
        answerable(stored, conversation, project, ledger.claims),
      );

      if (!batch.size)
        return {
          result: {
            attempted: [],
            requests: parties(stored, project, conversation),
          },
        };

      const attemptedAt = new Date().toISOString();
      const attempted: PeerRequest[] = [];

      const requests = stored.map((request) => {
        if (!batch.has(request)) return request;

        const stamped = { ...request, attemptedAt };
        attempted.push(stamped);

        return stamped;
      });

      return {
        result: {
          attempted,
          requests: parties(requests, project, conversation),
        },
        next: requests,
      };
    });
  }

  async answerPeer(
    conversation: string,
    id: string,
    message: string,
    deadline: number,
  ): Promise<PeerRequest> {
    const [answer] = await this.answerPeers(
      conversation,
      [{ id, message }],
      deadline,
    );

    return answer!;
  }

  /** validate the whole batch before publishing any answer. */
  async answerPeers(
    conversation: string,
    answers: readonly PeerAnswer[],
    deadline: number,
    preserveAnswered = false,
  ): Promise<PeerRequest[]> {
    return this.transact(peerRequests, deadline, async (requests) => {
      const updates = new Map<number, PeerRequest>();

      for (const { id, message } of answers) {
        const index = requests.findIndex((request) => request.id === id);
        const request = updates.get(index) ?? requests[index];

        if (request?.to !== conversation)
          throw new Error(
            `Peer request ${id} is not addressed to this conversation.`,
          );

        if (request.answer) {
          if (preserveAnswered && !updates.has(index)) continue;

          throw new Error(`Peer request ${id} already has an answer.`);
        }

        const answer = peerRequestSchema.parse({
          ...request,
          answer: { message, answeredAt: new Date().toISOString() },
        });

        updates.set(index, answer);
      }

      const result = [...updates.values()];

      // a batch whose every request was already answered changes nothing to write
      if (!updates.size) return { result };

      return {
        result,
        next: requests.map((request, index) => updates.get(index) ?? request),
      };
    });
  }

  /** the pauses the conversation issued or receives. */
  async pauses(conversation: string): Promise<Pause[]> {
    return (await this.list(pauses)).filter(
      (pause) =>
        pause.from === conversation || entry(pause, conversation) !== undefined,
    );
  }

  async pause(conversation: string, id: string): Promise<Pause> {
    const found = (await this.pauses(conversation)).find(
      (pause) => pause.id === id,
    );

    if (!found)
      throw new Error(`Pause ${id} was not issued by or to this conversation.`);

    return found;
  }

  /** the issuer's record from the same turn and `--to` list, whatever its status. */
  async existingPause(
    from: string,
    turn: string | undefined,
    requested: readonly string[] | undefined,
  ): Promise<Pause | undefined> {
    return (await this.list(pauses)).find((pause) =>
      sameRequest(pause, from, turn, requested),
    );
  }

  /** `recipients` runs under the lock, so a session live when the pause is recorded is chosen; it must not read the ledger, whose lock this holds. */
  async issuePause(
    issuer: ClaimOwner,
    turn: string | undefined,
    requested: readonly string[] | undefined,
    deadline: number,
    recipients: () => Promise<
      readonly { conversation: string; project: string }[]
    >,
  ): Promise<Pause> {
    return this.transact(pauses, deadline, async (issued) => {
      const existing = issued.find((pause) =>
        sameRequest(pause, issuer.conversation, turn, requested),
      );

      if (existing) return { result: existing };

      const unique = [
        ...new Map(
          (await recipients()).map((recipient) => [
            recipient.conversation,
            recipient,
          ]),
        ).values(),
      ];

      const pause = pauseSchema.parse({
        id: randomUUID(),
        from: issuer.conversation,
        project: issuer.project,
        issuedAt: new Date().toISOString(),
        turn,
        requested,
        recipients: unique.map(({ conversation, project }) => ({
          conversation,
          project,
        })),
      });

      return { result: pause, next: [...issued, pause] };
    });
  }

  async confirmPause(
    conversation: string,
    id: string,
    deadline: number,
  ): Promise<void> {
    await this.stampPauses(deadline, (pause) =>
      pause.id === id
        ? pause.recipients.map((recipient) =>
            recipient.conversation === conversation && !recipient.confirmedAt
              ? { ...recipient, confirmedAt: new Date().toISOString() }
              : recipient,
          )
        : undefined,
    );
  }

  async resumeByUser(
    conversation: string,
    ids: readonly string[],
    deadline: number,
  ): Promise<void> {
    await this.stampPauses(deadline, (pause) =>
      ids.includes(pause.id)
        ? pause.recipients.map((recipient) =>
            recipient.conversation === conversation && !recipient.resumedAt
              ? {
                  ...recipient,
                  resumedAt: new Date().toISOString(),
                  resumedBy: 'user' as const,
                }
              : recipient,
          )
        : undefined,
    );
  }

  /** only the issuer resumes its pause; entries a user already resumed keep that. */
  async resumePause(
    from: string,
    id: string,
    deadline: number,
  ): Promise<Pause> {
    let resumed: Pause | undefined;

    await this.stampPauses(deadline, (pause) => {
      if (pause.id !== id) return undefined;

      if (pause.from !== from)
        throw new Error(`Only the issuing session can resume pause ${id}.`);

      const recipients = pause.recipients.map((recipient) =>
        recipient.resumedAt
          ? recipient
          : {
              ...recipient,
              resumedAt: new Date().toISOString(),
              resumedBy: 'issuer' as const,
            },
      );

      resumed = { ...pause, recipients };

      return recipients;
    });

    if (!resumed)
      throw new Error(`Pause ${id} was not issued by this conversation.`);

    return resumed;
  }

  /** `update` returns a pause's new recipients, or undefined to leave it. */
  private async stampPauses(
    deadline: number,
    update: (pause: Pause) => PauseRecipient[] | undefined,
  ): Promise<void> {
    await this.transact(pauses, deadline, async (issued) => {
      let changed = false;

      const next = issued.map((pause) => {
        const recipients = update(pause);

        if (!recipients) return pause;

        changed = true;

        return { ...pause, recipients };
      });

      return { result: undefined, ...(changed ? { next } : {}) };
    });
  }

  async publish(presence: SessionPresence): Promise<void> {
    await writeJson(
      join(this.directory, 'sessions', `${presence.id}.json`),
      sessionPresenceSchema.parse(presence),
    );
  }

  /** a failed presence removal cannot register a later holder of the conversation lock. */
  async holdActivation(activation: string): Promise<() => Promise<void>> {
    const file = join(this.directory, 'sessions', `${activation}.lock`);

    const lock = await openLocked(
      file,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_NONBLOCK,
      { mode: 0o600 },
    );

    return async () => {
      await lock.close();
      await rm(file, { force: true });
    };
  }

  async activeActivations(
    activations: readonly string[],
    options: { timeout?: number } = {},
  ): Promise<Set<string>> {
    const paths = new Map(
      activations.map((activation) => [
        join(this.directory, 'sessions', `${activation}.lock`),
        activation,
      ]),
    );

    const locked = await lockedFiles([...paths.keys()], options);

    return new Set([...locked.keys()].map((path) => paths.get(path)!));
  }

  /** the caller holds the conversation lock until its writer drains and this removal finishes. */
  async removePresence(
    conversation: string,
    activation: string,
  ): Promise<void> {
    const file = join(this.directory, 'sessions', `${conversation}.json`);
    const presence = await readJson(file, sessionPresenceSchema);

    if (presence?.activation === activation) await rm(file, { force: true });
  }

  /** bounded reads notify observers under the reservation lock to preserve read order. */
  async state(deadline?: number, observe?: () => void): Promise<Ledger> {
    const lock = deadline === undefined ? undefined : await this.lock(deadline);

    try {
      observe?.();
      const ledger = await this.reconcile(await this.read(), deadline);

      if (deadline !== undefined) checkDeadline(deadline);

      return ledger;
    } finally {
      await lock?.close();
    }
  }

  async claims(): Promise<TaskClaim[]> {
    return (await this.state()).claims;
  }

  /** bind legacy ownership before restart opens a gap in its conversation lock. */
  async adoptClaim(
    owner: ClaimOwner,
    process: ProcessIdentity,
    deadline: number,
    verify: Verify,
  ): Promise<void> {
    await this.mutate(deadline, verify, (ledger) => {
      const claim = ledger.claims.find((claim) =>
        sameOwner(claim.owner, owner),
      );

      if (claim && !claim.process) claim.process = process;
    });
  }

  async claim(
    owner: ClaimOwner,
    input: ClaimInput,
    process: ProcessIdentity,
    deadline: number,
    verify: Verify,
  ): Promise<TaskClaim> {
    const normalized = claimInput(owner, input);

    return this.mutate(deadline, verify, (ledger) => {
      const claim = reserve(ledger, owner, normalized, process);

      ledger.selections = ledger.selections.filter(
        (ticket) => ticket.owner.conversation !== owner.conversation,
      );

      return claim;
    });
  }

  async recordAssignment(
    id: string,
    references: string[],
    deadline: number,
    verify: Verify,
  ): Promise<TaskClaim | undefined> {
    return this.mutate(deadline, verify, (ledger) => {
      const claim = ledger.claims.find((claim) => claim.id === id);

      if (claim)
        claim.assigned = [
          ...new Set([...(claim.assigned ?? []), ...references]),
        ];

      return claim;
    });
  }

  async release(
    owner: ClaimOwner,
    id: string,
    deadline: number,
    verify: Verify,
  ): Promise<void> {
    await this.mutate(deadline, verify, (ledger) => {
      const index = ledger.claims.findIndex((claim) => claim.id === id);

      if (index < 0) return;

      if (!sameOwner(ledger.claims[index]!.owner, owner))
        throw new Error('Only the owning conversation can release this task.');

      ledger.claims.splice(index, 1);
    });
  }

  async releaseReferences(
    owner: ClaimOwner,
    id: string,
    references: readonly string[],
    deadline: number,
    verify: Verify,
  ): Promise<{ references: string[]; claim?: TaskClaim }> {
    const released = [
      ...new Set(
        references.map((value) => taskReference(value, owner.project)),
      ),
    ];

    return this.mutate(deadline, verify, (ledger) => {
      const index = ledger.claims.findIndex((claim) => claim.id === id);
      const claim = ledger.claims[index];

      if (!claim)
        throw new Error(
          'This claim no longer exists. Query peers before continuing.',
        );

      if (!sameOwner(claim.owner, owner))
        throw new Error('Only the owning conversation can release this task.');

      if (claim.suggestion)
        throw new Error('Release the whole suggested task with --release.');

      if (claim.transfer || claim.automaticTransfer)
        throw new Error(
          'Wait for the pending task transfer before releasing references.',
        );

      if (
        !released.length ||
        released.some((value) => !claim.references.includes(value))
      )
        throw new Error(
          'Every released reference must belong to this claim. Query peers before continuing.',
        );

      claim.references = claim.references.filter(
        (value) => !released.includes(value),
      );

      if (!claim.references.length) ledger.claims.splice(index, 1);

      return {
        references: released,
        ...(claim.references.length ? { claim } : {}),
      };
    });
  }

  async requestTransfer(
    to: ClaimOwner,
    target: TransferTarget,
    request: Pick<Transfer, 'activation' | 'process'> & {
      expires: () => number;
    },
    deadline: number,
    verify: Verify,
  ): Promise<TaskClaim> {
    const normalized =
      target.field === 'transfer'
        ? taskReference(target.reference, to.project)
        : undefined;

    return this.mutate(deadline, verify, (ledger) => {
      const claim = ledger.claims.find((claim) =>
        target.field === 'automaticTransfer'
          ? claim.id === target.claim.id
          : claim.references.includes(normalized!),
      );

      if (!claim)
        throw new Error(
          target.field === 'transfer'
            ? `No other conversation holds ${target.reference}.`
            : 'The conflicting claim was released. Claim it again.',
        );

      if (
        target.field === 'automaticTransfer' &&
        (!sameOwner(claim.owner, target.claim.owner) || claim.suggestion)
      )
        throw new ClaimConflict(claim);

      if (
        target.field === 'automaticTransfer' &&
        !claimInput(to, target.input).references.some((value) =>
          claim.references.includes(value),
        )
      )
        throw new Error(
          'The conflicting references were released. Query peers and claim again.',
        );

      if (claim.owner.conversation === to.conversation)
        throw new Error('This conversation already holds this task.');

      if (
        ledger.claims.some(
          (entry) =>
            entry.owner.conversation === to.conversation && !entry.suggestion,
        )
      )
        throw new Error('Release the current task before taking another.');

      if (
        (['transfer', 'automaticTransfer'] as const).some(
          (field) =>
            claim[field] &&
            (field !== target.field ||
              claim[field].to.conversation !== to.conversation),
        )
      ) {
        if (target.field === 'automaticTransfer')
          throw new ClaimConflict(claim);

        throw new Error('Another conversation is already taking this task.');
      }

      claim[target.field] = { ...request, to, expires: request.expires() };

      return claim;
    });
  }

  /** the owner moves its claim or records why not; `refusal` reads the owner's live state under the lock. */
  async handOver(
    owner: ClaimOwner,
    id: string,
    deadline: number,
    verify: Verify,
    refusal: () => string | undefined,
    field: TransferField = 'transfer',
  ): Promise<TaskClaim | undefined> {
    return this.mutate(deadline, verify, (ledger) => {
      const claim = ledger.claims.find((claim) => claim.id === id);
      const transfer = claim?.[field];

      if (
        !claim ||
        !transfer ||
        transfer.refusal ||
        !sameOwner(claim.owner, owner)
      )
        return undefined;

      const { to } = transfer;

      const reason =
        field === 'automaticTransfer' && claim.suggestion
          ? 'The task is only a suggestion.'
          : ledger.claims.some(
                (entry) =>
                  entry.owner.conversation === to.conversation &&
                  !entry.suggestion,
              )
            ? 'The requesting conversation holds another task. Release it there, then run /task take again.'
            : refusal();

      if (reason) {
        transfer.refusal = reason;

        return claim;
      }

      ledger.claims = ledger.claims.filter(
        (entry) => entry.owner.conversation !== to.conversation,
      );

      ledger.selections = ledger.selections.filter(
        (ticket) => ticket.owner.conversation !== to.conversation,
      );

      claim.owner = to;
      claim.process = transfer.process;
      claim.movedFrom = owner;
      delete claim.transfer;
      delete claim.automaticTransfer;
      delete claim.suggestion;

      return claim;
    });
  }

  /** returns the claim as left, so a requester sees a hand-over that landed first. */
  async withdrawTransfer(
    activation: string,
    id: string,
    deadline: number,
    verify: Verify,
    field: TransferField = 'transfer',
  ): Promise<TaskClaim | undefined> {
    return this.mutate(deadline, verify, (ledger) => {
      const claim = ledger.claims.find((claim) => claim.id === id);

      if (claim?.[field]?.activation === activation) delete claim[field];

      return claim;
    });
  }

  async beginSelection(
    scope: SelectionScope,
    deadline: number,
    verify: Verify,
  ): Promise<SelectionState> {
    return this.mutate(deadline, verify, (ledger) => {
      const existing = ledger.selections.find(
        (ticket) => ticket.owner.conversation === scope.owner.conversation,
      );

      if (existing) return selection(ledger, scope, existing.id);

      const claim = ledger.claims.find(
        (claim) => claim.owner.conversation === scope.owner.conversation,
      );

      if (claim && !claim.suggestion)
        throw new Error('Release the current task before choosing another.');

      if (claim) ledger.claims.splice(ledger.claims.indexOf(claim), 1);

      const ticket = { ...scope, id: randomUUID() };
      ledger.selections.push(ticket);

      return selection(ledger, scope, ticket.id);
    });
  }

  async selection(
    scope: SelectionScope,
    id: string,
    deadline: number,
    verify: Verify,
  ): Promise<SelectionState> {
    return this.mutate(deadline, verify, (ledger) =>
      selection(ledger, scope, id),
    );
  }

  async recommend(
    scope: SelectionScope,
    id: string,
    input: ClaimInput,
    process: ProcessIdentity,
    deadline: number,
    verify: Verify,
  ): Promise<TaskClaim> {
    const normalized = claimInput(scope.owner, input);

    return this.mutate(deadline, verify, (ledger) => {
      const recorded = ledger.claims.find(
        (claim) => claim.suggestion?.selection === id,
      );

      if (recorded) {
        if (
          !sameOwner(recorded.owner, scope.owner) ||
          !recorded.process ||
          !sameProcess(recorded.process, process) ||
          recorded.summary !== normalized.summary ||
          recorded.references.length !== normalized.references.length ||
          !recorded.references.every((value) =>
            normalized.references.includes(value),
          )
        )
          throw new Error(
            'This recommendation does not match the recorded selection.',
          );

        return recorded;
      }

      if (selection(ledger, scope, id).position !== 1)
        throw new Error('Wait for first position before recommending a task.');

      const claim = reserve(ledger, scope.owner, normalized, process);
      claim.suggestion = { selection: id };

      ledger.selections = ledger.selections.filter(
        (ticket) => ticket.id !== id,
      );

      return claim;
    });
  }

  async cancelSelection(
    scope: SelectionScope,
    id: string | undefined,
    deadline: number,
    verify: Verify,
  ): Promise<void> {
    await this.mutate(deadline, verify, (ledger) => {
      if (id && ledger.selections.some((ticket) => ticket.id === id))
        selection(ledger, scope, id);

      ledger.selections = ledger.selections.filter(
        (ticket) =>
          !(sameScope(ticket, scope) && (id === undefined || ticket.id === id)),
      );
    });
  }

  async releaseConversation(
    owner: ClaimOwner,
    process: ProcessIdentity,
    deadline: number,
    verify: Verify,
  ): Promise<void> {
    await this.mutate(deadline, verify, (ledger) => {
      ledger.claims = ledger.claims.filter(
        (claim) =>
          !(
            sameOwner(claim.owner, owner) &&
            (!claim.process || sameProcess(claim.process, process))
          ),
      );
    });
  }

  private async read(): Promise<Ledger> {
    const ledger = await readJson(
      join(this.directory, 'claims.json'),
      ledgerSchema,
    );

    if (!ledger) return { claims: [], selections: [] };

    return {
      claims: ledger.claims,
      selections: ledger.version === 2 ? ledger.selections : [],
    };
  }

  private async reconcile(ledger: Ledger, deadline?: number): Promise<Ledger> {
    const options = {
      timeout: deadline === undefined ? undefined : checkDeadline(deadline),
    };

    const probes = [
      identifyProcesses(
        ledger.claims.flatMap((claim) => claim.process?.pid ?? []),
        options,
      ),
      this.store.openConversations(
        ledger.claims.flatMap((claim) =>
          claim.process ? [] : [claim.owner.conversation],
        ),
        options,
      ),
      this.activeActivations(
        [
          ...ledger.selections.map((ticket) => ticket.activation),
          ...ledger.claims.flatMap((claim) =>
            [claim.transfer, claim.automaticTransfer].flatMap(
              (request) => request?.activation ?? [],
            ),
          ),
        ],
        options,
      ),
    ] as const;

    // every probe must close before a failure releases the ledger lock.
    const failed = (await Promise.allSettled(probes)).flatMap((probe) =>
      probe.status === 'rejected' ? [probe.reason as unknown] : [],
    );

    // `killed` alone also marks a probe that exited by itself as its timeout fired
    const killed = (error: unknown) =>
      error instanceof Error &&
      'killed' in error &&
      error.killed === true &&
      'signal' in error &&
      error.signal === 'SIGKILL';

    // a probe killed at its timeout rejects as a failed command; alone, that failure is the deadline's
    if (deadline !== undefined && failed.length && failed.every(killed))
      checkDeadline(deadline);

    if (failed.length)
      throw failed.find((error) => !killed(error)) ?? failed[0];

    const [processes, opened, active] = await Promise.all(probes);
    const now = Date.now();

    return {
      claims: ledger.claims
        .filter((claim) =>
          claim.process
            ? sameProcess(processes.get(claim.process.pid), claim.process)
            : opened.has(claim.owner.conversation),
        )
        .map((claim) => {
          const kept = { ...claim };

          // a requester that left, died or stopped waiting abandons its request
          for (const field of ['transfer', 'automaticTransfer'] as const) {
            const transfer = kept[field];

            if (
              transfer &&
              (!active.has(transfer.activation) || transfer.expires <= now)
            )
              delete kept[field];
          }

          return kept;
        }),
      selections: ledger.selections.filter((ticket) =>
        active.has(ticket.activation),
      ),
    };
  }

  private async list<T>(stored: StoredList<T>): Promise<T[]> {
    return (
      (await readJson(join(this.directory, stored.file), stored.schema)) ?? []
    );
  }

  /** runs `change` on the list under the lock, writing the `next` it returns after a last deadline check. */
  private async transact<T, R>(
    stored: StoredList<T>,
    deadline: number,
    change: (items: T[]) => Promise<{ result: R; next?: T[] }>,
  ): Promise<R> {
    const lock = await this.lock(deadline);

    try {
      const { result, next } = await change(await this.list(stored));

      if (next) {
        checkDeadline(deadline);
        await writeJson(join(this.directory, stored.file), next);
      }

      return result;
    } finally {
      await lock.close();
    }
  }

  private async mutate<T>(
    deadline: number,
    verify: Verify,
    change: (ledger: Ledger) => T,
  ): Promise<T> {
    const lock = await this.lock(deadline);

    try {
      const stored = await this.read();
      const before = JSON.stringify(stored);
      const ledger = await this.reconcile(stored, deadline);
      checkDeadline(deadline);
      await verify(ledger);
      checkDeadline(deadline);
      const result = change(ledger);

      if (JSON.stringify(ledger) !== before)
        await writeJson(join(this.directory, 'claims.json'), {
          version: 2,
          ...ledger,
        });

      return result;
    } finally {
      await lock.close();
    }
  }

  private async lock(deadline: number): Promise<FileHandle> {
    while (true) {
      checkDeadline(deadline);

      const lock = await tryOpenLocked(
        join(this.directory, 'lock'),
        constants.O_RDWR | constants.O_CREAT,
        { mode: 0o600 },
      );

      if (lock) return lock;

      await delay(Math.min(25, Math.max(0, deadline - Date.now())));
    }
  }
}
