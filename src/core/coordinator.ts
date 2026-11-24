import { settleMemory } from './memory-settlement.js';
import { RuntimeSwitch } from './runtime-switch.js';
import { SessionLink, type LinkJobs } from './session-link.js';
import { TurnRunner } from './turn-runner.js';
import { PromptDelivery } from './prompt-delivery.js';
import { CopilotReviewController } from './review/copilot-review-controller.js';
import { PullRequestRepair } from './repository/pr-repair.js';
import { Compaction } from './compaction.js';
import { Attachments, imagePaste, unnumbered } from './attachments.js';
import { initialSnapshot, type Snapshot } from './snapshot.js';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { AgentRegistration } from '../agents/registry.js';
import { aborted, errorMessage, failureOf } from '../errors.js';
import { NativeStop, stopDeadline } from '../agents/shutdown.js';
import type {
  AgentEvent,
  AgentStopOptions,
  UserResponse,
} from '../agents/types.js';
import { noticeText } from '../memory/memory.js';
import { indexNote } from '../memory/names.js';
import type { Memory, MemoryScope } from '../memory/memory.js';
import type { Workspace } from '../memory/workspace.js';
import type {
  ConversationStore,
  ListedConversation,
  StateStore,
} from '../persistence/store.js';
import { updateBackgroundActivity } from './background-activity.js';
import { startupMoves } from './repository/move-repair.js';
import { launchRecord, recoverConversations } from './startup-recovery.js';
import { editInVSCode } from './editor.js';
import { editNote, memoryView, recoverMemory } from './memory-actions.js';
import type { MemoryView } from './memory-actions.js';
import { listFiles } from './files.js';
import { questionReply } from './prompts.js';
import type { WorkTreeChanges } from './repository/work-tree-changes.js';
import type { SessionCoordination } from './coordination/coordination.js';
import {
  sessionWorking,
  witchWorking,
} from './coordination/coordination-state.js';
import { runMergeCleanup } from './repository/merged.js';
import type { CleanupResult, MergeCleanup } from './repository/merged.js';
import { PentacleActivity } from './pentacle-activity.js';
import { adoptMoved, startActivity, type Activity } from './activity.js';
import { runReviewCommand } from './review/review-run.js';
import { Reviewers } from './review/reviewers.js';
import { ModelCatalog, type ModelSelection } from './runtime/models.js';
import { AccountUsage } from './runtime/usage.js';
import type { Conflict } from './repository/repository.js';
import type { PullRequest } from './repository/pull-requests.js';
import { watchEventNotices } from './coordination/conversation-events.js';
import { ConversationPauses } from './coordination/conversation-pauses.js';
import {
  agentWorking,
  applyDisplayUpdate,
  createConversation,
  type Conversation,
  type ConversationRecord,
  type DisplayUpdate,
  type Phase,
} from './state.js';

const localActivity = Symbol('local activity');

interface Launch {
  continue?: boolean;
  conversation?: string;
}

/** another operation holds the phase, so nothing ran and nothing failed. */
class Refusal extends Error {
  reported = false;
}

export class Coordinator {
  readonly pentacle = new PentacleActivity();
  snapshot: Snapshot;
  conflict?: Conflict;
  private record?: ConversationRecord;
  private files?: ConversationStore;
  private workspace?: Workspace;
  private listeners = new Set<() => void>();
  private task?: Promise<unknown>;
  private cancelled = false;
  /** memory recovery must keep a failed turn's queue held for the composer. */
  private turnFailed = false;
  /** counts admitted operations, so a waiting choice can tell another one ran. */
  private operations = 0;
  private stops = 0;
  private readonly pendingStops = new Set<Promise<void>>();
  private closed = false;
  /** a model change accepted during a turn can outlive it. */
  private changingModel?: Promise<void>;
  private modelRefresh?: { cancelled: boolean };
  private readonly catalog: ModelCatalog;
  private readonly link: SessionLink;
  private readonly turns: TurnRunner;
  private readonly delivery: PromptDelivery;
  private readonly attachments = new Attachments();
  readonly accountUsage: AccountUsage;
  /** the familiars Witch launches itself, which the familiar mailbox consults before the live session. */
  readonly reviewers = new Reviewers((event) => this.background(event));
  private readonly pauses = new ConversationPauses({
    conversation: () => this.record?.id,
    coordination: () => this.coordination,
    closed: () => this.closed,
    nativeRunning: () => this.snapshot.nativeRunning,
    task: () => this.task,
    draining: () => this.delivery.drained,
    holdDelivery: () => this.holdPromptDelivery(),
    stop: () => this.stopCurrent(),
    changed: () => this.delivery.drainAfter(),
    notice: (text) => this.notice(text, { save: false }),
  });
  readonly copilot = new CopilotReviewController({
    record: () => this.record,
    coordination: () => this.coordination,
    ready: () =>
      this.delivery.automaticReady() &&
      !this.snapshot.queue.length &&
      !this.delivery.answerReady() &&
      !this.repair.ready(),
    save: () => this.save(),
    notice: (text) => {
      if (!this.closed && this.record) this.notice(text);
    },
    changed: () => this.delivery.drainAfter(),
    run: (batch) => this.turns.reviewCopilot(batch),
    interrupt: () => this.stopCurrent(),
  });
  readonly repair = new PullRequestRepair({
    record: () => this.record,
    coordination: () => this.coordination,
    ready: () => this.delivery.automaticReady() && !this.snapshot.queue.length,
    queued: () => !!this.snapshot.queue.length,
    notice: (text) => {
      if (!this.closed && this.record) this.notice(text);
    },
    changed: () => this.delivery.drainAfter(),
    run: (repair, refused) => this.turns.repairPullRequest(repair, refused),
    interrupt: () => this.stopCurrent(),
  });
  private readonly runtimes = new RuntimeSwitch({
    conversation: () => this.current(),
    snapshot: () => this.snapshot,
    memory: () => this.memory,
    coordination: () => this.coordination,
    usage: () => this.accountUsage,
    cancelled: () => this.cancelled,
    closed: () => this.closed,
    session: () => this.link.session,
    send: (prompt, kind, images) =>
      this.turns.perform(prompt, kind, { images }),
    connect: (choice, ready = () => true) =>
      this.link.connect(choice.agent, undefined, choice, ready),
    disconnect: () => this.link.disconnect({ keepQuestions: true }),
    save: () => this.save(),
    publish: (update) => this.publish(update),
    notice: (text) => this.notice(text),
    operate: (operation) => this.operate('switching', operation),
    failed: (failed) => (this.turnFailed = failed),
    prepareBackground: () => this.operate('switching', async () => {}),
    changed: () => this.delivery.drainAfter(),
    compactionOnly: (): boolean =>
      this.compaction.pending && this.delivery.compactionOnly,
  });
  private readonly compaction = new Compaction({
    state: () => ({
      conversation: this.record?.id,
      phase: this.snapshot.phase,
      closed: this.closed,
      halted: this.halted(),
      replied: this.replied,
      parent: this.task,
      draining: this.delivery.drained,
      session: this.link.session,
    }),
    idle: async () => {
      let success = false;

      await this.operate('compacting', async () => {
        success = (await this.turns.compact()).status === 'completed';
      });

      return success;
    },
    changed: () => {
      this.publish({});
      this.delivery.drainAfter();
    },
    failed: () => (this.turnFailed = true),
    notice: (text) => this.notice(text),
    report: (error) => this.report(error),
    exhaustion: () => this.runtimes.backgroundSettled,
  });
  private opening = false;
  private editorCancellation?: AbortController;
  private cleanupCancellation?: AbortController;
  private reviewCancellation?: AbortController;
  constructor(
    private readonly store: StateStore,
    readonly memory: Memory,
    private readonly agents: readonly AgentRegistration[],
    private readonly jobs?: LinkJobs,
    private readonly editFile = editInVSCode,
    readonly coordination?: SessionCoordination,
    changes?: WorkTreeChanges,
  ) {
    this.catalog = new ModelCatalog(agents, (error) =>
      this.notice(errorMessage(error), { save: false }),
    );

    this.accountUsage = new AccountUsage(agents, (accounts) =>
      this.publish({ accounts }),
    );

    this.link = new SessionLink(
      {
        conversation: () => this.current(),
        record: () => this.record,
        files: () => this.files!,
        workspace: () => this.workspace!,
        snapshot: () => this.snapshot,
        cancelled: () => this.cancelled,
        exhausted: (session, limit) => {
          if (this.delivery.automaticHeld || this.pauses.held || this.closed)
            return;

          this.runtimes.backgroundExhausted(session, limit);
          this.delivery.drainAfter();
        },
        publish: (update) => this.publish(update),
        display: (update) => this.display(update),
        notice: (text, options) => this.notice(text, options),
        background: (event, cwd) => this.background(event, cwd),
        save: () => this.save(),
        persist: (operation) => this.persist(operation),
        retain: (id, context) => this.turns.retain(id, context),
      },
      this.catalog,
      this.accountUsage,
      this.reviewers,
      coordination,
      jobs,
      changes,
    );

    this.turns = new TurnRunner(
      {
        conversation: () => this.current(),
        workspace: () => this.workspace!,
        files: () => this.files!,
        snapshot: () => this.snapshot,
        conflict: () => this.conflict,
        cancelled: () => this.cancelled,
        deliveryHeld: () =>
          this.delivery.deliveryHeld || this.runtimes.backgroundPending,
        publish: (update) => this.publish(update),
        display: (update) => this.display(update),
        notice: (text) => this.notice(text),
        report: (error) => this.report(error),
        save: () => this.save(),
        persist: (operation) => this.persist(operation),
        beginActivity: (kind, scope) => this.beginActivity(kind, scope),
        steerQueued: () => this.delivery.steerQueued(),
        prepareImages: (prompt) =>
          this.attachments.prepare(
            this.attachments.resolve(prompt),
            this.files!,
          ),
        operate: (operation) => this.operate('running', operation),
        failed: (failed) => (this.turnFailed = failed),
        acceptMemory: (agent) =>
          !this.cancelled && this.runtimes.acceptMemory(agent),
      },
      memory,
      this.link,
      this.compaction,
      this.accountUsage,
      this.copilot,
      coordination,
    );

    this.delivery = new PromptDelivery(
      {
        snapshot: () => this.snapshot,
        record: () => this.record,
        current: () => this.current(),
        files: () => this.files,
        task: () => this.task,
        opening: () => this.opening,
        closed: () => this.closed,
        cancelled: () => this.cancelled,
        replied: () => this.replied,
        halted: () => this.halted(),
        publish: (update) => this.publish(update),
        persist: (operation) => this.persist(operation),
        save: () => this.save(),
        userRow: (text, images) => this.userRow(text, images),
        report: (error) => this.report(error),
        operate: (operation) => this.operate('running', operation),
      },
      this.attachments,
      this.link,
      this.turns,
      this.runtimes,
      this.compaction,
      this.pauses,
      this.copilot,
      this.repair,
      coordination,
    );

    this.snapshot = initialSnapshot(this.catalog.availability);
    this.coordination?.attach(() => this.link.session);
    this.publish({});

    watchEventNotices(
      coordination,
      () => this.snapshot,
      (notice) => {
        if (!this.closed) this.display(notice);
      },
    );

    coordination?.subscribe(() => {
      this.pauses.apply();
      this.copilot.checkBinding();
      this.repair.checkBinding();

      if (!this.snapshot.queue.length) this.delivery.drainAfter();
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
      this.delivery.drainAfter();
    }
  }
  private async load(directory: string, options: Launch): Promise<void> {
    await this.memory.initialize();
    const cwd = await realpath(directory);
    const moved = await startupMoves(this.store, this.memory, cwd);

    const id =
      options.conversation ??
      (options.continue
        ? (await this.store.conversations(cwd))[0]?.id
        : undefined);

    const report = await recoverConversations(this.store, this.memory, id);
    let scope: MemoryScope;

    try {
      scope = await this.openConversation(
        id
          ? { id }
          : { create: await launchRecord(this.store, this.agents, cwd) },
      );
    } catch (error) {
      if (report === undefined) throw error;

      throw new Error(`${errorMessage(error)}\n\n${report}`, { cause: error });
    }

    // a failed connect leaves the conversation open, as a failed send does
    const failure = await failureOf(this.link.connect(undefined, scope));

    if (moved) this.notice(moved, { save: false });

    const adoption = await failureOf(
      adoptMoved(
        this.workspace!,
        scope,
        this.current().cwd,
        this.store.root,
      ).then((notice) => notice && this.notice(notice, { save: false })),
    );

    // a scope directory that can't be created can fail both, so its message shows once
    await this.settle(
      [...new Set([report, failure, adoption].filter(Boolean))].join('\n\n') ||
        undefined,
    );
  }

  /** claims the target first, so a failed claim leaves the current conversation untouched. a created target's id is new, so it has no memory branch to repair. */
  private async openConversation(
    target: { id: string } | { create: Conversation },
  ): Promise<MemoryScope> {
    this.opening = true;

    try {
      await this.refuseQueued();

      const files =
        'id' in target
          ? await this.store.claim(target.id)
          : await this.store.create(target.create);

      const workspace = this.memory.workspace(files.directory, files.record.id);
      let items;

      try {
        items = await files.items();

        if ('id' in target) await workspace.repairWorktree();
      } catch (error) {
        await files.close().catch(() => {});

        throw error;
      }

      let failure: unknown;

      try {
        await this.link.disconnect();
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

      if (!this.record) items.push(...this.snapshot.items);

      this.files = files;
      this.record = files.record;
      this.delivery.automaticHeld = false;
      this.copilot.activate();
      this.repair.resume();
      this.workspace = workspace;

      if (!this.record.handoff?.activated) delete this.record.handoff;

      const queue = (this.record.queue ?? []).map(unnumbered);
      this.delivery.restore(queue);

      this.publish({
        conversation: this.record,
        queue,
        draft: this.record.draft && unnumbered(this.record.draft),
        items,
        models: [],
        native: undefined,
        usage: {},
        openedAt: Date.now(),
        completedTurn: undefined,
      });

      if (failure !== undefined) this.report(failure);

      const scope = await this.memory.scopePaths(this.record.cwd);
      await this.coordination?.activate(this.record, scope.project);

      return scope;
    } finally {
      this.opening = false;
    }
  }

  send(prompt: string, options: { composer?: boolean } = {}): Promise<void> {
    return this.delivery.send(prompt, options);
  }

  unqueue(draft: string): string[] {
    return this.delivery.unqueue(draft);
  }

  draft(id: string, text: string): void {
    this.delivery.draft(id, text);
  }

  holdPromptDelivery(compacting?: () => boolean): () => void {
    return this.delivery.holdPromptDelivery(compacting);
  }

  /** the markers for a paste that lists image files, spaced from a word before them; undefined leaves the paste as text. */
  paste = (text: string, before: string): string | undefined => {
    const paths = imagePaste(text);

    if (!paths) return;

    try {
      const markers = paths.map((path) => this.attachments.attach(path));

      return `${/\S$/.test(before) ? ' ' : ''}${markers.join(' ')}`;
    } catch {
      // a file removed since it was checked
      return;
    }
  };

  private get replied(): boolean {
    return this.snapshot.phase === 'running' && !!this.link.session?.replied;
  }
  /** a report or failed turn stays on screen, and the composer takes back what is queued; after an interrupt it runs, unless the interrupt stopped a switch after usage exhaustion. */
  private halted(): boolean {
    return !!this.snapshot.error || this.turnFailed;
  }

  /** without an agent, continues on this conversation's agent, model and effort. */
  async newConversation(agent?: string): Promise<void> {
    await this.operate('starting', async () => {
      const source = this.current();
      const chosen = agent ?? source.agent;
      this.catalog.installed(chosen);

      const scope = await this.openConversation({
        create: createConversation(source.cwd, chosen, source),
      });

      await this.link.connect(undefined, scope);
    });
  }

  async clear(): Promise<void> {
    await this.operate('starting', async () => {
      await this.refuseQueued();
      const conversation = this.current();

      await this.link.clear(
        await this.memory.scopePaths(conversation.cwd),
        () => this.turns.forget(conversation.id),
      );
    });
  }

  /** pending admissions still belong to this conversation and can block a switch or clear. */
  private async refuseQueued(): Promise<void> {
    await this.delivery.admitted;

    if (this.snapshot.queue.length)
      throw new Error('Prompts are still queued for this conversation');
  }

  async selectConversation(id: string): Promise<void> {
    if (id === this.record?.id) return;

    await this.operate('starting', async () => {
      await this.link.connect(undefined, await this.openConversation({ id }));
    });
  }

  async projectFiles(): Promise<string[]> {
    return listFiles(this.current().cwd);
  }

  async conversations(): Promise<ListedConversation[]> {
    return this.store.conversations(this.current().cwd);
  }

  /** returns false when canceled; a running operation keeps its catalog because reinitialization needs idle. */
  async refreshModels(): Promise<boolean> {
    if (this.task && this.snapshot.models.length) return true;

    if (!(await this.released())) return false;

    const refresh = { cancelled: false };

    try {
      await this.operate('starting', async () => {
        this.modelRefresh = refresh;
        const { cwd, agent } = this.current();

        try {
          const models = await this.catalog.read(cwd, this.link.live(agent), {
            refresh: true,
          });

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
    if (this.changingModel || this.snapshot.pendingModel)
      throw new Refusal('Stop the current operation first');

    if (
      selection.agent !== this.current().agent ||
      this.snapshot.phase !== 'running' ||
      this.pendingStops.size > 0 ||
      !this.link.session?.takesModel
    ) {
      if (!(await this.released(selection)))
        throw new Refusal('Model change canceled');

      if (selection.agent !== this.current().agent)
        return this.operate('switching', async () => {
          this.catalog.installed(selection.agent);
          await this.runtimes.handoff(selection);
        });

      return this.operate('starting', () => this.changeModel(selection));
    }

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

  /** a later stop cancels the choice; a choice made after a stop waits for its settlement. */
  private async released(pending?: ModelSelection): Promise<boolean> {
    const ready = () => !pending || this.modelReady(pending);

    if (
      !this.task &&
      !this.pendingStops.size &&
      (this.snapshot.phase !== 'idle' || ready())
    )
      return true;

    const { task, operations, stops } = this;
    const settling = [task, this.delivery.drained, ...this.pendingStops];
    let failed = false;

    const current = () =>
      this.operations === operations &&
      this.stops === stops &&
      !this.closed &&
      !this.halted() &&
      !failed;

    if (pending) this.publish({ pendingModel: pending });

    try {
      const results = await Promise.allSettled(settling);
      failed = results.some(({ status }) => status === 'rejected');

      if (current() && !ready())
        await new Promise<void>((resolve) => {
          const check = () => {
            if (current() && !ready()) return;

            unsubscribe();
            resolve();
          };

          const unsubscribe = this.subscribe(check);
          check();
        });

      return current();
    } finally {
      if (pending) this.publish({ pendingModel: undefined });
    }
  }

  private modelReady(selection: ModelSelection): boolean {
    const session = this.link.session;

    if (selection.agent !== this.current().agent)
      return (
        (!session || session.closed || !session.backgroundActive) &&
        !sessionWorking(this.snapshot)
      );

    return (
      !session ||
      session.closed ||
      session.canSelectModel(selection.id, selection.contextWindow)
    );
  }

  /** a session started here starts on the choice, so a stored model that fails to connect can be replaced; if it fails to connect or refuses the choice, it closes and the stored model stays. */
  private async changeModel(selection: ModelSelection): Promise<void> {
    const conversation = this.current();
    const kept = conversation.sessions[selection.agent];
    const starting = !this.link.live(selection.agent);

    try {
      const session = await this.link.connect(
        selection.agent,
        undefined,
        selection,
      );

      const selected = await this.runtimes.applyModel(session, selection);

      if (this.cancelled || session.closed)
        throw new Refusal('Model change canceled');

      conversation.sessions[selection.agent] = selected;
      await this.save();
      this.publish({ conversation, native: session.info });
    } catch (error) {
      if (!starting) throw error;

      if (kept) conversation.sessions[selection.agent] = kept;
      else delete conversation.sessions[selection.agent];

      await this.link
        .disconnect({ keepActivation: true, keepQuestions: true })
        .catch((closing: unknown) => this.notice(errorMessage(closing)));

      await this.save();

      throw error;
    }
  }

  interrupt(options: AgentStopOptions = {}): Promise<void> {
    this.delivery.automaticHeld = true;

    return this.stopCurrent(options);
  }

  /** register the wait before stopping publishes state, so a new choice waits for the native reply too. */
  private stopCurrent(options: AgentStopOptions = {}): Promise<void> {
    this.stops++;
    const stopped = Promise.withResolvers<void>();
    this.pendingStops.add(stopped.promise);
    void this.stop(options).then(stopped.resolve, stopped.reject);

    return stopped.promise.finally(() =>
      this.pendingStops.delete(stopped.promise),
    );
  }

  private async stop(options: AgentStopOptions): Promise<void> {
    const stop = { ...options, deadline: stopDeadline(options.deadline) };

    const refresh =
      this.snapshot.phase === 'starting' ? this.modelRefresh : undefined;

    if (refresh) refresh.cancelled = true;

    this.cancelled = true;
    this.compaction.cancel();
    this.attachments.cancel();
    this.runtimes.stop();

    this.publish({
      requests: this.snapshot.requests.filter(
        (request) => !request.replyAsPrompt,
      ),
    });

    this.link.connecting?.abort(new NativeStop(stop));
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
        if (this.snapshot.phase === 'starting' || this.link.connecting)
          await this.link.session?.close(stop);
        else {
          const session = this.link.session;
          await session?.interrupt(stop);

          if (this.changingModel || this.runtimes.selecting)
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
    else this.link.session?.respond(id, response);

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

    await this.runtimes.recovered(
      this.operate(
        'editing',
        async () => {
          await recoverMemory(this.workspace!, this.current(), kind, decision);
          await this.save();
        },
        'recovery',
      ),
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
      const scope = await this.memory.scopePaths(this.current().cwd);
      const note = path ?? `${scope.project}/${indexNote}`;

      this.notice(`Memory edit: ${noticeText(note)}`, {
        cwd: this.workspace!.root,
      });

      await this.beginActivity('memory-edit', scope);
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
    // a call operate refuses leaves the running review's controller in place
    this.reviewCancellation ??= abort;

    return runReviewCommand(argument, {
      conversation,
      coordination: this.coordination,
      reviewers: this.reviewers,
      agents: this.snapshot.agents,
      signal: abort.signal,
      notice: (text) => this.notice(text),
      display: (update) => this.display(update),
      retain: (text) => this.turns.retain(conversation.id, [text]),
      turn: async (prompt) => {
        const done = await this.turns.run(prompt, 'turn', { silent: true });

        if (done?.status !== 'completed' || this.cancelled) return false;

        if (this.halted() || conversation.activity) return false;

        const { recovery, failure } = await settleMemory(this.workspace!);

        if (failure) this.notice(`Memory publication failed: ${failure}`);

        return !recovery && !failure;
      },
      operate: (rounds) => this.operate('running', rounds),
      idle: () => !this.snapshot.error && this.snapshot.phase === 'idle',
    }).finally(() => {
      if (this.reviewCancellation === abort)
        this.reviewCancellation = undefined;
    });
  }

  async restoreMemory(path: string, revision: string): Promise<void> {
    await this.operate('editing', async () => {
      this.notice(
        `Memory restore: ${noticeText(path)} at ${revision.slice(0, 8)}`,
        { cwd: this.workspace!.root },
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

    if (error instanceof Refusal && this.record) {
      if (error.reported) return;

      error.reported = true;

      return this.notice(error.message, { save: false });
    }

    this.publish({ error: errorMessage(error) });
  }

  async close(options: { restart?: boolean } = {}): Promise<void> {
    if (this.closed) return;

    this.closed = true;
    this.pauses.close();
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
        await this.link.disconnect({ stop }).catch(() => {});
      }

      await this.task?.catch(() => {});
      await this.delivery.drained;

      // settle() returns early once closed, so an accepted recovery is published here
      const status =
        (await this.workspace?.exists()) && (await this.workspace!.status());

      if (status && !status.dirty && status.ahead !== 0)
        await this.workspace!.publish();
    } catch (error) {
      failure ??= error;
    } finally {
      try {
        await this.accountUsage.close(stop);
        await this.link.disconnect({ stop });
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

  compact(): Promise<boolean> {
    return this.compaction.start();
  }

  private async beginActivity(kind: Activity['kind'], scope?: MemoryScope) {
    const workspace = this.workspace!;

    const begun = await startActivity(
      workspace,
      this.current(),
      kind,
      this.store.root,
      scope,
    );

    if (begun.notice) this.notice(begun.notice, { save: false });

    await this.save();

    return begun;
  }

  private background(
    event: Extract<AgentEvent, { type: 'subagent' | 'command' }>,
    cwd = this.current().cwd,
  ): void {
    if (event.type === 'subagent') {
      const { status, exhausted, runtime } = event.subagent;

      if (status === 'failed' && exhausted && runtime)
        this.accountUsage.exhausted(runtime, cwd, exhausted);
    }

    const update = updateBackgroundActivity(this.snapshot, event, cwd);

    if (!update) return;

    this.publish(update.state);

    for (const row of update.rows) this.display(row);

    if (this.runtimes.backgroundPending) this.delivery.drainAfter();
  }

  private display(update: DisplayUpdate, save = true): void {
    if (update.cast && this.snapshot.items.some(({ id }) => id === update.id))
      return;

    const stamped = { ...update, at: new Date().toISOString() };
    this.publish({ items: applyDisplayUpdate(this.snapshot.items, stamped) });

    if (save) this.persist(this.files!.append(stamped));
  }

  private userRow(text: string, images?: string[]): void {
    const { cwd } = this.current();

    this.display({
      id: randomUUID(),
      kind: 'user',
      text,
      cwd,
      ...(images && { images }),
    });
  }

  /** transient notices must not make an unused conversation resumable. */
  notice(
    text: string,
    {
      cwd = this.record?.cwd ?? process.cwd(),
      save = true,
      warning,
    }: { cwd?: string; save?: boolean; warning?: true } = {},
  ): void {
    this.display(
      {
        id: randomUUID(),
        kind: 'notice',
        text,
        cwd,
        ...(warning && { warning }),
      },
      save,
    );
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
      // a close that began during settlement keeps its phase
      phase: this.closed ? 'closing' : recovery ? 'recovery' : 'idle',
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

      await this.settle().catch((error: unknown) => {
        throw this.enterError(error);
      });

      if (failure !== undefined) throw failure;
    })();

    try {
      await this.task;
    } finally {
      this.task = undefined;
      this.delivery.drainAfter();
    }
  }

  private publish(update: Partial<Snapshot>): void {
    this.runtimes.observe(update);

    this.snapshot = {
      ...this.snapshot,
      ...update,
      activityStartedAt:
        update.phase &&
        agentWorking(update.phase) &&
        !agentWorking(this.snapshot.phase)
          ? Date.now()
          : this.snapshot.activityStartedAt,
      commandsPending: this.delivery.commandsPending,
      pendingCompaction: this.compaction.pending,
    };

    if ('queue' in update) this.delivery.saveQueue();

    this.pentacle.set(localActivity, witchWorking(this.snapshot));
    // merge cleanup and closing start no agent jobs
    this.jobs?.setActive(sessionWorking(this.snapshot));
    this.coordination?.update(this.snapshot);

    if ('nativeRunning' in update && !update.nativeRunning) {
      this.pauses.confirm();

      if (this.runtimes.backgroundPending) this.delivery.drainAfter();
    }

    for (const listener of this.listeners) listener();
  }
}
