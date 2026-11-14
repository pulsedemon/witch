import { randomUUID } from 'node:crypto';
import { taskActivity } from './coordination-state.js';
import type { NativeRuntime } from '../agents/runtime-updates.js';
import { errorMessage, failureOf } from '../errors.js';
import type {
  AgentEvent,
  AgentSession,
  AgentStopOptions,
} from '../agents/types.js';
import type { MemoryScope } from '../memory/memory.js';
import type { Workspace } from '../memory/workspace.js';
import { processReports } from '../persistence/process.js';
import type { ConversationStore } from '../persistence/store.js';
import { stoppedActivity } from './background-activity.js';
import type { SessionCoordination } from './coordination.js';
import type { JobWatch } from './jobs.js';
import {
  modelEffort,
  type ModelCatalog,
  type ModelSelection,
} from './models.js';
import type { Reviewers } from './reviewers.js';
import type { Snapshot } from './snapshot.js';
import { castRow } from './spells.js';
import {
  agentDisplay,
  clearDelivery,
  clearConversationContext,
  recordSession,
  type ConversationRecord,
  type DisplayUpdate,
} from './state.js';
import type { AccountUsage } from './usage.js';
import type { WorkTreeChanges } from './work-tree-changes.js';

export type LinkJobs = Pick<
  JobWatch,
  'track' | 'environment' | 'script' | 'setActive'
>;

type ToolEvent = Extract<AgentEvent, { type: 'tool' }>;

interface LinkHost {
  conversation(): ConversationRecord;
  record(): ConversationRecord | undefined;
  files(): ConversationStore;
  workspace(): Workspace;
  snapshot(): Snapshot;
  cancelled(): boolean;
  exhausted(session: AgentSession): void;
  publish(update: Partial<Snapshot>): void;
  display(update: DisplayUpdate): void;
  notice(text: string, cwd?: string, save?: boolean): void;
  background(
    event: Extract<AgentEvent, { type: 'subagent' | 'command' }>,
    cwd?: string,
  ): void;
  save(): Promise<void>;
  persist(operation: Promise<void>): void;
  /** keeps Witch context the closing session never read for the next turn. */
  retain(id: string, context?: readonly string[]): void;
}

/** the open conversation's native session: connecting it, closing it and taking in its events. */
export class SessionLink {
  private connected?: AgentSession;
  private connection?: object;
  private aborter?: AbortController;
  private compactions = 0;
  private readonly compactedListeners = new Set<() => void>();
  /** the project memory the live session may write; native permissions are fixed at connect. */
  private sessionProject?: string;
  /** the failure to read file changes each conversation last posted, until a success, so a repeat in a row stays quiet. */
  private readonly changeFailures = new WeakMap<ConversationStore, string>();

  constructor(
    private readonly host: LinkHost,
    private readonly catalog: ModelCatalog,
    private readonly usage: AccountUsage,
    private readonly reviewers: Reviewers,
    private readonly coordination?: SessionCoordination,
    private readonly jobs?: LinkJobs,
    private readonly changes?: WorkTreeChanges,
  ) {}

  retryInitialization?: () => Promise<void>;

  get maintenanceReady(): boolean {
    const state = this.host.snapshot();
    return (
      ['idle', 'error'].includes(state.phase) &&
      !state.queue.length &&
      !state.requests.length &&
      !state.pendingCompaction &&
      !state.nativeRunning &&
      !taskActivity(state).running
    );
  }

  /** an update disconnects its runtime and refreshes discovery before reopening the saved session. */
  async maintain(
    runtime: NativeRuntime,
    run: () => Promise<void>,
  ): Promise<void> {
    const reconnect = this.host.record()?.agent === runtime;
    const failures: unknown[] = [];
    try {
      await this.usage.suspend();
      this.catalog.cancel();
      if (reconnect) await this.disconnect(true);
      await run();
    } catch (error) {
      failures.push(error);
    } finally {
      this.catalog.invalidate(runtime);
      if (this.host.snapshot().phase !== 'closing') {
        if (reconnect) {
          const error = await failureOf(this.connect());
          if (error) {
            failures.push(new Error(error));
            this.host.publish({ error });
          }
        }
        if (!this.host.record() && this.retryInitialization) {
          const error = await failureOf(this.retryInitialization());
          // project startup errors do not invalidate a qualified native installation.
          if (error) this.host.publish({ error });
          else this.retryInitialization = undefined;
        }
      }
      this.usage.resume(runtime);
      if (this.host.snapshot().phase !== 'closing')
        this.host.publish({
          phase: this.host.record() ? 'idle' : 'error',
          agents: this.catalog.availability,
        });
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, failures.map(errorMessage).join('\n'));
  }

  async clear(scope: MemoryScope, forget: () => void): Promise<void> {
    const conversation = this.host.conversation();
    const info = this.live(conversation.agent)?.info;
    const failures: unknown[] = [];
    await this.disconnect().catch((error: unknown) => failures.push(error));
    // a fresh activation keeps the conversation coordinated while it reconnects, without the closed session's authority
    if (this.host.snapshot().phase !== 'closing')
      await this.coordination
        ?.activate(conversation, scope.project)
        .catch((error: unknown) => failures.push(error));
    if (failures.length > 1)
      throw new Error(failures.map(errorMessage).join('\n\n'));
    if (failures.length) throw failures[0];
    if (this.host.cancelled()) return;
    clearConversationContext(conversation, info);
    forget();
    this.host.publish({ completedTurn: undefined });
    await this.host.save();
    this.host.display({
      id: randomUUID(),
      kind: 'notice',
      text: 'Context cleared. The agent cannot see anything above this line.',
      cwd: conversation.cwd,
      contextCleared: true,
    });
    await this.host.files().flush();
    if (this.host.cancelled()) return;
    const stored = conversation.sessions[conversation.agent]!;
    const session = await this.connect(undefined, scope);
    if (this.host.cancelled() || session.closed) return;
    if (stored.model) {
      // restore the resolved model without changing the saved alias
      await session.selectModel(stored.model, stored.effort);
      recordSession(conversation, conversation.agent, session.info);
    }
    await this.host.save();
    this.host.publish({ conversation, native: session.info });
  }

  get session(): AgentSession | undefined {
    return this.connected;
  }

  /** set while a connect runs, so a stop can abort it. */
  get connecting(): AbortController | undefined {
    return this.aborter;
  }

  /** changes when the native session compacts, which invalidates delivered context. */
  get generation(): number {
    return this.compactions;
  }

  /** calls `listener` after each native compaction until the returned function removes it. */
  onCompacted(listener: () => void): () => void {
    this.compactedListeners.add(listener);
    return () => this.compactedListeners.delete(listener);
  }

  live(agent: string): AgentSession | undefined {
    return this.connected &&
      !this.connected.closed &&
      this.connected.info.agent === agent
      ? this.connected
      : undefined;
  }

  /** reuses the live session unless `scope` names project memory it was never granted. */
  connect(
    agent?: string,
    scope?: MemoryScope,
    selection?: ModelSelection,
  ): Promise<AgentSession>;
  connect(
    agent: string | undefined,
    scope: MemoryScope | undefined,
    selection: ModelSelection | undefined,
    ready: () => boolean,
  ): Promise<AgentSession | undefined>;
  async connect(
    agent = this.host.conversation().agent,
    scope?: MemoryScope,
    selection?: ModelSelection,
    ready?: () => boolean,
  ): Promise<AgentSession | undefined> {
    const live = this.live(agent);
    if (live && (!scope || scope.project === this.sessionProject)) return live;
    const conversation = this.host.conversation();
    const files = this.host.files();
    const tools = new Map<string, string>();
    const commands = new Set<string>();
    const { adapter, executable } = this.catalog.installed(agent);
    const workspace = this.host.workspace();
    // prepared before the old session closes, so a failure here leaves the activation in place
    await workspace.ensureWorktree();
    if (scope) await workspace.prepare(scope);
    else scope = await workspace.scope(conversation.cwd);
    if (ready && !ready()) return;
    const quiesced = !!ready && !!this.coordination;
    if (quiesced && !(await this.coordination!.quiesce(ready))) return;
    // an initial connect keeps the activation published when its conversation opened; a runtime switch drops questions once it activates
    await this.disconnect(!this.connected, true, undefined, quiesced);
    const connection = (this.connection = {});
    await this.coordination?.activate(conversation, scope.project);
    this.aborter = new AbortController();
    try {
      const { signal } = this.aborter;
      // settled before the session exists, so a command's edit can't land in the baseline; an abort ends the wait
      if (this.changes)
        await Promise.race([
          this.watched(files, this.changes.watch(conversation.cwd)),
          new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          ),
        ]);
      if (signal.aborted)
        throw new DOMException('Connection was interrupted', 'AbortError');
      const stored = conversation.sessions[agent];
      const session = await adapter.connect({
        cwd: conversation.cwd,
        executable: executable!,
        resume: stored?.hasHistory ? stored.id : undefined,
        model: selection?.id ?? stored?.requestedModel,
        effort: selection
          ? (modelEffort(
              selection,
              this.host.snapshot().models,
              stored?.effort,
            ) ?? undefined)
          : stored?.effort,
        memoryDirectories: workspace.directories(scope),
        automaticCompaction: true,
        signal: this.aborter.signal,
        onEvent: (event) => {
          if (event.type === 'exhausted') {
            if (
              this.connection === connection &&
              this.connected &&
              !files.closed &&
              this.host.record() === conversation &&
              !this.host.cancelled()
            )
              this.host.exhausted(this.connected);
            return;
          }
          if (!files.closed)
            this.receive(conversation, agent, event, tools, commands, files);
        },
        ...processReports(conversation, files, (pid) => this.jobs?.track(pid)),
        mark: this.jobs,
        familiarBinding: this.coordination?.familiarBinding(),
        commandPrefixes: this.coordination?.commandPrefixes(),
      });
      this.connected = session;
      this.sessionProject = scope.project;
      recordSession(conversation, agent, session.info);
      await this.host.save();
      if (this.aborter.signal.aborted)
        throw new DOMException('Connection was interrupted', 'AbortError');
      const models = await this.catalog.read(conversation.cwd, session);
      // read after models(), so a skills or usage event sent meanwhile is not replaced by an older value
      const skills = await session.skills().catch((error: unknown) => {
        this.host.notice(errorMessage(error), undefined, false);
        return [];
      });
      const live = this.live(agent);
      this.host.publish({
        native: live?.info,
        usage: live?.usage ?? {},
        models,
        latest: this.catalog.latest,
        skills,
      });
      this.usage.connected(session, conversation.cwd);
      return session;
    } finally {
      this.aborter = undefined;
    }
  }

  async disconnect(
    keepActivation = false,
    keepQuestions = false,
    stop?: AgentStopOptions,
    quiesced = false,
  ): Promise<void> {
    if (!keepActivation && !quiesced && this.coordination)
      await this.coordination.quiesce();
    const conversationId = this.host.record()?.id;
    const session = this.connected;
    this.connection = undefined;
    this.connected = undefined;
    const owned = this.reviewers.owns;
    for (const event of stoppedActivity(this.host.snapshot(), owned))
      this.host.background(event);
    const snapshot = this.host.snapshot();
    this.host.publish({
      native: undefined,
      nativeRunning: false,
      usage: {},
      skills: [],
      subagents: snapshot.subagents.filter(({ id }) => owned(id)),
      requests: keepQuestions
        ? snapshot.requests.filter((request) => request.replyAsPrompt)
        : [],
    });
    try {
      await session?.close(stop);
      const record = this.host.record();
      if (!record) return;
      delete record.process;
      await this.host.save();
    } finally {
      // discard questions delivered while the old process was closing
      if (!keepQuestions) this.host.publish({ requests: [] });
      if (conversationId)
        this.host.retain(conversationId, session?.takeUnreadContext?.());
      if (!keepActivation) await this.coordination?.deactivate();
    }
  }

  private receive(
    conversation: ConversationRecord,
    agent: string,
    event: Exclude<AgentEvent, { type: 'exhausted' }>,
    tools: Map<string, string>,
    commands: Set<string>,
    files: ConversationStore,
  ): void {
    const host = this.host;
    if (event.type === 'info') {
      recordSession(conversation, agent, event.info);
      host.persist(host.save());
      if (conversation.agent === agent)
        host.publish({ native: event.info, conversation });
    } else if (event.type === 'compacted') {
      this.compactions++;
      const reference = conversation.sessions[agent];
      if (reference) clearDelivery(reference);
      host.persist(host.save());
      host.notice('Conversation compacted');
      for (const listener of this.compactedListeners) listener();
    } else if (event.type === 'request') {
      if (host.cancelled() && event.request.replyAsPrompt) return;
      host.publish({ requests: [...host.snapshot().requests, event.request] });
    } else if (event.type === 'closed') {
      for (const event of stoppedActivity(host.snapshot(), this.reviewers.owns))
        host.background(event);
      host.publish({
        native: undefined,
        nativeRunning: false,
        usage: {},
        requests: host
          .snapshot()
          .requests.filter((request) => request.replyAsPrompt),
      });
    } else if (event.type === 'request-resolved') {
      host.publish({
        requests: host.snapshot().requests.filter(({ id }) => id !== event.id),
      });
    } else if (event.type === 'notice') {
      host.notice(event.text, undefined, !event.transient);
    } else if (event.type === 'skills') {
      if (this.live(agent)) host.publish({ skills: event.skills });
    } else if (event.type === 'usage') {
      this.usage.report(agent, event.usage.account);
      if (this.live(agent)) host.publish({ usage: event.usage });
    } else if (event.type === 'subagent' || event.type === 'command') {
      if (this.live(agent)) host.background(event, conversation.cwd);
    } else if (event.type === 'running') {
      if (this.live(agent)) host.publish({ nativeRunning: event.running });
    } else if (event.type === 'spell') {
      host.display(castRow(event.cast, conversation.cwd));
    } else {
      let id = `${conversation.activity?.id ?? 'session'}/${agent}/${event.id}`;
      if (event.type === 'tool') {
        id = tools.get(event.id) ?? id;
        if (event.done) tools.delete(event.id);
        else tools.set(event.id, id);
      }
      host.display(agentDisplay(event, id, agent, conversation.cwd));
      if (event.type === 'tool')
        this.observe(event, id, conversation.cwd, commands, files);
    }
  }

  /** shows what a finished shell command changed in the checkout; a tool's own report moves the baseline past it. */
  private observe(
    event: ToolEvent,
    id: string,
    cwd: string,
    commands: Set<string>,
    files: ConversationStore,
  ): void {
    const changes = this.changes;
    if (!changes) return;
    if (!event.done) {
      if (event.command) commands.add(event.id);
      return;
    }
    // Claude marks only the start; Codex marks the finish too, which covers a command whose start never arrived
    const command = commands.delete(event.id) || !!event.command;
    if (event.diff) {
      // Codex keeps a diff on a patch that failed or was declined
      if (!event.failed)
        void this.watched(
          files,
          changes.absorb(
            cwd,
            event.diff.flatMap(({ path, movePath }) =>
              movePath ? [path, movePath] : [path],
            ),
          ),
        );
    } else if (command)
      void this.watched(
        files,
        changes.read(cwd).then(({ files: diff, withHead, more }) => {
          const plural = (count: number) => (count === 1 ? 'file' : 'files');
          const text =
            (withHead
              ? `\n… ${withHead} ${plural(withHead)} changed with HEAD`
              : '') + (more ? `\n… ${more} more ${plural(more)} changed` : '');
          if ((diff.length || text) && !files.closed)
            this.host.display({
              id,
              kind: 'tool',
              title: '',
              text,
              cwd,
              ...(diff.length ? { diff } : {}),
            });
        }),
      );
  }

  /** settles once `operation` has, with its failure posted as a notice. */
  private watched(
    files: ConversationStore,
    operation: Promise<void>,
  ): Promise<void> {
    return operation.then(
      () => {
        this.changeFailures.delete(files);
      },
      (error: unknown) => {
        const text = errorMessage(error);
        if (files.closed || this.changeFailures.get(files) === text) return;
        this.changeFailures.set(files, text);
        this.host.notice(text, undefined, false);
      },
    );
  }
}
