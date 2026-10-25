import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
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
} from '../core/coordination-state.js';
import type { ProcessIdentity } from '../core/state.js';
import { mergeEventId, mergeEventSchema } from '../core/merge-events.js';
import type { MergeEvent } from '../core/merge-events.js';
import type { PullRequest } from '../core/repository.js';
import { identifyProcesses, sameProcess } from './process.js';
import { lockedFiles, openLocked } from './lock.js';
import { writeJson } from './json.js';
import { StateStore } from './store.js';

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

export function checkDeadline(deadline: number): void {
  if (Date.now() >= deadline) throw new Error('Coordination request expired.');
}

export class CoordinationStore {
  private constructor(
    private readonly directory: string,
    private readonly store: StateStore,
  ) {}

  static async open(root: string): Promise<CoordinationStore> {
    const directory = join(root, 'coordination');
    await mkdir(join(directory, 'sessions'), { recursive: true, mode: 0o700 });
    return new CoordinationStore(directory, await StateStore.open(root));
  }

  async presences(): Promise<SessionPresence[]> {
    const directory = join(this.directory, 'sessions');
    const result: SessionPresence[] = [];
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) continue;
      const text = await readFile(join(directory, name), 'utf8').catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        },
      );
      if (text !== undefined)
        result.push(sessionPresenceSchema.parse(JSON.parse(text)));
    }
    return result;
  }

  private async readMerges(): Promise<MergeEvent[]> {
    const text = await readFile(
      join(this.directory, 'merges.json'),
      'utf8',
    ).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '[]';
      throw error;
    });
    return z.array(mergeEventSchema).parse(JSON.parse(text));
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
      await unlink(file).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    };
  }

  async activeActivations(
    activations: readonly string[],
  ): Promise<Set<string>> {
    const paths = new Map(
      activations.map((activation) => [
        join(this.directory, 'sessions', `${activation}.lock`),
        activation,
      ]),
    );
    const locked = await lockedFiles([...paths.keys()]);
    return new Set([...locked.keys()].map((path) => paths.get(path)!));
  }

  /** the caller holds the conversation lock until its writer drains and this removal finishes. */
  async removePresence(
    conversation: string,
    activation: string,
  ): Promise<void> {
    const file = join(this.directory, 'sessions', `${conversation}.json`);
    try {
      const presence = sessionPresenceSchema.parse(
        JSON.parse(await readFile(file, 'utf8')),
      );
      if (presence.activation === activation) await unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /** bounded reads notify observers under the reservation lock to preserve read order. */
  async state(deadline?: number, observe?: () => void): Promise<Ledger> {
    const lock = deadline === undefined ? undefined : await this.lock(deadline);
    try {
      observe?.();
      return await this.reconcile(await this.read());
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
    try {
      const ledger = ledgerSchema.parse(
        JSON.parse(await readFile(join(this.directory, 'claims.json'), 'utf8')),
      );
      return {
        claims: ledger.claims,
        selections: ledger.version === 2 ? ledger.selections : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { claims: [], selections: [] };
      throw error;
    }
  }

  private async reconcile(ledger: Ledger): Promise<Ledger> {
    const [processes, opened, active] = await Promise.all([
      identifyProcesses(
        ledger.claims.flatMap((claim) => claim.process?.pid ?? []),
      ),
      this.store.openConversations(
        ledger.claims.flatMap((claim) =>
          claim.process ? [] : [claim.owner.conversation],
        ),
      ),
      this.activeActivations(
        ledger.selections.map((ticket) => ticket.activation),
      ),
    ]);
    return {
      claims: ledger.claims.filter((claim) =>
        claim.process
          ? sameProcess(processes.get(claim.process.pid), claim.process)
          : opened.has(claim.owner.conversation),
      ),
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
      const ledger = await this.reconcile(stored);
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
      try {
        return await openLocked(
          join(this.directory, 'lock'),
          constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK,
          { mode: 0o600 },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
        await delay(Math.min(25, Math.max(0, deadline - Date.now())));
      }
    }
  }
}
