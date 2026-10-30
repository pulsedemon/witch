import { settleMemory } from './memory-settlement.js';
import { Compaction } from './compaction.js';
import { initialSnapshot } from './snapshot.js';
import type { Snapshot } from './snapshot.js';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { AgentRegistration } from '../agents/registry.js';
import { errorMessage } from '../agents/stderr.js';
import { NativeStop, stopDeadline } from '../agents/shutdown.js';
import type {
  AgentEvent,
  AgentSession,
  AgentStopOptions,
  TurnResult,
  Skill,
  UserResponse,
} from '../agents/types.js';
import { indexNote, main } from '../memory/memory.js';
import type { Memory, MemoryScope } from '../memory/memory.js';
import type { Workspace } from '../memory/workspace.js';
import type { ConversationStore, StateStore } from '../persistence/store.js';
import { identifyProcess } from '../persistence/process.js';
import { updateBackgroundActivity } from './background-activity.js';
import { castRow } from './spells.js';
import {
  missingDirectoryNotice,
  recoverConversations,
} from './startup-recovery.js';
import { editInVSCode } from './editor.js';
import { listFiles } from './files.js';
import {
  shellCommand,
  skillCall,
  ranCommand,
  nativePrompt,
  questionReply,
  noteName,
  memoryAttribution,
} from './prompts.js';
import { joining, nextTurn, steerInOrder, waitsBehind } from './queue.js';
import type { JobWatch } from './jobs.js';
import type { SessionCoordination } from './coordination.js';
import { watchClaimPolicy } from './coordination-policy.js';
import { taskActivity } from './coordination-state.js';
import { runMergeCleanup } from './merged.js';
import type { CleanupResult, MergeCleanup } from './merged.js';
import { PentacleActivity } from './pentacle-activity.js';
import { ModelCatalog, modelEffort } from './models.js';
import { AccountUsage } from './usage.js';
import type { ModelSelection } from './models.js';
import type { Conflict, PullRequest } from './repository.js';
import { watchMergeNotices } from './merge-events.js';
import {
  agentDisplay,
  agentWorking,
  applyDisplayUpdate,
  clearConversationContext,
  contextStart,
  createConversation,
  recordSession,
  untitled,
} from './state.js';
import type {
  Conversation,
  ConversationRecord,
  DisplayUpdate,
  Phase,
} from './state.js';

const compactAt = 80;
const localActivity = Symbol('local activity');
type Activity = NonNullable<ConversationRecord['activity']>;

/** the revision one memory UI action reads, resolved once so a publish mid-action can't move it. */
interface MemoryView {
  revision: string;
  scope: MemoryScope;
  /** the conversation's worktree, for links, while it holds this revision. */
  root?: string;
}

interface Launch {
  continue?: boolean;
  conversation?: string;
}

/** another operation holds the phase, so nothing ran and nothing failed. */
class Refusal extends Error {}

const aborted = (error: unknown) =>
  error instanceof Error && error.name === 'AbortError';

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
    failed: () => {
      this.turnFailed = true;
    },
    notice: (text) => this.notice(text),
    report: (error) => this.report(error),
  });
  private opening = false;
  private admitting: Promise<unknown> = Promise.resolve();
  private connecting?: AbortController;
  private editorCancellation?: AbortController;
  private cleanupCancellation?: AbortController;
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
    this.accountUsage = new AccountUsage(agents, (limits) =>
      this.publish({ limits }),
    );
    this.snapshot = initialSnapshot(agents);
    this.coordination?.attach(() => this.session);
    this.publish({});
    watchMergeNotices(
      coordination,
      () => this.snapshot,
      (notice) => {
        if (!this.closed) this.display(notice);
      },
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** opens the `conversation` it names, or with `continue` the most recent one in `directory`, or a new one there. */
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
        id ? { id } : { create: await this.launchRecord(cwd) },
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

  private async launchRecord(cwd: string): Promise<Conversation> {
    const [source] = await this.store.conversations();
    const installed = this.agents.filter(({ executable }) => executable);
    const agent =
      installed.find(({ adapter }) => adapter.id === source?.agent) ??
      installed[0] ??
      this.agents[0]!;
    return createConversation(cwd, agent.adapter.id, source);
  }

  /** claims the target first, so a failed claim leaves the current conversation untouched. */
  private async openConversation(
    target: { id: string } | { create: Conversation },
  ): Promise<void> {
    this.opening = true;
    try {
      // a queued prompt belongs to the conversation it was sent in, so none is taken until the next one opens,
      // including one sent just before the switch whose admission is still pending
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
            .catch((error: unknown) => {
              failure ??= error;
            });
        await this.files?.close().catch((error: unknown) => {
          failure ??= error;
        });
      }
      this.files = files;
      this.record = files.record;
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
    // a steer can wait on the agent, so each prompt steers or queues only after those sent before it
    const admitted = this.admitting.then(async () => {
      if (
        !waitsBehind(this.snapshot.queue, this.snapshot.skills) &&
        (await this.steer(prompt))
      )
        return true;
      this.publish({ queue: [...this.snapshot.queue, prompt] });
      return false;
    });
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
      this.cancelled ||
      !session ||
      this.deliveryHeld ||
      this.halted()
    )
      return false;
    const row = () =>
      this.display({
        id: randomUUID(),
        kind: 'user',
        text: prompt,
        cwd: this.current().cwd,
      });
    const command = shellCommand(prompt);
    if (command !== undefined) {
      if (!this.replied) return false;
      // shown first, since a command's output streams as soon as it starts
      row();
      return session.steer(`${prompt}\n\n${ranCommand}`, { command });
    }
    const skill = skillCall(prompt, this.snapshot.skills);
    if (
      !(await (skill
        ? session.steer(prompt.trimStart(), { skill })
        : session.steer(prompt)))
    )
      return false;
    row();
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
    if (!this.snapshot.queue.length) return;
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
      while (
        !this.deliveryHeld &&
        this.snapshot.phase === 'idle' &&
        this.snapshot.queue.length
      ) {
        const queue = this.snapshot.queue;
        const batch = nextTurn(
          queue,
          this.session ? this.snapshot.skills : undefined,
        );
        this.publish({ queue: queue.slice(batch.length) });
        let delivered = false;
        try {
          await this.operate('running', async () => {
            try {
              const session = await this.connectForTurn();
              if (!session) return;
              const usage = session.info.hasHistory
                ? await session.contextUsage()
                : undefined;
              if (this.cancelled || session.closed || this.session !== session)
                return;
              if (this.deliveryHeld) return;
              if (usage !== undefined && usage >= compactAt) {
                this.publish({ phase: 'compacting' });
                if (!(await this.performCompaction())) return;
                this.publish({ phase: 'running' });
              }
              if (this.deliveryHeld) return;
              await this.performTurn(
                batch.join('\n'),
                'turn',
                () => (delivered = true),
                true,
              );
            } catch (error) {
              this.report(error);
            }
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
      this.registration(chosen);
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
        this.registration(selection.agent);
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

  async interrupt(options: AgentStopOptions = {}): Promise<void> {
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
    const results = await Promise.allSettled([
      this.cleanupCancellation ? this.task : undefined,
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
      else
        this.display({
          id: randomUUID(),
          kind: 'user',
          text,
          cwd: this.current().cwd,
        });
    }
    if (response.decision === 'cancel') await this.interrupt();
  }

  async recoverMemory(decision: 'accept' | 'discard' | 'keep'): Promise<void> {
    const kind = this.snapshot.recovery?.kind;
    await this.operate(
      'editing',
      async () => {
        const workspace = this.workspace!;
        if (kind === 'conflict') {
          if (decision === 'keep') await workspace.keepMine();
          else if (decision === 'discard') await workspace.discardMine();
          else throw new Error('Keep your memory changes or discard them.');
        } else {
          const origin = this.current().activity;
          const actor =
            origin?.kind === 'memory-edit'
              ? 'manual'
              : (origin?.agent ?? 'manual');
          if (decision === 'accept')
            await workspace.commit(
              `chore(memory): recover ${actor} changes\n\n${memoryAttribution(origin ? this.current().id : 'manual', origin?.id ?? 'manual')}`,
            );
          else if (decision === 'discard') await workspace.discardPending();
          else throw new Error('Accept these memory changes or discard them.');
          delete this.current().activity;
        }
        if (decision === 'discard')
          for (const reference of Object.values(this.current().sessions))
            delete reference.deliveredRevision;
        await this.save();
      },
      'recovery',
    );
  }

  async memoryView(): Promise<MemoryView> {
    const workspace = this.workspace!;
    const revision = await this.memory.resolve(main);
    const scope = await this.memory.scopePaths(this.current().cwd);
    // an idle worktree stays where its last turn left it, behind anything published since
    const linked =
      (await workspace.exists()) && (await workspace.revision()) === revision;
    return { revision, scope, ...(linked ? { root: workspace.root } : {}) };
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
      this.notice(`Memory edit: ${noteName(note)}`, this.workspace!.root);
      await this.beginActivity('memory-edit');
      const file = await this.workspace!.prepareNote(note);
      this.editorCancellation = new AbortController();
      try {
        await this.editFile(file, this.editorCancellation.signal);
      } catch (error) {
        if (!this.cancelled || !aborted(error)) throw error;
      } finally {
        this.editorCancellation = undefined;
      }
      if (this.cancelled) return;
      await this.workspace!.commit('chore(memory): save edited notes');
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

  async restoreMemory(path: string, revision: string): Promise<void> {
    await this.operate('editing', async () => {
      this.notice(
        `Memory restore: ${noteName(path)} at ${revision.slice(0, 8)}`,
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

  private async handoff(selection: ModelSelection): Promise<void> {
    const { agent } = selection;
    const conversation = this.current();
    const { agent: from, handoff: previousHandoff } = conversation;
    const outcome = conversation.lastTurn?.status;
    const unfinished = outcome === 'interrupted' || outcome === 'failed';
    const previous = conversation.sessions[agent];
    let activated = false;
    try {
      let summary = '';
      if (
        this.snapshot.items
          .slice(contextStart(this.snapshot.items))
          .some((item) => item.kind === 'user')
      ) {
        const result = await this.performTurn(
          'Produce a concise handoff summary: objective, constraints, verified decisions, changed files, completed checks, and remaining work. Only summarize. Do not run tools or change files.',
          'handoff',
        );
        if (result.status !== 'completed')
          throw new Error(result.error ?? 'Handoff was interrupted');
        summary = result.text;
      }
      conversation.handoff = { from, to: agent, summary, activated: false };
      await this.save();
      if (this.cancelled) throw new Error('Handoff was interrupted');
      const session = await this.connect(agent, undefined, selection);
      const selected = await this.applyModel(session, selection);
      if (this.cancelled) throw new Error('Handoff was interrupted');
      conversation.agent = agent;
      conversation.sessions[agent] = selected;
      conversation.handoff.activated = true;
      await this.save();
      activated = true;
      this.publish({ conversation, native: this.session?.info });
      if (summary && unfinished)
        await this.performTurn(
          'Continue the task described by the handoff context. Check the working files before relying on statements about their state.',
          'turn',
        );
      else if (!summary) delete conversation.handoff;
      await this.save();
    } catch (error) {
      if (!activated) {
        conversation.agent = from;
        if (conversation.handoff !== previousHandoff)
          delete conversation.handoff;
        await this.disconnect().catch(() => {});
        if (previous) conversation.sessions[agent] = previous;
        else delete conversation.sessions[agent];
      }
      await this.save();
      this.publish({
        conversation,
        native: this.session?.info,
        usage: this.session?.usage ?? {},
      });
      if (!activated && this.coordination) {
        const { project } = await this.memory.scopePaths(conversation.cwd);
        if (!this.closed)
          await this.coordination.activate(conversation, project);
      }
      throw error;
    }
  }

  private async performTurn(
    prompt: string,
    kind: 'turn' | 'handoff',
    delivered?: () => void,
    queued = false,
  ): Promise<TurnResult> {
    const conversation = this.current();
    if (kind === 'turn') this.publish({ completedTurn: undefined });
    const { activity, scope } = await this.beginActivity(kind);
    const session = await this.connectForTurn(scope);
    if (!session || this.cancelled) return { status: 'interrupted', text: '' };
    this.coordination?.beginTurn(activity.id);
    try {
      this.publish({
        subagents: this.snapshot.subagents.filter(
          ({ status }) => status === 'running',
        ),
      });
      const command = kind === 'turn' ? shellCommand(prompt) : undefined;
      const handoff = conversation.handoff;
      const pendingHandoff =
        handoff?.activated && handoff.to === conversation.agent
          ? handoff
          : undefined;
      const coordination = await this.coordination?.context();
      const pendingContext = this.pendingContext.get(conversation.id);
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
          merges: this.coordination?.mergeEvents(conversation.id),
          conflict: this.conflict,
          usage: this.accountUsage.context(this.snapshot.agents),
        });
      let input = await context();
      // no await from here to the command or the send, so a Ctrl+C before them never reaches the agent
      if (this.cancelled || session.closed || (queued && this.deliveryHeld))
        return { status: 'interrupted', text: '' };
      if (kind === 'turn' && conversation.title === untitled)
        conversation.title = prompt.trim().replace(/\s+/g, ' ').slice(0, 80);
      this.display({
        id: randomUUID(),
        kind: kind === 'handoff' ? 'notice' : 'user',
        text: prompt,
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
            this.pendingContext.delete(conversation.id);
            generation = this.contextGeneration;
            const sending = session.send(
              input.prompt,
              skillCall(prompt, this.snapshot.skills),
              input.context,
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
      if (result.status === 'completed') {
        if (generation === this.contextGeneration) {
          const reference = conversation.sessions[activity.agent]!;
          reference.deliveredRevision = activity.baseRevision;
          reference.deliveredInstructionsRevision = input.instructionsRevision;
          if (input.merges.length)
            reference.deliveredMerges = Array.from(
              new Set([...(reference.deliveredMerges ?? []), ...input.merges]),
            );
        }
        if (pendingHandoff === conversation.handoff)
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
    const conversation = this.current();
    const { activity, scope } = await this.beginActivity('turn');
    let result: TurnResult = { status: 'interrupted', text: '' };
    try {
      const session = await this.connect(conversation.agent, scope);
      if (!this.cancelled && !session.closed) {
        if (session.info.hasHistory) result = await session.compact();
        else {
          this.notice('No conversation history to compact');
          result = { status: 'completed', text: '' };
        }
      }
    } catch (error) {
      result = { status: 'failed', text: '', error: errorMessage(error) };
    }
    if (this.cancelled) result = { status: 'interrupted', text: '' };
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
    const workspace = this.workspace!;
    await this.files!.flush();
    if (result.status === 'completed') {
      await workspace.commit(
        `chore(memory): save ${activity.agent} notes\n\n${memoryAttribution(conversation.id, activity.id)}`,
      );
      delete conversation.activity;
      this.accountUsage.others(activity.agent, conversation.cwd);
    } else {
      this.notice(result.error ?? 'Turn interrupted');
      if (result.status === 'failed') this.turnFailed = true;
      if (!(await workspace.isDirty())) delete conversation.activity;
    }
  }

  private async beginActivity(kind: Activity['kind']): Promise<{
    activity: Activity;
    scope: MemoryScope;
  }> {
    const conversation = this.current();
    const workspace = this.workspace!;
    await workspace.ensureWorktree();
    const begun = await workspace.begin(conversation.cwd);
    const activity = {
      id: randomUUID(),
      agent: conversation.agent,
      kind,
      baseRevision: begun.revision,
      startedAt: new Date().toISOString(),
    };
    conversation.activity = activity;
    await this.save();
    return { activity, scope: begun.scope };
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
    const { adapter, executable } = this.registration(agent);
    const workspace = this.workspace!;
    await workspace.ensureWorktree();
    const scope = turnScope ?? (await workspace.scope(conversation.cwd));
    await this.coordination?.activate(conversation, scope.project);
    const stored = conversation.sessions[agent];
    const identify =
      (key: 'process' | 'usageProcess' | 'shell') => async (pid?: number) => {
        const id = pid === undefined ? undefined : await identifyProcess(pid);
        if (files.closed) return;
        conversation[key] = id;
        await files.save(conversation);
      };
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
        onProcess: identify('process'),
        onUsageProcess: identify('usageProcess'),
        // a `!cmd &` shell can exit before the next read, so its group goes over at spawn
        onShell: async (pid) => {
          if (pid !== undefined) this.jobs?.track(pid);
          await identify('shell')(pid);
        },
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
      let skills: Skill[] = [];
      try {
        skills = await session.skills();
      } catch (error) {
        this.notice(errorMessage(error), undefined, false);
      }
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
    this.stopBackgroundActivity();
    this.publish({
      native: undefined,
      usage: {},
      skills: [],
      subagents: [],
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

  private stopBackgroundActivity(): void {
    for (const subagent of this.snapshot.subagents)
      if (subagent.status === 'running')
        this.background({
          type: 'subagent',
          subagent: { ...subagent, status: 'stopped' },
        });
    for (const command of this.snapshot.backgroundCommands)
      this.background({
        type: 'command',
        command: { ...command, status: 'stopped' },
      });
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
      if (reference) {
        delete reference.deliveredRevision;
        delete reference.deliveredInstructionsRevision;
        delete reference.deliveredMerges;
      }
      this.persist(this.save());
      this.notice('Conversation compacted');
    } else if (event.type === 'request') {
      if (this.cancelled && event.request.replyAsPrompt) return;
      this.publish({ requests: [...this.snapshot.requests, event.request] });
    } else if (event.type === 'closed') {
      this.stopBackgroundActivity();
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
      this.accountUsage.report(agent, event.usage.limits);
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

  private registration(id: string): AgentRegistration {
    const registration = this.agents.find(({ adapter }) => adapter.id === id);
    if (!registration?.executable)
      throw new Error(
        `${registration?.adapter.label ?? id} is not installed. Install its native CLI and sign in before using it.`,
      );
    return registration;
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
    operation: () => Promise<void>,
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
