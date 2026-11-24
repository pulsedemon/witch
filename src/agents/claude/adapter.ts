import { AnswerTurn } from '../answer-turn.js';
import { ClaudeRequests } from './permissions.js';
import { ClaudeMcp } from './mcp.js';
import { ClaudeProjection } from './projection.js';
import { content, readImages } from './content.js';
import { spawn } from 'node:child_process';
import { nativeLaunch } from '../native-launch.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AbortError, query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Query,
  SDKMessage,
  SDKSystemMessage,
  SDKModelRefusalFallbackMessage,
  SDKSessionStateChangedMessage,
  SDKRateLimitEvent,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { InputQueue } from '../input-queue.js';
import {
  createTurn,
  commandLifecycle,
  pendingInput,
  uncertainInput,
  unknownInput,
  recordResult,
  idleResult,
  claudeResult,
  recoverInput,
  unreadInput,
  unwrittenInput,
  resultInputs,
  type Turn,
} from './turn.js';
import { accountReading, ClaudeUsage } from './usage.js';
import { ClaudeCompaction } from './compaction.js';
import { ClaudeContext } from './context.js';
import {
  promptless,
  sideQuery,
  startupFailure,
  withoutModelPins,
} from './side.js';
import type { ClaudeLaunch } from './side.js';
import { ClaudeCommands } from './commands.js';
import type { ClaudeTaskControl } from './commands.js';
import type { UsageSource } from './usage.js';
import { errorMessage } from '../../errors.js';
import { watchChild, withTail, type ChildExit } from '../stderr.js';
import {
  beforeDeadline,
  closeFailedStart,
  NativeStopTimeout,
  running,
  stopDeadline,
  stopOptions,
  terminateChild,
  terminationReserveMs,
} from '../shutdown.js';
import { modelsOf, fallbackModel } from './models.js';
import { skillsOf } from './spells.js';
import { ClaudeShell } from './shell.js';
import { RateLimit } from './limits.js';
import type {
  AgentAdapter,
  AgentSession,
  AgentStopOptions,
  AccountReading,
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
      { settingSources: [], env: withoutModelPins(process.env) },
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
      return closeFailedStart(
        () => session.close(stopOptions(options.signal)),
        options.signal,
        error,
      );
    }
  }
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
  private bundled: ReadonlySet<string> = new Set();
  private interrupting?: Promise<void>;
  private terminating?: Promise<boolean>;
  private stopUntil?: number;
  private reportedStopTimeout = false;
  private readonly abort = new AbortController();
  private readonly cancelConnection = () => this.abort.abort();
  private readonly requests: ClaudeRequests;
  private turn?: Turn;
  private readonly rateLimit = new RateLimit<object>();
  private backgroundRun?: {
    eligible: boolean;
    exhausted: boolean;
    identity: object;
  };
  private backgroundEligible = false;
  private nativeRunning = false;
  private compaction?: ClaudeCompaction;
  private readonly context: ClaudeContext;
  readonly restoreCompactionContext?: AgentSession['restoreCompactionContext'];
  private readonly userShell: ClaudeShell;
  private readonly commands: ClaudeCommands;
  private readonly projection: ClaudeProjection;
  private connected = false;
  private messageLifecycle = false;
  private sessionLifecycle = false;
  private reportedMissingLifecycle = false;
  private readonly mcp: ClaudeMcp;

  constructor(
    private readonly options: SessionOptions,
    start: ClaudeLaunch,
    connect: (options: SessionOptions) => Promise<AgentSession>,
  ) {
    this.answers = new AnswerTurn(options, connect);
    this.userShell = new ClaudeShell(options);

    options.signal?.addEventListener('abort', this.cancelConnection, {
      once: true,
    });

    if (options.signal?.aborted) this.abort.abort();

    const resumedModel =
      options.resume && !options.answer ? options.resumedModel : undefined;

    this.info = {
      id: options.resume ?? randomUUID(),
      agent: 'claude',
      model: resumedModel?.model ?? options.model ?? '',
      modelBeforeFallback: resumedModel?.modelBeforeFallback,
      permissionMode: '',
      hasHistory: !!options.resume,
      effort: options.effort,
    };

    this.context = new ClaudeContext(() => this.query);

    this.restoreCompactionContext = options.automaticCompaction
      ? this.context.bind
      : undefined;

    this.requests = new ClaudeRequests(options, () => this.closed);

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
        canUseTool: this.requests.canUseTool,
        onElicitation: this.requests.onElicitation,
      },
    });

    this.mcp = new ClaudeMcp(this.query, () => this.closed, options.onEvent);

    this.projection = new ClaudeProjection(
      options,
      () => this.turn?.messages,
      () => {
        if (this.turn?.held && this.turn.answer !== undefined)
          this.release(this.turn);
      },
      () => {
        if (this.turn && !this.sessionLifecycle) this.finishIdle(this.turn);
      },
    );

    this.commands = new ClaudeCommands(
      this.query as Query & ClaudeTaskControl,
      options.familiarBinding,
      () => this.info.id,
      (id) => this.projection.hasSubagent(id),
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
      this.mcp.refresh();
    }
  }

  async models(refresh = false): Promise<Model[]> {
    if (this.turn)
      throw new Error('Stop the current turn before refreshing models');

    const models = refresh
      ? (await this.query.reinitialize()).models
      : await this.query.supportedModels();

    return modelsOf(models);
  }

  /** the SDK keeps this cache current from the CLI's `commands_changed` pushes, so reading it sends nothing. */
  async skills(): Promise<Skill[]> {
    return skillsOf(await this.query.supportedCommands(), this.bundled);
  }

  get backgroundActive(): boolean {
    return this.projection.holding;
  }

  get takesModel(): boolean {
    return !!this.turn && this.canSelectModel();
  }

  canSelectModel(): boolean {
    const turn = this.turn;

    return (
      !this.closed &&
      !this.answers.busy &&
      !this.userShell.running &&
      (!turn ||
        (!!turn.initialInput &&
          !turn.interrupted &&
          !turn.held &&
          !turn.compaction &&
          !this.compacting))
    );
  }

  /** an omitted effort leaves `effortLevel` unsent, which keeps the effort in force; the new model's window is published before it returns. */
  async selectModel(model: string, effort?: string | null): Promise<void> {
    if (!this.canSelectModel())
      throw new Error('Stop the current turn before changing models');

    const level = effort == null ? effort : effortLevel.parse(effort);
    await this.query.setModel(model);

    if (model !== this.info.model) this.report(this.context.invalidate());

    this.info = {
      ...this.info,
      model,
      modelBeforeFallback: undefined,
    };

    this.options.onEvent({ type: 'info', info: this.info });

    if (level !== undefined) {
      await this.query.applyFlagSettings({ effortLevel: level });

      this.info = {
        ...this.info,
        effort: level ?? undefined,
        nativeEffort: level ?? undefined,
      };

      this.options.onEvent({ type: 'info', info: this.info });
    }

    await this.contextUsage();

    if (this.options.automaticCompaction) await this.context.configure();
  }

  async send(
    prompt: string,
    { skill, context, purpose = 'user', answer, images = [] }: SendOptions = {},
  ): Promise<TurnResult> {
    if (purpose === 'peer-answer' && !this.options.answer) {
      return this.answers.run(
        { closed: this.closed, running: !!this.turn, label: 'Claude' },
        this.info,
        prompt,
        context,
        answer,
      );
    }

    const blocks = readImages(images);

    if (!Array.isArray(blocks)) return blocks;

    const turn = this.beginTurn();
    this.backgroundEligible = purpose === 'user';
    const stopped = this.process?.killed || this.child?.exited;

    if (this.options.automaticCompaction && !stopped) {
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

    if (skill && !skill.builtin) this.projection.pendingCast(uuid, skill.name);

    return turn.finished.promise;
  }

  async compact(): Promise<TurnResult> {
    if (this.userShell.running)
      throw new Error('This agent is already running');

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
      this.userShell.running ||
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

    if (!this.nativeRunning) this.backgroundRun = undefined;

    const turn = createTurn();
    this.turn = turn;

    return turn;
  }

  /** the SDK has no request that runs a `!` command, so Witch runs it and keeps its record for the next prompt. */
  async shell(command: string): Promise<TurnResult> {
    if (this.closed) throw new Error('The Claude session is closed');

    if (this.turn || this.userShell.running)
      throw new Error('This agent is already running');

    return this.userShell.run(command);
  }

  async steer(
    prompt: string,
    options: Parameters<AgentSession['steer']>[1] = {},
  ): Promise<boolean> {
    const { command, skill, contextOnly, images = [] } = options;
    const blocks = readImages(images);

    if (!Array.isArray(blocks)) return false;

    const turn = this.turn;

    if (turn && !turn.compaction && !turn.initialInput)
      if (!(await turn.started.promise)) return false;

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

      if (skill && !skill.builtin)
        this.projection.pendingCast(uuid, skill.name);
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
      this.projection.holding
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
      ran = await this.userShell.run(command);
    } catch (error) {
      ran = { status: 'failed', text: '', error: errorMessage(error) };
    }

    if (ran.status === 'failed')
      this.options.onEvent({ type: 'notice', text: ran.error ?? '' });

    if (ran.status === 'completed') turn.answer = prompt;

    if (
      ran.status !== 'completed' ||
      turn.idle ||
      this.projection.holding ||
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

    this.requests.respond(id, response);
  }

  readonly familiar = {
    report: (
      action: Parameters<ClaudeCommands['report']>[0],
      deadline: number,
    ) => this.commands.report(action, deadline),
  };

  interrupt(options: AgentStopOptions = {}): Promise<void> {
    this.backgroundEligible = false;

    if (this.backgroundRun) this.backgroundRun.eligible = false;

    if (this.answers.busy) return this.answers.interrupt(options);

    this.userShell.abort();
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
      void this.markClosed().catch(() => {});

      this.finish(turn, {
        status: 'interrupted',
        text: turn.messages.text,
        ...unreadInput(turn, receipt.still_queued),
      });

      this.query.close();
    }

    await turn.finished.promise;
  }

  close(options: AgentStopOptions = {}): Promise<void> {
    this.stopUntil ??= stopDeadline(options.deadline);

    return (this.closeTask ??= this.closeSession(this.stopUntil));
  }

  private markClosed(): Promise<void> {
    this.closed = true;
    this.mcp.stop();

    return this.usageReader.close({ deadline: this.stopUntil });
  }

  private async closeSession(deadline: number): Promise<void> {
    const shellFinished = this.userShell.finished;
    this.userShell.abort();
    const usageClosed = this.markClosed();
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
      await shellFinished;
      await usageClosed;

      if (cleanupError) throw cleanupError;
    })();

    try {
      await beforeDeadline(stopped, deadline - terminationReserveMs);
    } catch (error) {
      if (!(error instanceof NativeStopTimeout)) throw error;

      this.reportStopTimeout();
      this.commands.stop();
      this.requests.cancel();
      this.input.close();
      this.query.close();

      try {
        await this.terminate(deadline);
      } finally {
        await this.end('Claude did not stop in time');
      }

      await beforeDeadline(
        Promise.all([this.reading, usageClosed, shellFinished]),
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
    return this.userShell.take();
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

  private async read(): Promise<void> {
    try {
      for await (const message of this.query) this.receive(message);

      if (this.turn || this.backgroundRun)
        await this.end('Claude exited before reporting idle');
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
      this.mcp.stop();
      this.commands.stop();

      await this.usageReader
        .close({ deadline: this.stopUntil })
        .catch(() => {});

      this.requests.cancel();

      if (this.connected) this.options.onEvent({ type: 'closed' });
    }
  }

  private receive(message: SDKMessage): void {
    this.commands.receive(message);
    this.projection.started(message);

    if (this.compaction?.receive(message, this.info.id)) {
      this.completeCompaction();

      return;
    }

    const type: string = message.type;

    if (type === 'command_lifecycle') {
      const lifecycle = commandLifecycle.safeParse(message);

      if (lifecycle.success) this.lifecycle(lifecycle.data);

      return;
    }

    this.projection.receive(message);

    if (message.type === 'system') {
      if (message.subtype === 'init') this.initialized(message);
      else if (message.subtype === 'model_refusal_fallback')
        this.fellBack(message);
      else if (message.subtype === 'compact_boundary') {
        if (message.session_id !== this.info.id) return;

        this.options.onEvent({ type: 'compacted' });
      } else if (message.subtype === 'commands_changed') {
        this.options.onEvent({
          type: 'skills',
          skills: skillsOf(message.commands, this.bundled),
        });
      } else if (message.subtype === 'session_state_changed')
        this.sessionState(message);
    } else if (message.type === 'rate_limit_event') this.rateLimited(message);
    else if (message.type === 'result') this.resulted(message);
  }

  private lifecycle(message: z.infer<typeof commandLifecycle>): void {
    if (
      message.session_id === this.info.id &&
      this.compaction?.lifecycle(message.command_uuid, message.state)
    )
      this.completeCompaction();

    const turn = this.turn;

    if (this.messageLifecycle && turn && message.session_id === this.info.id) {
      const input = turn.inputs.get(message.command_uuid);
      const state = message.state;

      if (input && state !== 'queued') {
        if (state === 'started') this.backgroundRun = undefined;

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
  }

  private initialized(message: SDKSystemMessage): void {
    this.messageLifecycle =
      message.capabilities?.includes('msg_lifecycle_v1') ?? false;

    this.info = {
      ...this.info,
      id: message.session_id,
      model: message.model,
      modelBeforeFallback:
        this.info.model !== message.model
          ? undefined
          : this.info.modelBeforeFallback,
      permissionMode: message.permissionMode,
      hasHistory: true,
      // null when no effort will be sent, and absent on CLIs that don't report it
      nativeEffort:
        message.effort === undefined
          ? this.info.nativeEffort
          : (message.effort ?? undefined),
    };

    this.options.onEvent({ type: 'info', info: this.info });
    this.mcp.refresh();
    this.bundledSkills(message.skills);
  }

  /** relists skills when a turn's init names a different set, since only it tells bundled skills apart. */
  private bundledSkills(names: string[]): void {
    const bundled = new Set(names);

    if (
      bundled.size === this.bundled.size &&
      [...bundled].every((name) => this.bundled.has(name))
    )
      return;

    this.bundled = bundled;

    // the SDK answers from its cache once initialize has resolved, so this can't reject
    void this.skills().then((skills) => {
      if (!this.closed) this.options.onEvent({ type: 'skills', skills });
    });
  }

  private fellBack(message: SDKModelRefusalFallbackMessage): void {
    const model = fallbackModel(message);

    if (model === undefined) return;

    const reverted = message.direction === 'revert';

    const modelBeforeFallback = reverted
      ? undefined
      : (this.info.modelBeforeFallback ??
        (message.original_model !== model
          ? message.original_model
          : undefined));

    if (
      model === this.info.model &&
      modelBeforeFallback === this.info.modelBeforeFallback
    )
      return;

    if (model !== this.info.model) this.report(this.context.invalidate());

    this.info = { ...this.info, model, modelBeforeFallback };
    this.options.onEvent({ type: 'info', info: this.info });
  }

  private sessionState(message: SDKSessionStateChangedMessage): void {
    this.sessionLifecycle = true;
    const running = message.state !== 'idle';

    if (running && !this.nativeRunning && !this.turn)
      this.backgroundRun = {
        eligible: this.backgroundEligible,
        exhausted: false,
        identity: {},
      };

    this.nativeRunning = running;
    this.options.onEvent({ type: 'running', running });
    const turn = this.turn;

    if (turn) {
      turn.idle = !running;

      if (turn.idle && turn.held && turn.answer !== undefined)
        this.release(turn);
      else this.finishIdle(turn);
    }
  }

  private rateLimited(message: SDKRateLimitEvent): void {
    if (!this.turn || (this.messageLifecycle && pendingInput(this.turn)))
      this.backgroundRun ??= {
        eligible: this.backgroundEligible,
        exhausted: false,
        identity: this.turn ?? {},
      };

    this.rateLimit.report(
      message.rate_limit_info,
      this.backgroundRun?.identity ?? this.turn,
    );
  }

  private resulted(message: SDKResultMessage): void {
    const result = claudeResult(
      message,
      !!this.options.answer,
      message.subtype === 'success' ? '' : (this.turn?.messages.text ?? ''),
    );

    const success = result.status === 'completed';
    const uuids = resultInputs(message);

    const correlated = uuids.some(
      (uuid) => uuid !== undefined && this.turn?.inputs.has(uuid),
    );

    if (!this.turn || (this.backgroundRun && !correlated)) {
      if (success) this.rateLimit.clear();
      else if (this.confirmBackgroundExhaustion() && this.turn)
        void this.recoverBackgroundInput(this.turn);

      return;
    }

    if (!this.turn.initialInput || this.turn.compaction) return;

    if (correlated) this.backgroundRun = undefined;

    recordResult(this.turn, result, uuids, this.messageLifecycle);

    if (!this.sessionLifecycle) this.finishIdle(this.turn);
  }

  private confirmBackgroundExhaustion(): boolean {
    const run = this.backgroundRun;

    if (!run?.eligible || run.exhausted || this.closed) return false;

    const limit = this.rateLimit.rejection(run.identity, this.info.model);

    if (!limit) return false;

    run.exhausted = true;
    this.options.onEvent({ type: 'exhausted', limit });

    return true;
  }

  private async recoverBackgroundInput(turn: Turn): Promise<void> {
    turn.exhausting = true;
    const result = await recoverInput(turn, this.input, this.query);

    if (this.turn === turn) {
      this.closed = true;
      this.finish(turn, result);
      this.query.close();
    }

    turn.exhausting = false;
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

    // onEvent is the session's only reporting channel, so a failure of its own has nowhere to go
    void this.contextUsage().catch(() => {});
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

    if (!closed) this.confirmBackgroundExhaustion();

    this.stopUntil ??= stopDeadline();
    void this.markClosed().catch(() => {});
    const turn = this.turn;

    // a command running beside a turn was steered into it, and one run with no turn open outlives the CLI
    if (turn) this.userShell.abort();

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

    const unknown =
      this.messageLifecycle && this.backgroundRun && uncertainInput(turn);

    if (turn) {
      // a CLI that dies after a rejection confirms it as a failed result would; Witch's own close doesn't
      const limit =
        closed || unknown || turn.interrupted
          ? undefined
          : this.rateLimit.rejection(turn, this.info.model);

      this.finish(turn, {
        status: 'failed',
        text: this.reportedStopTimeout ? turn.messages.text : '',
        error: unknown ? unknownInput : text,
        ...unwrittenInput(turn),
        ...(limit ? { exhausted: true, limit } : {}),
      });
    }

    // a turn reports the error through its result
    if (!turn && this.connected && !closed)
      this.options.onEvent({ type: 'notice', text });
  }

  private finishIdle(turn: Turn): void {
    if (
      this.turn === turn &&
      (turn.idle || (!this.sessionLifecycle && !this.projection.holding)) &&
      (turn.result || turn.inputError !== undefined) &&
      !turn.held &&
      !turn.exhausting &&
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

      this.finish(
        turn,
        idleResult(turn, this.rateLimit.rejection(turn, this.info.model)),
      );

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
      if (!turn.initialInput && !turn.compaction && this.userShell.unread)
        result = { ...result, unreadContext: this.takeUnreadContext() };

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
