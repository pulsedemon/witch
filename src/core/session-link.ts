import { errorMessage } from '../agents/stderr.js';
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
  recordSession,
  type ConversationRecord,
  type DisplayUpdate,
} from './state.js';
import type { AccountUsage } from './usage.js';

interface LinkHost {
  conversation(): ConversationRecord;
  record(): ConversationRecord | undefined;
  files(): ConversationStore;
  workspace(): Workspace;
  snapshot(): Snapshot;
  cancelled(): boolean;
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
  private aborter?: AbortController;
  private compactions = 0;
  private readonly compactedListeners = new Set<() => void>();
  /** the project memory the live session may write; native permissions are fixed at connect. */
  private sessionProject?: string;

  constructor(
    private readonly host: LinkHost,
    private readonly catalog: ModelCatalog,
    private readonly usage: AccountUsage,
    private readonly reviewers: Reviewers,
    private readonly coordination?: SessionCoordination,
    private readonly jobs?: Pick<
      JobWatch,
      'track' | 'environment' | 'script' | 'setActive'
    >,
  ) {}

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
  async connect(
    agent = this.host.conversation().agent,
    scope?: MemoryScope,
    selection?: ModelSelection,
  ): Promise<AgentSession> {
    const live = this.live(agent);
    if (live && (!scope || scope.project === this.sessionProject)) return live;
    const conversation = this.host.conversation();
    const files = this.host.files();
    const tools = new Map<string, string>();
    const { adapter, executable } = this.catalog.installed(agent);
    const workspace = this.host.workspace();
    // prepared before the old session closes, so a failure here leaves the activation in place
    await workspace.ensureWorktree();
    if (scope) await workspace.prepare(scope);
    else scope = await workspace.scope(conversation.cwd);
    // an initial connect keeps the activation published when its conversation opened; a runtime switch drops questions once it activates
    await this.disconnect(!this.connected, true);
    await this.coordination?.activate(conversation, scope.project);
    const stored = conversation.sessions[agent];
    this.aborter = new AbortController();
    try {
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
          if (!files.closed) this.receive(conversation, agent, event, tools);
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
  ): Promise<void> {
    if (!keepActivation && this.coordination) await this.coordination.quiesce();
    const conversationId = this.host.record()?.id;
    const session = this.connected;
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
    event: AgentEvent,
    tools: Map<string, string>,
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
    }
  }
}
