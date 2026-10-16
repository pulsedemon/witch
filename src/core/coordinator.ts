import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentRegistration } from '../agents/registry.js';
import { errorMessage } from '../agents/stderr.js';
import type {
  AgentEvent,
  AgentSession,
  Model,
  SessionInfo,
  Skill,
  SkillCall,
  Subagent,
  TurnResult,
  Usage,
  UserRequest,
  UserResponse,
} from '../agents/types.js';
import { exists, main, printable } from '../memory/memory.js';
import type { Memory, MemoryScope } from '../memory/memory.js';
import type { Workspace } from '../memory/workspace.js';
import { LockedElsewhere } from '../persistence/store.js';
import type { ConversationStore, StateStore } from '../persistence/store.js';
import { identifyProcess } from '../persistence/process.js';
import { listFiles } from './files.js';
import { applyDisplayUpdate } from './state.js';
import type {
  Conversation,
  ConversationRecord,
  DisplayItem,
  DisplayUpdate,
} from './state.js';

const execute = promisify(execFile);
const untitled = 'New conversation';

/** splits `/name args` as Claude Code does: the name ends at the first whitespace. */
function skillCall(
  prompt: string,
  skills: readonly Skill[],
): SkillCall | undefined {
  const match = /^\/(\S+)([\s\S]*)$/.exec(prompt.trim());
  if (!match || !skills.some(({ name }) => name === match[1])) return;
  return { name: match[1]!, args: match[2]!.trim() };
}

/** a slash command takes a turn alone: a spell runs only from a turn's prompt, listed or not before its session connects, and Claude Code would run any other as its own. */
function slashCommand(prompt: string): boolean {
  return prompt.trimStart().startsWith('/');
}

/** a listed subagent, when Witch saw its run start in epoch milliseconds, and the run's transcript rows. */
export interface TimedSubagent extends Subagent {
  startedAt: number;
  /** the ids of its run's start and end rows. */
  rows: { start: string; end?: string };
}

/** replaces the subagent with the same id in place, so the list keeps start order. */
function withSubagent(
  subagents: readonly TimedSubagent[],
  subagent: TimedSubagent,
): TimedSubagent[] {
  const index = subagents.findIndex(({ id }) => id === subagent.id);
  return index < 0 ? [...subagents, subagent] : subagents.with(index, subagent);
}

/** a note name for a notice, which renders as Markdown, escaped so the name can't carry a Markdown link of its own. */
function noteName(path: string): string {
  return printable(path).replace(/[\\[\]]/g, '\\$&');
}

/** an error that only a restart clears. */
class RestartRequired extends Error {}
async function editInVSCode(file: string, signal: AbortSignal): Promise<void> {
  const application = '/Applications/Visual Studio Code.app/Contents';
  // as VS Code's own launcher does: Electron runs cli.js as Node, and Witch's Node options pass under VS Code's names
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
  /** prompts waiting for a turn, oldest first. */
  queue: readonly string[];
  requests: readonly UserRequest[];
  models: readonly Model[];
  /** the live session's skills, empty while none is connected. */
  skills: readonly Skill[];
  /** the live session's subagents in start order; a turn drops the finished ones. */
  subagents: readonly TimedSubagent[];
  agents: readonly { id: string; label: string; installed: boolean }[];
  native?: SessionInfo;
  /** the live session's usage; a session that never reported keeps it empty. */
  usage: Usage;
  /** when this instance opened the conversation, in epoch milliseconds. */
  openedAt?: number;
  recovery?: Recovery;
  error?: string;
}

interface Recovery {
  kind: 'pending' | 'conflict';
  /** the conflicting paths; empty when the conflict has no single path. */
  paths: string[];
  diff: string;
  root: string;
}

/** the revision one memory UI action reads, resolved once so a publish mid-action can't move it. */
interface MemoryView {
  revision: string;
  scope: MemoryScope;
  /** the conversation's worktree, for links, while it holds this revision. */
  root?: string;
}

export class Coordinator {
  snapshot: Snapshot;
  private record?: ConversationRecord;
  private files?: ConversationStore;
  private workspace?: Workspace;
  private session?: AgentSession;
  /** the project memory the live session may write; native permissions are fixed at connect. */
  private sessionProject?: string;
  private listeners = new Set<() => void>();
  private task?: Promise<unknown>;
  private cancelled = false;
  /** a turn in the current operation failed, which stops the queue as a report does. */
  private turnFailed = false;
  private closed = false;
  private draining = false;
  private opening = false;
  private admitting: Promise<unknown> = Promise.resolve();
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
      queue: [],
      requests: [],
      models: [],
      skills: [],
      subagents: [],
      usage: {},
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
      throw this.enterError(error, await this.needsRestart(error));
    } finally {
      this.task = undefined;
      this.drainAfter();
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
        target ? { id: target.id } : { create: await this.launchRecord(cwd) },
      );
    } catch (error) {
      if (report === undefined) throw error;
      throw new Error(`${errorMessage(error)}\n\n${report}`, { cause: error });
    }
    // a failed connect leaves the conversation open, as a failed send does
    const failure = await this.connect().then(() => undefined, errorMessage);
    await this.settle(
      [report, failure].filter(Boolean).join('\n\n') || undefined,
    );
  }

  /** a new conversation on the agent, model and effort of the most recently used one. */
  private async launchRecord(cwd: string): Promise<Conversation> {
    const [source] = await this.store.conversations();
    const installed = this.agents.filter(({ executable }) => executable);
    const agent =
      installed.find(({ adapter }) => adapter.id === source?.agent) ??
      installed[0] ??
      this.agents[0]!;
    return this.newRecord(cwd, agent.adapter.id, source);
  }

  /** stops orphans, publishes stranded memory and reports what it can't settle in conversations no instance holds. */
  private async sweep(skip: string | undefined): Promise<string | undefined> {
    const { records, unreadable } = await this.store.records();
    const ahead = new Set(
      (
        await this.memory.git(this.memory.root, [
          'for-each-ref',
          `--format=%(refname:short) %(ahead-behind:${main})`,
          'refs/heads/conversations',
        ])
      )
        .split('\n')
        .map((line) => line.split(' '))
        .filter(([, count]) => Number(count) > 0)
        .map(([branch]) => branch!.slice('conversations/'.length)),
    );
    const lines = unreadable.map(
      ({ file, error }) => `- ${file} can't be read: ${error}`,
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
        reason ??= errorMessage(error);
      };
      let files: ConversationStore | undefined;
      try {
        files = await this.store.claim(record.id);
        const workspace = this.memory.workspace(files.directory, record.id);
        let pending = false;
        if (await workspace.branchExists()) {
          await workspace.ensureWorktree();
          pending = await workspace.isDirty();
          if (pending) reason = 'unfinished memory changes';
          else if ((await workspace.publish()) === 'conflict')
            reason = 'memory conflicts with another conversation';
        }
        if (!pending && files.record.activity) {
          delete files.record.activity;
          await files.save(files.record);
        }
      } catch (error) {
        if (!(error instanceof LockedElsewhere)) problem(error);
      } finally {
        await files?.close().catch(problem);
      }
      if (!reason) continue;
      const gone = !(await exists(record.cwd));
      lines.push(
        `- ${record.title} in ${record.cwd}${gone ? ' (recreate this directory first)' : ''}: ${reason}`,
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
      });
      if (failure !== undefined) this.report(failure);
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
      if (await this.steer(prompt)) return true;
      this.publish({ queue: [...this.snapshot.queue, prompt] });
      return false;
    });
    this.admitting = admitted.catch(() => {});
    if (!(await admitted) && !(during && this.halted())) await this.drain();
  }

  /** takes back every queued prompt, oldest first, to edit. */
  unqueue(): string[] {
    const queue = [...this.snapshot.queue];
    this.publish({ queue: [] });
    return queue;
  }

  /** a slash command, and a prompt behind queued ones or sent after an interrupt, wait in the queue. */
  private async steer(prompt: string): Promise<boolean> {
    if (
      this.snapshot.phase !== 'running' ||
      this.cancelled ||
      this.snapshot.queue.length ||
      slashCommand(prompt) ||
      !(await this.session?.steer(prompt))
    )
      return false;
    this.display({
      id: randomUUID(),
      kind: 'user',
      text: prompt,
      cwd: this.current().cwd,
    });
    return true;
  }

  /** runs what was sent during an operation once it ends, unless that would run over a report or failed turn. */
  private drainAfter(): void {
    if (this.halted()) return;
    this.drain().catch((error: unknown) => this.report(error));
  }

  /** a report or failed turn stays on screen, and the composer takes back what is queued; after an interrupt it runs. */
  private halted(): boolean {
    return !!this.snapshot.error || this.turnFailed;
  }

  /** runs the queue while idle: a slash command alone, otherwise every prompt before the next one, a line each. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.snapshot.phase === 'idle' && this.snapshot.queue.length) {
        const queue = this.snapshot.queue;
        const command = queue.findIndex(slashCommand);
        const batch = queue.slice(
          0,
          command === 0 ? 1 : command < 0 ? queue.length : command,
        );
        this.publish({ queue: queue.slice(batch.length) });
        let delivered = false;
        try {
          await this.operate('running', async () => {
            try {
              await this.performTurn(batch.join('\n'), 'turn', () => {
                delivered = true;
              });
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
      this.draining = false;
    }
  }

  /** without an agent, continues on this conversation's agent, model and effort. */
  async newConversation(agent?: string): Promise<void> {
    await this.operate('starting', async () => {
      const source = this.current();
      const chosen = agent ?? source.agent;
      this.registration(chosen);
      await this.openConversation({
        create: this.newRecord(source.cwd, chosen, source),
      });
      await this.connect();
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

  async refreshModels(): Promise<void> {
    await this.operate('starting', async () => {
      const session = await this.connect();
      this.publish({ models: await session.models(true) });
    });
  }

  /** an omitted effort keeps the one in force, except on a model that lists none. */
  async selectModel(model: string, effort?: string): Promise<void> {
    await this.operate('starting', async () => {
      const conversation = this.current();
      if (!this.live(conversation.agent)) {
        // so a model that fails to connect can be replaced. the effort waits for the session to accept it, since a stored one every connect rejects can't be replaced
        conversation.sessions[conversation.agent] = {
          id: '',
          hasHistory: false,
          ...conversation.sessions[conversation.agent],
          model,
          requestedModel: model,
        };
        await this.save();
      }
      const session = await this.connect();
      const listed = this.snapshot.models.find((item) => item.id === model);
      // a kept effort would reach a model that takes none on the next connect
      await session.selectModel(
        model,
        listed && !listed.efforts.length ? null : effort,
      );
      conversation.sessions[conversation.agent] = {
        ...conversation.sessions[conversation.agent]!,
        model: session.info.model,
        requestedModel: model,
        effort: session.info.effort,
      };
      await this.save();
      this.publish({ conversation, native: session.info });
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
    // a session that is still starting has no turn to interrupt, so stopping it closes it
    if (this.snapshot.phase === 'starting') await this.session?.close();
    else await this.session?.interrupt();
  }

  async respond(id: string, response: UserResponse): Promise<void> {
    const questions = this.snapshot.requests.find(
      (request) => request.id === id,
    )?.questions;
    this.session?.respond(id, response);
    // the request view closes on answering, so the transcript keeps what was asked and chosen
    if (questions && response.decision === 'accept')
      this.display({
        id: randomUUID(),
        kind: 'user',
        text: questions
          .map(
            ({ id, title, secret }) =>
              `**${title}**\n→ ${secret ? '(hidden)' : (response.answers?.[id] ?? []).join(', ')}`,
          )
          .join('\n\n'),
        cwd: this.current().cwd,
      });
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
              `chore(memory): recover ${actor} changes\n\nconversation: ${origin ? this.current().id : 'manual'}\nturn: ${origin?.id ?? 'manual'}`,
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
    const revision = await this.memory.resolve(main);
    const scope = await this.memory.scopePaths(this.current().cwd);
    // an idle worktree stays where its last turn left it, behind anything published since
    const linked =
      (await workspace.exists()) && (await workspace.revision()) === revision;
    return { revision, scope, ...(linked ? { root: workspace.root } : {}) };
  }

  async editMemory(path?: string): Promise<void> {
    await this.operate('editing', async () => {
      const note =
        path ??
        `${(await this.memory.scopePaths(this.current().cwd)).project}/MEMORY.md`;
      this.notice(`Memory edit: ${noteName(note)}`, this.workspace!.root);
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

  /** an error phase keeps its message until restart. */
  report(error: unknown): void {
    if (this.snapshot.phase === 'error') return;
    this.publish({ error: errorMessage(error) });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // interrupt() reads the phase before `closing` replaces it
    const interrupting = this.interrupt();
    this.publish({ phase: 'closing' });
    let failure: unknown;
    try {
      try {
        await interrupting;
      } catch (error) {
        failure = error;
        // Codex's close() interrupts again and would rethrow, so the session ends here
        await this.disconnect().catch(() => {});
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
        await this.disconnect();
      } finally {
        await this.files?.close();
      }
    }
    if (failure !== undefined) throw failure;
  }

  private async handoff(agent: string): Promise<void> {
    const conversation = this.current();
    const from = conversation.agent;
    const previousHandoff = conversation.handoff;
    let activated = false;
    try {
      let summary = '';
      if (this.snapshot.items.some((item) => item.kind === 'user')) {
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
      this.publish({
        conversation,
        native: this.session?.info,
        usage: this.session?.usage ?? {},
      });
      throw error;
    }
  }

  private async performTurn(
    prompt: string,
    kind: 'turn' | 'handoff',
    delivered?: () => void,
  ): Promise<TurnResult> {
    const conversation = this.current();
    const { activity, scope } = await this.beginActivity(kind);
    const session = await this.connect(conversation.agent, scope);
    this.publish({
      subagents: this.snapshot.subagents.filter(
        ({ status }) => status === 'running',
      ),
    });
    const reference = conversation.sessions[conversation.agent]!;
    const workspace = this.workspace!;
    // a moved key needs the new project's full snapshot, which supersedes the marked one even if this turn fails
    if (reference.deliveredProject !== scope.project) {
      delete reference.deliveredRevision;
      reference.deliveredProject = scope.project;
    }
    const snapshot =
      reference.deliveredRevision === activity.baseRevision
        ? undefined
        : await this.memory.snapshot(
            activity.baseRevision,
            workspace.root,
            scope,
            reference.deliveredRevision,
          );
    const handoff = conversation.handoff;
    const pendingHandoff =
      handoff?.activated && handoff.to === conversation.agent
        ? handoff
        : undefined;
    const context = [
      'You are running inside Witch. Follow your native and project instructions.',
      `Shared memory directories: ${join(workspace.root, scope.global)} and ${join(workspace.root, scope.project)}.`,
      'Save durable, verified preferences and decisions with ordinary file tools before finishing useful work. Put user-wide preferences in global memory and project facts in project memory. Keep essentials and a reference index in MEMORY.md. Link to existing project documentation instead of copying it. Keep credentials and temporary handoffs out of memory. Witch owns memory Git commits; do not run Git in those memory directories.',
      ...(snapshot ? [snapshot] : []),
      ...(pendingHandoff?.summary
        ? [
            `Pending task context from ${pendingHandoff.from}:\n${pendingHandoff.summary}`,
          ]
        : []),
      `User request:\n${prompt}`,
    ].join('\n\n');
    // no await from here to the send, so a Ctrl+C before it never reaches the agent
    if (this.cancelled || session.closed)
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
    delivered?.();
    let result: TurnResult;
    try {
      result = await session.send(
        context,
        skillCall(prompt, this.snapshot.skills),
      );
    } catch (error) {
      result = { status: 'failed', text: '', error: errorMessage(error) };
    }
    if (result.unread?.length)
      this.publish({ queue: [...result.unread, ...this.snapshot.queue] });
    await this.files!.flush();
    if (result.status === 'completed') {
      await workspace.commit(
        `chore(memory): save ${activity.agent} notes\n\nconversation: ${conversation.id}\nturn: ${activity.id}`,
      );
      conversation.sessions[activity.agent]!.deliveredRevision =
        activity.baseRevision;
      delete conversation.activity;
      if (pendingHandoff === conversation.handoff) delete conversation.handoff;
    } else {
      this.notice(result.error ?? 'Turn interrupted');
      if (result.status === 'failed') this.turnFailed = true;
      if (!(await workspace.isDirty())) delete conversation.activity;
    }
    await this.save();
    return result;
  }

  private async beginActivity(
    kind: NonNullable<ConversationRecord['activity']>['kind'],
  ): Promise<{
    activity: NonNullable<ConversationRecord['activity']>;
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

  /** reuses the live session unless `turnScope` names project memory it was never granted. */
  private async connect(
    agent = this.current().agent,
    turnScope?: MemoryScope,
  ): Promise<AgentSession> {
    const live = this.live(agent);
    if (live && (!turnScope || turnScope.project === this.sessionProject))
      return live;
    await this.disconnect();
    const conversation = this.current();
    const files = this.files!;
    const { adapter, executable } = this.registration(agent);
    const workspace = this.workspace!;
    await workspace.ensureWorktree();
    const scope = turnScope ?? (await workspace.scope(conversation.cwd));
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
        memoryDirectories: [scope.global, scope.project].map((path) =>
          join(workspace.root, path),
        ),
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
    this.sessionProject = scope.project;
    this.saveInfo(conversation, agent, session.info);
    await this.save();
    // a failed list is reported, and the session's skills and usage still publish
    let models: Model[] = [];
    try {
      models = await session.models();
    } catch (error) {
      this.report(error);
    }
    // read after models(), so a skills or usage event sent meanwhile is not replaced by an older value
    let skills: Skill[] = [];
    try {
      skills = await session.skills();
    } catch (error) {
      this.report(error);
    }
    this.publish({
      native: session.info,
      usage: session.usage,
      models,
      skills,
    });
    return session;
  }

  private async disconnect(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    // closing the session stops its familiars, and their own stops would no longer reach receive()
    for (const subagent of this.snapshot.subagents)
      if (subagent.status === 'running')
        this.familiar(this.current(), { ...subagent, status: 'stopped' });
    this.publish({ skills: [], subagents: [] });
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
      this.notice(event.text);
    } else if (event.type === 'skills') {
      if (this.live(agent)) this.publish({ skills: event.skills });
    } else if (event.type === 'usage') {
      if (this.live(agent)) this.publish({ usage: event.usage });
    } else if (event.type === 'subagent') {
      if (this.live(agent)) this.familiar(conversation, event.subagent);
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
              ...(event.images ? { images: event.images } : {}),
            },
      );
    }
  }

  /** lists a familiar's update and writes its run's start and end rows, which the transcript keeps after a turn drops the familiar. */
  private familiar(conversation: ConversationRecord, subagent: Subagent): void {
    const previous = this.snapshot.subagents.find(
      ({ id }) => id === subagent.id,
    );
    // only a start lists a familiar, so a late update cannot restore one a turn dropped
    if (!previous && subagent.status !== 'running') return;
    const running = subagent.status === 'running';
    // a new run can start before the last one's end arrives, so a start under another run is a restart
    const started =
      running &&
      (previous?.status !== 'running' || previous.run !== subagent.run);
    const ended = !running && previous?.status === 'running';
    const rows = started
      ? { start: randomUUID() }
      : { ...previous!.rows, ...(ended ? { end: randomUUID() } : {}) };
    this.publish({
      subagents: withSubagent(this.snapshot.subagents, {
        ...subagent,
        startedAt: started ? Date.now() : previous!.startedAt,
        rows,
      }),
    });
    const row = (id: string, title: string[], text = '') =>
      this.display({
        id,
        kind: 'tool',
        title: title.filter(Boolean).join('  '),
        text,
        done: true,
        cwd: conversation.cwd,
      });
    // a name or kind can arrive after the rows, as a Codex thread's does, and retitles them in place
    const renamed =
      !started &&
      (subagent.name !== previous!.name || subagent.kind !== previous!.kind);
    if (started || renamed)
      row(rows.start, ['Familiar started', subagent.name, subagent.kind]);
    if (rows.end && (ended || renamed))
      row(
        rows.end,
        [
          `Familiar ${subagent.status}`,
          subagent.name,
          subagent.tools
            ? `${subagent.tools} tool${subagent.tools === 1 ? '' : 's'}`
            : '',
        ],
        ended ? (subagent.report ?? '') : '',
      );
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
      // a new native session has seen no memory snapshot yet
      deliveredRevision:
        previous?.id === info.id ? previous.deliveredRevision : undefined,
    };
  }

  private display(update: DisplayUpdate): void {
    const stamped = { ...update, at: new Date().toISOString() };
    this.publish({
      items: applyDisplayUpdate(this.snapshot.items, stamped),
    });
    this.persist(this.files!.append(stamped));
  }

  /** `cwd` resolves the paths the notice names, so a memory note links into the worktree. */
  private notice(text: string, cwd = this.current().cwd): void {
    this.display({ id: randomUUID(), kind: 'notice', text, cwd });
  }

  private save(): Promise<void> {
    return this.files!.save(this.current());
  }

  private persist(operation: Promise<void>): void {
    void operation.catch((error: unknown) => {
      this.enterError(error, true);
    });
  }

  /** a rejected flush is a sticky write failure, which only a restart clears. */
  private async needsRestart(error: unknown): Promise<boolean> {
    if (error instanceof RestartRequired) return true;
    if (!this.files) return false;
    return this.files.flush().then(
      () => false,
      () => true,
    );
  }

  private enterError(error: unknown, restart: boolean): Error {
    const text = `${restart ? 'Restart Witch: ' : ''}${errorMessage(error)}`;
    this.publish({ phase: 'error', error: text });
    return new Error(text, { cause: error });
  }

  /** copies the source's explicit model and effort when it ran on the same agent. */
  private newRecord(
    cwd: string,
    agent: string,
    source?: Conversation,
  ): Conversation {
    const stored = source?.agent === agent ? source.sessions[agent] : undefined;
    return {
      id: randomUUID(),
      title: untitled,
      cwd,
      agent,
      sessions: stored?.requestedModel
        ? {
            [agent]: {
              id: '',
              model: stored.model,
              requestedModel: stored.requestedModel,
              hasHistory: false,
              ...(stored.effort ? { effort: stored.effort } : {}),
            },
          }
        : {},
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
          failure = errorMessage(error);
        }
      // accept or keep mine would publish the markers a stuck rebase leaves
      if (await workspace.rebaseStopped())
        throw new RestartRequired(
          'memory is stuck in a rebase that could not be aborted.',
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
          : this.snapshot.phase === 'error' && this.snapshot.error
            ? this.snapshot.error
            : 'Stop the current operation first',
      );
    this.cancelled = false;
    this.turnFailed = false;
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
        throw this.enterError(error, await this.needsRestart(error));
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
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
}
