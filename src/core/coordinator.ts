import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
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
import { main } from '../memory/memory.js';
import type { Memory, MemoryScope } from '../memory/memory.js';
import type { Workspace } from '../memory/workspace.js';
import { lockedElsewhere } from '../persistence/store.js';
import type { ConversationStore, StateStore } from '../persistence/store.js';
import { identifyProcess } from '../persistence/process.js';
import { applyDisplayUpdate } from './state.js';
import type {
  Conversation,
  ConversationRecord,
  DisplayItem,
  DisplayUpdate,
} from './state.js';

const execute = promisify(execFile);
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
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
  items: readonly DisplayItem[];
  requests: readonly UserRequest[];
  models: readonly Model[];
  agents: readonly { id: string; label: string; installed: boolean }[];
  native?: SessionInfo;
  recovery?: Recovery;
  error?: string;
}

export interface Recovery {
  kind: 'pending' | 'conflict';
  /** the conflicting paths; empty when the conflict has no single path. */
  paths: string[];
  diff: string;
  root: string;
}

/** the revision one memory UI action reads, resolved once so a publish mid-action can't move it. */
export interface MemoryView {
  revision: string;
  scope: MemoryScope;
  /** the worktree, when the conversation has one, for links. */
  root?: string;
}

export class Coordinator {
  snapshot: Snapshot;
  private record?: ConversationRecord;
  private files?: ConversationStore;
  private workspace?: Workspace;
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

  /** opens a new conversation in `directory`, or with `continue` its most recent one. */
  async initialize(
    directory: string,
    options: { continue?: boolean } = {},
  ): Promise<void> {
    this.task = this.load(directory, options.continue ?? false);
    try {
      await this.task;
    } catch (error) {
      this.publish({ phase: 'error', error: String(error) });
      throw error;
    } finally {
      this.task = undefined;
    }
  }

  private async load(directory: string, resume: boolean): Promise<void> {
    await this.memory.initialize();
    const cwd = await realpath(directory);
    const target = resume
      ? (await this.store.conversations(cwd))[0]
      : undefined;
    const report = await this.sweep(target?.id);
    try {
      await this.openConversation(
        target
          ? { id: target.id }
          : {
              create: this.newRecord(
                cwd,
                this.agents.find((agent) => agent.executable)?.adapter.id ??
                  this.agents[0]!.adapter.id,
              ),
            },
      );
    } catch (error) {
      if (report === undefined) throw error;
      throw new Error(`${message(error)}\n\n${report}`, { cause: error });
    }
    await this.settle(report);
  }

  /** stops orphans, publishes stranded memory and reports what it can't settle in conversations no instance holds. */
  private async sweep(skip: string | undefined): Promise<string | undefined> {
    const { records, unreadable } = await this.store.records();
    const ahead = new Set(
      (
        await this.memory.git(this.memory.root, [
          'for-each-ref',
          '--format=%(refname:short) %(ahead-behind:refs/heads/main)',
          'refs/heads/conversations',
        ])
      )
        .split('\n')
        .map((line) => line.split(' '))
        .filter(([, count]) => Number(count) > 0)
        .map(([branch]) => branch!.slice('conversations/'.length)),
    );
    const lines = unreadable.map(
      ({ id, error }) =>
        `- conversations/${id}/state.json can't be read: ${error}`,
    );
    const listed = new Set(records.map(({ id }) => id));
    for (const id of ahead)
      if (!listed.has(id))
        lines.push(`- conversations/${id} has unpublished memory but no state`);
    for (const record of records) {
      if (
        record.id === skip ||
        (!record.process && !record.activity && !ahead.has(record.id))
      )
        continue;
      let reason: string | undefined;
      // close() rethrows a save failure the catch already reported
      const problem = (error: unknown) => {
        reason ??= message(error);
      };
      let files: ConversationStore | undefined;
      try {
        files = await this.store.claim(record.id);
        const workspace = this.memory.workspace(files.directory, record.id);
        let state: 'clean' | 'pending' | 'conflict' = 'clean';
        if (await workspace.branchExists()) {
          await workspace.ensureWorktree();
          if (await workspace.isDirty()) state = 'pending';
          else if ((await workspace.publish()) === 'conflict')
            state = 'conflict';
        }
        if (state === 'pending') reason = 'unfinished memory changes';
        else if (state === 'conflict')
          reason = 'memory conflicts with another conversation';
        if (state !== 'pending' && files.record.activity) {
          delete files.record.activity;
          await files.save(files.record);
        }
      } catch (error) {
        if (!lockedElsewhere(error)) problem(error);
      } finally {
        await files?.close().catch(problem);
      }
      if (reason)
        lines.push(
          `- ${record.title} in ${record.cwd}${
            (await access(record.cwd).then(
              () => true,
              () => false,
            ))
              ? ''
              : ' (recreate this directory first)'
          }: ${reason}`,
        );
    }
    return lines.length
      ? `These conversations need attention. Open each from /sessions in its directory:\n${lines.join('\n')}`
      : undefined;
  }

  /** claims the target first, so a failed claim leaves the current conversation untouched. */
  private async openConversation(
    target: { id: string } | { create: Conversation },
  ): Promise<void> {
    const files =
      'id' in target
        ? await this.store.claim(target.id)
        : await this.store.create(target.create);
    const workspace = this.memory.workspace(files.directory, files.record.id);
    let items;
    let scope: MemoryScope | undefined;
    try {
      items = await files.items();
      if (await workspace.branchExists()) {
        await workspace.ensureWorktree();
        scope = await workspace.scope(files.record.cwd);
      }
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
      await this.files?.close().catch((error: unknown) => {
        failure ??= error;
      });
    }
    this.files = files;
    this.record = files.record;
    this.workspace = workspace;
    this.scope = scope;
    if (!this.record.handoff?.activated) delete this.record.handoff;
    this.publish({
      conversation: this.record,
      items,
      models: [],
      native: undefined,
    });
    if (failure !== undefined) this.report(failure);
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
      await this.openConversation({
        create: this.newRecord(this.current().cwd, agent),
      });
    });
  }

  async selectConversation(id: string): Promise<void> {
    if (id === this.record?.id) return;
    await this.operate('starting', () => this.openConversation({ id }));
  }

  conversations(): Promise<Conversation[]> {
    return this.store.conversations(this.current().cwd);
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
      await this.save();
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
              `chore(memory): recover ${actor} changes\n\nconversation: ${origin?.conversationId ?? 'manual'}\nturn: ${origin?.id ?? 'manual'}`,
            );
          else if (decision === 'discard') await workspace.discardPending();
          else throw new Error('Accept these memory changes or discard them.');
          delete this.current().activity;
        }
        await this.save();
      },
      'recovery',
    );
  }

  async memoryView(): Promise<MemoryView> {
    const workspace = this.workspace!;
    const scope = await this.memory.scopePaths(this.current().cwd);
    if (await workspace.exists())
      return {
        revision: await workspace.revision(),
        scope,
        root: workspace.root,
      };
    return { revision: await this.memory.resolve(main), scope };
  }

  async editMemory(path?: string): Promise<void> {
    await this.operate('editing', async () => {
      const note =
        path ??
        `${(await this.memory.scopePaths(this.current().cwd)).project}/MEMORY.md`;
      this.notice(`Memory edit: ${note}`);
      await this.beginActivity('memory-edit');
      const file = await this.workspace!.prepareNote(note);
      this.editorCancellation = new AbortController();
      try {
        await this.editFile(file, this.editorCancellation.signal);
      } finally {
        this.editorCancellation = undefined;
      }
      if (this.cancelled) return;
      await this.workspace!.commit('chore(memory): save edited notes');
      delete this.current().activity;
      await this.save();
    });
  }

  async restoreMemory(path: string, revision: string): Promise<void> {
    await this.operate('editing', async () => {
      this.notice(`Memory restore: ${path} at ${revision.slice(0, 8)}`);
      await this.beginActivity('memory-edit');
      await this.workspace!.restore(path, revision);
      delete this.current().activity;
      await this.save();
    });
  }

  report(error: unknown): void {
    this.publish({ error: message(error) });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.publish({ phase: 'closing' });
    try {
      await this.interrupt();
      await this.task?.catch(() => {});
      // settle() returns early once closed, so an accepted recovery is published here
      if (
        (await this.workspace?.exists()) &&
        !(await this.workspace!.isDirty())
      )
        await this.workspace!.publish();
      await this.disconnect();
    } finally {
      await this.files?.close();
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
      await this.save();
      await this.disconnect();
      await this.connect(agent);
      if (this.cancelled) {
        throw new Error('Handoff was interrupted');
      }
      conversation.agent = agent;
      conversation.handoff.activated = true;
      await this.save();
      activated = true;
      this.publish({ conversation, native: this.session?.info });
      if (summary)
        await this.performTurn(
          'Continue the task described by the handoff context. Check the working files before relying on statements about their state.',
          'turn',
        );
      else delete conversation.handoff;
      await this.save();
    } catch (error) {
      if (!activated) {
        conversation.agent = from;
        if (conversation.handoff !== previousHandoff)
          delete conversation.handoff;
        await this.disconnect();
      }
      await this.save();
      this.publish({ conversation, native: this.session?.info });
      throw error;
    }
  }

  private async performTurn(
    prompt: string,
    kind: 'turn' | 'handoff',
  ): Promise<TurnResult> {
    const conversation = this.current();
    const activity = await this.beginActivity(kind);
    const session = await this.connect();
    if (this.cancelled) return { status: 'interrupted', text: '' };
    const reference = conversation.sessions[conversation.agent]!;
    const workspace = this.workspace!;
    const memory = await this.memory.snapshot(
      activity.baseRevision,
      workspace.root,
      await this.memory.scopePaths(conversation.cwd),
      reference.deliveredRevision,
    );
    const handoff = conversation.handoff;
    const pendingHandoff =
      handoff?.activated && handoff.to === conversation.agent
        ? handoff
        : undefined;
    const context = [
      'You are running inside Witch. Follow your native and project instructions.',
      `Shared memory directories: ${this.scope!.global} and ${this.scope!.project}.`,
      'Save durable, verified preferences and decisions with ordinary file tools before finishing useful work. Put user-wide preferences in global memory and project facts in project memory. Keep essentials and a reference index in MEMORY.md. Link to existing project documentation instead of copying it. Keep credentials and temporary handoffs out of memory. Witch owns memory Git commits; do not run Git in those memory directories.',
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
    this.display({
      id: randomUUID(),
      kind: kind === 'handoff' ? 'notice' : 'user',
      text: prompt,
      cwd: conversation.cwd,
    });
    await this.save();
    let result: TurnResult;
    try {
      result = await session.send(context);
    } catch (error) {
      result = { status: 'failed', text: '', error: String(error) };
    }
    await this.files!.flush();
    if (result.status === 'completed') {
      await workspace.commit(
        `chore(memory): save ${activity.agent} notes\n\nconversation: ${activity.conversationId}\nturn: ${activity.id}`,
      );
      conversation.sessions[activity.agent]!.deliveredRevision =
        memory.revision;
      delete conversation.activity;
      if (pendingHandoff === conversation.handoff) delete conversation.handoff;
    } else {
      this.display({
        id: randomUUID(),
        kind: 'notice',
        text: result.error ?? 'Turn interrupted',
        cwd: conversation.cwd,
      });
      if (!(await workspace.isDirty())) delete conversation.activity;
    }
    await this.save();
    return result;
  }

  private async beginActivity(
    kind: NonNullable<ConversationRecord['activity']>['kind'],
  ): Promise<NonNullable<ConversationRecord['activity']>> {
    const conversation = this.current();
    const workspace = this.workspace!;
    await workspace.ensureWorktree();
    const begun = await workspace.begin(conversation.cwd);
    this.scope = begun.scope;
    const activity = {
      id: randomUUID(),
      conversationId: conversation.id,
      agent: conversation.agent,
      kind,
      baseRevision: begun.revision,
      startedAt: new Date().toISOString(),
    };
    conversation.activity = activity;
    await this.save();
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
    const files = this.files!;
    const { adapter, executable } = this.registration(agent);
    await this.workspace!.ensureWorktree();
    this.scope = await this.workspace!.scope(conversation.cwd);
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
        onEvent: (event) => {
          if (!files.closed) this.receive(conversation, agent, event);
        },
        onProcess: async (pid) => {
          const process =
            pid === undefined ? undefined : await identifyProcess(pid);
          if (files.closed) return;
          conversation.process = process;
          await files.save(conversation);
        },
      });
    } finally {
      this.connecting = undefined;
    }
    this.session = session;
    this.saveInfo(conversation, agent, session.info);
    await this.save();
    this.publish({ native: session.info, models: await session.models() });
    return session;
  }

  private async disconnect(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    await session?.close();
    if (!this.record) return;
    delete this.record.process;
    await this.save();
  }

  private receive(
    conversation: ConversationRecord,
    agent: string,
    event: AgentEvent,
  ): void {
    if (event.type === 'info') {
      this.saveInfo(conversation, agent, event.info);
      this.persist(this.save());
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
      this.display({
        id: randomUUID(),
        kind: 'notice',
        text: event.text,
        cwd: conversation.cwd,
      });
    } else {
      const id = `${conversation.activity?.id ?? 'session'}/${agent}/${event.id}`;
      this.display(
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

  private display(update: DisplayUpdate): void {
    this.publish({
      items: applyDisplayUpdate(this.snapshot.items, update),
    });
    this.persist(this.files!.append(update));
  }

  private notice(text: string): void {
    this.display({
      id: randomUUID(),
      kind: 'notice',
      text,
      cwd: this.current().cwd,
    });
  }

  private save(): Promise<void> {
    return this.files!.save(this.current());
  }

  private persist(operation: Promise<void>): void {
    void operation.catch((error: unknown) => {
      this.publish({ phase: 'error', error: String(error) });
    });
  }

  private newRecord(cwd: string, agent: string): Conversation {
    return {
      id: randomUUID(),
      title: 'New conversation',
      cwd,
      agent,
      sessions: {},
      createdAt: new Date().toISOString(),
    };
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

  /** a load passes its report here, so the phase leaves `starting` with it. */
  private async settle(report?: string): Promise<void> {
    if (this.closed) return;
    await this.files!.flush();
    const workspace = this.workspace!;
    let dirty = false;
    let conflict = false;
    let failure: string | undefined;
    if (await workspace.exists()) {
      dirty = await workspace.isDirty();
      if (!dirty)
        try {
          conflict = (await workspace.publish()) === 'conflict';
        } catch (error) {
          failure = message(error);
        }
      // accept or keep mine would publish the markers a stuck rebase leaves
      if (await workspace.rebaseStopped())
        throw new Error(
          'Restart Witch: memory is stuck in a rebase that could not be aborted.',
        );
    }
    if (!dirty) delete this.current().activity;
    await this.save();
    const recovery: Recovery | undefined = dirty
      ? {
          kind: 'pending',
          paths: [],
          diff: await workspace.diff(),
          root: workspace.root,
        }
      : conflict
        ? {
            kind: 'conflict',
            ...(await workspace.conflict()),
            root: workspace.root,
          }
        : undefined;
    const error = [report, failure].filter(Boolean).join('\n\n');
    this.publish({
      phase: recovery ? 'recovery' : 'idle',
      recovery,
      requests: [],
      ...(error ? { error } : {}),
    });
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
