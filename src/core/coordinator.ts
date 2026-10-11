import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentRegistration } from '../agents/registry.js';
import type {
  AgentEvent,
  AgentSession,
  Model,
  SessionInfo,
  TurnResult,
  UserRequest,
  UserResponse,
} from '../agents/types.js';
import type { Memory } from '../memory/memory.js';
import type { MemoryScope } from '../memory/memory.js';
import type { StateStore } from '../persistence/store.js';
import {
  identifyProcess,
  stopPreviousProcess,
} from '../persistence/process.js';
import { applyDisplayUpdate } from './state.js';
import type {
  AppData,
  Conversation,
  DisplayItem,
  DisplayUpdate,
} from './state.js';

const execute = promisify(execFile);
async function editInVSCode(file: string, signal: AbortSignal): Promise<void> {
  const application = '/Applications/Visual Studio Code.app/Contents';
  const { NODE_OPTIONS, NODE_REPL_EXTERNAL_MODULE, ...environment } =
    process.env;
  await execute(
    join(application, 'MacOS/Code'),
    [join(application, 'Resources/app/out/cli.js'), '--wait', file],
    {
      signal,
      env: {
        ...environment,
        ELECTRON_RUN_AS_NODE: '1',
        VSCODE_NODE_OPTIONS: NODE_OPTIONS,
        VSCODE_NODE_REPL_EXTERNAL_MODULE: NODE_REPL_EXTERNAL_MODULE,
      },
    },
  );
}
type Phase =
  | 'starting'
  | 'idle'
  | 'running'
  | 'switching'
  | 'recovery'
  | 'editing'
  | 'closing'
  | 'error';

export interface Snapshot {
  phase: Phase;
  conversation?: Conversation;
  conversations: readonly Conversation[];
  items: readonly DisplayItem[];
  requests: readonly UserRequest[];
  models: readonly Model[];
  agents: readonly { id: string; label: string; installed: boolean }[];
  native?: SessionInfo;
  error?: string;
}

export class Coordinator {
  snapshot: Snapshot;
  private data: AppData = { version: 1, conversations: [] };
  private session?: AgentSession;
  private scope?: MemoryScope;
  private listeners = new Set<() => void>();
  private task?: Promise<unknown>;
  private cancelled = false;
  private closed = false;
  private connecting?: AbortController;
  private editorCancellation?: AbortController;

  constructor(
    private readonly store: StateStore,
    readonly memory: Memory,
    private readonly agents: readonly AgentRegistration[],
    private readonly editFile = editInVSCode,
  ) {
    this.snapshot = {
      phase: 'starting',
      conversations: [],
      items: [],
      requests: [],
      models: [],
      agents: agents.map(({ adapter, executable }) => ({
        id: adapter.id,
        label: adapter.label,
        installed: !!executable,
      })),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize(directory: string): Promise<void> {
    this.task = this.load(directory);
    try {
      await this.task;
    } catch (error) {
      this.publish({ phase: 'error', error: String(error) });
      throw error;
    } finally {
      this.task = undefined;
    }
  }

  private async load(directory: string): Promise<void> {
    this.data = await this.store.load();
    if (this.data.process) {
      await stopPreviousProcess(this.data.process);
      delete this.data.process;
    }
    await this.memory.initialize();
    const cwd = await realpath(directory);
    let conversation =
      this.data.conversations.find(
        (item) => item.id === this.data.activeId && item.cwd === cwd,
      ) ?? this.data.conversations.findLast((item) => item.cwd === cwd);
    if (!conversation) {
      conversation = this.createConversation(
        cwd,
        this.agents.find((agent) => agent.executable)?.adapter.id ??
          this.agents[0]!.adapter.id,
      );
    }
    this.data.activeId = conversation.id;
    this.scope = await this.memory.scope(cwd);
    const items = (await this.store.history(conversation.id)).reduce<
      DisplayItem[]
    >(applyDisplayUpdate, []);
    const dirty = await this.memory.isDirty();
    if (!dirty) delete this.data.activity;
    for (const saved of this.data.conversations)
      if (!saved.handoff?.activated) delete saved.handoff;
    await this.store.save(this.data);
    this.publish({
      conversation,
      conversations: this.data.conversations,
      items,
      phase: dirty ? 'recovery' : 'idle',
    });
  }

  async send(prompt: string): Promise<void> {
    if (!prompt.trim()) return;
    await this.operate('running', async () => {
      await this.performTurn(prompt, 'turn');
    });
  }

  async newConversation(agent = this.current().agent): Promise<void> {
    await this.operate('starting', async () => {
      this.registration(agent);
      await this.disconnect();
      const conversation = this.createConversation(this.current().cwd, agent);
      this.data.activeId = conversation.id;
      await this.store.save(this.data);
      this.publish({
        conversation,
        conversations: this.data.conversations,
        items: [],
        models: [],
        native: undefined,
        error: undefined,
      });
    });
  }

  async selectConversation(id: string): Promise<void> {
    await this.operate('starting', async () => {
      const conversation = this.data.conversations.find(
        (item) => item.id === id,
      );
      if (!conversation) throw new Error('Conversation does not exist');
      await this.disconnect();
      this.scope = await this.memory.scope(conversation.cwd);
      this.data.activeId = id;
      await this.store.save(this.data);
      this.publish({
        conversation,
        items: (await this.store.history(id)).reduce<DisplayItem[]>(
          applyDisplayUpdate,
          [],
        ),
        models: [],
        native: undefined,
        error: undefined,
      });
    });
  }

  async refreshModels(refresh = true): Promise<void> {
    await this.operate('starting', async () => {
      const session = await this.connect();
      this.publish({ models: await session.models(refresh) });
    });
  }

  async selectModel(model: string, effort?: string): Promise<void> {
    await this.operate('starting', async () => {
      const session = await this.connect();
      await session.selectModel(model, effort);
      this.current().sessions[this.current().agent] = {
        ...this.current().sessions[this.current().agent]!,
        model: session.info.model,
        requestedModel: model,
        effort,
      };
      await this.store.save(this.data);
      this.publish({ conversation: this.current(), native: session.info });
    });
  }

  async switchAgent(agent: string): Promise<void> {
    if (agent === this.current().agent) return;
    await this.operate('switching', async () => {
      this.registration(agent);
      await this.handoff(agent);
    });
  }

  async interrupt(): Promise<void> {
    this.cancelled = true;
    this.connecting?.abort();
    this.editorCancellation?.abort();
    if (this.snapshot.phase === 'starting') await this.session?.close();
    else await this.session?.interrupt();
  }

  async respond(id: string, response: UserResponse): Promise<void> {
    this.session?.respond(id, response);
    if (response.decision === 'cancel') await this.interrupt();
  }

  async recoverMemory(decision: 'accept' | 'discard'): Promise<void> {
    await this.operate(
      'editing',
      async () => {
        const origin = this.data.activity;
        const actor =
          origin?.kind === 'memory-edit'
            ? 'manual'
            : (origin?.agent ?? 'manual');
        if (decision === 'accept') {
          await this.memory.commit(
            `chore(memory): recover ${actor} changes\n\nconversation: ${origin?.conversationId ?? 'manual'}\nturn: ${origin?.id ?? 'manual'}`,
          );
        } else await this.memory.discard();
        delete this.data.activity;
        await this.store.save(this.data);
      },
      'recovery',
    );
  }

  async memoryEntries() {
    return this.memory.catalog(this.scope!);
  }

  async editMemory(path?: string): Promise<void> {
    await this.operate('editing', async () => {
      await this.beginActivity('memory-edit');
      const file = await this.memory.prepareNote(
        path ?? join(this.scope!.project, 'MEMORY.md'),
      );
      this.editorCancellation = new AbortController();
      try {
        await this.editFile(file, this.editorCancellation.signal);
      } finally {
        this.editorCancellation = undefined;
      }
      if (this.cancelled) return;
      await this.memory.commit('chore(memory): save edited notes');
      delete this.data.activity;
      await this.store.save(this.data);
    });
  }

  async restoreMemory(path: string, revision: string): Promise<void> {
    await this.operate('editing', async () => {
      await this.memory.restore(path, revision);
    });
  }

  report(error: unknown): void {
    this.publish({
      error: error instanceof Error ? error.message : String(error),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.publish({ phase: 'closing' });
    try {
      await this.interrupt();
      await this.task?.catch(() => {});
      await this.disconnect();
    } finally {
      await this.store.close();
    }
  }

  private async handoff(agent: string): Promise<void> {
    const conversation = this.current();
    const from = conversation.agent;
    const previousHandoff = conversation.handoff;
    let activated = false;
    try {
      let summary = '';
      if (
        previousHandoff?.activated ||
        this.snapshot.items.some((item) => item.kind === 'user')
      ) {
        const result = await this.performTurn(
          'Produce a concise handoff summary: objective, constraints, verified decisions, changed files, completed checks, and remaining work. Only summarize. Do not run tools or change files.',
          'handoff',
        );
        if (result.status !== 'completed')
          throw new Error(result.error ?? 'Handoff was interrupted');
        summary = result.text;
      }
      if (this.cancelled) throw new Error('Handoff was interrupted');
      conversation.handoff = { from, to: agent, summary, activated: false };
      await this.store.save(this.data);
      await this.disconnect();
      await this.connect(agent);
      if (this.cancelled) {
        throw new Error('Handoff was interrupted');
      }
      conversation.agent = agent;
      conversation.handoff.activated = true;
      await this.store.save(this.data);
      activated = true;
      this.publish({ conversation, native: this.session?.info });
      if (summary)
        await this.performTurn(
          'Continue the task described by the handoff context. Check the working files before relying on statements about their state.',
          'turn',
        );
      else delete conversation.handoff;
      await this.store.save(this.data);
    } catch (error) {
      if (!activated) {
        conversation.agent = from;
        if (conversation.handoff !== previousHandoff)
          delete conversation.handoff;
        await this.disconnect();
      }
      await this.store.save(this.data);
      this.publish({ conversation, native: this.session?.info });
      throw error;
    }
  }

  private async performTurn(
    prompt: string,
    kind: 'turn' | 'handoff',
  ): Promise<TurnResult> {
    if (await this.memory.isDirty())
      throw new Error('Resolve pending memory before running another task');
    const conversation = this.current();
    const activity = await this.beginActivity(kind);
    const session = await this.connect();
    if (this.cancelled) return { status: 'interrupted', text: '' };
    const reference = conversation.sessions[conversation.agent]!;
    const memory = await this.memory.snapshot(
      this.scope!,
      reference.deliveredRevision,
    );
    const handoff = conversation.handoff;
    const pendingHandoff =
      handoff?.activated && handoff.to === conversation.agent
        ? handoff
        : undefined;
    const context = [
      'You are running inside Agent Harness. Follow your native and project instructions.',
      `Shared memory directories: ${this.scope!.global} and ${this.scope!.project}.`,
      'Save durable, verified preferences and decisions with ordinary file tools before finishing useful work. Put user-wide preferences in global memory and project facts in project memory. Keep essentials and a reference index in MEMORY.md. Link to existing project documentation instead of copying it. Keep credentials and temporary handoffs out of memory. The harness owns memory Git commits; do not run Git in those memory directories.',
      ...(reference.deliveredRevision !== memory.revision ? [memory.text] : []),
      ...(pendingHandoff?.summary
        ? [
            `Pending task context from ${pendingHandoff.from}:\n${pendingHandoff.summary}`,
          ]
        : []),
      `User request:\n${prompt}`,
    ].join('\n\n');
    if (kind === 'turn' && conversation.title === 'New conversation')
      conversation.title = prompt.replace(/\s+/g, ' ').slice(0, 80);
    this.record({
      id: randomUUID(),
      kind: kind === 'handoff' ? 'notice' : 'user',
      text: prompt,
      cwd: conversation.cwd,
    });
    await this.store.save(this.data);
    let result: TurnResult;
    try {
      result = await session.send(context);
    } catch (error) {
      result = { status: 'failed', text: '', error: String(error) };
    }
    await this.store.flush();
    if (result.status === 'completed') {
      await this.memory.commit(
        `chore(memory): save ${activity.agent} notes\n\nconversation: ${activity.conversationId}\nturn: ${activity.id}`,
      );
      conversation.sessions[activity.agent]!.deliveredRevision =
        memory.revision;
      delete this.data.activity;
      if (pendingHandoff === conversation.handoff) delete conversation.handoff;
    } else {
      this.record({
        id: randomUUID(),
        kind: 'notice',
        text: result.error ?? 'Turn interrupted',
        cwd: conversation.cwd,
      });
      if (!(await this.memory.isDirty())) delete this.data.activity;
    }
    await this.store.save(this.data);
    return result;
  }

  private async beginActivity(
    kind: NonNullable<AppData['activity']>['kind'],
  ): Promise<NonNullable<AppData['activity']>> {
    if (await this.memory.isDirty())
      throw new Error('Resolve pending memory before running another task');
    const conversation = this.current();
    const activity = {
      id: randomUUID(),
      conversationId: conversation.id,
      agent: conversation.agent,
      kind,
      baseRevision: await this.memory.revision(),
      startedAt: new Date().toISOString(),
    };
    this.data.activity = activity;
    await this.store.save(this.data);
    return activity;
  }

  private async connect(agent = this.current().agent): Promise<AgentSession> {
    if (
      this.session &&
      !this.session.closed &&
      this.session.info.agent === agent
    )
      return this.session;
    await this.disconnect();
    const conversation = this.current();
    const { adapter, executable } = this.registration(agent);
    const stored = conversation.sessions[agent];
    this.connecting = new AbortController();
    let session: AgentSession;
    try {
      session = await adapter.connect({
        cwd: conversation.cwd,
        executable: executable!,
        resume: stored?.hasHistory ? stored.id : undefined,
        model: stored?.requestedModel,
        effort: stored?.effort,
        memoryDirectories: [this.scope!.global, this.scope!.project],
        signal: this.connecting.signal,
        onEvent: (event) => this.receive(conversation, agent, event),
        onProcess: async (pid) => {
          this.data.process =
            pid === undefined ? undefined : await identifyProcess(pid);
          await this.store.save(this.data);
        },
      });
    } finally {
      this.connecting = undefined;
    }
    this.session = session;
    this.saveInfo(conversation, agent, session.info);
    await this.store.save(this.data);
    this.publish({ native: session.info, models: await session.models() });
    return session;
  }

  private async disconnect(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    await session?.close();
    delete this.data.process;
    await this.store.save(this.data);
  }

  private receive(
    conversation: Conversation,
    agent: string,
    event: AgentEvent,
  ): void {
    if (event.type === 'info') {
      this.saveInfo(conversation, agent, event.info);
      this.persist(this.store.save(this.data));
      if (conversation.agent === agent)
        this.publish({ native: event.info, conversation });
    } else if (event.type === 'request') {
      this.publish({ requests: [...this.snapshot.requests, event.request] });
    } else if (event.type === 'request-resolved') {
      this.publish({
        requests: this.snapshot.requests.filter(
          (request) => request.id !== event.id,
        ),
      });
    } else if (event.type === 'notice') {
      this.record({
        id: randomUUID(),
        kind: 'notice',
        text: event.text,
        cwd: conversation.cwd,
      });
    } else {
      const id = `${this.data.activity?.id ?? 'session'}/${agent}/${event.id}`;
      this.record(
        event.type === 'text'
          ? {
              id,
              kind: 'assistant',
              title: agent,
              text: event.text,
              replace: event.replace,
              cwd: conversation.cwd,
            }
          : {
              id,
              kind: 'tool',
              title: event.title,
              text: event.text,
              replace: !event.append,
              done: event.done,
              cwd: event.cwd ?? conversation.cwd,
            },
      );
    }
  }

  private saveInfo(
    conversation: Conversation,
    agent: string,
    info: SessionInfo,
  ): void {
    const previous = conversation.sessions[agent];
    conversation.sessions[agent] = {
      ...previous,
      id: info.id,
      model: info.model,
      hasHistory: info.hasHistory,
      deliveredRevision:
        previous?.id === info.id ? previous.deliveredRevision : undefined,
    };
  }

  private record(update: DisplayUpdate): void {
    this.publish({
      items: applyDisplayUpdate([...this.snapshot.items], update),
    });
    this.persist(this.store.append(this.current().id, update));
  }

  private persist(operation: Promise<void>): void {
    void operation.catch((error: unknown) => {
      this.publish({ phase: 'error', error: String(error) });
    });
  }

  private createConversation(cwd: string, agent: string): Conversation {
    const conversation: Conversation = {
      id: randomUUID(),
      title: 'New conversation',
      cwd,
      agent,
      sessions: {},
      createdAt: new Date().toISOString(),
    };
    this.data.conversations.push(conversation);
    return conversation;
  }

  private current(): Conversation {
    const conversation = this.data.conversations.find(
      (item) => item.id === this.data.activeId,
    );
    if (!conversation) throw new Error('No active conversation');
    return conversation;
  }

  private registration(id: string): AgentRegistration {
    const registration = this.agents.find(({ adapter }) => adapter.id === id);
    if (!registration?.executable)
      throw new Error(
        `${registration?.adapter.label ?? id} is not installed. Install its native CLI and sign in before using it.`,
      );
    return registration;
  }

  private async settle(): Promise<void> {
    if (this.closed) return;
    await this.store.flush();
    const dirty = await this.memory.isDirty();
    if (!dirty) delete this.data.activity;
    await this.store.save(this.data);
    this.publish({ phase: dirty ? 'recovery' : 'idle', requests: [] });
  }

  private async operate(
    phase: Phase,
    operation: () => Promise<void>,
    expected: 'idle' | 'recovery' = 'idle',
  ): Promise<void> {
    if (this.snapshot.phase !== expected)
      throw new Error(
        this.snapshot.phase === 'recovery'
          ? 'Resolve pending memory before running another task'
          : 'Stop the current operation first',
      );
    this.cancelled = false;
    this.publish({ phase, error: undefined });
    this.task = (async () => {
      let failure: unknown;
      try {
        await operation();
      } catch (error) {
        failure = error;
        this.report(error);
      }
      try {
        await this.settle();
      } catch (error) {
        this.publish({ phase: 'error', error: String(error) });
        throw error;
      }
      if (failure !== undefined) throw failure;
    })();
    try {
      await this.task;
    } finally {
      this.task = undefined;
    }
  }

  private publish(update: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
}
