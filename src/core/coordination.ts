import { isFamiliarAction } from '../agents/familiar-report.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentSession } from '../agents/types.js';
import { errorMessage } from '../errors.js';
import type { Memory } from '../memory/memory.js';
import {
  CoordinationStore,
  checkDeadline,
} from '../persistence/coordination.js';
import type { Ledger, Verify } from '../persistence/coordination.js';
import { ControlHost } from '../persistence/control.js';
import type {
  ControlBinding,
  ControlOutcome,
  ControlRequest,
} from '../persistence/control.js';
import { identifyProcess, sameProcess } from '../persistence/process.js';
import type { StateStore } from '../persistence/store.js';
import {
  checkTaskRelease,
  emptySnapshot,
  type CoordinationSnapshot,
  type SelectionScope,
} from './coordination-state.js';
import type { Reviewers } from './reviewers.js';
import type { router } from './router.js';
import type { Snapshot } from './snapshot.js';
import {
  coordinationContext,
  coordinationInstructions,
} from './coordination-policy.js';
import { configStamp, discover, projectDiscovery } from './discovery.js';
import { movedNotices, transferRefusal } from './task-transfer.js';
import type { Discovery } from './discovery.js';
import { assignGitHubTask } from './github-assignment.js';
import { ReviewOwnership } from './review-ownership.js';
import type { Repository } from './repository.js';
import { ConversationEvents } from './conversation-events.js';
import {
  activationOwner,
  dispatchControl,
  type DispatchHost,
} from './control-dispatch.js';
import { PresencePublisher } from './presence.js';
import type { PeerRequest } from './peer-requests.js';
import type { PeerAnswer } from './peer-answers.js';
import type { Conversation, ProcessIdentity } from './state.js';

export interface Activation {
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

export interface LedgerView {
  revision: number;
  ledger: Ledger;
}

export interface RequestState {
  deadline?: number;
  ledger?: LedgerView;
  discovery?: { revision: number; promise: Promise<Discovery> };
}

/** one conversation owns mutations until quiesced; presence disappears only while its conversation lock is held. */
export class SessionCoordination {
  snapshot: CoordinationSnapshot = emptySnapshot;
  private listeners = new Set<() => void>();
  private active?: Activation;
  private state?: Snapshot;
  private repository?: Repository;
  readonly events: ConversationEvents;
  private readonly control: DispatchHost;
  private readonly presence: PresencePublisher;
  readonly reviews = new ReviewOwnership({
    observed: () => !!this.active?.accepting && !!this.ledger,
    context: (project) => this.context(project),
    current: () => {
      const active = this.admit();
      return {
        owner: activationOwner(active),
        cwd: active.conversation.cwd,
        repository: this.repository,
      };
    },
    claim: (owner, input, deadline, verify) =>
      this.serialize(() =>
        this.change(
          undefined,
          (check) =>
            this.registry.claim(owner, input, this.process, deadline, check),
          verify,
        ),
      ),
    assign: (...args) => this.assign(...args),
    record: (id, references, deadline) =>
      this.serialize(() =>
        this.change(undefined, (check) =>
          this.registry.recordAssignment(id, references, deadline, check),
        ),
      ),
  });
  private host!: ControlHost;
  private familiarHost!: ControlHost;
  private live?: () => AgentSession | undefined;
  /** answers `--route` outside the serialized claim queue, so background claim work doesn't delay it. */
  router?: ReturnType<typeof router>;
  ownFamiliars?: Reviewers['report'];
  private timer?: ReturnType<typeof setInterval>;
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
  /** a recipient's pause writes, each for the conversation that made it; ticks and deactivation flush them until stored. */
  private pauseWrites: {
    conversation: string;
    kind: 'confirm' | 'resume';
    pauses: string[];
  }[] = [];
  private flushingPauses?: Promise<void>;
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
    this.presence = new PresencePublisher({
      registry,
      process,
      state: () => this.state,
      branch: () => this.repository?.branch,
      active: () => this.active,
      closed: () => this.closed,
      ending: () => this.ending,
      failed: (error) => this.fail('presence', error),
      written: () => {
        this.failures.delete('presence');
        this.publish(this.snapshot);
      },
      failure: () => this.failures.has('presence'),
    });
    this.control = {
      registry,
      store,
      process,
      assign,
      state: () => this.state,
      turn: () => this.turn,
      presenceFailure: () => this.failures.get('presence'),
      failed: (error) => this.fail('selection', error),
      admit: (request) => this.admit(request),
      readLedger: (state) => this.readLedger(state),
      change: (state, work, verify) => this.change(state, work, verify),
      observe: (state) => this.observe(state),
      requestSnapshot: (active, state) => this.requestSnapshot(active, state),
      refreshProject: (active, deadline) =>
        this.refreshProject(active, deadline),
      retireProject: (active, state) => this.retireProject(active, state),
    };
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
      await this.presence.publish(active);
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

  /** returns a way to restore this activation's prior admission if the transition defers after draining. */
  async quiesce(): Promise<() => void> {
    const active = this.active;
    const accepting = active?.accepting ?? false;
    if (active) active.accepting = false;
    await this.operations;
    await this.host.drain();
    await this.familiarHost.drain();
    return () => {
      if (active && this.active === active && !this.ending && !this.closed)
        active.accepting = accepting;
    };
  }

  async deactivate(): Promise<void> {
    const active = this.active;
    if (!active) return;
    const quiescing = Promise.all([this.endTurn(), this.quiesce()]);
    active.publishing = false;
    this.presence.cancel();
    let failure: unknown;
    try {
      await quiescing;
      await this.flushPauseWrites();
      await this.presence.idle();
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
      this.events.forgetPauses();
      this.presence.reset();
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
    this.presence.schedule(active);
  }

  updateRepository(repository: Repository | undefined): void {
    this.repository = repository;
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

  /** takes the conversation from the caller, since `/clear` and runtime switches leave coordination briefly inactive. */
  confirmPause(conversation: string, pause: string): void {
    this.queuePauseWrite({ conversation, kind: 'confirm', pauses: [pause] });
  }

  resumePauses(conversation: string, pauses: string[]): void {
    this.queuePauseWrite({ conversation, kind: 'resume', pauses });
  }

  private queuePauseWrite(write: SessionCoordination['pauseWrites'][number]) {
    this.pauseWrites.push(write);
    void this.flushPauseWrites();
  }

  /** runs while closing too, without admission, so a resume made just before /restart is stored. */
  private flushPauseWrites(): Promise<void> {
    if (!this.pauseWrites.length) return Promise.resolve();
    this.flushingPauses ??= this.serialize(async () => {
      while (this.pauseWrites.length) {
        const { conversation, kind, pauses } = this.pauseWrites[0]!;
        const deadline = Date.now() + 1000;
        if (kind === 'resume')
          await this.registry.resumeByUser(conversation, pauses, deadline);
        else
          for (const pause of pauses)
            await this.registry.confirmPause(conversation, pause, deadline);
        this.pauseWrites.shift();
      }
      this.failures.delete('pause-writes');
      this.publish(this.snapshot);
    })
      .catch((error: unknown) => this.fail('pause-writes', error))
      .finally(() => {
        this.flushingPauses = undefined;
      });
    return this.flushingPauses;
  }

  beginTurn(turn: string): void {
    const active = this.admit();
    this.turn = {
      owner: activationOwner(active),
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

  async context(project?: string): Promise<{
    instructions: string;
    context: string;
    snapshot: CoordinationSnapshot;
  }> {
    const active = this.admit();
    let moved: string[] = [];
    try {
      await this.serialize(async () => {
        // a turn's own read stands in for another while it matches and no read failed
        if (project !== active.project || this.failures.has('project'))
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
    checkTaskRelease(this.state, true);
    this.failures.delete('control');
    await this.serialize(async () => {
      const state: RequestState = {};
      const claim = (await this.readLedger(state)).ledger.claims.find(
        (entry) => entry.owner.conversation === active.conversation.id,
      );
      if (!claim) return;
      await dispatchControl(
        this.control,
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
      dispatchControl(
        this.control,
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
      if (!this.current(active, project)) return false;
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
    work: (verify: Verify) => Promise<T>,
    verify: Verify = async () => {},
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
    if (!this.current(active, project)) return this.snapshot;
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
    return this.serialize(() => dispatchControl(this.control, request, human));
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
    void this.flushPauseWrites();
    void this.presence.retry();
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
      ![
        'discovery',
        'ledger',
        'merge-events',
        'peer-requests',
        'pauses',
        'pause-writes',
      ].some((key) => this.failures.has(key))
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
    const current = () => this.current(active, project);
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
      () => this.current(active, project),
    );
  }

  /** whether `active` is still the publishing activation, on the project the caller captured. */
  private current(
    active: Activation | undefined,
    project: string | undefined,
  ): boolean {
    return (
      !!active &&
      this.active === active &&
      active.project === project &&
      active.publishing &&
      !this.closed
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
