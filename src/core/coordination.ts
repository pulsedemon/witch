import { isFamiliarAction } from '../agents/familiar-report.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentSession } from '../agents/types.js';
import { errorMessage } from '../agents/stderr.js';
import type { Memory } from '../memory/memory.js';
import {
  ClaimConflict,
  CoordinationStore,
  checkDeadline,
} from '../persistence/coordination.js';
import type { Ledger } from '../persistence/coordination.js';
import { ControlHost } from '../persistence/control.js';
import type {
  ControlBinding,
  ControlOutcome,
  ControlRequest,
} from '../persistence/control.js';
import { identifyProcess, sameProcess } from '../persistence/process.js';
import type { StateStore } from '../persistence/store.js';
import {
  conversationSummarySchema,
  taskActivity,
  type CoordinationSnapshot,
  type SessionPresence,
  type SelectionScope,
  type TransferTarget,
} from './coordination-state.js';
import type { Reviewers } from './reviewers.js';
import type { router } from './router.js';
import type { Snapshot } from './snapshot.js';
import {
  coordinationContext,
  coordinationInstructions,
} from './coordination-policy.js';
import { configStamp, discover, projectDiscovery } from './discovery.js';
import {
  awaitTransfer,
  movedNotices,
  takeReference,
  transferRefusal,
  TransferUnavailable,
} from './task-transfer.js';
import type { Discovery } from './discovery.js';
import { assignGitHubTask } from './github-assignment.js';
import type { Repository } from './repository.js';
import { ConversationEvents } from './conversation-events.js';
import { checkAnswering, isPeerAction, peerOutcome } from './peer-requests.js';
import type { PeerRequest } from './peer-requests.js';
import type { PeerAnswer } from './peer-answers.js';
import type { Conversation, ProcessIdentity } from './state.js';

interface Activation {
  conversation: Conversation;
  project: string;
  binding: ControlBinding;
  openedAt: number;
  accepting: boolean;
  publishing: boolean;
  release(): Promise<void>;
  /** the repository's Git config, shared by its linked worktrees, unset outside a repository. a global `insteadOf` rewrite of the origin and a local origin's own config are not stamped. */
  config?: string;
  /** the config's stamp when the tick last queued a project read. */
  configured?: string;
  /** that read is queued or running. */
  rescoping?: boolean;
  /** the coordination signature when the tick last refreshed. */
  observed?: string;
  /** when the tick last refreshed, from `performance.now()`. */
  rereadAt?: number;
}

/** lock holders and process exits change no file, so the tick rereads them this often. */
const rereadInterval = 60_000;

interface LedgerView {
  revision: number;
  ledger: Ledger;
}

interface RequestState {
  deadline?: number;
  ledger?: LedgerView;
  discovery?: { revision: number; promise: Promise<Discovery> };
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
  private repository?: Repository;
  readonly events: ConversationEvents;
  private host!: ControlHost;
  private familiarHost!: ControlHost;
  private live?: () => AgentSession | undefined;
  /** answers `--route` outside the serialized claim queue, so background claim work doesn't delay it. */
  router?: ReturnType<typeof router>;
  ownFamiliars?: Reviewers['report'];
  private timer?: ReturnType<typeof setInterval>;
  private scheduled?: ReturnType<typeof setTimeout>;
  private pending?: SessionPresence;
  private projected?: SessionPresence;
  private writing: Promise<void> = Promise.resolve();
  private retrying?: Promise<void>;
  private operations: Promise<void> = Promise.resolve();
  private refreshing?: {
    active: Activation;
    project: string;
    promise: Promise<void>;
  };
  /** project reads run one at a time, so their results land in start order. */
  private projecting?: { promise: Promise<void>; cancel(): void };
  /** counts publications of a view with a ledger. */
  private published = 0;
  private revision = 0;
  private mutationRevision = 0;
  private ledgerObservation = 0;
  private discoveryFailure = 0;
  private view?: {
    active: Activation;
    project: string;
    discovery: Discovery;
  };
  private ledger?: LedgerView;
  private failures = new Map<string, string>();
  private turn?: SelectionScope;
  private cancellations = new Map<string, SelectionScope>();
  private claimReleases = new Set<string>();
  private maintaining?: Promise<void>;
  private handing?: Promise<void>;
  private ending = false;
  private closed = false;

  private constructor(
    private readonly store: StateStore,
    private readonly memory: Memory,
    private readonly registry: CoordinationStore,
    private readonly directory: string,
    private readonly prefix: (binding: ControlBinding) => string,
    private readonly process: ProcessIdentity,
    private readonly assign: typeof assignGitHubTask,
  ) {
    this.events = new ConversationEvents(
      registry,
      {
        scope: () =>
          this.active && {
            conversation: this.active.conversation.id,
            project: this.active.project,
          },
        claims: () => this.ledger?.ledger.claims ?? [],
        fail: (source, error) => this.fail(source, error),
        read: (sources, notify) => {
          for (const source of sources) this.failures.delete(source);
          if (sources.includes('peer-requests'))
            this.failures.delete('peer-admission');
          this.publish(this.snapshot);
          if (notify) for (const listener of this.listeners) listener();
        },
      },
      {
        closed: () => this.closed,
        serialize: (work) => this.serialize(work),
        recipients: async (project, source) => {
          const active = this.active;
          if (active?.conversation.id === source)
            await this.refreshProject(active);
          const discovery = await this.discover(++this.revision);
          const recipients = await Promise.all(
            discovery.records.map(async (record) => {
              const scope = await this.memory.scopePaths(record.cwd);
              return scope.project === project ? record.id : undefined;
            }),
          );
          return recipients.filter((id) => id !== undefined);
        },
        refresh: () => this.refreshEvents(),
      },
    );
  }

  static async open(
    store: StateStore,
    memory: Memory,
    directory: string,
    prefix: (binding: ControlBinding) => string,
    assign: typeof assignGitHubTask = assignGitHubTask,
  ): Promise<SessionCoordination> {
    const identity = await identifyProcess(process.pid);
    if (!identity) throw new Error('Witch process identity is unavailable.');
    const coordination = new SessionCoordination(
      store,
      memory,
      await CoordinationStore.open(store),
      directory,
      prefix,
      identity,
      assign,
    );
    coordination.host = await ControlHost.open(
      directory,
      (request) => coordination.handle(request),
      (error) => coordination.fail('control', error),
    );
    try {
      coordination.familiarHost = await ControlHost.open(
        join(directory, 'familiars'),
        async (request) => {
          coordination.admit(request);
          const { action } = request;
          if (!isFamiliarAction(action))
            throw new Error('Use the task control mailbox for this action.');
          const owned = coordination.ownFamiliars?.(action);
          if (owned) return owned;
          const familiar = coordination.live?.()?.familiar;
          if (!familiar)
            throw new Error('This runtime cannot report delegated familiars.');
          return familiar.report(action, request.deadline);
        },
        (error) => coordination.fail('control', error),
      );
    } catch (error) {
      await coordination.host.close();
      throw error;
    }
    coordination.timer = setInterval(() => coordination.tick(), 2000);
    coordination.timer.unref();
    return coordination;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** the conversation's live session, which receives its familiars' reports; `undefined` once it closes. */
  attach(live: (() => AgentSession | undefined) | undefined): void {
    this.live = live;
  }

  familiarBinding(): ControlBinding {
    return { ...this.admit().binding, directory: this.familiarHost.directory };
  }

  commandPrefixes() {
    return {
      control: this.prefix(this.admit().binding),
      familiar: this.prefix(this.familiarBinding()),
    };
  }

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
    const config = await this.memory
      .configPath(conversation.cwd)
      .catch(() => undefined);
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
      config,
    };
    this.active = active;
    this.view = undefined;
    this.ledger = undefined;
    this.publish(emptySnapshot);
    try {
      for (const claim of await this.registry.claims()) {
        if (claim.owner.conversation === conversation.id && !claim.process)
          await this.registry.adoptClaim(
            claim.owner,
            this.process,
            Date.now() + 1000,
            async () => {
              if (this.ending || this.closed || this.active !== active)
                throw new Error('Coordination is closing.');
            },
          );
        // restart must recover releases for conversations this process has already left.
        if (
          claim.owner.conversation !== conversation.id &&
          sameProcess(claim.process, this.process) &&
          !(await this.store.isOpen(claim.owner.conversation))
        )
          this.claimReleases.add(claim.owner.conversation);
      }
      await this.retireProject(active);
      const presence = this.presence(active);
      this.projected = presence;
      await this.write(presence);
      if (this.ending || this.closed)
        throw new Error('Coordination is closing.');
      active.accepting = true;
      this.failures.delete('project');
      this.updateRepository(this.repository);
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
    await this.familiarHost.drain();
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
    const projected = this.projected;
    const keys = Object.keys(presence) as (keyof SessionPresence)[];
    if (
      projected &&
      keys.length === Object.keys(projected).length &&
      keys.every(
        (key) =>
          key === 'updatedAt' ||
          (Object.hasOwn(projected, key) && presence[key] === projected[key]),
      )
    )
      return;
    this.projected = presence;
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
    this.repository = repository;
    this.branch = repository?.branch;
    if (this.state) this.update(this.state);
    const active = this.active;
    const pullRequest = repository?.pullRequest;
    if (
      !active?.accepting ||
      pullRequest?.state !== 'MERGED' ||
      repository!.branch !== pullRequest.branch ||
      repository!.pullRequestProject === undefined
    )
      return;
    this.events.observeMerge(
      repository!.pullRequestProject,
      active.conversation.id,
      pullRequest,
    );
  }

  /** stamps the active conversation's answerable requests for one answer turn; a failure records itself and admits none. */
  async beginAnswer(): Promise<PeerRequest[]> {
    try {
      return await this.serialize(async () => {
        const active = this.admit();
        const scope = {
          conversation: active.conversation.id,
          project: active.project,
        };
        const current = () =>
          this.active === active && active.project === scope.project;
        const { attempted, requests } = await this.change(
          undefined,
          (verify) =>
            this.registry.attemptPeerRequests(
              scope.project,
              scope.conversation,
              Date.now() + 1000,
              verify,
            ),
          async () => {
            this.admit();
            if (!current())
              throw new Error(
                'The conversation changed before its peer requests were admitted.',
              );
          },
        );
        if (current()) this.events.recordRequests(scope, requests);
        return attempted;
      });
    } catch (error) {
      this.fail('peer-admission', error);
      return [];
    }
  }

  answerPeers(answers: readonly PeerAnswer[]): Promise<void> {
    return this.serialize(async () => {
      const active = this.admit();
      await this.registry.answerPeers(
        active.conversation.id,
        answers,
        Date.now() + 1000,
        true,
      );
      await this.refreshEvents();
    });
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

  /** drain releases before reactivation so a retry cannot remove a newer claim. */
  private async finishCleanup(state?: RequestState): Promise<void> {
    try {
      for (const [id, scope] of this.cancellations) {
        await this.change(state, (verify) =>
          this.registry.cancelSelection(
            scope,
            undefined,
            state?.deadline ?? Date.now() + 1000,
            verify,
          ),
        );
        this.cancellations.delete(id);
      }
      for (const conversation of this.claimReleases) {
        const claim = (await this.readLedger(state)).ledger.claims.find(
          (claim) => claim.owner.conversation === conversation,
        );
        if (claim)
          await this.change(state, (verify) =>
            this.registry.releaseConversation(
              claim.owner,
              this.process,
              state?.deadline ?? Date.now() + 1000,
              verify,
            ),
          );
        this.claimReleases.delete(conversation);
      }
      this.failures.delete('selection');
    } catch (error) {
      this.fail('selection', error);
      throw error;
    }
  }

  private maintain(): Promise<void> {
    if (this.closed || (!this.cancellations.size && !this.claimReleases.size))
      return Promise.resolve();
    this.maintaining ??= this.serialize(() => this.finishCleanup())
      .catch(() => {})
      .finally(() => {
        this.maintaining = undefined;
      });
    return this.maintaining;
  }

  releaseConversation(conversation: string): Promise<void> {
    this.claimReleases.add(conversation);
    return this.serialize(() => this.finishCleanup());
  }

  private async retireProject(
    active: Activation,
    state?: RequestState,
  ): Promise<void> {
    if (this.turn && this.turn.owner.project !== active.project)
      this.revokeTurn();
    await this.finishCleanup(state);
    const claim = (await this.readLedger(state)).ledger.claims.find(
      (claim) =>
        claim.owner.conversation === active.conversation.id &&
        claim.suggestion &&
        claim.owner.project !== active.project,
    );
    if (claim) {
      this.claimReleases.add(claim.owner.conversation);
      await this.finishCleanup(state);
    }
  }

  async context(): Promise<{
    instructions: string;
    context: string;
    snapshot: CoordinationSnapshot;
  }> {
    const active = this.admit();
    let moved: string[] = [];
    try {
      await this.serialize(async () => {
        await this.refreshProject(active);
        const state: RequestState = {};
        await this.retireProject(active, state);
        moved = movedNotices(
          (await this.readLedger(state)).ledger,
          active.conversation.id,
        );
      });
    } catch {
      // the recorded error withholds new work while the agent can still explain or finish its existing task
    }
    const snapshot = await this.inspect();
    this.admit();
    const context = coordinationContext(snapshot, moved, this.turn?.turn);
    const instructions = coordinationInstructions(
      snapshot,
      this.commandPrefixes().control,
    );
    return { instructions, context, snapshot };
  }

  async releaseTask(): Promise<void> {
    const active = this.admit();
    this.canRelease(true);
    this.failures.delete('control');
    await this.serialize(async () => {
      const state: RequestState = {};
      const claim = (await this.readLedger(state)).ledger.claims.find(
        (entry) => entry.owner.conversation === active.conversation.id,
      );
      if (!claim) return;
      await this.dispatch(
        {
          id: randomUUID(),
          version: 1,
          conversation: active.conversation.id,
          activation: active.binding.activation,
          deadline: Date.now() + 10_000,
          action: { kind: 'release', claim: claim.id },
        },
        true,
        state,
      );
    });
  }

  async takeTask(reference: string, timeout = 10_000): Promise<void> {
    const active = this.admit();
    if (this.state?.phase !== 'idle' || this.state.recovery)
      throw new Error(
        'Wait for idle and resolve memory recovery before taking a task.',
      );
    this.failures.delete('control');
    await this.serialize(() =>
      this.dispatch(
        {
          id: randomUUID(),
          version: 1,
          conversation: active.conversation.id,
          activation: active.binding.activation,
          deadline: Date.now() + timeout,
          action: { kind: 'take', input: { reference } },
        },
        true,
      ),
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
          await this.releaseConversation(this.state.conversation.id);
      }
    } finally {
      await Promise.all([this.host.close(), this.familiarHost.close()]);
      await Promise.all([
        this.refreshing?.promise,
        this.events.pending,
        this.projecting?.promise,
      ]);
    }
  }

  private presence(active: Activation): SessionPresence {
    const state = this.state;
    const { familiars, brews } = taskActivity(state);
    const { id, title, cwd, agent } = active.conversation;
    return {
      id,
      title,
      cwd,
      agent,
      version: 1,
      selectionQueue: 1,
      peerRequests: 1,
      project: active.project,
      activation: active.binding.activation,
      process: this.process,
      phase:
        state?.phase === 'compacting'
          ? 'running'
          : (state?.phase ?? 'starting'),
      requests: state?.requests.length ?? 0,
      familiars,
      brews,
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

  private retryPresence(): Promise<void> {
    if (this.closed || !this.failures.has('presence')) return Promise.resolve();
    const active = this.active;
    const writing = this.writing;
    this.retrying ??= writing
      .then(async () => {
        if (
          this.closed ||
          this.ending ||
          !active?.accepting ||
          !active.publishing ||
          this.active !== active ||
          this.scheduled ||
          this.writing !== writing ||
          !this.failures.has('presence')
        )
          return;
        await this.write(this.presence(active));
      })
      .catch(() => {})
      .finally(() => {
        this.retrying = undefined;
      });
    return this.retrying;
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
    if (taskActivity(this.state).running)
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

  private async readLedger(state?: RequestState): Promise<LedgerView> {
    if (state?.ledger) return state.ledger;
    const active = this.active;
    const project = active?.project;
    let revision = 0;
    const accept = () => {
      if (
        this.active !== active ||
        active?.project !== project ||
        !active?.publishing ||
        this.closed
      )
        return false;
      // lock acquisition failures have no locked observation.
      const observed = revision || ++this.revision;
      if (observed <= this.ledgerObservation) return false;
      this.ledgerObservation = observed;
      return true;
    };
    try {
      const ledger = await this.registry.state(
        state?.deadline ?? Date.now() + 1000,
        () => {
          revision = ++this.revision;
        },
      );
      if (accept()) {
        this.failures.delete('ledger');
        if (active) this.answer(active, ledger);
      }
      const value = { revision, ledger };
      if (state) state.ledger = value;
      return value;
    } catch (error) {
      if (accept()) this.fail('ledger', error);
      throw error;
    }
  }

  private async change<T>(
    state: RequestState | undefined,
    work: (verify: (ledger: Ledger) => Promise<void>) => Promise<T>,
    verify: (ledger: Ledger) => Promise<void> = async () => {},
  ): Promise<T> {
    let committed: LedgerView | undefined;
    try {
      const result = await work(async (value) => {
        // ledger reads after this revision wait for the transaction to release its lock.
        this.mutationRevision = this.ledgerObservation = ++this.revision;
        this.failures.delete('ledger');
        committed = { revision: this.mutationRevision, ledger: value };
        await verify(value);
      });
      if (committed) {
        if (!this.ledger || committed.revision > this.ledger.revision)
          this.ledger = committed;
        if (state) state.ledger = this.ledger;
      }
      return result;
    } catch (error) {
      if (state) state.ledger = undefined;
      throw error;
    }
  }

  private observe(state: RequestState): Promise<Discovery> {
    if (!state.discovery) {
      const revision = ++this.revision;
      state.discovery = {
        revision,
        promise: this.discover(revision, state.deadline),
      };
    }
    return state.discovery.promise;
  }

  private async requestSnapshot(
    active: Activation,
    state: RequestState,
  ): Promise<CoordinationSnapshot> {
    const discovery = this.observe(state).catch((error: unknown) => {
      this.failDiscovery(error, state.discovery!.revision);
      throw error;
    });
    const [ledger, observed] = await Promise.all([
      this.readLedger(state),
      discovery,
    ]);
    return this.updateView(active, active.project, observed, ledger);
  }

  private updateView(
    active: Activation,
    project: string,
    discovery: Discovery,
    ledger?: LedgerView,
  ): CoordinationSnapshot {
    if (
      this.active !== active ||
      active.project !== project ||
      !active.publishing ||
      this.closed
    )
      return this.snapshot;
    const previous =
      this.view?.active === active && this.view.project === project
        ? this.view
        : undefined;
    this.view = {
      active,
      project,
      discovery:
        previous && previous.discovery.revision > discovery.revision
          ? previous.discovery
          : discovery,
    };
    // an invalidated ledger could erase a committed claim.
    if (!ledger) return this.snapshot;
    if (!this.ledger || ledger.revision > this.ledger.revision)
      this.ledger = ledger;
    if (this.view.discovery.revision > this.discoveryFailure)
      this.failures.delete('discovery');
    this.published++;
    this.publish(
      projectDiscovery(
        active.conversation.id,
        project,
        this.view.discovery,
        this.ledger.ledger,
      ),
    );
    return this.snapshot;
  }

  private handle(
    request: ControlRequest,
    human = false,
  ): Promise<ControlOutcome> {
    if (isFamiliarAction(request.action))
      return Promise.resolve({
        kind: 'error',
        message: 'Use the familiar reporting mailbox for this action.',
      });
    this.failures.delete('control');
    if (request.action.kind === 'route') {
      this.admit(request);
      if (!this.router) throw new Error('This Witch cannot route work.');
      return this.router(request.action);
    }
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
    state: RequestState = {},
  ): Promise<ControlOutcome> {
    const active = this.admit(request);
    state.deadline = request.deadline;
    let outcome: ControlOutcome | undefined;
    try {
      const action = request.action;
      if (isFamiliarAction(action) || action.kind === 'route')
        throw new Error('This action is answered before dispatch.');
      checkAnswering(this.state?.answering, action);
      if (action.kind === 'peers') {
        const snapshot = await this.requestSnapshot(active, state);
        if (snapshot.error) throw new Error(snapshot.error);
        return (outcome = { kind: 'peers', snapshot });
      }
      if (action.kind === 'take' && !human)
        throw new Error(
          'Only the user can request an unconditional transfer. Use --claim to request a transfer when the owner is out of usage.',
        );
      if (action.kind === 'release') {
        const claim = (await this.readLedger(state)).ledger.claims.find(
          (entry) => entry.id === action.claim,
        );
        await this.change(
          state,
          (verify) =>
            this.registry.release(
              {
                conversation: active.conversation.id,
                project: claim?.owner.project ?? active.project,
              },
              action.claim,
              request.deadline,
              verify,
            ),
          async () => {
            this.admit(request);
            this.canRelease(human);
          },
        );
        return { kind: 'released' };
      }
      await this.refreshProject(active, request.deadline);
      await this.retireProject(active, state);
      const owner = {
        conversation: active.conversation.id,
        project: active.project,
      };
      if (isPeerAction(action))
        return await peerOutcome(action, {
          registry: this.registry,
          owner,
          deadline: request.deadline,
          change: (work, verify) => this.change(state, work, verify),
          peers: async (ledger) => {
            this.admit(request);
            return projectDiscovery(
              active.conversation.id,
              active.project,
              await this.observe(state),
              ledger,
            ).peers;
          },
          claims: async () => (await this.readLedger(state)).ledger.claims,
        });
      const scope =
        action.kind === 'claim' || action.kind === 'take'
          ? undefined
          : this.selectionScope(
              active,
              action.kind === 'select-next' ? action.turn : undefined,
            );
      const verify = async (ledger: Ledger) => {
        await this.refreshProject(active, request.deadline);
        const snapshot = projectDiscovery(
          active.conversation.id,
          active.project,
          await this.observe(state),
          ledger,
        );
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
      if (action.kind === 'claim' || action.kind === 'take') {
        const transfer = async (target: TransferTarget) => {
          const { activation } = active.binding;
          const { claim, view } = await awaitTransfer({
            conversation: owner.conversation,
            activation,
            reference: action.input.reference,
            field: target.field,
            deadline: request.deadline,
            request: (expires) =>
              this.change(
                state,
                (check) =>
                  this.registry.requestTransfer(
                    owner,
                    target,
                    { activation, process: this.process, expires },
                    request.deadline,
                    check,
                  ),
                verify,
              ),
            title: async (id) => (await this.record(id))?.title,
            admit: () => this.admit(),
            read: (deadline) => this.readLedger({ deadline }),
            withdraw: (id) => {
              state.ledger = undefined;
              return this.change(state, (check) =>
                this.registry.withdrawTransfer(
                  activation,
                  id,
                  Date.now() + 1000,
                  check,
                  target.field,
                ),
              );
            },
          });
          state.ledger = view;
          return { kind: 'claimed' as const, claim };
        };
        if (action.kind === 'take')
          return await transfer({ field: 'transfer', ...action.input });
        let claim;
        try {
          claim = await this.change(
            state,
            (check) =>
              this.registry.claim(
                owner,
                action.input,
                this.process,
                request.deadline,
                check,
              ),
            verify,
          );
        } catch (error) {
          if (!(error instanceof ClaimConflict) || error.claim.suggestion)
            throw error;
          return await transfer({
            field: 'automaticTransfer',
            claim: error.claim,
          });
        }
        const { assigned, failure } = await this.assign(
          claim.references.filter(
            (reference) => !claim.assigned?.includes(reference),
          ),
          active.conversation.cwd,
          // leave a second to record the assignment and another to refresh peers and write the control reply.
          request.deadline - 2000,
        );
        let recorded = claim;
        if (assigned.length)
          try {
            recorded =
              (await this.change(state, (check) =>
                this.registry.recordAssignment(
                  claim.id,
                  assigned,
                  request.deadline - 1000,
                  check,
                ),
              )) ?? claim;
          } catch {
            // an unrecorded assignment repeats on the next --claim.
          }
        return {
          kind: 'claimed',
          claim: recorded,
          ...(failure
            ? {
                warning: `GitHub assignment failed. The local claim is retained; repeat --claim to retry. ${failure}`,
              }
            : {}),
        };
      }
      if (action.kind === 'recommend')
        return {
          kind: 'claimed',
          claim: await this.change(
            state,
            (check) =>
              this.registry.recommend(
                scope!,
                action.selection,
                action.input,
                this.process,
                request.deadline,
                check,
              ),
            verify,
          ),
        };
      if (action.kind === 'cancel-selection') {
        await this.change(
          state,
          (check) =>
            this.registry.cancelSelection(
              scope!,
              action.selection,
              request.deadline,
              check,
            ),
          verify,
        );
        return { kind: 'selection-cancelled', selection: action.selection };
      }
      const selection = await this.change(
        state,
        (check) =>
          action.kind === 'select-next'
            ? this.registry.beginSelection(scope!, request.deadline, check)
            : this.registry.selection(
                scope!,
                action.selection,
                request.deadline,
                check,
              ),
        verify,
      );
      return (outcome = {
        kind: 'selection',
        selection,
        snapshot: await this.requestSnapshot(active, state),
      });
    } catch (error) {
      const conflict =
        request.action.kind === 'claim' &&
        error instanceof TransferUnavailable &&
        error.claim
          ? new ClaimConflict(error.claim)
          : error;
      if (!(conflict instanceof ClaimConflict)) throw error;
      const owner = await this.record(conflict.claim.owner.conversation);
      return {
        kind: 'conflict',
        claim: conflict.claim,
        message:
          request.action.kind === 'claim'
            ? `${conflict.message} The user can move it here with /task take ${takeReference(request.action.input, conflict.claim, active.project)} once its owner is idle.`
            : conflict.message,
        ...(owner ? { owner: conversationSummarySchema.parse(owner) } : {}),
      };
    } finally {
      await this.retireProject(active, state).catch((error: unknown) =>
        this.fail('selection', error),
      );
      await this.requestSnapshot(active, state).then(
        (snapshot) => {
          if (outcome?.kind === 'peers' || outcome?.kind === 'selection')
            outcome.snapshot = snapshot;
        },
        () => {},
      );
    }
  }

  private async record(conversation: string) {
    return (await this.store.records([conversation])).records.find(
      (entry) => entry.id === conversation,
    );
  }

  /** the owner's Witch answers a transfer request without a model turn. */
  private answer(active: Activation, ledger: Ledger): void {
    const claim = ledger.claims.find(
      (claim) =>
        claim.owner.conversation === active.conversation.id &&
        (claim.transfer || claim.automaticTransfer),
    );
    if (!claim || this.handing) return;
    const field = claim.transfer ? 'transfer' : 'automaticTransfer';
    if (claim[field]?.refusal) return;
    const owner = { ...claim.owner, conversation: active.conversation.id };
    this.handing = this.serialize(async () => {
      const moved = await this.change(
        undefined,
        (verify) =>
          this.registry.handOver(
            owner,
            claim.id,
            Date.now() + 1000,
            verify,
            () => transferRefusal(this.state, field === 'automaticTransfer'),
            field,
          ),
        async () => {
          if (this.admit() !== active) throw new Error('Coordination moved.');
        },
      );
      if (moved && !moved.transfer) void this.refresh();
    })
      .catch(() => {
        // the request stays pending, so the next tick rereads and answers again
        active.observed = undefined;
      })
      .finally(() => {
        this.handing = undefined;
      });
  }

  private refreshProject(active: Activation, deadline?: number): Promise<void> {
    const previous = this.projecting;
    const controller = new AbortController();
    const cancel = () => {
      previous?.cancel();
      controller.abort();
    };
    const timer =
      deadline === undefined
        ? undefined
        : setTimeout(cancel, checkDeadline(deadline));
    const read = (previous?.promise ?? Promise.resolve()).then(() =>
      this.readProject(active, controller.signal),
    );
    const settled = read.finally(() => {
      clearTimeout(timer);
      if (this.projecting === pending) this.projecting = undefined;
    });
    const pending = { promise: settled.catch(() => {}), cancel };
    this.projecting = pending;
    return settled;
  }

  /** never awaits the refreshes it starts, since `verify` reads the project while holding the ledger lock they take. */
  private async readProject(
    active: Activation,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const { project } = await this.memory.scopePaths(
        active.conversation.cwd,
        signal,
      );
      signal.throwIfAborted();
      if (this.active !== active || !active.publishing || this.closed) return;
      const changed = active.project !== project;
      active.project = project;
      if (this.turn && this.turn.owner.project !== project) this.revokeTurn();
      this.failures.delete('project');
      if (this.state) this.update(this.state);
      if (changed) {
        void this.refresh();
        void this.refreshEvents();
      }
    } catch (error) {
      if (this.active === active && active.publishing && !this.closed)
        this.fail('project', error);
      throw error;
    }
  }

  /** starts its refreshes synchronously, so a caller can read `refreshing` as soon as it returns. */
  private tick(): void {
    void this.maintain();
    void this.retryPresence();
    void this.events.publishMerges();
    const active = this.active;
    if (!active?.publishing || this.closed) return;
    this.rescope(active);
    this.reread(active);
  }

  private rescope(active: Activation): void {
    // a hung Git would otherwise queue a read for every tick while a project failure stands
    if (active.rescoping) return;
    const stamp = configStamp(active.config);
    if (stamp === active.configured && !this.failures.has('project')) return;
    active.configured = stamp;
    active.rescoping = true;
    void this.refreshProject(active)
      .catch(() => {})
      .finally(() => {
        active.rescoping = false;
      });
  }

  /** a refresh started while another runs would join it and miss what changed since it read, so the next tick decides. */
  private reread(active: Activation): void {
    if (this.refreshing || this.events.pending) return;
    const signature = this.registry.signature();
    const now = performance.now();
    const minute =
      active.rereadAt === undefined || now - active.rereadAt >= rereadInterval;
    if (
      signature !== undefined &&
      signature === active.observed &&
      !minute &&
      !['discovery', 'ledger', 'merge-events', 'peer-requests'].some((key) =>
        this.failures.has(key),
      )
    )
      return;
    active.observed = signature;
    active.rereadAt = now;
    const published = this.published;
    void this.refresh().then(() => {
      // a refresh that published nothing leaves what it read unshown, so the next tick tries again
      if (this.published === published && active.observed === signature)
        active.observed = undefined;
    });
    void this.refreshEvents();
    // a repository created or moved after activation has no config to stamp yet
    if (
      minute &&
      (active.configured === 'none' || active.configured === 'missing')
    )
      void this.memory.configPath(active.conversation.cwd).then(
        (config) => {
          if (this.active === active) active.config = config;
        },
        () => {},
      );
  }

  private async inspect(): Promise<CoordinationSnapshot> {
    await Promise.all([this.refreshing?.promise, this.events.pending]);
    await Promise.all([this.refresh(), this.refreshEvents()]);
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
    const revision = ++this.revision;
    const current = () =>
      this.active === active &&
      active.project === project &&
      active.publishing &&
      !this.closed;
    const discovery = this.discover(revision).catch((error: unknown) => {
      if (current()) this.failDiscovery(error, revision);
    });
    const promise = Promise.all([this.readLedger(), discovery])
      .then(
        ([ledger, discovery]) => {
          if (!current() || !discovery) return;
          const consistent =
            ledger.revision > this.mutationRevision ||
            (this.ledger !== undefined &&
              this.ledger.revision > ledger.revision);
          this.updateView(
            active,
            project,
            discovery,
            consistent ? ledger : undefined,
          );
        },
        () => {},
      )
      .finally(() => {
        this.refreshing = undefined;
      });
    this.refreshing = { active, project, promise };
    return promise;
  }

  private refreshEvents(): Promise<void> {
    const active = this.active;
    if (!active?.publishing || this.closed) return Promise.resolve();
    const project = active.project;
    return this.events.refresh(
      active,
      { conversation: active.conversation.id, project },
      () =>
        this.active === active &&
        active.project === project &&
        active.publishing &&
        !this.closed,
    );
  }

  private discover(revision: number, deadline?: number): Promise<Discovery> {
    // this process holds its publishing activation's lock, so only the others need the lock query
    const held = this.active?.publishing
      ? this.active.binding.activation
      : undefined;
    return discover(
      { registry: this.registry, store: this.store, memory: this.memory },
      revision,
      held,
      deadline,
    );
  }

  private fail(source: string, error: unknown): void {
    this.failures.set(source, errorMessage(error));
    this.publish(this.snapshot);
  }

  private failDiscovery(error: unknown, revision: number): void {
    if (
      revision < this.discoveryFailure ||
      (this.view && this.view.discovery.revision > revision)
    )
      return;
    this.discoveryFailure = revision;
    this.fail('discovery', error);
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
