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
} from '../core/coordination-state.js';
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
} from '../core/coordination-state.js';
import type { ProcessIdentity } from '../core/state.js';
import { mergeEventId, mergeEventSchema } from '../core/merge-events.js';
import type { MergeEvent } from '../core/merge-events.js';
import { answerable, peerRequestSchema } from '../core/peer-requests.js';
import type { PeerRequest } from '../core/peer-requests.js';
import type { PeerAnswer } from '../core/peer-answers.js';
import type { PullRequest } from '../core/repository.js';
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

export function checkDeadline(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Coordination request expired.');
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

  /** changes with every presence, claim, merge and activation write, each a rename, creation or removal in these directories. */
  signature(): string | undefined {
    try {
      return [this.directory, join(this.directory, 'sessions')]
        .map((directory) => statSync(directory, { bigint: true }).mtimeNs)
        .join(':');
    } catch {
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

  private async readMerges(): Promise<MergeEvent[]> {
    return (
      (await readJson(
        join(this.directory, 'merges.json'),
        z.array(mergeEventSchema),
      )) ?? []
    );
  }

  async mergeEvents(
    project: string,
    conversation: string,
  ): Promise<MergeEvent[]> {
    return (await this.readMerges()).filter(
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
    const lock = await this.lock(Date.now() + 1000);
    try {
      const events = await this.readMerges();
      const existing = events.find((event) => event.id === id);
      if (existing) return existing;
      const event = mergeEventSchema.parse({
        id,
        project,
        source,
        observedAt: new Date().toISOString(),
        pullRequest,
        recipients: [...new Set(recipients)],
      });
      await writeJson(join(this.directory, 'merges.json'), [...events, event]);
      return event;
    } finally {
      await lock.close();
    }
  }

  private async readPeerRequests(): Promise<PeerRequest[]> {
    return (
      (await readJson(
        join(this.directory, 'peer-requests.json'),
        z.array(peerRequestSchema),
      )) ?? []
    );
  }

  async peerRequests(
    project: string,
    conversation: string,
  ): Promise<PeerRequest[]> {
    return parties(await this.readPeerRequests(), project, conversation);
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
    verify: (ledger: Ledger) => Promise<void>,
  ): Promise<PeerRequest> {
    const lock = await this.lock(deadline);
    try {
      const requests = await this.readPeerRequests();
      const existing = requests.find(
        (request) =>
          request.project === sender.project &&
          request.from === sender.conversation &&
          request.claim === claim &&
          request.message === message.trim(),
      );
      if (existing) return existing;
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
      checkDeadline(deadline);
      await this.writePeerRequests([...requests, request]);
      return request;
    } finally {
      await lock.close();
    }
  }

  /** stamps the conversation's answerable requests so each gets one automatic answer attempt. */
  async attemptPeerRequests(
    project: string,
    conversation: string,
    deadline: number,
    verify: (ledger: Ledger) => Promise<void>,
  ): Promise<{ attempted: PeerRequest[]; requests: PeerRequest[] }> {
    const lock = await this.lock(deadline);
    try {
      const ledger = await this.reconcile(await this.read(), deadline);
      await verify(ledger);
      const stored = await this.readPeerRequests();
      const batch = new Set(
        answerable(stored, conversation, project, ledger.claims),
      );
      if (!batch.size)
        return {
          attempted: [],
          requests: parties(stored, project, conversation),
        };
      const attemptedAt = new Date().toISOString();
      const attempted: PeerRequest[] = [];
      const requests = stored.map((request) => {
        if (!batch.has(request)) return request;
        const stamped = { ...request, attemptedAt };
        attempted.push(stamped);
        return stamped;
      });
      checkDeadline(deadline);
      await this.writePeerRequests(requests);
      return {
        attempted,
        requests: parties(requests, project, conversation),
      };
    } finally {
      await lock.close();
    }
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
  ): Promise<PeerRequest[]> {
    const lock = await this.lock(deadline);
    try {
      const requests = await this.readPeerRequests();
      const updates = new Map<number, PeerRequest>();
      for (const { id, message } of answers) {
        const index = requests.findIndex((request) => request.id === id);
        const request = updates.get(index) ?? requests[index];
        if (request?.to !== conversation)
          throw new Error(
            `Peer request ${id} is not addressed to this conversation.`,
          );
        if (request.answer)
          throw new Error(`Peer request ${id} already has an answer.`);
        const answer = peerRequestSchema.parse({
          ...request,
          answer: { message, answeredAt: new Date().toISOString() },
        });
        updates.set(index, answer);
      }
      checkDeadline(deadline);
      await this.writePeerRequests(
        requests.map((request, index) => updates.get(index) ?? request),
      );
      return [...updates.values()];
    } finally {
      await lock.close();
    }
  }

  private async writePeerRequests(requests: PeerRequest[]): Promise<void> {
    await writeJson(join(this.directory, 'peer-requests.json'), requests);
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
    verify: (ledger: Ledger) => Promise<void>,
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
    verify: (ledger: Ledger) => Promise<void>,
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
    verify: (ledger: Ledger) => Promise<void>,
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
    verify: (ledger: Ledger) => Promise<void>,
  ): Promise<void> {
    await this.mutate(deadline, verify, (ledger) => {
      const index = ledger.claims.findIndex((claim) => claim.id === id);
      if (index < 0) return;
      if (!sameOwner(ledger.claims[index]!.owner, owner))
        throw new Error('Only the owning conversation can release this task.');
      ledger.claims.splice(index, 1);
    });
  }

  async requestTransfer(
    to: ClaimOwner,
    target: TransferTarget,
    request: Pick<Transfer, 'activation' | 'process' | 'expires'>,
    deadline: number,
    verify: (ledger: Ledger) => Promise<void>,
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
      claim[target.field] = { to, ...request };
      return claim;
    });
  }

  /** the owner moves its claim or records why not; `refusal` reads the owner's live state under the lock. */
  async handOver(
    owner: ClaimOwner,
    id: string,
    deadline: number,
    verify: (ledger: Ledger) => Promise<void>,
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
    verify: (ledger: Ledger) => Promise<void>,
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
    verify: (ledger: Ledger) => Promise<void>,
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
    verify: (ledger: Ledger) => Promise<void>,
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
    verify: (ledger: Ledger) => Promise<void>,
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
    verify: (ledger: Ledger) => Promise<void>,
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
    verify: (ledger: Ledger) => Promise<void>,
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
    await Promise.allSettled(probes);
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

  private async mutate<T>(
    deadline: number,
    verify: (ledger: Ledger) => Promise<void>,
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
