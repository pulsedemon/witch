import { AnswerTurn } from './answer-turn.js';
import { toolRequest } from './claude-permissions.js';
import { content, readImages } from './claude-content.js';
import { spawn } from 'node:child_process';
import { nativeLaunch } from './native-launch.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AbortError, query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  ModelInfo,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { InputQueue } from './input-queue.js';
import { TurnText } from './turn-text.js';
import { accountReading, ClaudeUsage } from './claude-usage.js';
import { ClaudeCompaction } from './claude-compaction.js';
import { ClaudeContext } from './claude-context.js';
import { promptless, sideQuery, startupFailure } from './claude-side.js';
import type { ClaudeLaunch } from './claude-side.js';
import { ClaudeCommands } from './claude-commands.js';
import type { ClaudeTaskControl } from './claude-commands.js';
import type { UsageSource } from './claude-usage.js';
import { reportedDiff } from './claude-diff.js';
import { errorMessage, watchChild, withTail } from './stderr.js';
import type { ChildExit } from './stderr.js';
import {
  beforeDeadline,
  NativeStop,
  NativeStopTimeout,
  running,
  stopDeadline,
  stopOptions,
  terminateChild,
  terminationReserveMs,
} from './shutdown.js';
import { claudeTitle } from './tool-title.js';
import { modelsOf } from './claude-models.js';
import { acknowledged, skillCasts, skillsOf } from './claude-spells.js';
import { mergeCasts } from './familiar-report.js';
import { bashRecord, runShell, shellFailed } from './user-shell.js';
import { RateLimit } from './claude-limits.js';
import type {
  AgentAdapter,
  AgentSession,
  AgentStopOptions,
  AnswerInput,
  AccountReading,
  Model,
  ModelDiscoveryOptions,
  SessionInfo,
  SessionOptions,
  Skill,
  Cast,
  SkillCall,
  Subagent,
  TurnResult,
  TurnPurpose,
  Usage,
  UserRequest,
  UserResponse,
} from './types.js';

const launch: ClaudeLaunch = (options) =>
  nativeLaunch(options.command, options.env, (command) =>
    spawn(command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: 'pipe',
    }),
  );
const effortLevel = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const sessionUsage = z.object({
  session: z.object({
    total_lines_added: z.number(),
    total_lines_removed: z.number(),
  }),
});
const commandLifecycle = z.object({
  type: z.literal('command_lifecycle'),
  session_id: z.string(),
  command_uuid: z.string(),
  state: z.enum([
    'queued',
    'started',
    'completed',
    'cancelled',
    'discarded',
    'refused',
  ]),
});

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly label = 'Claude Code';

  constructor(private readonly start: ClaudeLaunch = launch) {}

  models(options: ModelDiscoveryOptions): Promise<Model[]> {
    return sideQuery(this.start, options, async (query) =>
      modelsOf(await query.supportedModels()),
    );
  }

  accountUsage(
    options: ModelDiscoveryOptions,
    previous: AccountReading,
  ): Promise<AccountReading> {
    return sideQuery(this.start, options, async (query) => {
      const account = accountReading(
        await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
          skipBehaviors: true,
        }),
        previous,
      );
      if (!account)
        throw new Error('Claude Code sent an unreadable usage report.');
      return account;
    });
  }

  /** settings files, `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_*_MODEL` can pin an alias to an older model, so none applies. */
  latest(options: ModelDiscoveryOptions): Promise<Record<string, string>> {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          name !== 'ANTHROPIC_MODEL' &&
          !/^ANTHROPIC_DEFAULT_\w+_MODEL$/.test(name),
      ),
    );
    return sideQuery(
      this.start,
      options,
      async (query) =>
        Object.fromEntries(
          (await query.supportedModels()).flatMap(({ value, resolvedModel }) =>
            value !== 'default' && !value.startsWith('claude-') && resolvedModel
              ? [[value, resolvedModel]]
              : [],
          ),
        ),
      { settingSources: [], env },
    );
  }

  async connect(options: SessionOptions): Promise<AgentSession> {
    const session = new ClaudeSession(options, this.start, (answer) =>
      this.connect(answer),
    );
    try {
      await session.initialize();
      return session;
    } catch (error) {
      // read before close, so a stop that lands while it waits doesn't replace the startup error
      const reason: unknown = options.signal?.reason;
      await session.close(stopOptions(options.signal));
      throw reason instanceof NativeStop ? reason : error;
    }
  }
}

interface Turn {
  started: ReturnType<typeof Promise.withResolvers<boolean>>;
  finished: ReturnType<typeof Promise.withResolvers<TurnResult>>;
  result?: TurnResult;
  interrupted: boolean;
  messages: TurnText;
  /** pending until acknowledged, so a result from Claude Code's own run can't settle the turn; generated context never returns unread. */
  inputs: Map<
    string,
    { prompt?: string; pending: boolean; contextOnly?: true }
  >;
  inputError?: string;
  commandRecords: Map<string, { records: string[]; writeAttempted: boolean }>;
  initialInput?: string;
  /** keep the turn open across native idle until a steered command and its reply finish. */
  held: boolean;
  /** native idle can precede delivery of input this turn already accepted. */
  idle: boolean;
  answer?: string;
  compaction?: true;
}

class ClaudeSession implements AgentSession {
  private readonly answers: AnswerTurn;
  info: SessionInfo;
  usage: Usage = {};
  closed = false;
  private readonly input = new InputQueue<SDKUserMessage>();
  private readonly query: Query;
  private readonly usageReader: ClaudeUsage;
  private readonly reading: Promise<void>;
  private registered = Promise.resolve();
  private child?: ChildExit;
  private process?: ChildProcessWithoutNullStreams;
  private closeTask?: Promise<void>;
  private interrupting?: Promise<void>;
  private terminating?: Promise<boolean>;
  private stopUntil?: number;
  private reportedStopTimeout = false;
  private readonly abort = new AbortController();
  private readonly cancelConnection = () => this.abort.abort();
  private readonly requests = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<UserResponse>>
  >();
  private currentMessage = '';
  private turn?: Turn;
  private readonly rateLimit = new RateLimit<Turn>();
  private compaction?: ClaudeCompaction;
  private readonly context: ClaudeContext;
  readonly restoreCompactionContext?: AgentSession['restoreCompactionContext'];
  /** the user's `!` command until its record and process reports settle. */
  private command?: { controller: AbortController; finished: Promise<void> };
  /** commands' records for the next prompt, where Claude Code merges its own `!` records. */
  private records: string[] = [];
  private readonly subagents = new Map<string, Subagent>();
  private readonly pendingCasts = new Map<string, string>();
  private readonly commands: ClaudeCommands;
  private readonly workflows = new Set<string>();
  /** the task ids the last live set listed. a foreground familiar is never listed, so only a task listed before can end by leaving it. */
  private listed = new Set<string>();
  private readonly runs = new Map<string, string>();
  /** the message each familiar's report comes from; its later blocks arrive as frames of their own. */
  private readonly reportMessages = new Map<string, string>();
  private connected = false;
  private messageLifecycle = false;
  private sessionLifecycle = false;
  private reportedMissingLifecycle = false;
  private readonly reportedMcp = new Set<string>();
  private mcpTimer?: ReturnType<typeof setTimeout>;
  private mcpReading = false;
  private mcpRequested = false;
  private mcpPending = false;

  constructor(
    private readonly options: SessionOptions,
    start: ClaudeLaunch,
    connect: (options: SessionOptions) => Promise<AgentSession>,
  ) {
    this.answers = new AnswerTurn(options, connect);
    options.signal?.addEventListener('abort', this.cancelConnection, {
      once: true,
    });
    if (options.signal?.aborted) this.abort.abort();
    this.info = {
      id: options.resume ?? randomUUID(),
      agent: 'claude',
      model: options.model ?? '',
      permissionMode: '',
      hasHistory: !!options.resume,
      effort: options.effort,
    };
    this.context = new ClaudeContext(() => this.query);
    this.restoreCompactionContext = options.automaticCompaction
      ? this.context.bind
      : undefined;
    this.query = query({
      prompt: this.input,
      options: {
        cwd: options.cwd,
        abortController: this.abort,
        pathToClaudeCodeExecutable: options.executable,
        ...(options.resume
          ? { resume: options.resume }
          : { sessionId: this.info.id }),
        model: options.model,
        ...(options.effort
          ? { effort: effortLevel.parse(options.effort) }
          : {}),
        additionalDirectories: options.memoryDirectories,
        settingSources: ['user', 'project', 'local'],
        ...(options.answer
          ? {
              ...promptless,
              forkSession: !!options.resume,
              tools: ['Read', 'Grep', 'Glob'],
              outputFormat: {
                type: 'json_schema' as const,
                schema: options.answer.outputSchema,
              },
            }
          : {}),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        includePartialMessages: true,
        hooks: options.automaticCompaction ? this.context.hooks : undefined,
        // a familiar's last message is its report, which the sidebar and transcript show
        forwardSubagentText: true,
        env: {
          ...process.env,
          CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
          // the script exports the mark to each command, and the CLI itself stays unmarked
          ...(options.mark?.script
            ? { CLAUDE_ENV_FILE: options.mark.script }
            : {}),
        },
        spawnClaudeCodeProcess: (settings) => {
          const child = start(settings);
          this.process = child;
          const write = child.stdin.write;
          child.stdin.write = (...args) => {
            const message = JSON.parse(args[0] as string) as SDKUserMessage;
            if (message.type === 'user' && message.uuid) {
              const input = this.turn?.commandRecords.get(message.uuid);
              // a writer can throw after accepting bytes, so record the attempt first
              if (input) input.writeAttempted = true;
            }
            return Reflect.apply(write, child.stdin, args) as boolean;
          };
          this.child = watchChild(child);
          this.registered = options.onProcess(child.pid);
          // initialize() awaits it, but may fail before it does
          this.registered.catch(() => {});
          return child;
        },
        canUseTool: async (toolName, input, context) => {
          // the batch file is Witch-owned input outside Claude's working directories
          if (
            toolName === 'Read' &&
            options.answer &&
            input.file_path === options.answer.requestFile
          )
            return { behavior: 'allow', updatedInput: input };
          if (options.answer)
            return {
              behavior: 'deny',
              message: 'Peer answers cannot request approval.',
            };
          const request = await toolRequest(
            toolName,
            input,
            context.toolUseID,
            options.cwd,
            context.signal,
          );
          if (context.signal.aborted || this.closed)
            return {
              behavior: 'deny',
              message: 'Request cancelled',
              interrupt: true,
            };
          const response = await this.ask(request, context.signal);
          if (response.decision !== 'accept')
            return {
              behavior: 'deny',
              message: 'User declined the request',
              interrupt: response.decision === 'cancel',
            };
          return {
            behavior: 'allow',
            updatedInput:
              toolName === 'AskUserQuestion'
                ? {
                    ...input,
                    answers: Object.fromEntries(
                      Object.entries(response.answers ?? {}).map(
                        ([id, answers]) => [id, answers.join(', ')],
                      ),
                    ),
                  }
                : input,
          };
        },
        onElicitation: async (request, context) => {
          if (options.answer) return { action: 'decline' };
          const response = await this.ask(
            {
              id: randomUUID(),
              kind: 'elicitation',
              title: request.message,
              detail: request.serverName,
              url: request.url,
              schema: request.requestedSchema,
            },
            context.signal,
          );
          const content = response.content
            ? z
                .record(
                  z.string(),
                  z.union([
                    z.string(),
                    z.number(),
                    z.boolean(),
                    z.array(z.string()),
                  ]),
                )
                .parse(response.content)
            : undefined;
          return { action: response.decision, ...(content ? { content } : {}) };
        },
      },
    });
    this.commands = new ClaudeCommands(
      this.query as Query & ClaudeTaskControl,
      options.familiarBinding,
      () => this.info.id,
      (id) => this.subagents.has(id),
      options.onEvent,
    );
    this.usageReader = new ClaudeUsage(
      options,
      start,
      this.query,
      (report, source) => this.applyUsage(report, source),
    );
    this.reading = this.read();
  }

  async initialize(): Promise<void> {
    try {
      await this.query.initializationResult();
    } catch (error) {
      throw await startupFailure(error, this.child);
    }
    this.connected = true;
    await this.registered;
    if (!this.options.answer) {
      this.readUsage();
      this.refreshMcpStatus();
    }
  }

  private refreshMcpStatus(): void {
    if (this.closed) return;
    clearTimeout(this.mcpTimer);
    this.mcpTimer = undefined;
    this.mcpRequested = true;
    if (!this.mcpReading) void this.readMcpStatus();
  }

  private async readMcpStatus(): Promise<void> {
    this.mcpReading = true;
    try {
      do {
        this.mcpRequested = false;
        try {
          const servers = await this.query.mcpServerStatus();
          if (this.closed) return;
          // cached discovery also reports pending, but its tools do not need a startup poll.
          this.mcpPending = servers.some(
            ({ status, tools }) => status === 'pending' && tools === undefined,
          );
          for (const { name, status, error } of servers) {
            if (status !== 'failed' && status !== 'needs-auth') continue;
            const key = JSON.stringify([name, status]);
            if (this.reportedMcp.has(key)) continue;
            this.reportedMcp.add(key);
            this.options.onEvent({
              type: 'notice',
              text:
                status === 'needs-auth'
                  ? `Claude MCP server ${name} needs sign-in.`
                  : `Claude could not connect to MCP server ${name}${error ? `: ${error}` : '.'}`,
              transient: true,
            });
          }
        } catch {
          // a failed diagnostic read must not interrupt the conversation.
        }
      } while (this.mcpRequested && !this.closed);
    } finally {
      this.mcpReading = false;
      if (this.mcpPending && !this.closed) {
        this.mcpTimer = setTimeout(() => this.refreshMcpStatus(), 1000);
        this.mcpTimer.unref();
      }
    }
  }

  private stopMcpPolling(): void {
    clearTimeout(this.mcpTimer);
    this.mcpTimer = undefined;
    this.mcpRequested = false;
  }

  async models(refresh = false): Promise<Model[]> {
    if (this.turn)
      throw new Error('Stop the current turn before refreshing models');
    const models: ModelInfo[] = refresh
      ? (await this.query.reinitialize()).models
      : await this.query.supportedModels();
    return modelsOf(models);
  }

  /** the SDK keeps this cache current from the CLI's `commands_changed` pushes, so reading it sends nothing. */
  async skills(): Promise<Skill[]> {
    return skillsOf(await this.query.supportedCommands());
  }

  /** an omitted effort leaves `effortLevel` unsent, which keeps the effort in force. */
  async selectModel(model: string, effort?: string | null): Promise<void> {
    if (this.answers.busy || (this.turn && !this.replied))
      throw new Error('Stop the current turn before changing models');
    const level = effort == null ? effort : effortLevel.parse(effort);
    await this.query.setModel(model);
    if (model !== this.info.model) {
      this.report({ context: undefined, contextWindow: undefined });
      this.context.invalidate();
    }
    if (level !== undefined)
      await this.query.applyFlagSettings({ effortLevel: level });
    this.info = {
      ...this.info,
      model,
      ...(level !== undefined
        ? { effort: level ?? undefined, nativeEffort: level ?? undefined }
        : {}),
    };
    this.options.onEvent({ type: 'info', info: this.info });
    if (this.options.automaticCompaction) await this.context.configure();
  }

  async send(
    prompt: string,
    skill?: SkillCall,
    context?: string,
    purpose: TurnPurpose = 'user',
    answer?: AnswerInput,
    images: readonly string[] = [],
  ): Promise<TurnResult> {
    if (purpose === 'peer-answer' && !this.options.answer) {
      if (this.closed) throw new Error('The Claude session is closed');
      if (this.turn) throw new Error('This agent is already running');
      return this.answers.run(this.info, prompt, context, answer);
    }
    const blocks = readImages(images);
    if (!Array.isArray(blocks)) return blocks;
    const turn = this.beginTurn();
    if (this.options.automaticCompaction) {
      try {
        await this.context.configure();
      } catch (error) {
        this.finish(turn, {
          status: 'failed',
          text: '',
          error: errorMessage(error),
        });
        return { ...(await turn.finished.promise), inputUnsent: true };
      }
      if (turn.interrupted || this.turn !== turn || this.closed) {
        this.finish(turn, { status: 'interrupted', text: '' });
        return { ...(await turn.finished.promise), inputUnsent: true };
      }
    }
    const records = this.takeUnreadContext();
    const input =
      context === undefined
        ? prompt
        : `${context}\n\n${purpose === 'user' ? 'User' : 'Witch'} request:\n${prompt}`;
    const uuid = this.push(
      content(records, input, blocks, skill),
      !skill && prompt.trim().startsWith('/'),
    );
    turn.initialInput = uuid;
    turn.idle = false;
    turn.started.resolve(true);
    turn.inputs.set(uuid, { pending: true });
    turn.commandRecords.set(uuid, { records, writeAttempted: false });
    if (skill && !skill.builtin) this.pendingCasts.set(uuid, skill.name);
    return turn.finished.promise;
  }

  async compact(): Promise<TurnResult> {
    if (this.command) throw new Error('This agent is already running');
    const turn = this.beginTurn();
    turn.compaction = true;
    this.compaction = new ClaudeCompaction(this.push('/compact'), true);
    return turn.finished.promise;
  }

  compactDuringTurn(): Promise<TurnResult> | undefined {
    const turn = this.turn;
    if (
      this.closed ||
      !turn ||
      !turn.initialInput ||
      turn.interrupted ||
      turn.held ||
      turn.compaction ||
      this.compacting ||
      this.command ||
      (!this.messageLifecycle && !this.replied)
    )
      return undefined;
    turn.idle = false;
    this.compaction = new ClaudeCompaction(
      this.push('/compact'),
      !this.messageLifecycle,
    );
    return this.compaction.finished.promise;
  }

  private get compacting(): boolean {
    return !!this.compaction && !this.compaction.result;
  }

  private beginTurn(): Turn {
    if (this.answers.busy) throw new Error('This agent is already running');
    if (this.closed) throw new Error('The Claude session is closed');
    if (this.turn) throw new Error('This agent is already running');
    const turn: Turn = {
      started: Promise.withResolvers<boolean>(),
      finished: Promise.withResolvers<TurnResult>(),
      interrupted: false,
      messages: new TurnText(),
      inputs: new Map(),
      commandRecords: new Map(),
      held: false,
      idle: false,
    };
    this.turn = turn;
    return turn;
  }

  /** the SDK has no request that runs a `!` command, so Witch runs it and keeps its record for the next prompt. */
  async shell(command: string): Promise<TurnResult> {
    if (this.closed) throw new Error('The Claude session is closed');
    if (this.turn || this.command)
      throw new Error('This agent is already running');
    return this.run(command);
  }

  private async run(command: string): Promise<TurnResult> {
    const abort = new AbortController();
    const finished = Promise.withResolvers<void>();
    this.command = { controller: abort, finished: finished.promise };
    try {
      const id = randomUUID();
      const row = (text: string, done = false, failed = false) =>
        this.options.onEvent({
          type: 'tool',
          id,
          title: '',
          text,
          done,
          append: true,
          ...(failed ? { failed: true } : {}),
        });
      this.options.onEvent({
        type: 'tool',
        id,
        title: command,
        text: '',
        done: false,
        shell: true,
      });
      let started: Promise<void> | undefined;
      let failed = true;
      try {
        const run = await runShell(command, {
          cwd: this.options.cwd,
          env: this.options.mark?.environment,
          signal: abort.signal,
          onOutput: (text) => row(text),
          onSpawn: (pid) => {
            started = this.options.onShell?.(pid);
            // awaited once the command ends, which can be long after a failed report
            started?.catch(() => {});
          },
        });
        this.records.push(bashRecord(command, run));
        failed = shellFailed(run);
        return {
          status: run.interrupted ? 'interrupted' : 'completed',
          text: '',
        };
      } catch (error) {
        return { status: 'failed', text: '', error: errorMessage(error) };
      } finally {
        row('', true, failed);
        if (started) {
          await started;
          await this.options.onShell?.(undefined);
        }
      }
    } finally {
      this.command = undefined;
      finished.resolve();
    }
  }

  async steer(
    prompt: string,
    options: Parameters<AgentSession['steer']>[1] = {},
  ): Promise<boolean> {
    const { command, skill, contextOnly, images = [] } = options;
    const blocks = readImages(images);
    if (!Array.isArray(blocks)) return false;
    const turn = this.turn;
    if (turn && !turn.compaction && !(await turn.started.promise)) return false;
    if (
      this.closed ||
      !turn ||
      this.turn !== turn ||
      turn.interrupted ||
      turn.held ||
      turn.compaction ||
      this.compacting
    )
      return false;
    // without acknowledgements, background holders keep delivery ahead of idle
    if (
      turn.result &&
      !this.replied &&
      !(this.messageLifecycle && command === undefined)
    )
      return false;
    // Claude Code runs a command only once the native turn ends, which without acknowledgements could be after this one
    if (skill && !this.messageLifecycle && !this.replied) return false;
    if (command === undefined) {
      // Claude Code holds a message shaped like a slash command until the turn ends; marked, it joins as text
      const uuid = this.push(
        blocks.length
          ? content([], skill ? '' : prompt, blocks, skill)
          : prompt,
        !skill && prompt.trim().startsWith('/'),
      );
      turn.inputs.set(uuid, {
        prompt: contextOnly ? undefined : prompt,
        pending: true,
        contextOnly,
      });
      if (skill && !skill.builtin) this.pendingCasts.set(uuid, skill.name);
    } else {
      turn.held = true;
      void this.reply(turn, command, prompt);
    }
    return true;
  }

  get replied(): boolean {
    const turn = this.turn;
    return (
      !this.closed &&
      !!turn?.result &&
      !turn.compaction &&
      !this.compacting &&
      !turn.interrupted &&
      !turn.held &&
      this.holding
    );
  }

  /** a familiar or workflow runs in the background, which holds off Claude Code's idle. */
  private get holding(): boolean {
    return (
      this.workflows.size > 0 ||
      [...this.subagents.values()].some(({ status }) => status === 'running')
    );
  }

  /** native idle or a new holder releases a reply that arrives after the last holder. */
  private async reply(
    turn: Turn,
    command: string,
    prompt: string,
  ): Promise<void> {
    let ran: TurnResult;
    try {
      ran = await this.run(command);
    } catch (error) {
      ran = { status: 'failed', text: '', error: errorMessage(error) };
    }
    if (ran.status === 'failed')
      this.options.onEvent({ type: 'notice', text: ran.error ?? '' });
    if (ran.status === 'completed') turn.answer = prompt;
    if (
      ran.status !== 'completed' ||
      turn.idle ||
      this.holding ||
      !this.sessionLifecycle
    )
      this.release(turn);
  }

  private release(turn: Turn): void {
    const answer = turn.answer;
    turn.held = false;
    turn.answer = undefined;
    if (answer !== undefined && !turn.interrupted && !this.closed) {
      turn.idle = false;
      const records = this.takeUnreadContext();
      const uuid = this.push(content(records, answer, []));
      turn.inputs.set(uuid, { pending: true });
      turn.commandRecords.set(uuid, { records, writeAttempted: false });
    } else if (!this.closed) this.finishIdle(turn);
  }

  respond(id: string, response: UserResponse): void {
    if (this.commands.respond(id, response)) return;
    this.requests.get(id)?.resolve(response);
  }

  readonly familiar = {
    report: (
      action: Parameters<ClaudeCommands['report']>[0],
      deadline: number,
    ) => this.commands.report(action, deadline),
  };

  interrupt(options: AgentStopOptions = {}): Promise<void> {
    if (this.answers.busy) return this.answers.interrupt(options);
    this.command?.controller.abort();
    const turn = this.turn;
    if (!turn) return Promise.resolve();
    if (this.interrupting) return this.interrupting;
    turn.interrupted = true;
    this.stopUntil ??= stopDeadline(options.deadline);
    const deadline = this.stopUntil;
    return (this.interrupting = beforeDeadline(
      this.interruptTurn(turn),
      deadline - terminationReserveMs,
    )
      .catch(async (error: unknown) => {
        if (!(error instanceof NativeStopTimeout)) throw error;
        this.reportStopTimeout();
        await this.close({ ...options, deadline });
      })
      .finally(() => {
        this.interrupting = undefined;
        if (!this.closed) this.stopUntil = undefined;
      }));
  }

  private async interruptTurn(turn: Turn): Promise<void> {
    // a shell-only wait ends when the aborted command releases it
    if (
      turn.idle &&
      turn.held &&
      (!this.messageLifecycle ||
        ![...turn.inputs.values()].some(({ pending }) => pending))
    ) {
      await turn.finished.promise;
      return;
    }
    // the receipt covers only inputs written before the interrupt; a stopped SDK may never finish dispatch
    await Promise.race([this.input.flush(), turn.finished.promise]);
    if (this.turn !== turn || this.closed) {
      await turn.finished.promise;
      return;
    }
    let receipt;
    try {
      receipt = await this.query.interrupt();
    } catch (error) {
      // the SDK rejects once closed, and when the CLI dies with the interrupt pending
      if (!this.closed && !this.child?.exited) throw error;
      await turn.finished.promise;
      return;
    }
    // the CLI would run what it still holds after this turn, outside any turn
    if (receipt?.still_queued?.length) {
      const unreadContext = receipt.still_queued.flatMap(
        (uuid) => turn.commandRecords.get(uuid)?.records ?? [],
      );
      this.closed = true;
      this.stopMcpPolling();
      void this.usageReader.close({ deadline: this.stopUntil }).catch(() => {});
      this.finish(turn, {
        status: 'interrupted',
        text: turn.messages.text,
        unread: receipt.still_queued.flatMap(
          (uuid) => turn.inputs.get(uuid)?.prompt ?? [],
        ),
        ...(unreadContext.length ? { unreadContext } : {}),
      });
      this.query.close();
    }
    await turn.finished.promise;
  }

  close(options: AgentStopOptions = {}): Promise<void> {
    this.stopUntil ??= stopDeadline(options.deadline);
    return (this.closeTask ??= this.closeSession(this.stopUntil));
  }

  private async closeSession(deadline: number): Promise<void> {
    const command = this.command;
    command?.controller.abort();
    this.closed = true;
    this.stopMcpPolling();
    const usageClosed = this.usageReader.close({ deadline });
    void usageClosed.catch(() => {});
    const stopped = (async () => {
      let cleanupError: unknown;
      try {
        await this.answers.interrupt({ deadline });
      } catch (error) {
        cleanupError = error;
      }
      try {
        await this.commands.close();
      } catch (error) {
        cleanupError = error;
      } finally {
        this.input.close();
        this.query.close();
      }
      await this.reading;
      await this.child?.closed;
      await command?.finished;
      await usageClosed;
      if (cleanupError) throw cleanupError;
    })();
    try {
      await beforeDeadline(stopped, deadline - terminationReserveMs);
    } catch (error) {
      if (!(error instanceof NativeStopTimeout)) throw error;
      this.reportStopTimeout();
      this.commands.stop();
      for (const request of this.requests.values())
        request.resolve({ decision: 'cancel' });
      this.input.close();
      this.query.close();
      try {
        await this.terminate(deadline);
      } finally {
        await this.end('Claude did not stop in time');
      }
      await beforeDeadline(
        Promise.all([this.reading, usageClosed, command?.finished]),
        deadline,
      );
    } finally {
      this.options.signal?.removeEventListener('abort', this.cancelConnection);
      if (!this.process || !running(this.process))
        await this.options.onProcess(undefined);
    }
  }

  private terminate(deadline: number): Promise<boolean> {
    if (!this.process || !this.child) return Promise.resolve(false);
    return (this.terminating ??= terminateChild(
      this.process,
      this.child.closed,
      deadline,
    ));
  }

  private reportStopTimeout(): void {
    if (this.reportedStopTimeout) return;
    this.reportedStopTimeout = true;
    this.options.onEvent({
      type: 'notice',
      text: 'Claude did not stop in time.',
    });
  }

  takeUnreadContext(): string[] {
    const records = this.records;
    this.records = [];
    return records;
  }

  /** returns the uuid the message went with; a composed message goes as written, with no slash dispatch or `@path` expansion. */
  private push(
    content: SDKUserMessage['message']['content'],
    composed = false,
  ): string {
    const uuid = randomUUID();
    this.input.push({
      type: 'user',
      uuid,
      session_id: this.info.id,
      message: { role: 'user', content },
      parent_tool_use_id: null,
      ...(composed ? { client_composed: true as const } : {}),
    });
    return uuid;
  }

  private async ask(
    request: UserRequest,
    signal?: AbortSignal,
  ): Promise<UserResponse> {
    const response = Promise.withResolvers<UserResponse>();
    this.requests.set(request.id, response);
    const cancel = () => response.resolve({ decision: 'cancel' });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    else this.options.onEvent({ type: 'request', request });
    try {
      return await response.promise;
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.requests.delete(request.id);
      this.options.onEvent({ type: 'request-resolved', id: request.id });
    }
  }

  private async read(): Promise<void> {
    try {
      for await (const message of this.query) this.receive(message);
      if (this.turn) await this.end('Claude exited before reporting idle');
    } catch (error) {
      const reason: unknown = this.abort.signal.reason;
      // preserve the dispatch cause when the SDK masks it with AbortError.
      const failure =
        error instanceof AbortError &&
        reason instanceof Error &&
        !(reason instanceof AbortError) &&
        reason.name !== 'AbortError'
          ? reason
          : error;
      await this.end(errorMessage(failure));
    } finally {
      this.closed = true;
      this.stopMcpPolling();
      this.commands.stop();
      await this.usageReader
        .close({ deadline: this.stopUntil })
        .catch(() => {});
      for (const request of this.requests.values())
        request.resolve({ decision: 'cancel' });
      if (this.connected) this.options.onEvent({ type: 'closed' });
    }
  }

  private receive(message: SDKMessage): void {
    this.commands.receive(message);
    this.started(message);
    if (this.compaction?.receive(message, this.info.id)) {
      this.completeCompaction();
      return;
    }
    const type: string = message.type;
    if (type === 'command_lifecycle') {
      const lifecycle = commandLifecycle.safeParse(message);
      if (!lifecycle.success) return;
      if (
        lifecycle.data.session_id === this.info.id &&
        this.compaction?.lifecycle(
          lifecycle.data.command_uuid,
          lifecycle.data.state,
        )
      )
        this.completeCompaction();
      const turn = this.turn;
      if (
        this.messageLifecycle &&
        turn &&
        lifecycle.data.session_id === this.info.id
      ) {
        const input = turn.inputs.get(lifecycle.data.command_uuid);
        const state = lifecycle.data.state;
        if (input && state !== 'queued') {
          if (state === 'started' && input.pending) turn.result = undefined;
          input.pending = false;
          if (
            state !== 'started' &&
            state !== 'completed' &&
            !turn.interrupted &&
            !input.contextOnly
          )
            turn.inputError ??= `Claude ${state} a prompt`;
          this.finishIdle(turn);
        }
      }
      return;
    }
    if (message.type === 'system') {
      if (message.subtype === 'init') {
        this.messageLifecycle =
          message.capabilities?.includes('msg_lifecycle_v1') ?? false;
        this.info = {
          ...this.info,
          id: message.session_id,
          model: message.model,
          permissionMode: message.permissionMode,
          hasHistory: true,
          // null when no effort will be sent, and absent on CLIs that don't report it
          nativeEffort:
            message.effort === undefined
              ? this.info.nativeEffort
              : (message.effort ?? undefined),
        };
        this.options.onEvent({ type: 'info', info: this.info });
        this.refreshMcpStatus();
      } else if (message.subtype === 'compact_boundary') {
        if (message.session_id !== this.info.id) return;
        this.options.onEvent({ type: 'compacted' });
      } else if (message.subtype === 'commands_changed') {
        this.options.onEvent({
          type: 'skills',
          skills: skillsOf(message.commands),
        });
      } else if (message.subtype === 'session_state_changed') {
        this.sessionLifecycle = true;
        const running = message.state !== 'idle';
        this.options.onEvent({ type: 'running', running });
        const turn = this.turn;
        if (turn) {
          turn.idle = !running;
          if (turn.idle && turn.held && turn.answer !== undefined)
            this.release(turn);
          else this.finishIdle(turn);
        }
      } else if (
        // ambient tasks are housekeeping, such as forked-skill workers
        message.subtype === 'task_started' &&
        (message.task_type === 'local_agent' ||
          message.task_type === 'local_workflow') &&
        !message.ambient &&
        !this.late(message)
      ) {
        if (message.run_id) this.runs.set(message.task_id, message.run_id);
        // a workflow holds off idle as a familiar does, though its agents never reach the stream
        if (message.task_type === 'local_workflow')
          this.workflows.add(message.task_id);
        else {
          this.subagent({
            id: message.task_id,
            parent: message.parent_task_id,
            name: message.description,
            kind: message.subagent_type ?? '',
            runtime: 'claude',
            status: 'running',
            run: message.run_id,
          });
        }
        if (this.turn?.held && this.turn.answer !== undefined)
          this.release(this.turn);
      } else if (message.subtype === 'background_tasks_changed') {
        const listed = new Set(message.tasks.map(({ task_id }) => task_id));
        // registry removal or a full output queue can omit the task notification.
        for (const id of this.listed) {
          if (listed.has(id)) continue;
          this.workflows.delete(id);
          const subagent = this.subagents.get(id);
          if (subagent?.status === 'running')
            this.subagent({ ...subagent, status: 'stopped' });
        }
        this.listed = listed;
        if (this.turn && !this.sessionLifecycle) this.finishIdle(this.turn);
      } else if (message.subtype === 'task_notification') {
        if (this.late(message)) return;
        this.workflows.delete(message.task_id);
        const subagent = this.subagents.get(message.task_id);
        if (subagent) this.subagent({ ...subagent, status: message.status });
        if (this.turn && !this.sessionLifecycle) this.finishIdle(this.turn);
      }
    } else if (
      message.type === 'stream_event' &&
      message.parent_tool_use_id === null
    ) {
      const event = message.event;
      if (event.type === 'message_start')
        this.currentMessage = event.message.id;
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        const text = event.delta.text;
        const id = this.currentMessage;
        this.turn?.messages.append(id, text);
        this.options.onEvent({ type: 'text', id, text });
      }
    } else if (
      message.type === 'assistant' &&
      message.parent_tool_use_id === null
    ) {
      const id = message.message.id;
      const text = message.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      if (text) {
        this.turn?.messages.replace(id, text);
        this.options.onEvent({ type: 'text', id, text, replace: true });
      }
      for (const block of message.message.content) {
        if (block.type === 'tool_use')
          this.options.onEvent({
            type: 'tool',
            id: block.id,
            ...claudeTitle(
              block.name,
              block.input,
              this.options.cwd,
              this.options.commandPrefixes,
            ),
            text: JSON.stringify(block.input, null, 2),
            done: false,
          });
      }
      this.cast(skillCasts(message.message.content));
    } else if (
      message.type === 'assistant' &&
      !(message.agent_id && this.subagents.has(message.agent_id))
    ) {
      // an ambient worker's or an unattributed nested cast is shown as the main agent's
      this.cast(skillCasts(message.message.content));
    } else if (message.type === 'assistant' && message.agent_id) {
      const subagent = this.subagents.get(message.agent_id)!;
      const observed = message.message.model;
      const model =
        observed && observed !== '<synthetic>' ? observed : subagent.model;
      let { activity, tools = 0, report } = subagent;
      for (const block of message.message.content)
        if (block.type === 'tool_use') {
          activity = claudeTitle(
            block.name,
            block.input,
            this.options.cwd,
          ).title;
          tools++;
        } else if (block.type === 'text') {
          report =
            report &&
            this.reportMessages.get(subagent.id) === message.message.id
              ? `${report}\n${block.text}`
              : block.text;
          this.reportMessages.set(subagent.id, message.message.id);
        }
      const spells = mergeCasts(
        subagent.spells,
        skillCasts(message.message.content),
      );
      if (
        model !== subagent.model ||
        tools !== (subagent.tools ?? 0) ||
        report !== subagent.report ||
        spells
      )
        this.subagent({
          ...subagent,
          model,
          activity,
          tools,
          report,
          ...(spells ? { spells } : {}),
        });
    } else if (
      message.type === 'user' &&
      message.parent_tool_use_id === null &&
      Array.isArray(message.message.content)
    ) {
      // use each result's own report block, replacing result text with its diff.
      const diff = reportedDiff(message.tool_use_result, this.options.cwd);
      for (const block of message.message.content) {
        if (block.type !== 'tool_result') continue;
        const parts =
          typeof block.content === 'string'
            ? [{ type: 'text' as const, text: block.content }]
            : (block.content ?? []);
        const images: string[] = [];
        const texts = parts.flatMap((part) => {
          if (part.type === 'image' && part.source.type === 'base64') {
            images.push(
              `data:${part.source.media_type};base64,${part.source.data}`,
            );
            return [];
          }
          return [
            part.type === 'text' ? part.text : JSON.stringify(part, null, 2),
          ];
        });
        this.options.onEvent({
          type: 'tool',
          id: block.tool_use_id,
          title: '',
          text: diff ? '' : texts.join('\n'),
          done: true,
          ...(images.length ? { images } : {}),
          ...(diff ? { diff } : {}),
          ...(block.is_error ? { failed: true } : {}),
        });
      }
    } else if (message.type === 'rate_limit_event') {
      this.rateLimit.report(message.rate_limit_info, this.turn);
    } else if (message.type === 'result') {
      if (!this.turn?.initialInput || this.turn.compaction) return;
      const success = message.subtype === 'success' && !message.is_error;
      if (this.messageLifecycle) {
        const uuids = message.user_message_uuids ?? [message.user_message_uuid];
        for (const uuid of uuids) {
          const input =
            uuid === undefined ? undefined : this.turn.inputs.get(uuid);
          if (!input) continue;
          input.pending = false;
          if (!success && !this.turn.interrupted)
            this.turn.inputError ??=
              message.subtype === 'success'
                ? message.result
                : message.errors.join('\n');
        }
      }
      this.turn.result = {
        status: success ? 'completed' : 'failed',
        text:
          message.subtype === 'success'
            ? this.options.answer
              ? (JSON.stringify(message.structured_output) ?? '')
              : message.result
            : this.turn.messages.text,
        ...(!success
          ? {
              error:
                message.subtype === 'success'
                  ? message.result
                  : message.errors.join('\n'),
            }
          : {}),
      };
      if (!this.sessionLifecycle) this.finishIdle(this.turn);
    }
  }

  private subagent(subagent: Subagent): void {
    this.subagents.set(subagent.id, subagent);
    this.options.onEvent({ type: 'subagent', subagent });
  }

  private cast(casts: Cast[]): void {
    for (const cast of casts) this.options.onEvent({ type: 'spell', cast });
  }

  /** a sent spell counts once Claude starts its input, which can come before init announces lifecycle support. */
  private started(message: SDKMessage): void {
    if (!this.pendingCasts.size) return;
    const lifecycle = commandLifecycle.safeParse(message);
    const uuids = lifecycle.success
      ? lifecycle.data.state === 'started'
        ? [lifecycle.data.command_uuid]
        : []
      : (acknowledged.safeParse(message).data?.user_message_uuids ?? []);
    for (const uuid of uuids) {
      const name = this.pendingCasts.get(uuid);
      if (name === undefined) continue;
      this.pendingCasts.delete(uuid);
      this.cast([{ id: uuid, name }]);
    }
  }

  /** run ids sort in the order the runs opened, so a frame naming an earlier run is late. */
  private late({ task_id, run_id }: { task_id: string; run_id?: string }) {
    const run = this.runs.get(task_id);
    return Boolean(run_id && run && run_id < run);
  }

  private report(update: Usage): void {
    this.usage = { ...this.usage, ...update };
    this.options.onEvent({ type: 'usage', usage: this.usage });
  }

  contextUsage(): Promise<number | undefined> {
    return this.context.read(
      () => (this.closed ? undefined : this.info.model),
      (usage) => this.report(usage),
    );
  }

  private readUsage(): void {
    if (this.options.answer) return;
    void this.contextUsage();
    this.usageReader.refresh();
  }

  private applyUsage(report: unknown, source: UsageSource): void {
    const update: Usage = {};
    const session =
      source === 'main' ? sessionUsage.safeParse(report) : undefined;
    if (session?.success) {
      update.lines = {
        added: session.data.session.total_lines_added,
        removed: session.data.session.total_lines_removed,
      };
    }
    const account = accountReading(
      report,
      this.usage.account ?? { limits: [] },
    );
    if (account) update.account = account;
    if (Object.keys(update).length) this.report(update);
  }

  /** ends the turn a stopped CLI leaves, once its stderr is complete. */
  private async end(error: string): Promise<void> {
    const closed = this.closed;
    // set before the wait, so a send() can't start a turn on a dead process
    this.closed = true;
    this.stopMcpPolling();
    this.stopUntil ??= stopDeadline();
    void this.usageReader.close({ deadline: this.stopUntil }).catch(() => {});
    const turn = this.turn;
    // a command running beside a turn was steered into it, and one run with no turn open outlives the CLI
    if (turn) this.command?.controller.abort();
    this.query.close();
    try {
      await beforeDeadline(
        this.child?.closed ?? Promise.resolve(),
        this.stopUntil - terminationReserveMs,
      );
    } catch (failure) {
      if (failure instanceof NativeStopTimeout) {
        this.reportStopTimeout();
        await this.terminate(this.stopUntil).catch((failure: unknown) => {
          error = `${error}: ${errorMessage(failure)}`;
        });
      } else error = `${error}: ${errorMessage(failure)}`;
    }
    const text = withTail(error, this.child?.tail() ?? '');
    if (turn) {
      const unreadContext = [...turn.commandRecords.values()].flatMap(
        ({ records, writeAttempted }) => (writeAttempted ? [] : records),
      );
      const inputUnsent =
        turn.initialInput !== undefined &&
        turn.commandRecords.get(turn.initialInput)?.writeAttempted === false;
      // input goes in order, so what was steered behind unwritten input is unwritten too
      const unread = inputUnsent
        ? [...turn.inputs.values()].flatMap(({ prompt, pending }) =>
            pending && prompt !== undefined ? [prompt] : [],
          )
        : [];
      this.finish(turn, {
        status: 'failed',
        text: this.reportedStopTimeout ? turn.messages.text : '',
        error: text,
        ...(unread.length ? { unread } : {}),
        ...(unreadContext.length ? { unreadContext } : {}),
        ...(inputUnsent ? { inputUnsent } : {}),
        // a CLI that dies after a rejection confirms it as a failed result would; Witch's own close doesn't
        ...(!closed &&
        !turn.interrupted &&
        this.rateLimit.rejects(turn, this.info.model)
          ? { exhausted: true }
          : {}),
      });
    }
    // a turn reports the error through its result
    if (!turn && this.connected && !closed)
      this.options.onEvent({ type: 'notice', text });
  }

  private finishIdle(turn: Turn): void {
    if (
      this.turn === turn &&
      (turn.idle || (!this.sessionLifecycle && !this.holding)) &&
      (turn.result || turn.inputError !== undefined) &&
      !turn.held &&
      !this.compacting &&
      (!this.messageLifecycle ||
        ![...turn.inputs.values()].some(({ pending }) => pending))
    ) {
      if (!this.sessionLifecycle && !this.reportedMissingLifecycle) {
        this.reportedMissingLifecycle = true;
        this.options.onEvent({
          type: 'notice',
          text: 'Claude did not report session state; Witch finished the turn after its result and tracked work settled.',
        });
      }
      this.finish(turn, {
        ...(turn.inputError !== undefined
          ? {
              status: 'failed',
              text: turn.result?.text ?? '',
              error: turn.inputError,
            }
          : turn.result!),
        // only the current turn's failure confirms a rejection
        ...(turn.result?.status === 'failed' &&
        !turn.interrupted &&
        this.rateLimit.rejects(turn, this.info.model)
          ? { exhausted: true }
          : {}),
      });
      this.readUsage();
    }
  }

  private completeCompaction(): void {
    if (!this.turn) return;
    if (this.turn.compaction) this.turn.result = this.compaction!.result;
    if (!this.sessionLifecycle) this.finishIdle(this.turn);
  }

  /** an interrupt decides how the turn ends, whatever result came before or after it. */
  private finish(turn: Turn, result: TurnResult): void {
    turn.started.resolve(false);
    if (this.turn === turn) {
      this.turn = undefined;
      this.compaction?.finish({
        status: turn.interrupted ? 'interrupted' : 'failed',
        text: '',
        error: result.error ?? 'Claude ended before compaction completed',
      });
      this.compaction = undefined;
    }
    if (!turn.interrupted && result.status === 'completed')
      this.rateLimit.clear();
    turn.finished.resolve(
      turn.interrupted ? { ...result, status: 'interrupted' } : result,
    );
  }
}
