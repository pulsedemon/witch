import { settleMemory } from './memory-settlement.js';
import { RuntimeSwitch } from './runtime-switch.js';
import { SessionLink } from './session-link.js';
import { TurnRunner } from './turn-runner.js';
import { CopilotReviewController } from './copilot-review-controller.js';
import {
  PullRequestRepair,
  repairInstruction,
  type Repair,
} from './pr-repair.js';
import { reviewInstruction, type ReviewBatch } from './copilot-reviews.js';
import { Compaction } from './compaction.js';
import { Attachments, imagePaste, unnumbered } from './attachments.js';
import { initialSnapshot, type Snapshot } from './snapshot.js';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { AgentRegistration } from '../agents/registry.js';
import { aborted, errorMessage, failureOf } from '../agents/stderr.js';
import { NativeStop, stopDeadline } from '../agents/shutdown.js';
import type {
  AgentEvent,
  AgentStopOptions,
  TurnResult,
  UserResponse,
} from '../agents/types.js';
import { indexNote, noticeText } from '../memory/memory.js';
import type { Memory, MemoryScope } from '../memory/memory.js';
import type { Workspace } from '../memory/workspace.js';
import type {
  ConversationStore,
  ListedConversation,
  StateStore,
} from '../persistence/store.js';
import { updateBackgroundActivity } from './background-activity.js';
import { startupMoves } from './move-repair.js';
import { launchRecord, recoverConversations } from './startup-recovery.js';
import { editInVSCode } from './editor.js';
import { editNote, memoryView, recoverMemory } from './memory-actions.js';
import type { MemoryView } from './memory-actions.js';
import { listFiles } from './files.js';
import {
  shellCommand,
  skillCall,
  ranCommand,
  questionReply,
} from './prompts.js';
import { joining, nextTurn, steerInOrder, waitsBehind } from './queue.js';
import type { JobWatch } from './jobs.js';
import type { SessionCoordination } from './coordination.js';
import { taskActivity } from './coordination-state.js';
import { runMergeCleanup } from './merged.js';
import type { CleanupResult, MergeCleanup } from './merged.js';
import { PentacleActivity } from './pentacle-activity.js';
import { adoptMoved, startActivity, type Activity } from './activity.js';
import { runReviewCommand } from './review-run.js';
import { Reviewers } from './reviewers.js';
import { ModelCatalog, type ModelSelection } from './models.js';
import { AccountUsage } from './usage.js';
import type { Conflict, PullRequest } from './repository.js';
import { watchMergeNotices } from './merge-events.js';
import { answerInstruction, watchPeerRequestNotices } from './peer-requests.js';
import { entry, holding, watchPauseNotices } from './pauses.js';
import {
  agentWorking,
  applyDisplayUpdate,
  clearConversationContext,
  createConversation,
  recordSession,
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
class Refusal extends Error {}
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
  /** prompts taken from the queue's head whose user row isn't saved yet. */
  private taken: Pending[] = [];
  /** prompts `send` is admitting, which neither steered nor queued yet. */
  private arriving: Pending[] = [];
  /** a queue saved before a restart or crash waits for the user, not for delivery. */
  private restoredQueue = false;
  /** the operation's native turn has ended, so only its settlement holds the phase. */
  private turnEnded = false;
  /** counts admitted operations, so a waiting choice can tell another one ran. */
  private operations = 0;
  private closed = false;
  /** a model change accepted after the reply can outlive the native turn. */
  private changingModel?: Promise<void>;
  private modelRefresh?: { cancelled: boolean };
  private readonly catalog: ModelCatalog;
  private readonly link: SessionLink;
  private readonly turns: TurnRunner;
  private readonly attachments = new Attachments();
  readonly accountUsage: AccountUsage;
  private draining?: PromiseWithResolvers<void>;
  private deliveryHolds = 0;
  private admissions = 0;
  /** the familiars Witch launches itself, which the familiar mailbox consults before the live session. */
  readonly reviewers = new Reviewers((event) => this.background(event));
  /** a stop holds automatic turns until the user's next send or another conversation. */
  private automaticHeld = false;
  /** the pauses holding the open conversation in this visit, and the delivery hold they share. */
  private paused?: {
    conversation: string;
    applied: Set<string>;
    confirming: Set<string>;
    release: () => void;
    /** a stop is in flight; confirmation waits for it. */
    stopping: boolean;
    /** a pause arrived during that stop, so another pass follows it. */
    again: boolean;
    retry?: ReturnType<typeof setTimeout>;
  };
  /** `conversation/pause` pairs the user lifted with a prompt, which hold no more even before the store records it. */
  private readonly userResumed = new Set<string>();
  /** when the user last prompted each conversation, which resumes any pause issued before it, even one not read yet. */
  private readonly promptedAt = new Map<string, number>();
  readonly copilot = new CopilotReviewController({
    record: () => this.record,
    coordination: () => this.coordination,
    ready: () =>
      this.automaticReady() &&
      !this.snapshot.queue.length &&
      !this.answerReady() &&
      !this.repair.ready(),
    save: () => this.save(),
    notice: (text) => {
      if (!this.closed && this.record) this.notice(text);
    },
    changed: () => this.drainAfter(),
    run: (batch) => this.reviewCopilot(batch),
    interrupt: () => this.stopCurrent(),
  });
  readonly repair = new PullRequestRepair({
    record: () => this.record,
    coordination: () => this.coordination,
    ready: () => this.automaticReady() && !this.snapshot.queue.length,
    queued: () => !!this.snapshot.queue.length,
    notice: (text) => {
      if (!this.closed && this.record) this.notice(text);
    },
    changed: () => this.drainAfter(),
    run: (repair, refused) => this.repairPullRequest(repair, refused),
    interrupt: () => this.stopCurrent(),
  });
  /** a repair turn takes no steering, so prompts sent during it queue. */
  private repairing = false;
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
    connect: (choice) => this.link.connect(choice.agent, undefined, choice),
    disconnect: () => this.link.disconnect(false, true),
    save: () => this.save(),
    publish: (update) => this.publish(update),
    notice: (text) => this.notice(text),
    operate: (operation) => this.operate('switching', operation),
    failed: (failed) => (this.turnFailed = failed),
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
      this.drainAfter();
    },
    failed: () => (this.turnFailed = true),
    notice: (text) => this.notice(text),
    report: (error) => this.report(error),
  });
  private opening = false;
  private admitting: Promise<unknown> = Promise.resolve();
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
    this.link = new SessionLink(
      {
        conversation: () => this.current(),
        record: () => this.record,
        files: () => this.files!,
        workspace: () => this.workspace!,
        snapshot: () => this.snapshot,
        cancelled: () => this.cancelled,
        publish: (update) => this.publish(update),
        display: (update) => this.display(update),
        notice: (text, cwd, save) => this.notice(text, cwd, save),
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
    );
    this.turns = new TurnRunner(
      {
        conversation: () => this.current(),
        workspace: () => this.workspace!,
        files: () => this.files!,
        snapshot: () => this.snapshot,
        conflict: () => this.conflict,
        cancelled: () => this.cancelled,
        deliveryHeld: () => this.deliveryHeld,
        publish: (update) => this.publish(update),
        display: (update) => this.display(update),
        notice: (text) => this.notice(text),
        report: (error) => this.report(error),
        save: () => this.save(),
        persist: (operation) => this.persist(operation),
        beginActivity: (kind, scope) => this.beginActivity(kind, scope),
        steerQueued: () => this.steerQueued(),
        prepareImages: (prompt) =>
          this.attachments.prepare(
            this.attachments.resolve(prompt),
            this.files!,
          ),
        ended: () => (this.turnEnded = true),
        failed: (failed) => (this.turnFailed = failed),
      },
      memory,
      this.link,
      this.compaction,
      this.accountUsage,
      this.copilot,
      coordination,
    );
    this.snapshot = initialSnapshot(agents);
    this.coordination?.attach(() => this.link.session);
    this.publish({});
    for (const watch of [
      watchMergeNotices,
      watchPeerRequestNotices,
      watchPauseNotices,
    ])
      watch(
        coordination,
        () => this.snapshot,
        (notice) => {
          if (!this.closed) this.display(notice);
        },
      );
    coordination?.subscribe(() => {
      this.applyPauses();
      this.copilot.checkBinding();
      this.repair.checkBinding();
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
    if (moved) this.notice(moved, undefined, false);
    const adoption = await failureOf(
      adoptMoved(
        this.workspace!,
        scope,
        this.current().cwd,
        this.store.root,
      ).then((notice) => notice && this.notice(notice, undefined, false)),
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
      this.files = files;
      this.record = files.record;
      this.automaticHeld = false;
      this.copilot.activate();
      this.repair.resume();
      this.workspace = workspace;
      if (!this.record.handoff?.activated) delete this.record.handoff;
      const queue = (this.record.queue ?? []).map(unnumbered);
      this.restoredQueue = queue.length > 0;
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

  /** steers the turn in flight, or queues the prompt for a later turn; a queued turn that never reaches the agent leaves its prompts queued. */
  async send(
    prompt: string,
    { composer = false }: { composer?: boolean } = {},
  ): Promise<void> {
    if (!prompt.trim()) return;
    // only a restart leaves the error phase, so nothing would run what waits
    if (this.snapshot.phase === 'error') throw new Error(this.snapshot.error);
    if (this.opening) throw new Error('Wait for the next conversation to open');
    // one sent during an operation runs after it only as drainAfter would, even when its steer is refused once it has ended
    const during = this.snapshot.phase !== 'idle';
    this.automaticHeld = false;
    this.copilot.resume();
    this.repair.resume();
    // counted before the pause releases, so the automatic work its release wakes can't run ahead of this prompt
    this.admissions++;
    if (this.record) this.promptedAt.set(this.record.id, Date.now());
    const paused = this.paused;
    if (paused) {
      for (const id of paused.applied)
        this.userResumed.add(`${paused.conversation}/${id}`);
      this.releasePause();
      this.coordination?.resumePauses(paused.conversation, [...paused.applied]);
    }
    const arriving = { prompt };
    this.arriving.push(arriving);
    // the composer clears once this returns, so the prompt leaves the draft in the same save
    if (composer && this.record) delete this.record.draft;
    this.saveQueue();
    // a steer can wait on the agent, so each prompt steers or queues only after those sent before it
    const admitted = this.admitting
      .then(async () => {
        const steered =
          !waitsBehind(this.snapshot.queue, this.snapshot.skills) &&
          (await this.steer(prompt));
        this.arriving = without(this.arriving, [arriving]);
        if (steered) this.saveQueue();
        else this.publish({ queue: [...this.snapshot.queue, prompt] });
        return steered;
      })
      .finally(() => {
        this.admissions--;
        // a failed admission loses its prompt here as it does live
        if (this.arriving.includes(arriving)) {
          this.arriving = without(this.arriving, [arriving]);
          this.saveQueue();
        }
      });
    this.admitting = admitted.catch(() => {});
    const steered = await admitted;
    this.restoredQueue = false;
    if (!steered && !(during && this.halted())) await this.drain();
  }

  /** hands the queue to the composer, saving the composer's resulting text in the same save. */
  unqueue(draft: string): string[] {
    const queue = [...this.snapshot.queue];
    if (!queue.length) return queue;
    if (draft) this.record!.draft = draft;
    else delete this.record!.draft;
    this.publish({ queue: [] });
    if (this.restoredQueue) {
      this.restoredQueue = false;
      this.drainAfter(true);
    }
    return queue;
  }

  /** saves the composer's text with its conversation; a write for another conversation, or after it closed, is dropped. */
  draft(id: string, text: string): void {
    const record = this.record;
    if (record?.id !== id || this.files?.closed !== false) return;
    if ((record.draft ?? '') === text) return;
    if (text) record.draft = text;
    else delete record.draft;
    this.persist(this.save());
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

  /** holds the open conversation for each pause naming it, and lifts the hold once every applied pause reads resumed. */
  private applyPauses(): void {
    const conversation = this.record?.id;
    // a visit ends when its conversation does
    if (this.paused && this.paused.conversation !== conversation)
      this.releasePause();
    const pauses =
      conversation && !this.closed
        ? this.coordination?.events.pauses(conversation)
        : undefined;
    if (!conversation || !pauses) return;
    const prompted = this.promptedAt.get(conversation);
    const lifted = holding(pauses, conversation).filter(
      ({ id, issuedAt }) =>
        prompted !== undefined &&
        Date.parse(issuedAt) <= prompted &&
        !this.userResumed.has(`${conversation}/${id}`),
    );
    if (lifted.length) {
      for (const { id } of lifted)
        this.userResumed.add(`${conversation}/${id}`);
      this.coordination?.resumePauses(
        conversation,
        lifted.map(({ id }) => id),
      );
    }
    const held = holding(pauses, conversation).filter(
      ({ id }) => !this.userResumed.has(`${conversation}/${id}`),
    );
    if (!held.length) {
      this.releasePause();
      return;
    }
    const paused = (this.paused ??= {
      conversation,
      applied: new Set<string>(),
      confirming: new Set<string>(),
      release: this.holdPromptDelivery(),
      stopping: false,
      again: false,
    });
    const fresh = held.filter(({ id }) => !paused.applied.has(id));
    for (const { id } of fresh) paused.applied.add(id);
    // an operation the user started while held may run, so each new pause stops it again
    if (fresh.length && paused.stopping) paused.again = true;
    else if (fresh.length) {
      paused.stopping = true;
      void this.stopForPause(paused);
    }
    this.confirmPauses();
  }

  /** confirms once the stop succeeded and the operation it stopped has settled; a failed stop retries until the visit ends. */
  private async stopForPause(
    paused: NonNullable<Coordinator['paused']>,
  ): Promise<void> {
    const task = this.task;
    try {
      // stopCurrent leaves the user's own Escape hold to the user
      await this.stopCurrent();
      await task?.catch(() => {});
    } catch (error) {
      if (this.paused !== paused || this.closed) return;
      this.notice(
        `Witch could not stop this conversation for its pause and will retry: ${errorMessage(error)}`,
        undefined,
        false,
      );
      paused.retry = setTimeout(() => void this.stopForPause(paused), 2000);
      return;
    }
    if (paused.again && this.paused === paused) {
      paused.again = false;
      return this.stopForPause(paused);
    }
    paused.stopping = false;
    this.confirmPauses();
  }

  /** Escape can't stop a native run outside a turn, so confirmation waits for it to end. */
  private confirmPauses(): void {
    const paused = this.paused;
    if (!paused || paused.stopping || this.snapshot.nativeRunning) return;
    const pauses = this.coordination?.events.pauses(paused.conversation) ?? [];
    for (const pause of pauses) {
      const recipient = entry(pause, paused.conversation);
      if (
        paused.applied.has(pause.id) &&
        !recipient?.confirmedAt &&
        !paused.confirming.has(pause.id)
      ) {
        paused.confirming.add(pause.id);
        this.coordination?.confirmPause(paused.conversation, pause.id);
      }
    }
  }

  /** the hold's own wake skips a drain the pause cancelled, so this wakes after it. */
  private releasePause(): void {
    const paused = this.paused;
    if (!paused) return;
    this.paused = undefined;
    clearTimeout(paused.retry);
    paused.release();
    void (this.draining?.promise ?? Promise.resolve()).then(() =>
      this.drainAfter(),
    );
  }

  private get deliveryHeld(): boolean {
    return (
      this.deliveryHolds > 0 || this.compaction.pending || this.restoredQueue
    );
  }

  private async steer(prompt: string): Promise<boolean> {
    const session = this.link.session;
    if (!session || !this.steerable()) return false;
    const command = shellCommand(prompt);
    if (command !== undefined) {
      if (!this.replied) return false;
      // shown first, since a command's output streams as soon as it starts
      this.userRow(prompt);
      return session.steer(`${prompt}\n\n${ranCommand}`, { command });
    }
    const skill = skillCall(prompt, this.snapshot.skills);
    const ids = this.attachments.resolve(prompt);
    let images: string[] | undefined;
    if (ids.length) {
      // a failure leaves the prompt queued, and its own turn reports it
      images = await this.attachments
        .prepare(ids, this.files!)
        .catch(() => undefined);
      // the turn can settle meanwhile and let a review start, which must not take the user's prompt
      if (!images || !this.steerable() || this.link.session !== session)
        return false;
    }
    if (
      !(await (skill
        ? session.steer(prompt.trimStart(), { skill, images })
        : session.steer(prompt, { images })))
    )
      return false;
    this.userRow(prompt, images);
    return true;
  }

  private steerable(): boolean {
    return (
      this.snapshot.phase === 'running' &&
      !this.snapshot.answering &&
      !this.snapshot.reviewing &&
      !this.repairing &&
      !this.cancelled &&
      !this.deliveryHeld &&
      !this.halted()
    );
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
  private drainAfter(releasedHold = false): void {
    if (this.closed || this.deliveryHeld || this.halted()) return;
    if (this.draining && !this.replied) {
      if (releasedHold)
        void this.draining.promise.then(() => {
          if (!this.cancelled && !this.link.session?.closed) this.drainAfter();
        });
      return;
    }
    if (
      !this.snapshot.queue.length &&
      !(
        this.automaticReady() &&
        (this.answerReady() || this.repair.ready() || this.copilot.ready())
      )
    )
      return;
    const draining = this.replied ? this.steerQueued() : this.drain();
    draining.catch((error: unknown) => this.report(error));
  }

  /** a report or failed turn stays on screen, and the composer takes back what is queued; after an interrupt it runs, unless the interrupt stopped a switch after usage exhaustion. */
  private halted(): boolean {
    return !!this.snapshot.error || this.turnFailed;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    const draining = (this.draining = Promise.withResolvers<void>());
    this.runtimes.beginStep();
    // an admission that didn't run isn't retried in this drain until its candidate changes. repairs need no entry:
    // one that doesn't run either recorded its key or found its candidate changed
    const tried = new Set<string>();
    try {
      while (!this.deliveryHeld && this.snapshot.phase === 'idle') {
        if (!this.snapshot.queue.length) {
          if (!this.automaticReady()) return;
          const answers = `answer ${this.answerable().join(' ')}`;
          let ran: boolean;
          if (this.answerReady() && !tried.has(answers)) {
            tried.add(answers);
            ran = await this.answerPeers();
          } else if (this.repair.ready()) ran = await this.repair.run();
          else if (!tried.has('copilot') && this.copilot.ready()) {
            tried.add('copilot');
            ran = await this.copilot.run();
          } else return;
          if (ran) {
            if (this.halted()) return;
            tried.clear();
          }
          continue;
        }
        const queue = this.snapshot.queue;
        const batch = nextTurn(
          queue,
          this.link.session ? this.snapshot.skills : undefined,
        );
        const taken = batch.map((prompt) => ({ prompt }));
        this.taken.push(...taken);
        this.publish({ queue: queue.slice(batch.length) });
        let delivered = false;
        let result = undefined as TurnResult | undefined;
        try {
          await this.operate('running', async () => {
            result = await this.turns.run(batch.join('\n'), 'turn', {
              delivered: () => (delivered = true),
              // the save after the row carries the queue without the batch
              showing: () => {
                this.taken = without(this.taken, taken);
                this.recordQueue();
              },
              unsent: () => this.taken.unshift(...taken),
              queued: true,
            });
          });
        } finally {
          if (!delivered) {
            this.taken = without(this.taken, taken);
            this.publish({ queue: [...batch, ...this.snapshot.queue] });
          }
        }
        // a pre-turn compaction that ran out left the batch requeued above, for the destination to run
        if (
          result?.status === 'failed' &&
          result.exhausted &&
          // an Escape as the turn fails stops the switch too
          !this.cancelled &&
          (await this.runtimes.continueAfterExhaustion()) &&
          !this.halted()
        )
          continue;
        if (!delivered || this.halted()) return;
        tried.clear();
      }
    } finally {
      this.draining = undefined;
      draining.resolve();
      // a repair that became ready while this drain ran had its wake dropped
      if (this.repair.ready()) this.drainAfter();
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
      !!this.record &&
      // a pause the first read missed would otherwise let automatic work through
      (!this.coordination ||
        this.coordination.events.pauses(this.record.id) !== undefined)
    );
  }

  private answerable(): string[] {
    return this.coordination?.events.answerable(this.current().id) ?? [];
  }

  private answerReady(): boolean {
    return this.automaticReady() && this.answerable().length > 0;
  }

  /** a turn that never delivered its input returns its batch unsent, so the batch waits for a later attempt. */
  private async reviewCopilot(
    batch: ReviewBatch,
  ): Promise<TurnResult | undefined> {
    let result: TurnResult | undefined;
    let delivered = false;
    this.publish({ reviewing: true });
    try {
      await this.operate('running', async () => {
        result = await this.turns.run(reviewInstruction(batch), 'review', {
          review: batch,
          delivered: () => (delivered = true),
        });
      });
    } finally {
      this.publish({ reviewing: false });
    }
    return delivered
      ? result
      : { status: 'interrupted', text: '', inputUnsent: true };
  }

  private async repairPullRequest(
    repair: Repair,
    refused: (error: string) => void,
  ): Promise<TurnResult | undefined> {
    let result: TurnResult | undefined;
    this.repairing = true;
    try {
      await this.operate('running', async () => {
        result = await this.turns.run(repairInstruction(repair), 'repair', {
          repair,
          refused,
        });
      });
    } finally {
      this.repairing = false;
    }
    return result;
  }

  private async answerPeers(): Promise<boolean> {
    let ran = false;
    this.publish({ answering: true });
    await this.operate('running', async () => {
      const requests = await this.coordination!.beginAnswer();
      ran = requests.length > 0;
      if (ran) await this.turns.run(answerInstruction, 'answer', { requests });
    }).finally(() => this.publish({ answering: false }));
    return ran;
  }

  /** the prompts queued behind a queued turn's prompt join that turn; a `!` command and what follows it wait. */
  private steerQueued(): Promise<void> {
    const steering = this.admitting.then(async () => {
      if (this.deliveryHeld || this.halted()) return;
      const followers = joining(this.snapshot.queue);
      const taken = followers.map((prompt) => ({ prompt }));
      this.taken.push(...taken);
      this.publish({ queue: this.snapshot.queue.slice(followers.length) });
      let next = 0;
      await steerInOrder(
        followers,
        this.snapshot.skills,
        async (prompt) => {
          const follower = taken[next++]!;
          if (!(await this.steer(prompt))) return false;
          this.taken = without(this.taken, [follower]);
          this.saveQueue();
          return true;
        },
        (back) => {
          this.taken = without(this.taken, taken);
          this.publish({ queue: [...back, ...this.snapshot.queue] });
        },
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
      const scope = await this.openConversation({
        create: createConversation(source.cwd, chosen, source),
      });
      await this.link.connect(undefined, scope);
    });
  }

  async clear(): Promise<void> {
    await this.operate('starting', async () => {
      await this.admitting;
      if (this.snapshot.queue.length)
        throw new Error('Prompts are still queued for this conversation');
      const conversation = this.current();
      const info = this.link.live(conversation.agent)?.info;
      const scope = await this.memory.scopePaths(conversation.cwd);
      const failures: unknown[] = [];
      await this.link
        .disconnect()
        .catch((error: unknown) => failures.push(error));
      // a fresh activation keeps the conversation coordinated while it reconnects, without the closed session's authority
      if (!this.closed)
        await this.coordination
          ?.activate(conversation, scope.project)
          .catch((error: unknown) => failures.push(error));
      if (failures.length > 1)
        throw new Error(failures.map(errorMessage).join('\n\n'));
      if (failures.length) throw failures[0];
      if (this.cancelled) return;
      clearConversationContext(conversation, info);
      this.turns.forget(conversation.id);
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
      const session = await this.link.connect(undefined, scope);
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
      await this.link.connect(undefined, await this.openConversation({ id }));
    });
  }

  async projectFiles(): Promise<string[]> {
    return listFiles(this.current().cwd);
  }

  async conversations(): Promise<ListedConversation[]> {
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
          const models = await this.catalog.read(
            cwd,
            this.link.live(agent),
            true,
          );
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
        await this.runtimes.handoff(selection);
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
        .disconnect(true, true)
        .catch((closing: unknown) => this.notice(errorMessage(closing)));
      await this.save();
      throw error;
    }
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
      this.notice(`Memory edit: ${noticeText(note)}`, this.workspace!.root);
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
    clearTimeout(this.paused?.retry);
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
        await this.link.disconnect(false, false, stop).catch(() => {});
      }
      await this.task?.catch(() => {});
      await this.draining?.promise;
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
        await this.link.disconnect(false, false, stop);
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
    if (begun.notice) this.notice(begun.notice, undefined, false);
    await this.save();
    return begun;
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
  notice(text: string, cwd = this.current().cwd, save = true): void {
    this.display({ id: randomUUID(), kind: 'notice', text, cwd }, save);
  }

  private save(): Promise<void> {
    return this.files!.save(this.current());
  }

  /** copies the prompts sent but not yet shown into the record, in the order they were sent; true when they changed. */
  private recordQueue(): boolean {
    const record = this.record;
    if (!record) return false;
    const queue = [
      ...this.taken.map(({ prompt }) => prompt),
      ...this.snapshot.queue,
      ...this.arriving.map(({ prompt }) => prompt),
    ];
    const saved = record.queue ?? [];
    if (
      queue.length === saved.length &&
      queue.every((prompt, i) => prompt === saved[i])
    )
      return false;
    if (queue.length) record.queue = queue;
    else delete record.queue;
    return true;
  }

  private saveQueue(): void {
    if (this.recordQueue() && this.files?.closed === false)
      this.persist(this.save());
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
      await this.settle().catch((error: unknown) => {
        throw this.enterError(error);
      });
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
    if ('queue' in update) this.saveQueue();
    const working =
      agentWorking(this.snapshot.phase) ||
      taskActivity(this.snapshot).running ||
      !!this.snapshot.nativeRunning;
    // merge cleanup and closing start no agent jobs
    this.pentacle.set(
      localActivity,
      working || ['cleaning', 'closing'].includes(this.snapshot.phase),
    );
    this.jobs?.setActive(working);
    this.coordination?.update(this.snapshot);
    if ('nativeRunning' in update && !update.nativeRunning)
      this.confirmPauses();
    for (const listener of this.listeners) listener();
  }
}

/** a sent prompt, kept by identity so equal texts stay distinct. */
interface Pending {
  prompt: string;
}

function without(list: readonly Pending[], removed: readonly Pending[]) {
  return list.filter((entry) => !removed.includes(entry));
}
