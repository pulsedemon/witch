import { randomUUID } from 'node:crypto';
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
import { identifyProcess, identifyProcesses } from '../persistence/process.js';
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
import { assignGitHubTask } from './github-assignment.js';
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

interface Discovery {
  revision: number;
  live: Map<string, SessionPresence>;
  opened: Awaited<ReturnType<StateStore['openConversations']>>;
  unregistered: Map<string, CoordinationSnapshot['unregistered']>;
}

interface LedgerView {
  revision: number;
  ledger: Ledger;
}

interface RequestState {
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
  private host!: ControlHost;
  private timer?: ReturnType<typeof setInterval>;
  private scheduled?: ReturnType<typeof setTimeout>;
  private pending?: SessionPresence;
  private projected?: string;
  private writing: Promise<void> = Promise.resolve();
  private retrying?: Promise<void>;
  private operations: Promise<void> = Promise.resolve();
  private refreshing?: {
    active: Activation;
    project: string;
    promise: Promise<void>;
  };
  private revision = 0;
  private mutations = 0;
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
  ) {}

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
      await CoordinationStore.open(store.root),
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
    coordination.timer = setInterval(() => {
      void coordination.maintain();
      void coordination.refresh();
      void coordination.retryPresence();
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
          claim.process?.pid === this.process.pid &&
          claim.process.started === this.process.started &&
          !(await this.store.isOpen(claim.owner.conversation))
        )
          this.claimReleases.add(claim.owner.conversation);
      }
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

  /** drain releases before reactivation so a retry cannot remove a newer claim. */
  private async finishCleanup(state?: RequestState): Promise<void> {
    try {
      for (const [id, scope] of this.cancellations) {
        await this.change(state, (verify) =>
          this.registry.cancelSelection(
            scope,
            undefined,
            Date.now() + 1000,
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
              Date.now() + 1000,
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
      phase:
        state?.phase === 'compacting'
          ? 'running'
          : (state?.phase ?? 'starting'),
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

  private async readLedger(state?: RequestState): Promise<LedgerView> {
    if (state?.ledger) return state.ledger;
    let revision = 0;
    const ledger = await this.registry.state(Date.now() + 1000, () => {
      revision = ++this.revision;
    });
    const value = { revision, ledger };
    if (state) state.ledger = value;
    return value;
  }

  private async change<T>(
    state: RequestState | undefined,
    work: (verify: (ledger: Ledger) => Promise<void>) => Promise<T>,
    verify: (ledger: Ledger) => Promise<void> = async () => {},
  ): Promise<T> {
    const previous = this.ledger;
    const refreshing = this.refreshing;
    let ledger: Ledger | undefined;
    try {
      const result = await work(async (value) => {
        // invalidate observations made while this transaction waited for its lock.
        this.mutations++;
        ledger = value;
        await verify(value);
      });
      if (ledger) {
        let committed: LedgerView | undefined;
        if (refreshing || this.refreshing || this.ledger !== previous) {
          if (state) state.ledger = undefined;
          // publication failures must not change a committed action's result.
          committed = await this.readLedger().catch(() => undefined);
        } else committed = { revision: ++this.revision, ledger };
        if (committed) {
          if (!this.ledger || committed.revision > this.ledger.revision)
            this.ledger = committed;
          if (state) state.ledger = this.ledger;
        }
      }
      return result;
    } catch (error) {
      if (state) state.ledger = undefined;
      throw error;
    } finally {
      this.mutations++;
    }
  }

  private observe(state: RequestState): Promise<Discovery> {
    if (!state.discovery) {
      const revision = ++this.revision;
      state.discovery = { revision, promise: this.discover(revision) };
    }
    return state.discovery.promise;
  }

  private async requestSnapshot(
    active: Activation,
    state: RequestState,
  ): Promise<CoordinationSnapshot> {
    const discovery = this.observe(state);
    try {
      const [ledger, observed] = await Promise.all([
        this.readLedger(state),
        discovery,
      ]);
      return this.updateView(active, active.project, observed, ledger);
    } catch (error) {
      this.failDiscovery(error, state.discovery!.revision);
      throw error;
    }
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
    this.publish(
      this.projectDiscovery(
        active,
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
    state: RequestState = {},
  ): Promise<ControlOutcome> {
    const active = this.admit(request);
    let outcome: ControlOutcome | undefined;
    try {
      const action = request.action;
      if (action.kind === 'peers') {
        const snapshot = await this.requestSnapshot(active, state);
        if (snapshot.error) throw new Error(snapshot.error);
        return (outcome = { kind: 'peers', snapshot });
      }
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
      await this.refreshProject(active);
      await this.retireProject(active, state);
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
      const verify = async (ledger: Ledger) => {
        await this.refreshProject(active);
        const snapshot = this.projectDiscovery(
          active,
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
      if (action.kind === 'claim') {
        const claim = await this.change(
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
        try {
          await this.assign(
            claim.references,
            active.conversation.cwd,
            // leave time to refresh peers and write the control reply.
            request.deadline - 1000,
          );
          return { kind: 'claimed', claim };
        } catch (error) {
          return {
            kind: 'claimed',
            claim,
            warning: `GitHub assignment failed. The local claim is retained; repeat --claim to retry. ${errorMessage(error)}`,
          };
        }
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
      if (!(error instanceof ClaimConflict)) throw error;
      const owner = (
        await this.store.records([error.claim.owner.conversation])
      ).records.find((entry) => entry.id === error.claim.owner.conversation);
      return {
        kind: 'conflict',
        claim: error.claim,
        message: error.message,
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
    const mutations = this.mutations;
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
            this.mutations === mutations ||
            (this.ledger !== undefined &&
              this.ledger.revision > ledger.revision);
          this.updateView(
            active,
            project,
            discovery,
            consistent ? ledger : undefined,
          );
        },
        (error: unknown) => {
          if (current() && this.mutations === mutations)
            this.failDiscovery(error, revision);
        },
      )
      .finally(() => {
        this.refreshing = undefined;
      });
    this.refreshing = { active, project, promise };
    return promise;
  }

  private async discover(revision: number): Promise<Discovery> {
    const [presences, opened] = await Promise.all([
      this.registry.presences(),
      this.store.openConversations(),
    ]);
    const { records, unreadable } = await this.store.records([
      ...opened.keys(),
    ]);
    if (unreadable.length)
      throw new Error(
        `Cannot determine session ownership: ${unreadable.map((entry) => entry.file).join(', ')}`,
      );
    const candidates = new Map<string, SessionPresence>();
    for (const record of records) {
      const presence = presences.find((entry) => entry.id === record.id);
      if (opened.has(record.id) && presence?.cwd === record.cwd)
        candidates.set(record.id, presence);
    }
    const activations = await this.registry.activeActivations(
      [...candidates.values()].map((presence) => presence.activation),
    );
    const processes = await identifyProcesses(
      [...candidates.values()].flatMap((presence) =>
        activations.has(presence.activation) ? [presence.process.pid] : [],
      ),
    );
    const live = new Map<string, SessionPresence>();
    const unregistered = new Map<
      string,
      CoordinationSnapshot['unregistered']
    >();
    for (const record of records) {
      const holder = opened.get(record.id);
      if (!holder) continue;
      const presence = candidates.get(record.id);
      if (
        presence &&
        activations.has(presence.activation) &&
        processes.get(presence.process.pid)?.started ===
          presence.process.started
      ) {
        live.set(record.id, presence);
        continue;
      }
      // a current Witch opening, reconnecting or closing this conversation
      if (holder.coordinated) continue;
      try {
        const { project } = await this.memory.scopePaths(record.cwd);
        const summaries = unregistered.get(project) ?? [];
        summaries.push(conversationSummarySchema.parse(record));
        unregistered.set(project, summaries);
      } catch (error) {
        const { code, syscall } = error as NodeJS.ErrnoException;
        if (code !== 'ENOENT' || syscall !== 'realpath') throw error;
      }
    }
    return { revision, live, opened, unregistered };
  }

  private projectDiscovery(
    active: Activation,
    project: string,
    discovery: Discovery,
    { claims, selections }: Ledger,
  ): CoordinationSnapshot {
    const { live, opened } = discovery;
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
    return {
      peers,
      ownClaim,
      ownSelection,
      reservations,
      unregistered: discovery.unregistered.get(project) ?? [],
    };
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
