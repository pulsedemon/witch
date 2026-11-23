import { AnswerTurn } from '../answer-turn.js';
import { answerConfiguration, checkNoMcpTools } from './answer.js';
import { object, readConfig, withoutMcp } from './config.js';
import { readModels } from './models.js';
import {
  CodexCompactionPolicy,
  readContextCatalog,
  withContextWindows,
} from './compaction-policy.js';
import type { CodexSelection } from './compaction-policy.js';
import { permissionProfile, sessionInfo } from './session-info.js';
import { spawn } from 'node:child_process';
import { nativeLaunch } from '../native-launch.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { JsonRpc } from './json-rpc.js';
import type { RpcMessage } from './json-rpc.js';
import { TurnText } from '../turn-text.js';
import { CodexCommands } from './commands.js';
import type { Notification } from './commands.js';
import { CodexAccount, probeAccountUsage, rateLimits } from './limits.js';
import type { FamiliarAction, FamiliarOutcome } from '../familiar-report.js';
import { CodexFamiliars } from './familiars.js';
import {
  fileChangeIdentity,
  fileChangeKey,
  fileChanges,
  fileDiffs,
  itemTool,
  turnId,
  untooled,
} from './items.js';
import { parseRequest, requestResult } from './requests.js';
import { diffLines } from '../file-diff.js';
import { errorMessage } from '../../errors.js';
import {
  beforeDeadline,
  closeFailedStart,
  NativeStopTimeout,
  stopDeadline,
  stopOptions,
  terminationReserveMs,
} from '../shutdown.js';
import { castIndex, readSpells, skillsOf } from './spells.js';
import type {
  AgentAdapter,
  AccountReading,
  AgentSession,
  ContextWindowChoice,
  AgentStopOptions,
  FileDiff,
  Model,
  ModelDiscoveryOptions,
  SessionInfo,
  SessionOptions,
  Skill,
  TurnResult,
  Usage,
  UserResponse,
  SendOptions,
} from '../types.js';

const stringValue = z.string();
const nullishString = stringValue.nullish();
const turnDiff = z.object({ turnId: stringValue, diff: stringValue });

const tokenUsage = z.object({
  tokenUsage: z.object({
    last: z.object({ totalTokens: z.number() }),
    modelContextWindow: z.number().nullable(),
  }),
});

const messageQuestions = z.array(
  z.object({
    title: z.string(),
    options: z.array(z.string()).nullish(),
  }),
);

const mcpStartup = z.object({
  name: stringValue,
  status: stringValue,
  error: nullishString,
});

type Launch = (
  executable: string,
  cwd: string,
  signal?: AbortSignal,
) => ChildProcessWithoutNullStreams;

const launch: Launch = (executable, cwd, signal) =>
  nativeLaunch(executable, undefined, (command) =>
    spawn(command, ['app-server', '--stdio'], { cwd, stdio: 'pipe', signal }),
  );

async function initializeRpc(rpc: JsonRpc): Promise<void> {
  await rpc.request('initialize', {
    clientInfo: { name: 'witch', title: 'Witch', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });

  rpc.notify('initialized');
}

function waitForStop(
  stopped: Promise<void>,
  options: AgentStopOptions & { deadline: number },
): Promise<void> {
  return options.restart
    ? stopped
    : beforeDeadline(stopped, options.deadline - terminationReserveMs);
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly label = 'Codex';

  constructor(
    private readonly start: Launch = launch,
    private readonly contextCatalog = readContextCatalog,
  ) {}

  models(options: ModelDiscoveryOptions): Promise<Model[]> {
    return this.probe(options, async (rpc) => {
      const models = await readModels(rpc);

      return withContextWindows(models, await this.contextCatalog(options));
    });
  }

  accountUsage(
    options: ModelDiscoveryOptions,
    previous: AccountReading,
  ): Promise<AccountReading> {
    return this.probe(options, (rpc) => probeAccountUsage(rpc, previous));
  }

  private async probe<T>(
    options: ModelDiscoveryOptions,
    read: (rpc: JsonRpc) => Promise<T>,
  ): Promise<T> {
    const rpc = new JsonRpc(
      this.start(options.executable, options.cwd, options.signal),
    );

    try {
      await initializeRpc(rpc);

      return await read(rpc);
    } finally {
      await rpc.close(stopOptions(options.signal));
    }
  }

  async connect(options: SessionOptions): Promise<AgentSession> {
    const child = this.start(options.executable, options.cwd, options.signal);
    const rpc = new JsonRpc(child);

    const session = new CodexSession(
      rpc,
      options,
      (answer) => this.connect(answer),
      this.contextCatalog,
    );

    try {
      await options.onProcess(child.pid);
      await session.initialize();

      return session;
    } catch (error) {
      return closeFailedStart(
        () => session.close(stopOptions(options.signal)),
        options.signal,
        error,
      );
    }
  }
}

class CodexSession implements AgentSession {
  private readonly answers: AnswerTurn;
  info: SessionInfo;
  usage: Usage = {};
  closed = false;
  /** a turn ends at its own `turn/completed`, which no familiar holds back. */
  readonly replied = false;
  /** thread settings apply to subsequent turns. */
  readonly takesModel = false;
  private turn?: {
    started: ReturnType<typeof Promise.withResolvers<string>>;
    finished: ReturnType<typeof Promise.withResolvers<TurnResult>>;
    messages: TurnText;
    interrupted: boolean;
    id?: string;
    compaction?: { item?: string; completed: boolean };
    /** the user's `!` command this turn runs, as typed. */
    command?: string;
  };
  private requests = new Map<string, RpcMessage>();
  private readonly proposals = new Map<
    string,
    { threadId: string; turnId: string; diff: FileDiff[] }
  >();
  private closing = false;
  private closeTask?: Promise<void>;
  private interrupting?: Promise<void>;
  private stopUntil?: number;
  private reportedStopTimeout = false;
  private connected = false;
  private settings?: ReturnType<typeof Promise.withResolvers<void>>;
  /** model and effort retain Codex settings across reroutes; Witch's requested window survives failed reloads. */
  private native: CodexSelection = { model: '' };
  private readonly malformed = new Set<string>();
  private readonly commands: CodexCommands;
  private readonly familiars: CodexFamiliars;
  private spellIndex: { name: string; path: string }[] = [];
  private castIndex = new Map<string, string>();
  private listed: Model[] = [];
  private readonly turnLines = new Map<
    string,
    { added: number; removed: number }
  >();
  private readonly account = new CodexAccount();
  private limitsRead?: Promise<void>;
  private automaticCompaction?: CodexCompactionPolicy;
  private compacting?: { item: string; turn: string };

  constructor(
    private readonly rpc: JsonRpc,
    private readonly options: SessionOptions,
    connect: (options: SessionOptions) => Promise<AgentSession>,
    private readonly contextCatalog: typeof readContextCatalog,
  ) {
    this.answers = new AnswerTurn(options, connect);

    this.info = {
      id: options.resume ?? '',
      agent: 'codex',
      model: options.model ?? '',
      permissionMode: '',
      hasHistory: !!options.resume,
      effort: options.effort,
    };

    this.native.contextWindow = options.contextWindow;

    this.familiars = new CodexFamiliars(
      rpc,
      options,
      () => this.info.id,
      () => this.closing || this.closed,
    );

    this.commands = new CodexCommands(
      rpc,
      options.familiarBinding,
      () => this.info.id,
      (thread) => thread === this.info.id || this.familiars.has(thread),
      (thread, turn) =>
        thread === this.info.id &&
        this.turn?.id === turn &&
        this.turn.interrupted,
      options.onEvent,
    );

    rpc.onMessage = (message) => this.receive(message);

    rpc.onExit = (error) => {
      // a turn or settings change in flight reports the exit itself
      const reported = !!(this.turn || this.settings);
      this.settings?.reject(error);
      this.commands.stop();
      this.proposals.clear();
      this.closed = true;

      if (this.connected) this.options.onEvent({ type: 'closed' });

      this.finish(
        this.turn?.interrupted ? 'interrupted' : 'failed',
        error.message,
      );

      if (!reported && this.connected && !this.closing)
        options.onEvent({ type: 'notice', text: error.message });
    };
  }

  async initialize(): Promise<void> {
    await initializeRpc(this.rpc);

    const answer =
      this.options.answer &&
      (await answerConfiguration(
        this.rpc,
        this.options.cwd,
        this.options.answer.requestFile,
        this.options.answer.permissionProfile,
      ));

    const isolated = !answer && this.options.withoutMcp;

    const base = {
      cwd: this.options.cwd,
      // an omitted selection restores the thread's saved workspace roots
      runtimeWorkspaceRoots: [
        ...new Set([this.options.cwd, ...this.options.memoryDirectories]),
      ],
      // in the thread's config, so app-server's own children stay unmarked
      config: {
        ...answer?.config,
        ...(isolated &&
          withoutMcp(await readConfig(this.rpc, this.options.cwd))),
        ...Object.fromEntries(
          Object.entries(this.options.mark?.environment ?? {}).map(
            ([key, value]) => [`shell_environment_policy.set.${key}`, value],
          ),
        ),
      },
    };

    this.automaticCompaction = await CodexCompactionPolicy.read(
      this.rpc,
      this.options,
      base,
      this.contextCatalog,
    );

    const parameters = {
      ...answer,
      ...(answer && this.options.resume ? { excludeTurns: true } : {}),
      ...base,
      model: this.options.model,
      config: {
        ...base.config,
        ...this.automaticCompaction?.configuration(this.options.model),
      },
      ...(this.options.resume ? { threadId: this.options.resume } : {}),
    };

    this.updateInfo(
      await this.rpc.request(
        this.options.resume
          ? answer
            ? 'thread/fork'
            : 'thread/resume'
          : 'thread/start',
        parameters,
      ),
    );

    const holder = answer ? 'a peer answer' : isolated && 'a familiar';

    if (holder) await checkNoMcpTools(this.rpc, this.info.id, holder);

    this.connected = true;
    this.publishContext();

    if (!answer) void this.readAccountUsage();
  }

  async models(): Promise<Model[]> {
    this.listed = [];
    const models = await readModels(this.rpc);
    this.listed = this.automaticCompaction?.models(models) ?? models;

    return this.listed;
  }

  async skills(): Promise<Skill[]> {
    const { enabled, errors } = await readSpells(this.rpc, this.options.cwd);

    for (const { path, message } of errors)
      this.options.onEvent({
        type: 'notice',
        text: `Can't load spell ${path}: ${message}`,
        transient: true,
      });

    this.spellIndex = enabled;
    this.castIndex = castIndex(enabled);

    return skillsOf(enabled);
  }

  /** Codex accepts any id at selection, and only its backend refuses one at the next turn. */
  async checkModel(model: string): Promise<void> {
    const offered = (models: Model[]) => models.some(({ id }) => id === model);

    if (!offered(this.listed) && !offered(await readModels(this.rpc, true)))
      throw new Error(`Codex has no model ${model}.`);
  }

  canSelectModel(
    model: string,
    contextWindow: ContextWindowChoice | undefined = this.native.contextWindow,
  ): boolean {
    return (
      !this.closed &&
      !this.turn &&
      !this.answers.busy &&
      (!this.backgroundActive ||
        !this.automaticCompaction?.requiresReload(model, contextWindow))
    );
  }

  /** Codex can't clear its thread's effort, so `null` only stops requesting one. */
  async selectModel(
    model: string,
    effort?: string | null,
    contextWindow: ContextWindowChoice | undefined = this.native.contextWindow,
  ): Promise<void> {
    if (this.turn || this.answers.busy)
      throw new Error('Stop the current turn before changing models');

    this.automaticCompaction?.assertIdle(
      model,
      this.backgroundActive,
      contextWindow,
    );

    await this.configureCompaction();

    // Codex notifies only when the settings change
    if (
      model !== this.native.model ||
      (effort != null && effort !== this.native.effort)
    ) {
      this.settings = Promise.withResolvers<void>();

      try {
        await Promise.all([
          this.rpc.request('thread/settings/update', {
            threadId: this.info.id,
            model,
            effort,
          }),
          this.settings.promise,
        ]);
      } finally {
        this.settings = undefined;
      }
    }

    this.native.contextWindow = contextWindow;
    await this.configureCompaction();

    this.setInfo({
      ...this.info,
      model: this.native.model,
      effort: effort === undefined ? this.info.effort : (effort ?? undefined),
    });
  }

  private beginTurn(): NonNullable<CodexSession['turn']> {
    if (this.closed || this.closing)
      throw new Error('The Codex session is closed');

    if (this.turn || this.answers.busy)
      throw new Error('This agent is already running');

    const turn = {
      started: Promise.withResolvers<string>(),
      finished: Promise.withResolvers<TurnResult>(),
      messages: new TurnText(),
      interrupted: false,
    };

    this.turn = turn;

    return turn;
  }

  async send(
    prompt: string,
    { skill, context, purpose = 'user', answer, images = [] }: SendOptions = {},
  ): Promise<TurnResult> {
    if (purpose === 'peer-answer' && !this.options.answer) {
      return this.answers.run(
        {
          closed: this.closed || this.closing,
          running: !!this.turn,
          label: 'Codex',
        },
        this.info,
        prompt,
        context,
        answer,
      );
    }

    const path =
      skill && this.spellIndex.find(({ name }) => name === skill.name)?.path;

    const turn = this.beginTurn();
    let submitted = false;

    try {
      if (!(await this.configureCompaction(turn)))
        return { ...(await turn.finished.promise), inputUnsent: true };

      if (context !== undefined)
        await this.rpc.request('thread/inject_items', {
          threadId: this.info.id,
          items: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: context }],
            },
          ],
        });

      if (this.turn !== turn || turn.interrupted) {
        if (this.turn === turn) this.finish('interrupted');

        return { ...(await turn.finished.promise), inputUnsent: true };
      }

      submitted = true;

      const response = turnId.parse(
        await this.rpc.request('turn/start', {
          threadId: this.info.id,
          // the TUI sends a selected skill as an item, which Codex resolves by path
          input: [
            { type: 'text', text: prompt, text_elements: [] },
            ...(skill && path
              ? [{ type: 'skill', name: skill.name, path }]
              : []),
            ...images.map((file) => ({ type: 'localImage', path: file })),
          ],
          effort: this.info.effort,
          ...(this.options.answer
            ? { outputSchema: this.options.answer.outputSchema }
            : {}),
        }),
      );

      turn.started.resolve(response.turn.id);

      if (this.turn === turn) this.turn.id = response.turn.id;

      this.setInfo({ ...this.info, hasHistory: true });
    } catch (error) {
      if (this.turn === turn) this.finish('failed', errorMessage(error));
    }

    const result = await turn.finished.promise;

    return submitted ? result : { ...result, inputUnsent: true };
  }

  async contextUsage(): Promise<number | undefined> {
    return this.usage.context;
  }

  get backgroundActive(): boolean {
    return this.commands.active || this.familiars.active;
  }

  private async configureCompaction(
    turn?: NonNullable<CodexSession['turn']>,
  ): Promise<boolean> {
    const response = await this.automaticCompaction?.apply(
      this.info,
      this.native,
      this.backgroundActive,
    );

    if (response) this.updateInfo(response);

    this.publishContext();

    if (!turn || (!turn.interrupted && this.turn === turn)) return true;

    if (this.turn === turn) this.finish('interrupted');

    return false;
  }

  private publishContext(): void {
    if (!this.automaticCompaction) return;

    const contextWindow = this.automaticCompaction.capacity(
      this.native.model,
      this.native.contextWindow,
    );

    if (contextWindow === undefined) return;

    if (this.info.contextWindow !== this.native.contextWindow) {
      this.setInfo({ ...this.info, contextWindow: this.native.contextWindow });
    }

    if (contextWindow !== this.usage.contextWindow)
      this.report({ context: undefined, contextWindow });
  }

  async compact(): Promise<TurnResult> {
    const turn = this.beginTurn();
    turn.compaction = { completed: false };

    try {
      if (!(await this.configureCompaction(turn))) return turn.finished.promise;

      await this.rpc.request('thread/compact/start', {
        threadId: this.info.id,
      });
    } catch (error) {
      if (this.turn === turn) this.finish('failed', errorMessage(error));
    }

    return turn.finished.promise;
  }

  /** Codex records the command and its output in the thread, and its turn ends without a reply. */
  async shell(command: string): Promise<TurnResult> {
    const turn = this.beginTurn();
    turn.command = command;

    try {
      if (!(await this.configureCompaction(turn))) return turn.finished.promise;

      await this.rpc.request('thread/shellCommand', {
        threadId: this.info.id,
        command,
      });

      this.setInfo({ ...this.info, hasHistory: true });
    } catch (error) {
      if (this.turn === turn) this.finish('failed', errorMessage(error));
    }

    return turn.finished.promise;
  }

  /** Codex keeps a steered prompt in the thread even when the turn is then interrupted. */
  async steer(
    prompt: string,
    { skill, images = [] }: Parameters<AgentSession['steer']>[1] = {},
  ): Promise<boolean> {
    // a prompt steered into a shell command's turn would never be answered, and Codex expands a skill only at a turn's start
    if (
      this.closed ||
      this.closing ||
      this.turn?.command !== undefined ||
      this.turn?.compaction ||
      skill
    )
      return false;

    const id = await this.turn?.started.promise;

    if (!id) return false;

    try {
      await this.rpc.request('turn/steer', {
        threadId: this.info.id,
        expectedTurnId: id,
        input: [
          { type: 'text', text: prompt, text_elements: [] },
          ...images.map((file) => ({ type: 'localImage', path: file })),
        ],
      });

      return true;
    } catch {
      // any refusal leaves the prompt to the next turn, the expected one being a turn that has just ended
      return false;
    }
  }

  interrupt(options: AgentStopOptions = {}): Promise<void> {
    if (this.answers.busy) return this.answers.interrupt(options);

    const turn = this.turn;

    if (!turn) return Promise.resolve();

    if (this.interrupting) return this.interrupting;

    turn.interrupted = true;
    this.stopUntil ??= stopDeadline(options.deadline);

    return (this.interrupting = this.interruptTurn(turn, {
      ...options,
      deadline: this.stopUntil,
    }).finally(() => {
      this.interrupting = undefined;

      if (!this.closing) this.stopUntil = undefined;
    }));
  }

  private async interruptTurn(
    turn: NonNullable<CodexSession['turn']>,
    options: AgentStopOptions & { deadline: number },
  ): Promise<void> {
    const stopped = (async () => {
      const id = await turn.started.promise;

      if (id && this.turn === turn)
        try {
          await this.rpc.request('turn/interrupt', {
            threadId: this.info.id,
            turnId: id,
          });
        } catch (error) {
          // an exit, or a completion Codex sent ahead of its reply, has ended the turn by the time its rejection lands
          if (!this.closed && this.turn === turn) throw error;
        }

      await turn.finished.promise;
    })();

    try {
      await waitForStop(stopped, options);
    } catch (error) {
      if (!(error instanceof NativeStopTimeout)) throw error;

      this.reportStopTimeout();
      this.closing = true;
      this.commands.stop();
      await this.rpc.close(options);
    }
  }

  readonly familiar = {
    report: async (
      action: FamiliarAction,
      deadline: number,
    ): Promise<FamiliarOutcome> => {
      if (this.closing || this.closed)
        throw new Error('The native session is closing.');

      return this.commands.report(action, deadline);
    },
  };

  respond(id: string, response: UserResponse): void {
    if (this.commands.respond(id, response)) return;

    const request = this.requests.get(id);

    if (!request || request.id === undefined) return;

    this.rpc.respond(request.id, requestResult(request, response));
    this.requests.delete(id);
    this.options.onEvent({ type: 'request-resolved', id });
  }

  close(options: AgentStopOptions = {}): Promise<void> {
    this.closing = true;
    this.stopUntil ??= stopDeadline(options.deadline);

    return (this.closeTask ??= this.closeSession({
      ...options,
      deadline: this.stopUntil,
    }));
  }

  private async closeSession(
    options: AgentStopOptions & { deadline: number },
  ): Promise<void> {
    try {
      const stopped = this.answers.interrupt(options).finally(async () => {
        await this.commands.close();
        await this.interrupt(options);
      });

      await waitForStop(stopped, options);
    } catch (error) {
      if (!(error instanceof NativeStopTimeout)) throw error;

      this.reportStopTimeout();
    } finally {
      this.commands.stop();

      if (await this.rpc.close(options)) this.reportStopTimeout();

      await this.options.onProcess(undefined);
    }
  }

  private reportStopTimeout(): void {
    if (this.reportedStopTimeout) return;

    this.reportedStopTimeout = true;

    this.options.onEvent({
      type: 'notice',
      text: 'Codex did not stop in time.',
    });
  }

  private setInfo(info: SessionInfo): void {
    this.info = info;
    this.options.onEvent({ type: 'info', info });
  }

  private updateInfo(response: unknown): void {
    const info = sessionInfo(response, this.info);

    this.native = {
      ...this.native,
      model: info.model,
      effort: info.nativeEffort,
    };

    this.setInfo(info);
  }

  /** one malformed notification posts a notice per method and fails only what it settles. */
  private receive(message: RpcMessage): void {
    if (message.id !== undefined && message.method) {
      this.requestInput(message);

      return;
    }

    const child = this.childThread(message);

    try {
      if (message.method === 'item/commandExecution/outputDelta')
        this.commands.output(message.params);

      const item =
        message.method === 'item/started' ||
        message.method === 'item/completed';

      if (
        child &&
        !item &&
        message.method !== 'turn/started' &&
        message.method !== 'turn/completed' &&
        message.method !== 'thread/settings/updated' &&
        message.method !== 'model/rerouted'
      )
        return;

      const params =
        message.params == null && !item && message.method !== 'turn/completed'
          ? {}
          : object.parse(message.params);

      const notification: Notification = {
        method: message.method,
        params,
        item: item ? object.parse(params.item) : undefined,
      };

      const diff = this.fileChangeDiff(notification);
      this.commands.receive(notification);
      this.familiars.cast(notification, child, this.castIndex);

      if (child) this.familiars.receive(notification, child);
      else this.notification(notification, diff);
    } catch (error) {
      const text = `Witch could not read Codex's ${message.method} notification: ${errorMessage(error)}`;

      // a subagent's notification settles nothing of this thread's
      if (!child && message.method === 'turn/completed')
        this.finish('failed', text);
      else if (!child && message.method === 'thread/settings/updated')
        this.settings?.reject(new Error(text));

      if (this.malformed.has(message.method!)) return;

      this.malformed.add(message.method!);
      this.options.onEvent({ type: 'notice', text });
    }
  }

  /** familiar approvals need their proposal even when no main transcript row owns it. */
  private fileChangeDiff(message: Notification): FileDiff[] | undefined {
    const { params: data, item } = message;

    if (message.method === 'turn/completed') {
      const completed = turnId.safeParse(data).data?.turn.id;

      if (completed === undefined) return;

      for (const [key, proposal] of this.proposals)
        if (
          proposal.threadId === data.threadId &&
          proposal.turnId === completed
        )
          this.proposals.delete(key);

      return;
    }

    if (item?.type !== 'fileChange') return;

    const changes = fileChanges.safeParse(item.changes);
    const diff = changes.success ? fileDiffs(changes.data) : undefined;
    const identity = fileChangeIdentity.safeParse({ ...data, itemId: item.id });

    if (identity.success) {
      const { threadId, turnId, itemId } = identity.data;
      const key = fileChangeKey(threadId, turnId, itemId);

      if (message.method === 'item/started' && diff)
        this.proposals.set(key, { threadId, turnId, diff });
      else this.proposals.delete(key);
    }

    return diff;
  }

  /** Codex sends a spawned thread's notifications to every connection, under that thread's id. */
  private childThread(message: RpcMessage): string | undefined {
    // a subagent's approval is asked here, so its resolution is too
    if (!this.connected || message.method === 'serverRequest/resolved') return;

    const { params } = message;

    const threadId =
      typeof params === 'object' && params !== null && 'threadId' in params
        ? params.threadId
        : undefined;

    return typeof threadId === 'string' && threadId !== this.info.id
      ? threadId
      : undefined;
  }

  private notification(message: Notification, diff?: FileDiff[]): void {
    const data = message.params;

    switch (message.method) {
      case 'thread/settings/updated': {
        const settings = object.parse(data.threadSettings);

        if (settings.model !== this.native.model)
          this.report({ context: undefined, contextWindow: undefined });

        this.native = {
          ...this.native,
          model: stringValue.parse(settings.model),
          effort: nullishString.parse(settings.effort) ?? undefined,
        };

        this.setInfo({
          ...this.info,
          model: this.native.model,
          nativeEffort: this.native.effort,
          permissionProfile: permissionProfile(
            settings.activePermissionProfile,
          ),
        });

        this.settings?.resolve();

        break;
      }

      case 'turn/started':
        // a send learned the id from `turn/start` already, and a shell command learns it here
        if (this.turn && !this.turn.id) {
          this.turn.id = turnId.parse(data).turn.id;
          this.turn.started.resolve(this.turn.id);
        }

        break;

      case 'skills/changed':
        if (!this.closing)
          void this.skills().then(
            (skills) => this.options.onEvent({ type: 'skills', skills }),
            (error: unknown) =>
              this.options.onEvent({
                type: 'notice',
                text: errorMessage(error),
                transient: true,
              }),
          );

        break;

      case 'item/agentMessage/delta': {
        const id = stringValue.parse(data.itemId);
        const text = stringValue.parse(data.delta);
        this.turn?.messages.append(id, text);
        this.options.onEvent({ type: 'text', id, text });

        break;
      }

      case 'item/started':

      case 'item/completed': {
        const item = message.item!;
        const id = stringValue.parse(item.id);
        const type = stringValue.parse(item.type);

        if (type === 'contextCompaction') {
          const turn = this.turn;
          const compact = turn?.compaction;

          if (message.method === 'item/started') {
            if (compact && data.turnId === turn.id) compact.item = id;

            this.compacting = {
              item: id,
              turn: stringValue.parse(data.turnId),
            };

            this.options.onEvent({ type: 'compacting', compacting: true });
          } else {
            if (compact && data.turnId === turn.id && compact.item === id)
              compact.completed = true;

            if (
              this.compacting?.item === id &&
              this.compacting.turn === data.turnId
            )
              this.endCompaction();

            this.options.onEvent({ type: 'compacted' });
          }
        } else if (type === 'agentMessage') {
          if (typeof item.text === 'string') {
            this.turn?.messages.replace(id, item.text);

            this.options.onEvent({
              type: 'text',
              id,
              text: item.text,
              replace: true,
            });
          }

          if (message.method === 'item/completed' && item.questions != null) {
            const questions = messageQuestions
              .parse(item.questions)
              .map((question, index) => ({
                id: String(index),
                title: question.title,
                options: question.options ?? [],
              }));

            if (questions.length)
              this.options.onEvent({
                type: 'request',
                request: {
                  id: `question/${id}`,
                  kind: 'question',
                  title: 'Questions',
                  detail: '',
                  questions,
                  replyAsPrompt: true,
                },
              });
          }
        } else if (type === 'reasoning') {
          // Codex reports a reasoning step only when it ends
          if (message.method === 'item/completed')
            this.options.onEvent({ type: 'reasoned' });
        } else if (!untooled.includes(type)) {
          this.options.onEvent(
            itemTool(
              item,
              message.method === 'item/completed',
              this.options.cwd,
              this.options.commandPrefixes,
              diff,
              // Codex titles a user's command with its shell wrapper
              item.source === 'userShell' ? this.turn?.command : undefined,
            ),
          );
        }

        break;
      }

      case 'item/commandExecution/outputDelta':
        this.options.onEvent({
          type: 'tool',
          id: stringValue.parse(data.itemId),
          title: '',
          text: stringValue.parse(data.delta),
          done: false,
          append: true,
        });

        break;

      case 'thread/tokenUsage/updated': {
        const { tokenUsage: usage } = tokenUsage.parse(data);

        const restored =
          typeof data.turnId === 'string' && data.turnId !== this.turn?.id;

        // keep the applied capacity when resume replays an older turn's usage
        const applied = restored
          ? this.automaticCompaction?.capacity(
              this.native.model,
              this.native.contextWindow,
            )
          : undefined;

        const contextWindow = applied ?? usage.modelContextWindow;

        if (contextWindow)
          this.report({
            context: (usage.last.totalTokens / contextWindow) * 100,
            contextWindow,
          });

        break;
      }

      case 'turn/diff/updated': {
        const turn = turnDiff.parse(data);
        const previous = this.turnLines.get(turn.turnId);
        const lines = diffLines(turn.diff);
        this.turnLines.set(turn.turnId, lines);

        this.report({
          lines: {
            added:
              (this.usage.lines?.added ?? 0) -
              (previous?.added ?? 0) +
              lines.added,
            removed:
              (this.usage.lines?.removed ?? 0) -
              (previous?.removed ?? 0) +
              lines.removed,
          },
        });

        break;
      }

      case 'account/rateLimits/updated': {
        const account = this.account.update(rateLimits.parse(data.rateLimits));

        if (account) this.report({ account });

        break;
      }

      case 'turn/completed': {
        const turn = object.parse(data.turn);

        if (this.turn?.compaction && turn.id !== this.turn.id) break;

        const status = stringValue.parse(turn.status);
        const error = turn.error == null ? undefined : object.parse(turn.error);
        const completed = turnId.safeParse(data).data?.turn.id;

        if (['completed', 'interrupted', 'failed'].includes(status))
          this.finish(
            status as TurnResult['status'],
            typeof error?.message === 'string' ? error.message : undefined,
            completed,
            // rateLimitExceeded and sessionBudgetExceeded are separate members and don't count
            error?.codexErrorInfo === 'usageLimitExceeded',
          );
        else
          this.finish(
            'failed',
            `Codex ended the turn with status ${status}`,
            completed,
          );

        break;
      }

      case 'model/rerouted':
        if (typeof data.toModel === 'string') {
          if (data.toModel !== this.info.model)
            this.report({ context: undefined, contextWindow: undefined });

          this.setInfo({ ...this.info, model: data.toModel });
        }

        break;

      case 'mcpServer/startupStatus/updated': {
        const { name, status, error } = mcpStartup.parse(data);

        if (status === 'failed')
          this.options.onEvent({
            type: 'notice',
            text: `Codex could not start MCP server ${name}${error ? `: ${error}` : '.'}`,
            transient: true,
          });

        break;
      }

      case 'serverRequest/resolved': {
        const id = String(data.requestId);
        this.requests.delete(id);
        this.options.onEvent({ type: 'request-resolved', id });

        break;
      }

      case 'error':
        // a final error comes back as the failed turn's error, which the coordinator posts
        if (data.willRetry || !this.turn)
          this.options.onEvent({
            type: 'notice',
            text: stringValue.parse(object.parse(data.error).message),
          });
    }
  }

  private requestInput(message: RpcMessage): void {
    if (this.options.answer) {
      this.rpc.reject(
        message.id!,
        'Peer answers cannot request user input or approval.',
      );

      return;
    }

    let request;

    try {
      request = parseRequest(message, this.proposals);
    } catch (error) {
      const text = `Witch could not read Codex's ${message.method} request: ${errorMessage(error)}`;
      this.rpc.reject(message.id!, text);
      this.options.onEvent({ type: 'notice', text });

      return;
    }

    if (!request) {
      const text = `Unsupported native request: ${message.method}`;
      this.rpc.reject(message.id!, text);
      this.options.onEvent({ type: 'notice', text });

      return;
    }

    this.requests.set(request.id, message);
    this.options.onEvent({ type: 'request', request });
  }

  private report(update: Usage): void {
    this.usage = { ...this.usage, ...update };
    this.options.onEvent({ type: 'usage', usage: this.usage });
  }

  readAccountUsage(): Promise<void> {
    return (this.limitsRead ??= this.readLimitsOnce().finally(() => {
      this.limitsRead = undefined;
    }));
  }

  private async readLimitsOnce(): Promise<void> {
    try {
      const account = await this.account.read(this.rpc);

      if (account) this.report({ account });
    } catch {
      // limits stay unreported
    }
  }

  private finish(
    status: TurnResult['status'],
    error?: string,
    completedTurnId = this.turn?.id,
    exhausted = false,
  ): void {
    const turn = this.turn;

    // an interrupted or failed attempt can end without a compaction completion item
    if (this.closed || this.compacting?.turn === completedTurnId)
      this.endCompaction();

    if (turn?.interrupted && (turn.compaction || this.reportedStopTimeout))
      status = 'interrupted';
    else if (
      turn?.compaction &&
      status === 'completed' &&
      !turn.compaction.completed
    ) {
      status = 'failed';
      error = 'Codex ended compaction without confirming history replacement';
    }

    this.turn = undefined;
    // a shell command's turn that never reported its start would hold an interrupt waiting for it
    turn?.started.resolve('');

    for (const [id, request] of this.requests) {
      const { threadId, turnId } = object.parse(request.params);

      if (
        this.closed ||
        (completedTurnId !== undefined &&
          threadId === this.info.id &&
          turnId === completedTurnId)
      ) {
        this.requests.delete(id);
        this.options.onEvent({ type: 'request-resolved', id });
      }
    }

    turn?.finished.resolve({
      status,
      text: turn.compaction
        ? ''
        : this.options.answer
          ? turn.messages.last
          : turn.messages.text,
      ...(!turn.compaction && turn.messages.final
        ? { final: turn.messages.final }
        : {}),
      ...(error ? { error } : {}),
      ...(exhausted && status === 'failed' ? { exhausted } : {}),
    });
  }

  private endCompaction(): void {
    if (!this.compacting) return;

    this.compacting = undefined;
    this.options.onEvent({ type: 'compacting', compacting: false });
  }
}
