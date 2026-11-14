import { AnswerTurn } from './answer-turn.js';
import { answerConfiguration, checkNoMcpTools } from './codex-answer.js';
import { object, readConfig, withoutMcp } from './codex-config.js';
import { readModels } from './codex-models.js';
import {
  CodexCompactionPolicy,
  readContextCatalog,
} from './codex-compaction-policy.js';
import type { CodexSelection } from './codex-compaction-policy.js';
import { permissionProfile, sessionInfo } from './codex-session-info.js';
import { spawn } from 'node:child_process';
import { nativeLaunch } from './native-launch.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { JsonRpc } from './json-rpc.js';
import type { RpcMessage } from './json-rpc.js';
import { TurnText } from './turn-text.js';
import { CodexCommands } from './codex-commands.js';
import type { Notification } from './codex-commands.js';
import { CodexAccount, probeAccountUsage, rateLimits } from './codex-limits.js';
import type { FamiliarAction, FamiliarOutcome } from './familiar-report.js';
import { CodexFamiliars } from './codex-familiars.js';
import {
  fileChanges,
  fileDiffs,
  itemTool,
  turnId,
  untooled,
} from './codex-items.js';
import { diffLines } from './file-diff.js';
import { errorMessage } from '../errors.js';
import {
  beforeDeadline,
  closeFailedStart,
  NativeStopTimeout,
  stopDeadline,
  stopOptions,
  terminationReserveMs,
} from './shutdown.js';
import { castIndex } from './codex-spells.js';
import type {
  AgentAdapter,
  AccountReading,
  AgentSession,
  AgentStopOptions,
  FileDiff,
  Model,
  ModelDiscoveryOptions,
  SessionInfo,
  SessionOptions,
  Skill,
  TurnResult,
  Usage,
  UserRequest,
  UserResponse,
  SendOptions,
} from './types.js';

const stringValue = z.string();
const nullishString = stringValue.nullish();
const turnDiff = z.object({ turnId: stringValue, diff: stringValue });

const skillList = z.object({
  data: z.array(
    z.object({
      skills: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          shortDescription: z.string().nullish(),
          interface: z
            .object({ shortDescription: z.string().nullish() })
            .nullish(),
          path: z.string(),
          enabled: z.boolean(),
        }),
      ),
    }),
  ),
});

const tokenUsage = z.object({
  tokenUsage: z.object({
    last: z.object({ totalTokens: z.number() }),
    modelContextWindow: z.number().nullable(),
  }),
});

const questionList = z.array(
  z.object({
    id: z.string(),
    question: z.string(),
    isSecret: z.boolean().optional(),
    options: z.array(z.object({ label: z.string() })).nullable(),
  }),
);

const messageQuestions = z.array(
  z.object({
    title: z.string(),
    options: z.array(z.string()).nullish(),
  }),
);

function fileChangeKey(
  threadId: string,
  turnId: string,
  itemId: string,
): string {
  return JSON.stringify([threadId, turnId, itemId]);
}

const fileChangeIdentity = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
});

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

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly label = 'Codex';

  constructor(
    private readonly start: Launch = launch,
    private readonly contextCatalog = readContextCatalog,
  ) {}

  models(options: ModelDiscoveryOptions): Promise<Model[]> {
    return this.probe(options, readModels);
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
  /** the thread's settings as Codex last reported them, which `model/rerouted` leaves alone. */
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

    const parameters = {
      ...answer,
      ...(answer && this.options.resume ? { excludeTurns: true } : {}),
      cwd: this.options.cwd,
      model: this.options.model,
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
      ...(this.options.resume ? { threadId: this.options.resume } : {}),
    };

    this.automaticCompaction = await CodexCompactionPolicy.read(
      this.rpc,
      this.options,
      parameters.config,
      this.contextCatalog,
    );

    parameters.config = {
      ...parameters.config,
      ...this.automaticCompaction?.configuration(parameters.model),
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

    if (!answer) void this.readAccountUsage();
  }

  async models(): Promise<Model[]> {
    this.listed = [];
    this.listed = await readModels(this.rpc);

    return this.listed;
  }

  async skills(): Promise<Skill[]> {
    const { data } = skillList.parse(
      await this.rpc.request('skills/list', {
        cwds: [this.options.cwd],
        forceReload: true,
      }),
    );

    const enabled = data
      .flatMap((entry) => entry.skills)
      .filter((skill) => skill.enabled);

    this.spellIndex = enabled;
    this.castIndex = castIndex(enabled);
    const skills: Skill[] = [];

    for (const skill of enabled) {
      if (skills.some(({ name }) => name === skill.name)) continue;

      skills.push({
        name: skill.name,
        description:
          skill.interface?.shortDescription ??
          skill.shortDescription ??
          skill.description,
      });
    }

    return skills;
  }

  /** Codex accepts any id at selection, and only its backend refuses one at the next turn. */
  async checkModel(model: string): Promise<void> {
    const offered = (models: Model[]) => models.some(({ id }) => id === model);

    if (!offered(this.listed) && !offered(await readModels(this.rpc, true)))
      throw new Error(`Codex has no model ${model}.`);
  }

  /** Codex can't clear its thread's effort, so `null` only stops requesting one. */
  async selectModel(model: string, effort?: string | null): Promise<void> {
    if (this.turn || this.answers.busy)
      throw new Error('Stop the current turn before changing models');

    this.automaticCompaction?.assertIdle(model, this.backgroundActive);

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

    await this.configureCompaction();

    this.info = {
      ...this.info,
      model: this.native.model,
      effort: effort === undefined ? this.info.effort : (effort ?? undefined),
    };

    this.options.onEvent({ type: 'info', info: this.info });
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

      this.info = { ...this.info, hasHistory: true };

      this.options.onEvent({ type: 'info', info: this.info });
    } catch (error) {
      if (this.turn === turn) this.finish('failed', errorMessage(error));
    }

    const result = await turn.finished.promise;

    return submitted ? result : { ...result, inputUnsent: true };
  }

  async contextUsage(): Promise<number | undefined> {
    return this.usage.context;
  }

  private get backgroundActive(): boolean {
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

    if (!turn || (!turn.interrupted && this.turn === turn)) return true;

    if (this.turn === turn) this.finish('interrupted');

    return false;
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

      this.info = { ...this.info, hasHistory: true };

      this.options.onEvent({ type: 'info', info: this.info });
    } catch (error) {
      this.finish('failed', errorMessage(error));
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
      if (options.restart) await stopped;
      else
        await beforeDeadline(stopped, options.deadline - terminationReserveMs);
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

    const params = object.parse(request.params);
    let result: unknown;

    switch (request.method) {
      case 'item/tool/requestUserInput':
        result = {
          answers: Object.fromEntries(
            Object.entries(response.answers ?? {}).map(([key, answers]) => [
              key,
              { answers },
            ]),
          ),
        };

        break;

      case 'mcpServer/elicitation/request':
        result = {
          action: response.decision,
          content: response.content ?? null,
          _meta: null,
        };

        break;

      case 'item/permissions/requestApproval':
        result = {
          permissions:
            response.decision === 'accept'
              ? Object.fromEntries(
                  Object.entries(object.parse(params.permissions)).filter(
                    ([, value]) => value !== null,
                  ),
                )
              : {},
          scope: 'turn',
        };

        break;

      default:
        result = { decision: response.decision };
    }

    this.rpc.respond(request.id, result);

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

      if (options.restart) await stopped;
      else
        await beforeDeadline(stopped, options.deadline - terminationReserveMs);
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

  private updateInfo(response: unknown): void {
    this.info = sessionInfo(response, this.info);

    this.native = {
      model: this.info.model,
      effort: this.info.nativeEffort,
    };

    this.options.onEvent({ type: 'info', info: this.info });
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
          model: stringValue.parse(settings.model),
          effort: nullishString.parse(settings.effort) ?? undefined,
        };

        this.info = {
          ...this.info,
          model: this.native.model,
          nativeEffort: this.native.effort,
          permissionProfile: permissionProfile(
            settings.activePermissionProfile,
          ),
        };

        this.options.onEvent({ type: 'info', info: this.info });

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
          } else {
            if (compact && data.turnId === turn.id && compact.item === id)
              compact.completed = true;

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

        if (usage.modelContextWindow)
          this.report({
            context: (usage.last.totalTokens / usage.modelContextWindow) * 100,
            contextWindow: usage.modelContextWindow,
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

          this.info = { ...this.info, model: data.toModel };

          this.options.onEvent({ type: 'info', info: this.info });
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
      request = this.parseRequest(message);
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

  private parseRequest(message: RpcMessage): UserRequest | undefined {
    const id = String(message.id);
    const data = object.parse(message.params);

    const request = {
      id,
      title: String(
        data.reason ?? data.message ?? data.command ?? message.method,
      ),
      detail: JSON.stringify(data, null, 2),
      survivesTurn: true,
    };

    if (message.method === 'item/tool/requestUserInput')
      return {
        ...request,
        kind: 'question',
        questions: questionList.parse(data.questions).map((question) => ({
          id: question.id,
          title: question.question,
          secret: question.isSecret,
          options: question.options?.map((option) => option.label) ?? [],
        })),
      };

    if (message.method === 'mcpServer/elicitation/request')
      return {
        ...request,
        kind: 'elicitation',
        url: typeof data.url === 'string' ? data.url : undefined,
        schema: data.requestedSchema
          ? object.parse(data.requestedSchema)
          : undefined,
      };

    if (message.method === 'item/fileChange/requestApproval') {
      const identity = fileChangeIdentity.safeParse(data);

      const diff = identity.success
        ? this.proposals.get(
            fileChangeKey(
              identity.data.threadId,
              identity.data.turnId,
              identity.data.itemId,
            ),
          )?.diff
        : undefined;

      return { ...request, kind: 'approval', ...(diff ? { diff } : {}) };
    }

    if (
      [
        'item/commandExecution/requestApproval',
        'item/permissions/requestApproval',
      ].includes(message.method ?? '')
    )
      return { ...request, kind: 'approval' };

    return undefined;
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
      ...(error ? { error } : {}),
      ...(exhausted && status === 'failed' ? { exhausted } : {}),
    });
  }
}
