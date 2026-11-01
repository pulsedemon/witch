import { settleMemory } from './memory-settlement.js';
import { handoff } from './handoff.js';
import { CopilotReviewController } from './copilot-review-controller.js';
import { reviewInstruction, type ReviewBatch } from './copilot-reviews.js';
import { Compaction, compactSession } from './compaction.js';
import { initialSnapshot, type Snapshot } from './snapshot.js';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { AgentRegistration } from '../agents/registry.js';
import { aborted, errorMessage } from '../agents/stderr.js';
import { NativeStop, stopDeadline } from '../agents/shutdown.js';
import type {
  AgentEvent,
  AgentSession,
  AgentStopOptions,
  TurnResult,
  UserResponse,
} from '../agents/types.js';
import { indexNote, noticeText } from '../memory/memory.js';
import type { Memory, MemoryScope } from '../memory/memory.js';
import type { Workspace } from '../memory/workspace.js';
import type { ConversationStore, StateStore } from '../persistence/store.js';
import { processReports } from '../persistence/process.js';
import {
  stoppedActivity,
  updateBackgroundActivity,
} from './background-activity.js';
import { castRow } from './spells.js';
import {
  launchRecord,
  missingDirectoryNotice,
  recoverConversations,
} from './startup-recovery.js';
import { editInVSCode } from './editor.js';
import { editNote, memoryView, recoverMemory } from './memory-actions.js';
import type { MemoryView } from './memory-actions.js';
import { listFiles } from './files.js';
import {
  shellCommand,
  skillCall,
  ranCommand,
  nativePrompt,
  questionReply,
} from './prompts.js';
import { joining, nextTurn, steerInOrder, waitsBehind } from './queue.js';
import type { JobWatch } from './jobs.js';
import type { SessionCoordination } from './coordination.js';
import { watchClaimPolicy } from './coordination-policy.js';
import { taskActivity } from './coordination-state.js';
import { runMergeCleanup } from './merged.js';
import type { CleanupResult, MergeCleanup } from './merged.js';
import { PentacleActivity } from './pentacle-activity.js';
import { endActivity, startActivity, type Activity } from './activity.js';
import { runReviewCommand } from './review-run.js';
import { Reviewers } from './reviewers.js';
import { ModelCatalog, modelEffort, type ModelSelection } from './models.js';
import { AccountUsage } from './usage.js';
import type { Conflict, PullRequest } from './repository.js';
import { watchMergeNotices } from './merge-events.js';
import {
  answerInstruction,
  answerNotice,
  watchPeerRequestNotices,
  type PeerRequest,
} from './peer-requests.js';
import {
  preparePeerAnswers,
  recordPeerAnswers,
  peerAnswerOutputSchema,
} from './peer-answers.js';
import {
  agentDisplay,
  agentWorking,
  applyDisplayUpdate,
  clearConversationContext,
  clearDelivery,
  createConversation,
  recordDelivery,
  recordSession,
  untitled,
  type Conversation,
  type ConversationRecord,
  type DisplayUpdate,
  type Phase,
} from './state.js';

const compactAt = 80;
const localActivity = Symbol('local activity');
interface Launch {
  continue?: boolean;
  conversation?: string;
}
interface TurnOptions {
  delivered?: () => void;
  queued?: boolean;
  requests?: readonly PeerRequest[];
  /** a turn Witch composed, such as a /review correction, adds no user row and doesn't title the conversation. */
  silent?: boolean;
  review?: ReviewBatch;
}
/** another operation holds the phase, so nothing ran and nothing failed. */
class Refusal extends Error {}
export class Coordinator {
  readonly pentacle = new PentacleActivity();
  snapshot: Snapshot;
  conflict?: Conflict;
  private record?: ConversationRecord;
  private files?: ConversationStore;
  private workspace?: Workspace;
  private session?: AgentSession;
  private contextGeneration = 0;
  private readonly pendingContext = new Map<string, string[]>();
  /** the project memory the live session may write; native permissions are fixed at connect. */
  private sessionProject?: string;
  private listeners = new Set<() => void>();
  private task?: Promise<unknown>;
  private cancelled = false;
  /** memory recovery must keep a failed turn's queue held for the composer. */
  private turnFailed = false;
  /** the operation's native turn has ended, so only its settlement holds the phase. */
  private turnEnded = false;
  /** counts admitted operations, so a waiting choice can tell another one ran. */
  private operations = 0;
  private closed = false;
  /** a model change accepted after the reply can outlive the native turn. */
  private changingModel?: Promise<void>;
  private selectingModel = false;
  private modelRefresh?: { cancelled: boolean };
  private readonly catalog: ModelCatalog;
  readonly accountUsage: AccountUsage;
  private draining?: PromiseWithResolvers<void>;
  private deliveryHolds = 0;
  private admissions = 0;
  /** the familiars Witch launches itself, which the familiar mailbox consults before the live session. */
  readonly reviewers = new Reviewers((event) => this.background(event));
  /** a stop holds automatic turns until the user's next send or another conversation. */
  private automaticHeld = false;
  readonly copilot = new CopilotReviewController({
    record: () => this.record,
    coordination: () => this.coordination,
    ready: () =>
      this.automaticReady() &&
      !this.snapshot.queue.length &&
      !this.answerReady(),
    save: () => this.save(),
    notice: (text) => {
      if (!this.closed && this.record) this.notice(text);
    },
    changed: () => this.drainAfter(),
    run: (batch) => this.reviewCopilot(batch),
    interrupt: () => this.stopCurrent(),
  });
  private readonly compaction = new Compaction({
    state: () => ({
      conversation: this.record?.id,
      phase: this.snapshot.phase,
      closed: this.closed,
      halted: this.halted(),
      replied: this.replied,
      parent: this.task,
      draining: this.draining?.promise,
      session: this.session,
    }),
    idle: async () => {
      let success = false;
      await this.operate('compacting', async () => {
        success = await this.performCompaction();
      });
      return success;
    },
    changed: () => {
      this.publish({});
      this.drainAfter();
    },
    failed: () => (this.turnFailed = true),
    notice: (text) => this.notice(text),
    report: (error) => this.report(error),
  });
  private opening = false;
  private admitting: Promise<unknown> = Promise.resolve();
  private connecting?: AbortController;
  private editorCancellation?: AbortController;
  private cleanupCancellation?: AbortController;
  private reviewCancellation?: AbortController;
  constructor(
    private readonly store: StateStore,
    readonly memory: Memory,
    private readonly agents: readonly AgentRegistration[],
    private readonly jobs?: Pick<
      JobWatch,
      'track' | 'environment' | 'script' | 'setActive'
    >,
    private readonly editFile = editInVSCode,
    readonly coordination?: SessionCoordination,
  ) {
    this.catalog = new ModelCatalog(agents, (error) =>
      this.notice(errorMessage(error), undefined, false),
    );
    this.accountUsage = new AccountUsage(agents, (accounts) =>
      this.publish({ accounts }),
    );
    this.snapshot = initialSnapshot(agents);
    this.coordination?.attach(() => this.session);
    this.publish({});
    for (const watch of [watchMergeNotices, watchPeerRequestNotices])
      watch(
        coordination,
        () => this.snapshot,
        (notice) => {
          if (!this.closed) this.display(notice);
        },
      );
    coordination?.subscribe(() => {
      this.copilot.checkBinding();
      if (!this.snapshot.queue.length) this.drainAfter();
    });
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async initialize(directory: string, options: Launch = {}): Promise<void> {
    this.task = this.load(directory, options);
    try {
      await this.task;
    } catch (error) {
      throw this.enterError(error);
    } finally {
      this.task = undefined;
      this.drainAfter();
    }
  }
  private async load(directory: string, options: Launch): Promise<void> {
    await this.memory.initialize();
    const cwd = await realpath(directory);
    const id =
      options.conversation ??
      (options.continue
        ? (await this.store.conversations(cwd))[0]?.id
        : undefined);
    const report = await recoverConversations(this.store, this.memory, id);
    try {
      await this.openConversation(
        id
          ? { id }
          : { create: await launchRecord(this.store, this.agents, cwd) },
      );
    } catch (error) {
      if (report === undefined) throw error;
      throw new Error(`${errorMessage(error)}\n\n${report}`, { cause: error });
    }
    // a failed connect leaves the conversation open, as a failed send does
    const failure = await this.connect().then(() => undefined, errorMessage);
    const adoption = await this.workspace!.adoptCheckout(cwd).then(
      () => undefined,
      errorMessage,
    );
    const missing = await missingDirectoryNotice(this.store);
    if (missing) this.notice(missing, undefined, false);
    // a failed scope read fails both, so its message shows once
    await this.settle(
      [...new Set([report, failure, adoption].filter(Boolean))].join('\n\n') ||
        undefined,
    );
  }

  /** claims the target first, so a failed claim leaves the current conversation untouched. */
  private async openConversation(
    target: { id: string } | { create: Conversation },
  ): Promise<void> {
    this.opening = true;
    try {
      // pending admissions still belong to this conversation and can block the switch.
      await this.admitting;
      if (this.snapshot.queue.length)
        throw new Error('Prompts are still queued for this conversation');
      const files =
        'id' in target
          ? await this.store.claim(target.id)
          : await this.store.create(target.create);
      const workspace = this.memory.workspace(files.directory, files.record.id);
      let items;
      try {
        items = await files.items();
        if (await workspace.branchExists()) await workspace.ensureWorktree();
      } catch (error) {
        await files.close().catch(() => {});
        throw error;
      }
      let failure: unknown;
      try {
        await this.disconnect();
      } catch (error) {
        failure = error;
      } finally {
        if (this.record)
          await this.coordination
            ?.releaseConversation(this.record.id)
            .catch((error: unknown) => (failure ??= error));
        await this.files
          ?.close()
          .catch((error: unknown) => (failure ??= error));
      }
      this.files = files;
      this.record = files.record;
      this.automaticHeld = false;
      this.copilot.activate();
      this.workspace = workspace;
      if (!this.record.handoff?.activated) delete this.record.handoff;
      this.publish({
        conversation: this.record,
        items,
        models: [],
        native: undefined,
        usage: {},
        openedAt: Date.now(),
        completedTurn: undefined,
      });
      if (failure !== undefined) this.report(failure);
      if (this.coordination)
        await this.coordination.activate(
          this.record,
          (await this.memory.scopePaths(this.record.cwd)).project,
        );
    } finally {
      this.opening = false;
    }
  }

  /** steers the turn in flight, or queues the prompt for a later turn; a queued turn that never reaches the agent leaves its prompts queued. */
  async send(prompt: string): Promise<void> {
    if (!prompt.trim()) return;
    // only a restart leaves the error phase, so nothing would run what waits
    if (this.snapshot.phase === 'error') throw new Error(this.snapshot.error);
    if (this.opening) throw new Error('Wait for the next conversation to open');
    // one sent during an operation runs after it only as drainAfter would, even when its steer is refused once it has ended
    const during = this.snapshot.phase !== 'idle';
    this.automaticHeld = false;
    this.copilot.resume();
    this.admissions++;
    // a steer can wait on the agent, so each prompt steers or queues only after those sent before it
    const admitted = this.admitting
      .then(async () => {
        if (
          !waitsBehind(this.snapshot.queue, this.snapshot.skills) &&
          (await this.steer(prompt))
        )
          return true;
        this.publish({ queue: [...this.snapshot.queue, prompt] });
        return false;
      })
      .finally(() => this.admissions--);
    this.admitting = admitted.catch(() => {});
    if (!(await admitted) && !(during && this.halted())) await this.drain();
  }

  unqueue(): string[] {
    const queue = [...this.snapshot.queue];
    this.publish({ queue: [] });
    return queue;
  }

  holdPromptDelivery(): () => void {
    this.deliveryHolds++;
    this.publish({});
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.deliveryHolds--;
      this.publish({});
      this.drainAfter(true);
    };
  }

  private get deliveryHeld(): boolean {
    return this.deliveryHolds > 0 || this.compaction.pending;
  }

  private async steer(prompt: string): Promise<boolean> {
    const session = this.session;
    if (
      this.snapshot.phase !== 'running' ||
      this.snapshot.answering ||
      this.snapshot.reviewing ||
      this.cancelled ||
      !session ||
      this.deliveryHeld ||
      this.halted()
    )
      return false;
    const command = shellCommand(prompt);
    if (command !== undefined) {
      if (!this.replied) return false;
      // shown first, since a command's output streams as soon as it starts
      this.userRow(prompt);
      return session.steer(`${prompt}\n\n${ranCommand}`, { command });
    }
    const skill = skillCall(prompt, this.snapshot.skills);
    if (
      !(await (skill
        ? session.steer(prompt.trimStart(), { skill })
        : session.steer(prompt)))
    )
      return false;
    this.userRow(prompt);
    return true;
  }

  private get replied(): boolean {
    return this.snapshot.phase === 'running' && !!this.session?.replied;
  }
  private drainAfter(releasedHold = false): void {
    if (this.closed || this.deliveryHeld || this.halted()) return;
    if (this.draining && !this.replied) {
      if (releasedHold)
        void this.draining.promise.then(() => {
          if (!this.cancelled && !this.session?.closed) this.drainAfter();
        });
      return;
    }
    if (
      !this.snapshot.queue.length &&
      !(this.automaticReady() && (this.answerReady() || this.copilot.ready()))
    )
      return;
    const draining = this.replied ? this.steerQueued() : this.drain();
    draining.catch((error: unknown) => this.report(error));
  }

  /** a report or failed turn stays on screen, and the composer takes back what is queued; after an interrupt it runs. */
  private halted(): boolean {
    return !!this.snapshot.error || this.turnFailed;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    const draining = (this.draining = Promise.withResolvers<void>());
    try {
      while (!this.deliveryHeld && this.snapshot.phase === 'idle') {
        if (!this.snapshot.queue.length) {
          if (!this.automaticReady()) return;
          const answering = this.answerReady();
          const ran = answering
            ? await this.answerPeers()
            : await this.copilot.run();
          if (!ran && !answering && this.answerReady()) continue;
          if (ran ? this.halted() : !this.snapshot.queue.length) return;
          continue;
        }
        const queue = this.snapshot.queue;
        const batch = nextTurn(
          queue,
          this.session ? this.snapshot.skills : undefined,
        );
        this.publish({ queue: queue.slice(batch.length) });
        let delivered = false;
        try {
          await this.operate('running', async () => {
            await this.runTurn(batch.join('\n'), 'turn', {
              delivered: () => (delivered = true),
              queued: true,
            });
          });
        } finally {
          if (!delivered)
            this.publish({ queue: [...batch, ...this.snapshot.queue] });
        }
        if (!delivered || this.halted()) return;
      }
    } finally {
      this.draining = undefined;
      draining.resolve();
    }
  }

  /** admitted automatic turns have already spent their attempt, so only queued user input waits behind delivery holds. */
  private async runTurn(
    prompt: string,
    kind: 'turn' | 'answer' | 'review',
    options: TurnOptions,
  ): Promise<TurnResult | undefined> {
    try {
      const session = await this.connectForTurn();
      if (!session) return;
      const usage = session.info.hasHistory
        ? await session.contextUsage()
        : undefined;
      if (this.cancelled || session.closed || this.session !== session) return;
      if (options.queued && this.deliveryHeld) return;
      if (usage !== undefined && usage >= compactAt) {
        this.publish({ phase: 'compacting' });
        if (!(await this.performCompaction())) return;
        this.publish({ phase: 'running' });
      }
      if (options.queued && this.deliveryHeld) return;
      return await this.performTurn(prompt, kind, options);
    } catch (error) {
      this.report(error);
    }
  }

  private automaticReady(): boolean {
    return (
      this.snapshot.phase === 'idle' &&
      !this.task &&
      !this.admissions &&
      !this.deliveryHeld &&
      !this.halted() &&
      !this.opening &&
      !this.closed &&
      !this.snapshot.requests.length &&
      !this.automaticHeld &&
      !!this.record
    );
  }

  private answerReady(): boolean {
    return (
      this.automaticReady() &&
      !!this.coordination?.events.answerable(this.current().id)
    );
  }

  private async reviewCopilot(
    batch: ReviewBatch,
  ): Promise<TurnResult | undefined> {
    let result: TurnResult | undefined;
    this.publish({ reviewing: true });
    try {
      await this.operate('running', async () => {
        result = await this.runTurn(reviewInstruction(batch), 'review', {
          review: batch,
        });
      });
    } finally {
      this.publish({ reviewing: false });
    }
    return result;
  }

  private async answerPeers(): Promise<boolean> {
    let ran = false;
    this.publish({ answering: true });
    await this.operate('running', async () => {
      const requests = await this.coordination!.beginAnswer();
      ran = requests.length > 0;
      if (ran) await this.runTurn(answerInstruction, 'answer', { requests });
    }).finally(() => this.publish({ answering: false }));
    return ran;
  }

  /** the prompts queued behind a queued turn's prompt join that turn; a `!` command and what follows it wait. */
  private steerQueued(): Promise<void> {
    const steering = this.admitting.then(async () => {
      if (this.deliveryHeld || this.halted()) return;
      const followers = joining(this.snapshot.queue);
      this.publish({ queue: this.snapshot.queue.slice(followers.length) });
      await steerInOrder(
        followers,
        this.snapshot.skills,
        (prompt) => this.steer(prompt),
        (back) => this.publish({ queue: [...back, ...this.snapshot.queue] }),
      );
    });
    this.admitting = steering.catch(() => {});
    return steering.catch((error: unknown) => this.report(error));
  }

  /** without an agent, continues on this conversation's agent, model and effort. */
  async newConversation(agent?: string): Promise<void> {
    await this.operate('starting', async () => {
      const source = this.current();
      const chosen = agent ?? source.agent;
      this.catalog.installed(chosen);
      await this.openConversation({
        create: createConversation(source.cwd, chosen, source),
      });
      await this.connect();
    });
  }

  async clear(): Promise<void> {
    await this.operate('starting', async () => {
      await this.admitting;
      if (this.snapshot.queue.length)
        throw new Error('Prompts are still queued for this conversation');
      const conversation = this.current();
      const info = this.live(conversation.agent)?.info;
      await this.disconnect();
      if (this.cancelled) return;
      clearConversationContext(conversation, info);
      this.pendingContext.delete(conversation.id);
      this.publish({ completedTurn: undefined });
      await this.save();
      this.display({
        id: randomUUID(),
        kind: 'notice',
        text: 'Context cleared. The agent cannot see anything above this line.',
        cwd: conversation.cwd,
        contextCleared: true,
      });
      await this.files!.flush();
      if (this.cancelled) return;
      const stored = conversation.sessions[conversation.agent]!;
      const session = await this.connect();
      if (this.cancelled || session.closed) return;
      if (stored.model) {
        // restore the resolved model without changing the saved alias
        await session.selectModel(stored.model, stored.effort);
        recordSession(conversation, conversation.agent, session.info);
      }
      await this.save();
      this.publish({ conversation, native: session.info });
    });
  }

  async selectConversation(id: string): Promise<void> {
    if (id === this.record?.id) return;
    await this.operate('starting', async () => {
      await this.openConversation({ id });
      await this.connect();
    });
  }

  async projectFiles(): Promise<string[]> {
    return listFiles(this.current().cwd);
  }

  async conversations(): Promise<Conversation[]> {
    return this.store.conversations(this.current().cwd);
  }

  /** returns false when canceled; a replied turn keeps its catalog because reinitialization needs idle. */
  async refreshModels(): Promise<boolean> {
    if (this.replied) return true;
    if (!(await this.settled())) return false;
    const refresh = { cancelled: false };
    try {
      await this.operate('starting', async () => {
        this.modelRefresh = refresh;
        const { cwd, agent } = this.current();
        try {
          const models = await this.catalog.read(cwd, this.live(agent), true);
          if (!refresh.cancelled)
            this.publish({ models, latest: this.catalog.latest });
        } catch (error) {
          if (!refresh.cancelled || this.closed || !aborted(error)) throw error;
        }
      });
      return !refresh.cancelled;
    } finally {
      if (this.modelRefresh === refresh) this.modelRefresh = undefined;
    }
  }

  /** an omitted effort keeps the one in force, except on a model that lists none. */
  async selectModel(selection: ModelSelection): Promise<void> {
    if (this.changingModel)
      throw new Refusal('Stop the current operation first');
    if (selection.agent !== this.current().agent)
      return this.operate('switching', async () => {
        this.catalog.installed(selection.agent);
        await this.handoff(selection);
      });
    if (!this.replied && !(await this.settled()))
      throw new Refusal('Model change canceled');
    // a familiar or workflow holding a replied turn open doesn't stop Claude Code taking the change
    if (!this.replied)
      return this.operate('starting', () => this.changeModel(selection));
    this.changingModel = this.changeModel(selection);
    try {
      await this.changingModel;
    } catch (error) {
      this.report(error);
      throw error;
    } finally {
      this.changingModel = undefined;
    }
  }

  /** waits for an ended turn to settle; false if Witch was interrupted, the turn or its settlement failed, or another operation ran first. */
  private async settled(): Promise<boolean> {
    if (!this.turnEnded || this.snapshot.phase !== 'running') return true;
    const { task, draining, operations } = this;
    await task?.catch(() => {});
    await draining?.promise;
    return this.operations === operations && !this.cancelled && !this.halted();
  }

  private async changeModel(selection: ModelSelection): Promise<void> {
    const conversation = this.current();
    const { agent, id } = selection;
    if (!this.live(conversation.agent)) {
      // so a model that fails to connect can be replaced. the effort waits for the session to accept it, since a stored one every connect rejects can't be replaced
      conversation.sessions[conversation.agent] = {
        id: '',
        hasHistory: false,
        ...conversation.sessions[conversation.agent],
        model: id,
        requestedModel: id,
      };
      await this.save();
    }
    const session = await this.connect();
    conversation.sessions[agent] = await this.applyModel(session, selection);
    await this.save();
    this.publish({ conversation, native: session.info });
  }

  private async applyModel(session: AgentSession, selection: ModelSelection) {
    const { agent, id } = selection;
    this.selectingModel = true;
    try {
      await session.selectModel(
        id,
        modelEffort(selection, this.snapshot.models),
      );
    } finally {
      this.selectingModel = false;
    }
    return {
      ...this.current().sessions[agent]!,
      model: session.info.model,
      requestedModel: id,
      effort: session.info.effort,
    };
  }

  interrupt(options: AgentStopOptions = {}): Promise<void> {
    this.automaticHeld = true;
    return this.stopCurrent(options);
  }

  private async stopCurrent(options: AgentStopOptions = {}): Promise<void> {
    const stop = { ...options, deadline: stopDeadline(options.deadline) };
    const refresh =
      this.snapshot.phase === 'starting' ? this.modelRefresh : undefined;
    if (refresh) refresh.cancelled = true;
    this.cancelled = true;
    this.compaction.cancel();
    this.publish({
      requests: this.snapshot.requests.filter(
        (request) => !request.replyAsPrompt,
      ),
    });
    this.connecting?.abort(new NativeStop(stop));
    this.catalog.cancel(new NativeStop(stop));
    this.editorCancellation?.abort();
    this.cleanupCancellation?.abort();
    this.reviewCancellation?.abort(new NativeStop(stop));
    const results = await Promise.allSettled([
      (this.cleanupCancellation ?? this.reviewCancellation) && this.task,
      this.coordination?.endTurn(),
      (async () => {
        if (refresh && !this.closed) return;
        // a session that is still starting has no turn to interrupt, so stopping it closes it
        if (this.snapshot.phase === 'starting' || this.connecting)
          await this.session?.close(stop);
        else {
          const session = this.session;
          await session?.interrupt(stop);
          if (this.changingModel || this.selectingModel)
            await session?.close(stop);
        }
      })(),
    ]);
    for (const result of results)
      if (result.status === 'rejected') throw result.reason;
  }

  async respond(id: string, response: UserResponse): Promise<void> {
    const request = this.snapshot.requests.find((request) => request.id === id);
    if (!request) return;
    const { questions, replyAsPrompt } = request;
    if (replyAsPrompt)
      this.publish({
        requests: this.snapshot.requests.filter((request) => request.id !== id),
      });
    else this.session?.respond(id, response);
    // the request view closes on answering, so the transcript keeps what was asked and chosen
    if (questions && response.decision === 'accept') {
      const text = questionReply(questions, response);
      if (replyAsPrompt) await this.send(text);
      else this.userRow(text);
    }
    if (response.decision === 'cancel') await this.interrupt();
  }

  async recoverMemory(decision: 'accept' | 'discard' | 'keep'): Promise<void> {
    const kind = this.snapshot.recovery?.kind;
    await this.operate(
      'editing',
      async () => {
        await recoverMemory(this.workspace!, this.current(), kind, decision);
        await this.save();
      },
      'recovery',
    );
  }

  async memoryView(): Promise<MemoryView> {
    return memoryView(this.memory, this.workspace!, this.current().cwd);
  }

  async memoryDirectories(): Promise<string[]> {
    const scope = await this.memory.scopePaths(this.current().cwd);
    return this.workspace!.directories(scope);
  }

  async editMemory(path?: string): Promise<void> {
    await this.operate('editing', async () => {
      const note =
        path ??
        `${(await this.memory.scopePaths(this.current().cwd)).project}/${indexNote}`;
      this.notice(`Memory edit: ${noticeText(note)}`, this.workspace!.root);
      await this.beginActivity('memory-edit');
      const abort = (this.editorCancellation = new AbortController());
      if (this.cancelled) abort.abort();
      const saved = await editNote(
        this.workspace!,
        note,
        this.editFile,
        abort.signal,
      ).finally(() => (this.editorCancellation = undefined));
      if (!saved) return;
      delete this.current().activity;
      await this.save();
    });
  }

  async cleanUpMerge(
    pullRequest: PullRequest,
    install?: string,
    progress: MergeCleanup = {},
  ): Promise<CleanupResult> {
    let acted: CleanupResult = false;
    await this.operate('cleaning', async () => {
      const abort = (this.cleanupCancellation = new AbortController());
      if (this.cancelled) abort.abort();
      try {
        acted = await runMergeCleanup(pullRequest, progress, {
          store: this.store,
          memory: this.memory,
          conversation: this.current(),
          install,
          signal: abort.signal,
          notice: (text) => this.notice(text),
        });
      } finally {
        this.cleanupCancellation = undefined;
      }
    });
    return acted;
  }

  /** `/review`'s rounds as one operation; true once they settle or stop at a regression and the operation settles cleanly. */
  async review(argument: string): Promise<boolean> {
    const conversation = this.current();
    const abort = new AbortController();
    return runReviewCommand(argument, {
      conversation,
      coordination: this.coordination,
      reviewers: this.reviewers,
      agents: this.snapshot.agents,
      signal: abort.signal,
      notice: (text) => this.notice(text),
      display: (update) => this.display(update),
      retain: (text) => this.retainContext(conversation.id, [text]),
      turn: async (prompt) => {
        const done = await this.runTurn(prompt, 'turn', { silent: true });
        if (done?.status !== 'completed' || this.cancelled) return false;
        if (this.halted() || conversation.activity) return false;
        const { recovery, failure } = await settleMemory(this.workspace!);
        if (failure) this.notice(`Memory publication failed: ${failure}`);
        return !recovery && !failure;
      },
      operate: (rounds) =>
        this.operate('running', () => {
          this.reviewCancellation = abort;
          return rounds().finally(() => (this.reviewCancellation = undefined));
        }),
      idle: () => !this.snapshot.error && this.snapshot.phase === 'idle',
    });
  }

  async restoreMemory(path: string, revision: string): Promise<void> {
    await this.operate('editing', async () => {
      this.notice(
        `Memory restore: ${noticeText(path)} at ${revision.slice(0, 8)}`,
        this.workspace!.root,
      );
      await this.beginActivity('memory-edit');
      await this.workspace!.restore(path, revision);
      delete this.current().activity;
      await this.save();
    });
  }

  /** a refusal posts a transient notice, so queued prompts stay runnable. */
  report(error: unknown): void {
    if (this.snapshot.phase === 'error') return;
    if (error instanceof Refusal && this.record)
      return this.notice(error.message, undefined, false);
    this.publish({ error: errorMessage(error) });
  }

  async close(options: { restart?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.copilot.close();
    const stop = { ...options, deadline: stopDeadline() };
    this.coordination?.attach(undefined);
    const quiescing = this.coordination?.quiesce();
    // interrupt() reads the phase before `closing` replaces it
    const interrupting = this.interrupt(stop);
    this.publish({ phase: 'closing' });
    let failure: unknown;
    try {
      try {
        await Promise.all([interrupting, quiescing]);
      } catch (error) {
        failure = error;
        // Codex's close() interrupts again and would rethrow, so the session ends here
        await this.disconnect(false, false, stop).catch(() => {});
      }
      await this.task?.catch(() => {});
      await this.draining?.promise;
      // settle() returns early once closed, so an accepted recovery is published here
      if (
        (await this.workspace?.exists()) &&
        !(await this.workspace!.isDirty())
      )
        await this.workspace!.publish();
    } catch (error) {
      failure ??= error;
    } finally {
      try {
        await this.accountUsage.close(stop);
        await this.disconnect(false, false, stop);
      } finally {
        try {
          await this.coordination?.close(options);
        } finally {
          await this.files?.close();
        }
      }
    }
    if (failure !== undefined) throw failure;
  }

  async releaseTask(): Promise<void> {
    if (!this.coordination)
      throw new Error('Session coordination is unavailable.');
    await this.coordination.releaseTask();
  }

  async takeTask(reference: string): Promise<void> {
    if (!this.coordination)
      throw new Error('Session coordination is unavailable.');
    await this.coordination.takeTask(reference);
  }

  private handoff(selection: ModelSelection): Promise<void> {
    return handoff(
      {
        conversation: this.current(),
        snapshot: this.snapshot,
        memory: this.memory,
        coordination: this.coordination,
        cancelled: () => this.cancelled,
        closed: () => this.closed,
        session: () => this.session,
        send: (prompt, kind) => this.performTurn(prompt, kind),
        connect: (choice) => this.connect(choice.agent, undefined, choice),
        select: (session, choice) => this.applyModel(session, choice),
        disconnect: () => this.disconnect(),
        save: () => this.save(),
        publish: (update) => this.publish(update),
      },
      selection,
    );
  }

  private async performTurn(
    prompt: string,
    kind: 'turn' | 'handoff' | 'answer' | 'review',
    { delivered, queued = false, requests, silent, review }: TurnOptions = {},
  ): Promise<TurnResult> {
    const conversation = this.current();
    const answer = kind === 'answer';
    const automatic = answer || kind === 'review';
    if (kind === 'turn') this.publish({ completedTurn: undefined });
    const { activity, scope } = await this.beginActivity(
      automatic ? 'turn' : kind,
    );
    const session = await this.connectForTurn(scope);
    if (!session || this.cancelled) return { status: 'interrupted', text: '' };
    if (!answer) this.coordination?.beginTurn(activity.id);
    try {
      const batch = requests && (await preparePeerAnswers(requests));
      this.publish({
        subagents: this.snapshot.subagents.filter(
          ({ status }) => status === 'running',
        ),
      });
      const command = kind === 'turn' ? shellCommand(prompt) : undefined;
      const handoff = conversation.handoff;
      const pendingHandoff =
        !answer && handoff?.activated && handoff.to === conversation.agent
          ? handoff
          : undefined;
      const coordination = await this.coordination?.context();
      const pendingContext = automatic
        ? undefined
        : this.pendingContext.get(conversation.id);
      const context = () =>
        nativePrompt({
          prompt,
          memory: this.memory,
          workspace: this.workspace!,
          scope,
          revision: activity.baseRevision,
          reference: conversation.sessions[conversation.agent]!,
          pendingHandoff,
          coordination,
          pendingContext,
          command,
          familiarCommand:
            session.familiar && this.coordination
              ? {
                  command: this.coordination.commandPrefixes().familiar,
                  runtime: session.info.agent,
                }
              : undefined,
          merges: this.coordination?.events.mergeEvents(conversation.id),
          requests: batch,
          answers:
            kind === 'turn'
              ? this.coordination?.events.answered(conversation.id)
              : undefined,
          conflict: this.conflict,
          usage: this.accountUsage.context(this.snapshot.agents),
          reviewWatch: this.copilot.context(),
        });
      let input = await context();
      if (
        review &&
        (review.owner !== conversation.id ||
          !(await this.coordination?.reviews.owns(
            review.claim,
            review.pullRequest,
          )))
      )
        return { status: 'interrupted', text: '', inputUnsent: true };
      // a stop during an awaited check must prevent native input.
      if (this.cancelled || session.closed || (queued && this.deliveryHeld))
        return { status: 'interrupted', text: '' };
      if (kind === 'turn' && !silent && conversation.title === untitled)
        conversation.title = prompt.trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!silent)
        this.display({
          id: randomUUID(),
          kind: kind === 'turn' ? 'user' : 'notice',
          text: requests
            ? answerNotice(requests)
            : review
              ? `Handling ${review.items.length} Copilot findings on #${review.pullRequest.number}.`
              : prompt,
          cwd: conversation.cwd,
        });
      this.persist(this.save());
      if (command !== undefined) delivered?.();
      let result: TurnResult;
      let steering: Promise<void> | undefined;
      let generation = this.contextGeneration;
      try {
        const ran =
          command === undefined ? undefined : await session.shell(command);
        if (ran && ran.status !== 'completed') result = ran;
        else {
          if (generation !== this.contextGeneration) input = await context();
          if (this.cancelled || session.closed)
            result = { status: 'interrupted', text: '' };
          else {
            if (!automatic) this.pendingContext.delete(conversation.id);
            generation = this.contextGeneration;
            const sending = session.send(
              input.prompt,
              skillCall(prompt, this.snapshot.skills),
              input.context,
              automatic ? (answer ? 'peer-answer' : 'pr-review') : 'user',
              batch && {
                outputSchema: peerAnswerOutputSchema,
                requestFile: batch.file,
              },
            );
            const stopPolicy = watchClaimPolicy(
              this.coordination,
              kind === 'turn' ? coordination?.snapshot : undefined,
              (text) =>
                !this.cancelled &&
                this.session === session &&
                generation === this.contextGeneration
                  ? session.steer(text, { contextOnly: true })
                  : Promise.resolve(false),
            );
            // before any await, so these steers go ahead of a prompt sent once the turn runs, whose steer can wait for this turn to end
            if (queued && command === undefined) steering = this.steerQueued();
            result = await sending.finally(stopPolicy);
            if (requests)
              await recordPeerAnswers(result, requests, this.coordination!);
          }
        }
      } catch (error) {
        result = { status: 'failed', text: '', error: errorMessage(error) };
      }
      this.turnEnded = true;
      // first, so the prompts the turn left unread go ahead of those a refused steer gives back
      await steering;
      await this.compaction.busy;
      if (command === undefined && !result.inputUnsent) delivered?.();
      if (result.unread?.length)
        this.publish({ queue: [...result.unread, ...this.snapshot.queue] });
      if (result.inputUnsent)
        this.retainContext(conversation.id, pendingContext);
      this.retainContext(conversation.id, result.unreadContext);
      await this.finishActivity(activity, this.compaction.failure ?? result);
      if (result.status === 'completed' && !answer) {
        if (generation === this.contextGeneration) {
          const reference = conversation.sessions[activity.agent]!;
          reference.deliveredRevision = activity.baseRevision;
          reference.deliveredInstructionsRevision = input.instructionsRevision;
          recordDelivery(reference, input);
        }
        if (!automatic && pendingHandoff === conversation.handoff)
          delete conversation.handoff;
      }
      if (kind === 'turn')
        conversation.lastTurn = { id: activity.id, status: result.status };
      await this.save();
      if (kind === 'turn' && conversation.lastTurn?.status === 'completed')
        this.publish({ completedTurn: conversation.lastTurn.id });
      return result;
    } finally {
      await this.coordination?.endTurn(activity.id);
    }
  }

  compact(): Promise<boolean> {
    return this.compaction.start();
  }

  private performCompaction(): Promise<boolean> {
    return this.compaction.automatic(() => this.compactActivity());
  }

  private async compactActivity(): Promise<boolean> {
    const { activity, scope } = await this.beginActivity('turn');
    const result = await compactSession(
      () => this.connect(undefined, scope),
      () => this.cancelled,
      (text) => this.notice(text),
    );
    this.turnFailed = result.status !== 'completed';
    await this.finishActivity(activity, result);
    await this.save();
    this.turnFailed ||= this.cancelled;
    return !this.turnFailed;
  }

  private async finishActivity(
    activity: Activity,
    result: TurnResult,
  ): Promise<void> {
    const conversation = this.current();
    const completed = result.status === 'completed';
    await this.files!.flush();
    if (!completed) {
      this.notice(result.error ?? 'Turn interrupted');
      if (result.status === 'failed') this.turnFailed = true;
    }
    await endActivity(this.workspace!, conversation, activity, completed);
    if (completed) this.accountUsage.others(activity.agent, conversation.cwd);
  }

  private async beginActivity(kind: Activity['kind']) {
    const begun = await startActivity(this.workspace!, this.current(), kind);
    await this.save();
    return begun;
  }

  private live(agent: string): AgentSession | undefined {
    return this.session &&
      !this.session.closed &&
      this.session.info.agent === agent
      ? this.session
      : undefined;
  }

  private async connectForTurn(turnScope?: MemoryScope) {
    try {
      return await this.connect(this.current().agent, turnScope);
    } catch (error) {
      if (!this.cancelled || !aborted(error)) throw error;
    }
  }

  /** reuses the live session unless `turnScope` names project memory it was never granted. */
  private async connect(
    agent = this.current().agent,
    turnScope?: MemoryScope,
    selection?: ModelSelection,
  ): Promise<AgentSession> {
    const live = this.live(agent);
    if (live && (!turnScope || turnScope.project === this.sessionProject))
      return live;
    // an initial connect keeps the activation published when its conversation opened
    await this.disconnect(!this.session, agent === this.current().agent);
    const conversation = this.current();
    const files = this.files!;
    const tools = new Map<string, string>();
    const { adapter, executable } = this.catalog.installed(agent);
    const workspace = this.workspace!;
    await workspace.ensureWorktree();
    const scope = turnScope ?? (await workspace.scope(conversation.cwd));
    await this.coordination?.activate(conversation, scope.project);
    const stored = conversation.sessions[agent];
    this.connecting = new AbortController();
    try {
      const session = await adapter.connect({
        cwd: conversation.cwd,
        executable: executable!,
        resume: stored?.hasHistory ? stored.id : undefined,
        model: selection?.id ?? stored?.requestedModel,
        effort: selection
          ? (modelEffort(selection, this.snapshot.models, stored?.effort) ??
            undefined)
          : stored?.effort,
        memoryDirectories: workspace.directories(scope),
        signal: this.connecting.signal,
        onEvent: (event) => {
          if (!files.closed) this.receive(conversation, agent, event, tools);
        },
        ...processReports(conversation, files, (pid) => this.jobs?.track(pid)),
        mark: this.jobs,
        familiarBinding: this.coordination?.familiarBinding(),
        commandPrefixes: this.coordination?.commandPrefixes(),
      });
      this.session = session;
      this.sessionProject = scope.project;
      recordSession(conversation, agent, session.info);
      await this.save();
      if (this.connecting.signal.aborted)
        throw new DOMException('Connection was interrupted', 'AbortError');
      const models = await this.catalog.read(conversation.cwd, session);
      // read after models(), so a skills or usage event sent meanwhile is not replaced by an older value
      const skills = await session.skills().catch((error: unknown) => {
        this.notice(errorMessage(error), undefined, false);
        return [];
      });
      const live = this.live(agent);
      this.publish({
        native: live?.info,
        usage: live?.usage ?? {},
        models,
        latest: this.catalog.latest,
        skills,
      });
      this.accountUsage.connected(session, conversation.cwd);
      return session;
    } finally {
      this.connecting = undefined;
    }
  }

  private retainContext(id: string, context?: readonly string[]): void {
    if (!context?.length) return;
    const pending = this.pendingContext.get(id) ?? [];
    this.pendingContext.set(id, [...pending, ...context]);
  }

  private async disconnect(
    keepActivation = false,
    keepQuestions = false,
    stop?: AgentStopOptions,
  ): Promise<void> {
    if (!keepActivation && this.coordination) await this.coordination.quiesce();
    const conversationId = this.record?.id;
    const session = this.session;
    this.session = undefined;
    const owned = this.reviewers.owns;
    for (const event of stoppedActivity(this.snapshot, owned))
      this.background(event);
    this.publish({
      native: undefined,
      usage: {},
      skills: [],
      subagents: this.snapshot.subagents.filter(({ id }) => owned(id)),
      requests: keepQuestions
        ? this.snapshot.requests.filter((request) => request.replyAsPrompt)
        : [],
    });
    try {
      await session?.close(stop);
      if (!this.record) return;
      delete this.record.process;
      await this.save();
    } finally {
      // discard questions delivered while the old process was closing
      if (!keepQuestions) this.publish({ requests: [] });
      if (conversationId)
        this.retainContext(conversationId, session?.takeUnreadContext?.());
      if (!keepActivation) await this.coordination?.deactivate();
    }
  }

  private receive(
    conversation: ConversationRecord,
    agent: string,
    event: AgentEvent,
    tools: Map<string, string>,
  ): void {
    if (event.type === 'info') {
      recordSession(conversation, agent, event.info);
      this.persist(this.save());
      if (conversation.agent === agent)
        this.publish({ native: event.info, conversation });
    } else if (event.type === 'compacted') {
      this.contextGeneration++;
      const reference = conversation.sessions[agent];
      if (reference) clearDelivery(reference);
      this.persist(this.save());
      this.notice('Conversation compacted');
    } else if (event.type === 'request') {
      if (this.cancelled && event.request.replyAsPrompt) return;
      this.publish({ requests: [...this.snapshot.requests, event.request] });
    } else if (event.type === 'closed') {
      for (const event of stoppedActivity(this.snapshot, this.reviewers.owns))
        this.background(event);
      this.publish({
        native: undefined,
        usage: {},
        requests: this.snapshot.requests.filter(
          (request) => request.replyAsPrompt,
        ),
      });
    } else if (event.type === 'request-resolved') {
      this.publish({
        requests: this.snapshot.requests.filter(({ id }) => id !== event.id),
      });
    } else if (event.type === 'notice') {
      this.notice(event.text, undefined, !event.transient);
    } else if (event.type === 'skills') {
      if (this.live(agent)) this.publish({ skills: event.skills });
    } else if (event.type === 'usage') {
      this.accountUsage.report(agent, event.usage.account);
      if (this.live(agent)) this.publish({ usage: event.usage });
    } else if (event.type === 'subagent' || event.type === 'command') {
      if (this.live(agent)) this.background(event, conversation.cwd);
    } else if (event.type === 'spell') {
      this.display(castRow(event.cast, conversation.cwd));
    } else {
      let id = `${conversation.activity?.id ?? 'session'}/${agent}/${event.id}`;
      if (event.type === 'tool') {
        id = tools.get(event.id) ?? id;
        if (event.done) tools.delete(event.id);
        else tools.set(event.id, id);
      }
      this.display(agentDisplay(event, id, agent, conversation.cwd));
    }
  }

  private background(
    event: Extract<AgentEvent, { type: 'subagent' | 'command' }>,
    cwd = this.current().cwd,
  ): void {
    const update = updateBackgroundActivity(this.snapshot, event, cwd);
    if (!update) return;
    this.publish(update.state);
    for (const row of update.rows) this.display(row);
  }

  private display(update: DisplayUpdate, save = true): void {
    if (update.cast && this.snapshot.items.some(({ id }) => id === update.id))
      return;
    const stamped = { ...update, at: new Date().toISOString() };
    this.publish({ items: applyDisplayUpdate(this.snapshot.items, stamped) });
    if (save) this.persist(this.files!.append(stamped));
  }

  private userRow(text: string): void {
    const { cwd } = this.current();
    this.display({ id: randomUUID(), kind: 'user', text, cwd });
  }

  /** transient notices must not make an unused conversation resumable. */
  notice(text: string, cwd = this.current().cwd, save = true): void {
    this.display({ id: randomUUID(), kind: 'notice', text, cwd }, save);
  }

  private save(): Promise<void> {
    return this.files!.save(this.current());
  }

  private persist(operation: Promise<void>): void {
    void operation.catch((error: unknown) => this.enterError(error));
  }

  private enterError(error: unknown): Error {
    const text = `Restart Witch: ${errorMessage(error)}`;
    this.publish({ phase: 'error', error: text });
    return new Error(text, { cause: error });
  }

  private current(): ConversationRecord {
    if (!this.record) throw new Error('No active conversation');
    return this.record;
  }

  private async settle(report?: string): Promise<void> {
    if (this.closed) return;
    await this.files!.flush();
    const { recovery, failure } = await settleMemory(this.workspace!);
    if (recovery?.kind !== 'pending') delete this.current().activity;
    await this.save();
    const error = [report, failure].filter(Boolean).join('\n\n');
    this.publish({
      phase: recovery ? 'recovery' : 'idle',
      recovery,
      requests: this.snapshot.requests.filter(
        (request) => request.replyAsPrompt || request.survivesTurn,
      ),
      ...(error ? { error } : {}),
    });
  }

  private async operate(
    phase: Phase,
    operation: () => Promise<unknown>,
    expected: 'idle' | 'recovery' = 'idle',
  ): Promise<void> {
    if (this.snapshot.phase !== expected) {
      if (this.snapshot.phase === 'recovery')
        throw new Error('Resolve pending memory before running another task');
      if (this.snapshot.phase === 'error' && this.snapshot.error)
        throw new Error(this.snapshot.error);
      throw new Refusal(
        this.replied
          ? 'Wait for the running familiars or workflows to report, or press Escape to stop them'
          : 'Stop the current operation first',
      );
    }
    this.cancelled = false;
    this.turnEnded = false;
    this.operations++;
    this.compaction.beginActivity();
    if (expected === 'idle') this.turnFailed = false;
    this.publish({ phase, error: undefined });
    this.task = (async () => {
      let failure: unknown;
      try {
        await operation();
      } catch (error) {
        failure = error;
        this.report(error);
      }
      // the selector reports its failure; the original operation still needs to settle
      await this.changingModel?.catch(() => {});
      try {
        await this.settle();
      } catch (error) {
        throw this.enterError(error);
      }
      if (failure !== undefined) throw failure;
    })();
    try {
      await this.task;
    } finally {
      this.task = undefined;
      this.drainAfter();
    }
  }

  private publish(update: Partial<Snapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...update,
      commandsPending: this.deliveryHolds > 0,
      pendingCompaction: this.compaction.pending,
    };
    const active =
      agentWorking(this.snapshot.phase) || taskActivity(this.snapshot).running;
    this.pentacle.set(localActivity, active);
    this.jobs?.setActive(active);
    this.coordination?.update(this.snapshot);
    for (const listener of this.listeners) listener();
  }
}
