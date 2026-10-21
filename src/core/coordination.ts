import { randomUUID } from 'node:crypto';
import { errorMessage } from '../agents/stderr.js';
import type { Memory } from '../memory/memory.js';
import {
  ClaimConflict,
  CoordinationStore,
  checkDeadline,
} from '../persistence/coordination.js';
import { ControlHost } from '../persistence/control.js';
import type {
  ControlBinding,
  ControlOutcome,
  ControlRequest,
} from '../persistence/control.js';
import { identifyProcess } from '../persistence/process.js';
import type { StateStore } from '../persistence/store.js';
import {
  conversationSummarySchema,
  selectionStates,
} from './coordination-state.js';
import type {
  CoordinationSnapshot,
  SessionPresence,
  SelectionScope,
} from './coordination-state.js';
import type { Snapshot } from './coordinator.js';
import type { Repository } from './repository.js';
import type { Conversation, ProcessIdentity } from './state.js';

interface Activation {
  conversation: Conversation;
  project: string;
  binding: ControlBinding;
  openedAt: number;
  accepting: boolean;
  publishing: boolean;
  release(): Promise<void>;
}

const emptySnapshot: CoordinationSnapshot = {
  peers: [],
  reservations: [],
  unregistered: [],
};

/** one conversation owns mutations until quiesced; presence disappears only while its conversation lock is held. */
export class SessionCoordination {
  snapshot: CoordinationSnapshot = emptySnapshot;
  private listeners = new Set<() => void>();
  private active?: Activation;
  private state?: Snapshot;
  private branch?: string;
  private host!: ControlHost;
  private timer?: ReturnType<typeof setInterval>;
  private scheduled?: ReturnType<typeof setTimeout>;
  private pending?: SessionPresence;
  private projected?: string;
  private writing: Promise<void> = Promise.resolve();
  private operations: Promise<void> = Promise.resolve();
  private refreshing?: {
    active: Activation;
    project: string;
    promise: Promise<void>;
  };
  private failures = new Map<string, string>();
  private turn?: SelectionScope;
  private cancellations = new Map<string, SelectionScope>();
  private suggestionReleases = new Set<string>();
  private maintaining?: Promise<void>;
  private ending = false;
  private closed = false;

  private constructor(
    private readonly store: StateStore,
    private readonly memory: Memory,
    private readonly registry: CoordinationStore,
    private readonly directory: string,
    private readonly prefix: (binding: ControlBinding) => string,
    private readonly process: ProcessIdentity,
  ) {}

  static async open(
    store: StateStore,
    memory: Memory,
    directory: string,
    prefix: (binding: ControlBinding) => string,
  ): Promise<SessionCoordination> {
    const identity = await identifyProcess(process.pid);
    if (!identity) throw new Error('Witch process identity is unavailable.');
    const coordination = new SessionCoordination(
      store,
      memory,
      await CoordinationStore.open(store.root),
      directory,
      prefix,
      identity,
    );
    coordination.host = await ControlHost.open(
      directory,
      (request) => coordination.handle(request),
      (error) => coordination.fail('control', error),
    );
    coordination.timer = setInterval(() => {
      void coordination.maintain();
      void coordination.refresh();
    }, 2000);
    coordination.timer.unref();
    return coordination;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async activate(
    conversation: Conversation,
    project: string,
  ): Promise<ControlBinding> {
    if (this.ending || this.closed) throw new Error('Coordination is closing.');
    if (
      this.active?.accepting &&
      this.active.conversation.id === conversation.id &&
      this.active.project === project
    )
      return this.active.binding;
    if (this.active) await this.deactivate();
    const activation = randomUUID();
    const release = await this.registry.holdActivation(activation);
    const active: Activation = {
      conversation,
      project,
      binding: {
        directory: this.directory,
        conversation: conversation.id,
        activation,
      },
      openedAt: this.state?.openedAt ?? Date.now(),
      accepting: false,
      publishing: true,
      release,
    };
    this.active = active;
    this.publish(emptySnapshot);
    try {
      await this.retireProject(active);
      const presence = this.presence(active);
      this.projected = JSON.stringify({ ...presence, updatedAt: undefined });
      await this.write(presence);
      if (this.ending || this.closed)
        throw new Error('Coordination is closing.');
      active.accepting = true;
      this.failures.delete('project');
      await this.inspect();
      return active.binding;
    } catch (error) {
      await this.deactivate().catch(() => {});
      throw error;
    }
  }

  async quiesce(): Promise<void> {
    if (this.active) this.active.accepting = false;
    await this.operations;
    await this.host.drain();
  }

  async deactivate(): Promise<void> {
    const active = this.active;
    if (!active) return;
    const quiescing = Promise.all([this.endTurn(), this.quiesce()]);
    active.publishing = false;
    clearTimeout(this.scheduled);
    this.scheduled = undefined;
    this.pending = undefined;
    let failure: unknown;
    try {
      await quiescing;
      await this.writing;
      const error = this.failures.get('presence');
      if (error) failure = new Error(error);
    } catch (error) {
      failure = error;
    }
    try {
      await this.registry.removePresence(
        active.conversation.id,
        active.binding.activation,
      );
    } catch (error) {
      failure ??= error;
    } finally {
      await active.release().catch((error: unknown) => {
        failure ??= error;
      });
      if (this.active === active) this.active = undefined;
      this.projected = undefined;
    }
    if (failure !== undefined) throw failure;
  }

  update(snapshot: Snapshot): void {
    this.state = snapshot;
    if (snapshot.phase === 'closing') {
      this.ending = true;
      if (this.active) this.active.accepting = false;
    }
    const active = this.active;
    if (
      this.closed ||
      !active?.publishing ||
      snapshot.conversation?.id !== active.conversation.id
    )
      return;
    const presence = this.presence(active);
    const projected = JSON.stringify({ ...presence, updatedAt: undefined });
    if (projected === this.projected) return;
    this.projected = projected;
    this.pending = presence;
    if (this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      const pending = this.pending;
      this.pending = undefined;
      if (pending && active.publishing && this.active === active)
        void this.write(pending);
    }, 100);
    this.scheduled.unref();
  }

  updateRepository(repository: Repository | undefined): void {
    this.branch = repository?.branch;
    if (this.state) this.update(this.state);
  }

  beginTurn(turn: string): void {
    const active = this.admit();
    this.turn = {
      owner: { conversation: active.conversation.id, project: active.project },
      activation: active.binding.activation,
      turn,
    };
  }

  endTurn(turn?: string): Promise<void> {
    this.revokeTurn(turn);
    return this.serialize(() => this.finishCleanup());
  }

  private revokeTurn(turn?: string): void {
    if (this.turn && (turn === undefined || this.turn.turn === turn)) {
      this.cancellations.set(this.turn.turn, this.turn);
      this.turn = undefined;
    }
  }

  /** drain releases before reactivation so a retry cannot remove a newer suggestion. */
  private async finishCleanup(): Promise<void> {
    try {
      for (const [id, scope] of this.cancellations) {
        await this.registry.cancelSelection(
          scope,
          undefined,
          Date.now() + 1000,
          async () => {},
        );
        this.cancellations.delete(id);
      }
      for (const conversation of this.suggestionReleases) {
        const claim = (await this.registry.claims()).find(
          (claim) =>
            claim.owner.conversation === conversation && claim.suggestion,
        );
        if (claim)
          await this.registry.releaseSuggestion(
            claim.owner,
            this.process,
            Date.now() + 1000,
            async () => {},
          );
        this.suggestionReleases.delete(conversation);
      }
      this.failures.delete('selection');
    } catch (error) {
      this.fail('selection', error);
      throw error;
    }
  }

  private maintain(): Promise<void> {
    if (
      this.closed ||
      (!this.cancellations.size && !this.suggestionReleases.size)
    )
      return Promise.resolve();
    this.maintaining ??= this.serialize(() => this.finishCleanup())
      .catch(() => {})
      .finally(() => {
        this.maintaining = undefined;
      });
    return this.maintaining;
  }

  releaseSuggestion(conversation: string): Promise<void> {
    this.suggestionReleases.add(conversation);
    return this.serialize(() => this.finishCleanup());
  }

  private async retireProject(active: Activation): Promise<void> {
    if (this.turn && this.turn.owner.project !== active.project)
      this.revokeTurn();
    await this.finishCleanup();
    const claim = (await this.registry.claims()).find(
      (claim) =>
        claim.owner.conversation === active.conversation.id &&
        claim.suggestion &&
        claim.owner.project !== active.project,
    );
    if (claim) {
      this.suggestionReleases.add(claim.owner.conversation);
      await this.finishCleanup();
    }
  }

  async context(): Promise<string> {
    const active = this.admit();
    try {
      await this.serialize(async () => {
        await this.refreshProject(active);
        await this.retireProject(active);
      });
    } catch {
      // the recorded error withholds new work while the agent can still explain or finish its existing task
    }
    const snapshot = await this.inspect();
    this.admit();
    return [
      'Session coordination:',
      JSON.stringify(snapshot),
      ...(snapshot.error
        ? [
            'Coordination is unavailable. Do not start new claimed work until a fresh query succeeds.',
          ]
        : []),
      `Control command: ${this.prefix(active.binding)}`,
      'Use --peers --json to inspect sessions; --claim <full GitHub issue/pr URL or task:name> --summary <work> --alias <related reference> to claim; --release <claim-id> to release. --alias is optional and repeatable.',
      ...(this.turn
        ? [
            `Selection turn: ${this.turn.turn}`,
            `When asked to choose the next task, run --select-next ${this.turn.turn} --json before triage. It waits automatically for your place. Do not claim a generic triage task, end the request because another session is choosing, or ask the user to repeat it.`,
            'After position 1 is granted, refresh issues, code and reservations. Reserve your recommendation with --recommend <reference> --selection <ticket-id> --summary <work> [--alias <reference>] before presenting it. A specific-task conflict keeps your place: choose another unreserved task. Other sessions may choose as soon as your recommendation is recorded.',
            'Keep the suggestion reserved while awaiting the user. When the user requests planning, investigation or implementation, use --claim on that reference to promote it. A different named task replaces your suggestion only if its claim succeeds. Another --select-next releases the old suggestion and joins the tail. Cancel with --cancel-selection <ticket-id> when redirected or when no suitable work remains. Do not infer permission from a failed or timed-out command; query peers to reconcile its result.',
          ]
        : []),
      'Before starting a new task, query the other sessions and claim its reference. For unnumbered work, compare existing task summaries and reuse a matching reference. A conflict means stop that task and report its owner; do not rename the task to get around the conflict. Keep the summary current, pass this ownership context to delegated workers, and release only after the task and its delegated work have ended. Refresh before changing scope, including after a steered request.',
    ].join('\n');
  }

  async releaseTask(): Promise<void> {
    const active = this.admit();
    this.canRelease(true);
    const claim = (await this.registry.claims()).find(
      (entry) => entry.owner.conversation === active.conversation.id,
    );
    if (!claim) return;
    await this.handle(
      {
        id: randomUUID(),
        version: 1,
        conversation: active.conversation.id,
        activation: active.binding.activation,
        deadline: Date.now() + 10_000,
        action: { kind: 'release', claim: claim.id },
      },
      true,
    );
  }

  async close(options: { restart?: boolean } = {}): Promise<void> {
    this.ending = true;
    this.closed = true;
    clearInterval(this.timer);
    try {
      try {
        await this.deactivate();
      } finally {
        if (!options.restart && this.state?.conversation)
          await this.releaseSuggestion(this.state.conversation.id);
      }
    } finally {
      await this.host.close();
      await this.refreshing?.promise;
    }
  }

  private presence(active: Activation): SessionPresence {
    const state = this.state;
    return {
      ...conversationSummarySchema.parse(active.conversation),
      version: 1,
      selectionQueue: 1,
      project: active.project,
      activation: active.binding.activation,
      process: this.process,
      phase: state?.phase ?? 'starting',
      requests: state?.requests.length ?? 0,
      familiars:
        state?.subagents.filter((entry) => entry.status === 'running').length ??
        0,
      brews: state?.backgroundCommands.length ?? 0,
      ...(this.branch ? { branch: this.branch } : {}),
      openedAt: active.openedAt,
      updatedAt: Date.now(),
    };
  }

  private write(presence: SessionPresence): Promise<void> {
    const written = this.writing.then(() => this.registry.publish(presence));
    this.writing = written.then(
      () => {
        this.failures.delete('presence');
        this.publish(this.snapshot);
      },
      (error: unknown) => this.fail('presence', error),
    );
    return written;
  }

  private admit(request?: ControlRequest): Activation {
    const active = this.active;
    if (
      !active?.accepting ||
      this.ending ||
      this.closed ||
      (request &&
        (request.conversation !== active.conversation.id ||
          request.activation !== active.binding.activation))
    )
      throw new Error(
        'This control activation is no longer current. Use the prefix from the current Witch context.',
      );
    if (request) checkDeadline(request.deadline);
    return active;
  }

  private canRelease(human: boolean): void {
    if (human && (this.state?.phase !== 'idle' || this.state.recovery))
      throw new Error(
        'Wait for idle and resolve memory recovery before releasing the task.',
      );
    if (
      this.state?.subagents.some((entry) => entry.status === 'running') ||
      this.state?.backgroundCommands.length
    )
      throw new Error(
        'Stop the running familiars and brews before releasing the task.',
      );
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.operations.then(work);
    this.operations = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  private handle(
    request: ControlRequest,
    human = false,
  ): Promise<ControlOutcome> {
    this.failures.delete('control');
    return this.serialize(() => this.dispatch(request, human));
  }

  private selectionScope(active: Activation, turn?: string): SelectionScope {
    const scope = this.turn;
    if (
      !scope ||
      scope.activation !== active.binding.activation ||
      scope.owner.project !== active.project ||
      (turn !== undefined && scope.turn !== turn)
    )
      throw new Error('This selection turn is no longer current.');
    return scope;
  }

  private async dispatch(
    request: ControlRequest,
    human: boolean,
  ): Promise<ControlOutcome> {
    const active = this.admit(request);
    try {
      const action = request.action;
      if (action.kind === 'peers') {
        const snapshot = await this.inspect();
        if (snapshot.error) throw new Error(snapshot.error);
        return { kind: 'peers', snapshot };
      }
      if (action.kind === 'release') {
        const claim = (await this.registry.claims()).find(
          (entry) => entry.id === action.claim,
        );
        await this.registry.release(
          {
            conversation: active.conversation.id,
            project: claim?.owner.project ?? active.project,
          },
          action.claim,
          request.deadline,
          async () => {
            this.admit(request);
            this.canRelease(human);
          },
        );
        return { kind: 'released' };
      }
      await this.refreshProject(active);
      await this.retireProject(active);
      const owner = {
        conversation: active.conversation.id,
        project: active.project,
      };
      const scope =
        action.kind === 'claim'
          ? undefined
          : this.selectionScope(
              active,
              action.kind === 'select-next' ? action.turn : undefined,
            );
      const verify = async () => {
        await this.refreshProject(active);
        const snapshot = await this.discover(active, active.project);
        this.admit(request);
        if (owner.project !== active.project)
          throw new Error(
            'The project changed. Query peers before claiming again.',
          );
        if (scope && this.selectionScope(active) !== scope)
          throw new Error('This selection turn is no longer current.');
        if (this.failures.get('presence'))
          throw new Error(this.failures.get('presence'));
        if (snapshot.unregistered.length)
          throw new Error(
            `Restart or close these unregistered Witch sessions before claiming: ${snapshot.unregistered.map((entry) => `${entry.title} (${entry.id}, ${entry.cwd})`).join('; ')}`,
          );
        if (
          snapshot.ownClaim &&
          snapshot.ownClaim.owner.project !== active.project
        )
          throw new Error(
            'Release the existing task in its original project before claiming in this project.',
          );
        if (action.kind === 'select-next') {
          const older = snapshot.peers.filter(
            (peer) => !peer.presence.selectionQueue,
          );
          if (older.length)
            throw new Error(
              `Restart or close these Witch sessions before selecting: ${older.map((peer) => `${peer.presence.title} (${peer.presence.id})`).join('; ')}`,
            );
        }
        if (
          action.kind === 'select-next' ||
          action.kind === 'recommend' ||
          (action.kind === 'claim' && snapshot.ownSelection)
        )
          this.canRelease(false);
      };
      if (action.kind === 'claim')
        return {
          kind: 'claimed',
          claim: await this.registry.claim(
            owner,
            action.input,
            request.deadline,
            verify,
          ),
        };
      if (action.kind === 'recommend')
        return {
          kind: 'claimed',
          claim: await this.registry.recommend(
            scope!,
            action.selection,
            action.input,
            this.process,
            request.deadline,
            verify,
          ),
        };
      if (action.kind === 'cancel-selection') {
        await this.registry.cancelSelection(
          scope!,
          action.selection,
          request.deadline,
          verify,
        );
        return { kind: 'selection-cancelled', selection: action.selection };
      }
      const selection =
        action.kind === 'select-next'
          ? await this.registry.beginSelection(scope!, request.deadline, verify)
          : await this.registry.selection(
              scope!,
              action.selection,
              request.deadline,
              verify,
            );
      return { kind: 'selection', selection, snapshot: await this.inspect() };
    } catch (error) {
      if (!(error instanceof ClaimConflict)) throw error;
      const owner = (await this.store.records()).records.find(
        (entry) => entry.id === error.claim.owner.conversation,
      );
      return {
        kind: 'conflict',
        claim: error.claim,
        message: error.message,
        ...(owner ? { owner: conversationSummarySchema.parse(owner) } : {}),
      };
    } finally {
      await this.retireProject(active);
      await this.inspect();
    }
  }

  private async refreshProject(active: Activation): Promise<void> {
    try {
      const { project } = await this.memory.scopePaths(active.conversation.cwd);
      active.project = project;
      if (this.turn && this.turn.owner.project !== project) this.revokeTurn();
      this.failures.delete('project');
      if (this.state) this.update(this.state);
    } catch (error) {
      this.fail('project', error);
      throw error;
    }
  }

  private async inspect(): Promise<CoordinationSnapshot> {
    await this.refreshing?.promise;
    await this.refresh();
    return this.snapshot;
  }

  private refresh(): Promise<void> {
    const active = this.active;
    if (!active?.publishing || this.closed) return Promise.resolve();
    const project = active.project;
    if (this.refreshing)
      return this.refreshing.active === active &&
        this.refreshing.project === project
        ? this.refreshing.promise
        : this.refreshing.promise.then(() => this.refresh());
    const promise = this.discover(active, project)
      .then(
        (snapshot) => {
          if (
            this.active !== active ||
            active.project !== project ||
            !active.publishing ||
            this.closed
          )
            return;
          this.failures.delete('discovery');
          this.publish(snapshot);
        },
        (error: unknown) => {
          if (
            this.active === active &&
            active.project === project &&
            active.publishing
          )
            this.fail('discovery', error);
        },
      )
      .finally(() => {
        this.refreshing = undefined;
      });
    this.refreshing = { active, project, promise };
    return promise;
  }

  private async discover(
    active: Activation,
    project: string,
  ): Promise<CoordinationSnapshot> {
    const [{ claims, selections }, presences, { records, unreadable }] =
      await Promise.all([
        this.registry.state(),
        this.registry.presences(),
        this.store.records(),
      ]);
    if (unreadable.length)
      throw new Error(
        `Cannot determine session ownership: ${unreadable.map((entry) => entry.file).join(', ')}`,
      );
    const opened = new Set<string>();
    const live = new Map<string, SessionPresence>();
    const unregistered: CoordinationSnapshot['unregistered'] = [];
    const processes = new Map<number, Promise<ProcessIdentity | undefined>>();
    for (const record of records) {
      if (!(await this.store.isOpen(record.id))) continue;
      opened.add(record.id);
      const presence = presences.find((entry) => entry.id === record.id);
      if (
        presence &&
        presence.cwd === record.cwd &&
        (await this.registry.isActive(presence.activation))
      ) {
        let process = processes.get(presence.process.pid);
        if (!process) {
          process = identifyProcess(presence.process.pid);
          processes.set(presence.process.pid, process);
        }
        if ((await process)?.started === presence.process.started) {
          live.set(record.id, presence);
          continue;
        }
      }
      if ((await this.memory.scopePaths(record.cwd)).project === project)
        unregistered.push(conversationSummarySchema.parse(record));
    }
    const positions = selectionStates(selections);
    const ownSelection = positions.find(
      (state) => state.ticket.owner.conversation === active.conversation.id,
    );
    const ownClaim = claims.find(
      (claim) => claim.owner.conversation === active.conversation.id,
    );
    const projectClaims = claims.filter(
      (claim) =>
        claim.owner.project === project &&
        claim.owner.conversation !== active.conversation.id,
    );
    const peers = [...live.values()]
      .filter(
        (presence) =>
          presence.project === project &&
          presence.id !== active.conversation.id,
      )
      .sort((a, b) => a.openedAt - b.openedAt || a.id.localeCompare(b.id))
      .map((presence) => ({
        presence,
        selection: positions.find(
          (state) => state.ticket.owner.conversation === presence.id,
        ),
        claim: projectClaims.find(
          (claim) => claim.owner.conversation === presence.id,
        ),
      }));
    const reservations: CoordinationSnapshot['reservations'] =
      projectClaims.flatMap((claim) => {
        const presence = live.get(claim.owner.conversation);
        if (presence?.project === project) return [];
        return [
          {
            claim,
            status: presence
              ? 'owner-outside-project'
              : opened.has(claim.owner.conversation)
                ? 'unknown'
                : 'unattended',
          },
        ];
      });
    return { peers, ownClaim, ownSelection, reservations, unregistered };
  }

  private fail(source: string, error: unknown): void {
    this.failures.set(source, errorMessage(error));
    this.publish(this.snapshot);
  }

  private publish(snapshot: CoordinationSnapshot): void {
    if (this.closed) return;
    const next = {
      ...snapshot,
      error: [...this.failures.values()].join('\n') || undefined,
    };
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
