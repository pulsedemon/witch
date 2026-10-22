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
  BackgroundCommand,
  SessionInfo,
  Skill,
  Subagent,
  TurnResult,
  Usage,
  UserRequest,
  UserResponse,
} from '../agents/types.js';
import {
  branchOf,
  exists,
  indexNote,
  main,
  printable,
} from '../memory/memory.js';
import type { Memory, MemoryScope } from '../memory/memory.js';
import type { Workspace } from '../memory/workspace.js';
import { LockedElsewhere } from '../persistence/store.js';
import type { ConversationStore, StateStore } from '../persistence/store.js';
import { identifyProcess } from '../persistence/process.js';
import { listFiles } from './files.js';
import {
  alone,
  shellCommand,
  skillCall,
  ranCommand,
  nativePrompt,
} from './prompts.js';
import type { JobWatch } from './jobs.js';
import type { SessionCoordination } from './coordination.js';
import { cleanUpMerge, peerTurnIn, refreshInstall } from './merged.js';
import { PentacleActivity } from './pentacle-activity.js';
import { ModelCatalog, modelEffort } from './models.js';
import type { ModelChoice, ModelSelection } from './models.js';
import type { PullRequest } from './repository.js';
import {
  agentWorking,
  applyDisplayUpdate,
  createConversation,
  recordSession,
  untitled,
} from './state.js';
import type {
  Conversation,
  ConversationRecord,
  DisplayItem,
  DisplayUpdate,
  Phase,
} from './state.js';

const execute = promisify(execFile);
const compactAt = 80;
const localActivity = Symbol('local activity');
type Activity = NonNullable<ConversationRecord['activity']>;
/** a listed subagent, when Witch saw its run start in epoch milliseconds, and the run's transcript rows. */
export interface TimedSubagent extends Subagent {
  startedAt: number;
  /** the ids of its run's start and end rows. */
  rows: { start: string; end?: string };
}

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

class RestartRequired extends Error {}
/** as VS Code's own launcher does: Electron runs cli.js as Node, and Witch's Node options pass under VS Code's names. */
export function editorEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { NODE_OPTIONS, NODE_REPL_EXTERNAL_MODULE, ...environment } = env;
  // VS Code can outlive the scratch directory TMPDIR names
  delete environment.TMPDIR;
  return {
    ...environment,
    ELECTRON_RUN_AS_NODE: '1',
    VSCODE_NODE_OPTIONS: NODE_OPTIONS,
    VSCODE_NODE_REPL_EXTERNAL_MODULE: NODE_REPL_EXTERNAL_MODULE,
  };
}
async function editInVSCode(file: string, signal: AbortSignal): Promise<void> {
  const application = '/Applications/Visual Studio Code.app/Contents';
  await execute(
    join(application, 'MacOS/Code'),
    [join(application, 'Resources/app/out/cli.js'), '--wait', file],
    { signal, env: editorEnvironment(process.env) },
  );
}
export interface Snapshot {
  phase: Phase;
  conversation?: Conversation;
  items: readonly DisplayItem[];
  /** prompts waiting for a turn, oldest first. */
  queue: readonly string[];
  requests: readonly UserRequest[];
  models: readonly ModelChoice[];
  /** the live session's skills, empty while none is connected. */
  skills: readonly Skill[];
  /** the live session's subagents in start order; a turn drops the finished ones. */
  subagents: readonly TimedSubagent[];
  /** the live session's running background commands, which Witch calls brews, in start order. */
  backgroundCommands: readonly BackgroundCommand[];
  agents: readonly { id: string; label: string; installed: boolean }[];
  native?: SessionInfo;
  /** the live session's usage; a session that never reported keeps it empty. */
  usage: Usage;
  /** when this instance opened the conversation, in epoch milliseconds. */
  openedAt?: number;
  /** a successful normal turn whose memory and final record save finished; never persisted. */
  completedTurn?: string;
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

interface Launch {
  continue?: boolean;
  conversation?: string;
}

export class Coordinator {
  readonly pentacle = new PentacleActivity();
  snapshot: Snapshot;
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
  /** a turn in the current operation failed, which stops the queue as a report does. */
  private turnFailed = false;
  private closed = false;
  /** a model change accepted after the reply can outlive the native turn. */
  private changingModel?: Promise<void>;
  private selectingModel = false;
  private readonly catalog: ModelCatalog;
  private draining = false;
  private opening = false;
  private admitting: Promise<unknown> = Promise.resolve();
  private connecting?: AbortController;
  private editorCancellation?: AbortController;

  constructor(
    private readonly store: StateStore,
    readonly memory: Memory,
    private readonly agents: readonly AgentRegistration[],
    private readonly jobs?: Pick<JobWatch, 'track' | 'environment' | 'script'>,
    private readonly editFile = editInVSCode,
    readonly coordination?: SessionCoordination,
  ) {
    this.catalog = new ModelCatalog(agents, (error) => this.report(error));
    this.snapshot = {
      phase: 'starting',
      items: [],
      queue: [],
      requests: [],
      models: [],
      skills: [],
      subagents: [],
      backgroundCommands: [],
      usage: {},
      agents: agents.map(({ adapter, executable }) => ({
        id: adapter.id,
        label: adapter.label,
        installed: !!executable,
      })),
    };
    this.publish({});
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
      throw this.enterError(error, await this.needsRestart(error));
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
    const report = await this.sweep(id);
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
    // a failed scope read fails both, so its message shows once
    await this.settle(
      [...new Set([report, failure, adoption].filter(Boolean))].join('\n\n') ||
        undefined,
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
    return createConversation(cwd, agent.adapter.id, source);
  }

  /** stops orphans, publishes stranded memory and reports what it can't settle in conversations no instance holds. */
  private async sweep(skip: string | undefined): Promise<string | undefined> {
    const { records, unreadable } = await this.store.records();
    const ahead = new Set(await this.memory.unpublished());
    const lines = unreadable.map(
      ({ file, error }) => `- ${file} can't be read: ${error}`,
    );
    const listed = new Set(records.map(({ id }) => id));
    for (const id of ahead)
      if (!listed.has(id))
        lines.push(`- ${branchOf(id)} has unpublished memory but no state`);
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

  /**
   * a prompt behind queued ones or sent after an interrupt waits in the queue, and so does a slash command or `!`
   * command, apart from a spell or `!` command sent once the turn has replied.
   */
  private async steer(prompt: string): Promise<boolean> {
    const session = this.session;
    if (
      this.snapshot.phase !== 'running' ||
      this.cancelled ||
      this.snapshot.queue.length ||
      !session
    )
      return false;
    const row = () =>
      this.display({
        id: randomUUID(),
        kind: 'user',
        text: prompt,
        cwd: this.current().cwd,
      });
    if (!alone(prompt)) {
      if (!(await session.steer(prompt))) return false;
      row();
      return true;
    }
    const command = shellCommand(prompt);
    if (
      !this.replied ||
      (command === undefined && !skillCall(prompt, this.snapshot.skills))
    )
      return false;
    // shown first, since a command's output streams as soon as it starts
    row();
    await (command === undefined
      ? session.steer(prompt.trimStart())
      : session.steer(`${prompt}\n\n${ranCommand}`, { command }));
    return true;
  }

  /** the live session's turn has replied and stays open only for its familiars or workflows. */
  private get replied(): boolean {
    return this.snapshot.phase === 'running' && !!this.session?.replied;
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

  /** runs the queue while idle: a slash command or `!` command alone, otherwise every prompt before the next one, a line each. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.snapshot.phase === 'idle' && this.snapshot.queue.length) {
        const queue = this.snapshot.queue;
        const command = queue.findIndex(alone);
        const batch = queue.slice(
          0,
          command === 0 ? 1 : command < 0 ? queue.length : command,
        );
        this.publish({ queue: queue.slice(batch.length) });
        let delivered = false;
        try {
          await this.operate('running', async () => {
            try {
              const session = await this.connect();
              const usage = session.info.hasHistory
                ? await session.contextUsage()
                : undefined;
              if (this.cancelled || session.closed || this.session !== session)
                return;
              if (usage !== undefined && usage >= compactAt) {
                this.publish({ phase: 'compacting' });
                if (!(await this.performCompaction())) return;
                this.publish({ phase: 'running' });
              }
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
        create: createConversation(source.cwd, chosen, source),
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
    // a replied turn keeps the list from its connect, since a refresh reinitializes Claude Code
    if (this.replied) return;
    await this.operate('starting', async () => {
      const { cwd, agent } = this.current();
      this.publish({
        models: await this.catalog.read(cwd, this.live(agent), true),
      });
    });
  }

  /** an omitted effort keeps the one in force, except on a model that lists none. */
  async selectModel(selection: ModelSelection): Promise<void> {
    if (this.changingModel) throw new Error('Stop the current operation first');
    if (selection.agent !== this.current().agent)
      return this.operate('switching', async () => {
        this.registration(selection.agent);
        await this.handoff(selection);
      });
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

  async interrupt(): Promise<void> {
    this.cancelled = true;
    this.publish({
      requests: this.snapshot.requests.filter(
        (request) => !request.replyAsPrompt,
      ),
    });
    this.connecting?.abort();
    this.catalog.cancel();
    this.editorCancellation?.abort();
    const results = await Promise.allSettled([
      this.coordination?.endTurn(),
      (async () => {
        // a session that is still starting has no turn to interrupt, so stopping it closes it
        if (this.snapshot.phase === 'starting' || this.connecting)
          await this.session?.close();
        else {
          const session = this.session;
          await session?.interrupt();
          if (this.changingModel || this.selectingModel) await session?.close();
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
      const text = questions
        .map(
          ({ id, title, secret }) =>
            `**${title}**\n→ ${secret ? '(hidden)' : (response.answers?.[id] ?? []).join(', ')}`,
        )
        .join('\n\n');
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
        `${(await this.memory.scopePaths(this.current().cwd)).project}/${indexNote}`;
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

  /**
   * returns whether merge cleanup acted, refreshing `install` after Witch's own cleanup.
   * skips unreadable records and peer turns with a running native process anywhere in this checkout.
   */
  async cleanUpMerge(
    pullRequest: PullRequest,
    install?: string,
  ): Promise<boolean> {
    let acted = false;
    await this.operate('cleaning', async () => {
      const { id, cwd } = this.current();
      // the phase covers only this Witch, and another one's agent would carry on on the base
      const outcome = await cleanUpMerge(cwd, pullRequest, () =>
        peerTurnIn(this.store, id, cwd),
      );
      if (!outcome) return;
      acted = true;
      // first, so a failed rebuild doesn't lose it
      this.notice(outcome.text);
      if (
        outcome.cleaned &&
        install &&
        (await this.memory.scopePaths(cwd)).project ===
          (await this.memory.scopePaths(install)).project
      )
        this.notice(await refreshInstall(install, pullRequest.base));
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

  /** an error phase keeps its message until restart. */
  report(error: unknown): void {
    if (this.snapshot.phase === 'error') return;
    this.publish({ error: errorMessage(error) });
  }

  async close(options: { restart?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const quiescing = this.coordination?.quiesce();
    // interrupt() reads the phase before `closing` replaces it
    const interrupting = this.interrupt();
    this.publish({ phase: 'closing' });
    let failure: unknown;
    try {
      try {
        await Promise.all([interrupting, quiescing]);
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

  private async handoff(selection: ModelSelection): Promise<void> {
    const { agent } = selection;
    const conversation = this.current();
    const { agent: from, handoff: previousHandoff } = conversation;
    const previous = conversation.sessions[agent];
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
      const session = await this.connect(agent, undefined, selection);
      const selected = await this.applyModel(session, selection);
      if (this.cancelled) {
        throw new Error('Handoff was interrupted');
      }
      conversation.agent = agent;
      conversation.sessions[agent] = selected;
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
      let failure = error;
      if (!activated) {
        conversation.agent = from;
        if (conversation.handoff !== previousHandoff)
          delete conversation.handoff;
        await this.disconnect().catch((closeError: unknown) => {
          failure = closeError;
        });
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
      throw failure;
    }
  }

  private async performTurn(
    prompt: string,
    kind: 'turn' | 'handoff',
    delivered?: () => void,
  ): Promise<TurnResult> {
    const conversation = this.current();
    if (kind === 'turn') this.publish({ completedTurn: undefined });
    const { activity, scope } = await this.beginActivity(kind);
    // an interrupt that aborts this connect interrupts the turn, as one after it does
    const session = await this.connect(conversation.agent, scope).catch(
      (error: unknown) => {
        if (
          this.cancelled &&
          error instanceof Error &&
          error.name === 'AbortError'
        )
          return undefined;
        throw error;
      },
    );
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
        });
      let input = await context();
      // no await from here to the command or the send, so a Ctrl+C before them never reaches the agent
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
            result = await session.send(
              input,
              skillCall(prompt, this.snapshot.skills),
            );
          }
        }
      } catch (error) {
        result = { status: 'failed', text: '', error: errorMessage(error) };
      }
      if (result.unread?.length)
        this.publish({ queue: [...result.unread, ...this.snapshot.queue] });
      if (result.unreadContext?.length)
        this.pendingContext.set(conversation.id, result.unreadContext);
      await this.finishActivity(activity, result);
      if (result.status === 'completed') {
        if (generation === this.contextGeneration)
          conversation.sessions[activity.agent]!.deliveredRevision =
            activity.baseRevision;
        if (pendingHandoff === conversation.handoff)
          delete conversation.handoff;
      }
      await this.save();
      if (kind === 'turn' && result.status === 'completed')
        this.publish({ completedTurn: activity.id });
      return result;
    } finally {
      await this.coordination?.endTurn(activity.id);
    }
  }

  async compact(): Promise<void> {
    await this.operate('compacting', async () => {
      await this.performCompaction();
    });
  }

  private async performCompaction(): Promise<boolean> {
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
        `chore(memory): save ${activity.agent} notes\n\nconversation: ${conversation.id}\nturn: ${activity.id}`,
      );
      delete conversation.activity;
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
    await this.disconnect(!this.session);
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
      (key: 'process' | 'shell') => async (pid: number | undefined) => {
        const identity =
          pid === undefined ? undefined : await identifyProcess(pid);
        if (files.closed) return;
        conversation[key] = identity;
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
        memoryDirectories: [scope.global, scope.project].map((path) =>
          join(workspace.root, path),
        ),
        signal: this.connecting.signal,
        onEvent: (event) => {
          if (!files.closed) this.receive(conversation, agent, event, tools);
        },
        onProcess: identify('process'),
        // a `!cmd &` shell can exit before the next read, so its group goes over at spawn
        onShell: async (pid) => {
          if (pid !== undefined) this.jobs?.track(pid);
          await identify('shell')(pid);
        },
        mark: this.jobs,
      });
      this.session = session;
      this.sessionProject = scope.project;
      recordSession(conversation, agent, session.info);
      await this.save();
      if (this.connecting.signal.aborted)
        throw new Error('Connection was interrupted');
      const models = await this.catalog.read(conversation.cwd, session);
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
    } finally {
      this.connecting = undefined;
    }
  }

  private async disconnect(keepActivation = false): Promise<void> {
    if (!keepActivation && this.coordination) await this.coordination.quiesce();
    const session = this.session;
    this.session = undefined;
    // closing the session stops its familiars and brews, and their own stops would no longer reach receive()
    for (const subagent of this.snapshot.subagents)
      if (subagent.status === 'running')
        this.familiar(this.current(), { ...subagent, status: 'stopped' });
    for (const command of this.snapshot.backgroundCommands)
      this.brew(this.current(), { ...command, status: 'stopped' });
    this.publish({ skills: [], subagents: [], requests: [] });
    try {
      await session?.close();
      if (!this.record) return;
      delete this.record.process;
      await this.save();
    } finally {
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
      if (reference) delete reference.deliveredRevision;
      this.persist(this.save());
      this.notice('Conversation compacted');
    } else if (event.type === 'request') {
      if (this.cancelled && event.request.replyAsPrompt) return;
      this.publish({ requests: [...this.snapshot.requests, event.request] });
    } else if (event.type === 'closed') {
      this.publish({ requests: [] });
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
    } else if (event.type === 'command') {
      if (this.live(agent)) this.brew(conversation, event.command);
    } else {
      let id = `${conversation.activity?.id ?? 'session'}/${agent}/${event.id}`;
      if (event.type === 'tool') {
        id = tools.get(event.id) ?? id;
        if (event.done) tools.delete(event.id);
        else tools.set(event.id, id);
      }
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
              ...(event.diff ? { diff: event.diff } : {}),
              // an append leaves it out, and keeps the one its row has
              ...(event.shell ? { shell: true } : {}),
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
    // a name or kind can arrive after the rows, as a Codex thread's does, and retitles them in place
    const renamed =
      !started &&
      (subagent.name !== previous!.name || subagent.kind !== previous!.kind);
    if (started || renamed)
      this.taskRow(conversation, rows.start, [
        'Familiar started',
        subagent.name,
        subagent.kind,
      ]);
    if (rows.end && (ended || renamed))
      this.taskRow(
        conversation,
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

  /** lists a background command, which Witch calls a brew, while it runs, and writes its start and end rows. */
  private brew(
    conversation: ConversationRecord,
    command: BackgroundCommand,
  ): void {
    const running = command.status === 'running';
    const listed = this.snapshot.backgroundCommands.some(
      ({ id }) => id === command.id,
    );
    if (running === listed) return;
    this.publish({
      backgroundCommands: running
        ? [...this.snapshot.backgroundCommands, command]
        : this.snapshot.backgroundCommands.filter(
            ({ id }) => id !== command.id,
          ),
    });
    this.taskRow(conversation, randomUUID(), [
      `Brew ${running ? 'started' : command.status}`,
      command.description,
    ]);
  }

  private taskRow(
    conversation: ConversationRecord,
    id: string,
    title: string[],
    text = '',
  ): void {
    this.display({
      id,
      kind: 'tool',
      title: title.filter(Boolean).join('  '),
      text,
      done: true,
      cwd: conversation.cwd,
    });
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
    if (this.snapshot.phase !== expected)
      throw new Error(
        this.snapshot.phase === 'recovery'
          ? 'Resolve pending memory before running another task'
          : this.snapshot.phase === 'error' && this.snapshot.error
            ? this.snapshot.error
            : this.replied
              ? 'Wait for the running familiars or workflows to report, or press Escape to stop them'
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
      // the selector reports its failure; the original operation still needs to settle
      await this.changingModel?.catch(() => {});
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
    this.pentacle.set(
      localActivity,
      agentWorking(this.snapshot.phase) ||
        this.snapshot.subagents.some(({ status }) => status === 'running') ||
        this.snapshot.backgroundCommands.length > 0,
    );
    this.coordination?.update(this.snapshot);
    for (const listener of this.listeners) listener();
  }
}
