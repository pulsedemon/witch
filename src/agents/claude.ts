import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  SpawnOptions,
  Query,
  SDKMessage,
  SDKUserMessage,
  ModelInfo,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { InputQueue } from './input-queue.js';
import { errorMessage, watchChild, withTail } from './stderr.js';
import type { ChildExit } from './stderr.js';
import { toolTitle } from './tool-title.js';
import { bashRecord, runShell } from './user-shell.js';
import type {
  AgentAdapter,
  AgentSession,
  BackgroundCommand,
  Model,
  SessionInfo,
  SessionOptions,
  Skill,
  SkillCall,
  Subagent,
  TurnResult,
  Usage,
  UserRequest,
  UserResponse,
} from './types.js';

type Launch = (options: SpawnOptions) => ChildProcessWithoutNullStreams;
const launch: Launch = (options) =>
  spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: 'pipe',
  });
const effortLevel = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const limitWindow = z
  .object({
    utilization: z.number().nullable(),
    resets_at: z.string().nullable(),
  })
  .nullish();
/** the experimental usage report may change shape, so only what parses is shown. */
const usageReport = z.object({
  session: z.object({
    total_lines_added: z.number(),
    total_lines_removed: z.number(),
  }),
  // percentages of 0 to 100
  rate_limits: z
    .object({ five_hour: limitWindow, seven_day: limitWindow })
    .nullable(),
});
const questions = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      multiSelect: z.boolean().optional(),
      options: z.array(z.object({ label: z.string() })).optional(),
    }),
  ),
});

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly label = 'Claude Code';

  constructor(private readonly start: Launch = launch) {}

  async connect(options: SessionOptions): Promise<AgentSession> {
    const session = new ClaudeSession(options, this.start);
    try {
      await session.initialize();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
}

interface Turn {
  finished: ReturnType<typeof Promise.withResolvers<TurnResult>>;
  result?: TurnResult;
  interrupted: boolean;
  messages: Map<string, string>;
  /** prompts steered into the turn, by the uuid each was sent with. */
  steered: Map<string, string>;
  /**
   * a command steered after the reply hasn't ended, or its reply hasn't gone, and Claude Code's idle doesn't end the
   * turn meanwhile.
   */
  held: boolean;
  /** Claude Code's last state reported while the turn was held is idle. */
  idle: boolean;
  /** the completed command's reply, waiting to go. */
  answer?: string;
}

/** everything but Claude Code's own commands, including unmarked rows a built-in shadows, since `/name` runs the built-in. */
function skillsOf(commands: SlashCommand[]): Skill[] {
  const builtin = new Set(
    commands.filter((command) => command.builtin).map(({ name }) => name),
  );
  return commands
    .filter(({ name }) => !builtin.has(name))
    .map(({ name, description, argumentHint }) => ({
      name,
      description,
      ...(argumentHint ? { argumentHint } : {}),
    }));
}

class ClaudeSession implements AgentSession {
  info: SessionInfo;
  usage: Usage = {};
  closed = false;
  private readonly input = new InputQueue<SDKUserMessage>();
  private readonly query: Query;
  private readonly reading: Promise<void>;
  private registered = Promise.resolve();
  private child?: ChildExit;
  private readonly abort = new AbortController();
  private readonly cancelConnection = () => this.abort.abort();
  private readonly requests = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<UserResponse>>
  >();
  private currentMessage = '';
  private turn?: Turn;
  /** the user's `!` command while it runs. */
  private command?: AbortController;
  /** commands' records for the next prompt, where Claude Code merges its own `!` records. */
  private records: string[] = [];
  private readonly subagents = new Map<string, Subagent>();
  private readonly backgroundCommands = new Map<string, BackgroundCommand>();
  /** the background workflows still running. */
  private readonly workflows = new Set<string>();
  /** each subagent task's latest run, since a resumed task keeps its id. */
  private readonly runs = new Map<string, string>();
  /** the message each familiar's report comes from; its later blocks arrive as frames of their own. */
  private readonly reportMessages = new Map<string, string>();
  /** an exit before this rejects the connect, which reports it. */
  private connected = false;

  constructor(
    private readonly options: SessionOptions,
    start: Launch,
  ) {
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
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        includePartialMessages: true,
        // a familiar's last message is its report, which the sidebar and transcript show
        forwardSubagentText: true,
        env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
        spawnClaudeCodeProcess: (settings) => {
          const child = start(settings);
          this.child = watchChild(child);
          this.registered = options.onProcess(child.pid);
          // initialize() awaits it, but may fail before it does
          this.registered.catch(() => {});
          return child;
        },
        canUseTool: async (toolName, input, context) => {
          const request: UserRequest = {
            id: context.toolUseID,
            kind: 'approval',
            title: toolName,
            detail: JSON.stringify(input, null, 2),
          };
          if (toolName === 'AskUserQuestion') {
            request.kind = 'question';
            request.questions = questions
              .parse(input)
              .questions.map((question) => ({
                id: question.question,
                title: question.question,
                options: question.options?.map((option) => option.label) ?? [],
                multiple: question.multiSelect,
              }));
          }
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
    this.reading = this.read();
  }

  async initialize(): Promise<void> {
    try {
      await this.query.initializationResult();
    } catch (error) {
      // the CLI may still be alive, holding its stderr open
      await Promise.race([this.child?.closed, delay(1000)]);
      throw new Error(withTail(errorMessage(error), this.child?.tail() ?? ''), {
        cause: error,
      });
    }
    this.connected = true;
    await this.registered;
    void this.readUsage();
  }

  async models(refresh = false): Promise<Model[]> {
    if (this.turn)
      throw new Error('Stop the current turn before refreshing models');
    const models: ModelInfo[] = refresh
      ? (await this.query.reinitialize()).models
      : await this.query.supportedModels();
    return models.map((model) => ({
      id: model.value,
      label: model.displayName,
      efforts: model.supportedEffortLevels ?? [],
    }));
  }

  /** the SDK keeps this cache current from the CLI's `commands_changed` pushes, so reading it sends nothing. */
  async skills(): Promise<Skill[]> {
    return skillsOf(await this.query.supportedCommands());
  }

  /** an omitted effort leaves `effortLevel` unsent, which keeps the effort in force. */
  async selectModel(model: string, effort?: string | null): Promise<void> {
    if (this.turn && !this.replied)
      throw new Error('Stop the current turn before changing models');
    const level = effort == null ? effort : effortLevel.parse(effort);
    await this.query.setModel(model);
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
  }

  async send(prompt: string, skill?: SkillCall): Promise<TurnResult> {
    if (this.closed) throw new Error('The Claude session is closed');
    if (this.turn) throw new Error('This agent is already running');
    const turn = {
      finished: Promise.withResolvers<TurnResult>(),
      interrupted: false,
      messages: new Map<string, string>(),
      steered: new Map<string, string>(),
      held: false,
      idle: false,
    };
    this.turn = turn;
    this.push(this.content(prompt, skill));
    return turn.finished.promise;
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
    this.command = abort;
    const id = randomUUID();
    const row = (text: string, done = false) =>
      this.options.onEvent({
        type: 'tool',
        id,
        title: '',
        text,
        done,
        append: true,
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
    try {
      const run = await runShell(command, {
        cwd: this.options.cwd,
        signal: abort.signal,
        onOutput: (text) => row(text),
        onSpawn: (pid) => {
          started = this.options.onShell?.(pid);
          // awaited once the command ends, which can be long after a failed report
          started?.catch(() => {});
        },
      });
      this.records.push(bashRecord(command, run));
      return {
        status: run.interrupted ? 'interrupted' : 'completed',
        text: '',
      };
    } catch (error) {
      return { status: 'failed', text: '', error: errorMessage(error) };
    } finally {
      this.command = undefined;
      row('', true);
      if (started) {
        await started;
        await this.options.onShell?.(undefined);
      }
    }
  }

  /**
   * Claude Code queues the prompt and folds it in after the next tool step, or runs it before going idle. a command
   * runs first, and its reply follows once it completes.
   */
  async steer(
    prompt: string,
    { command }: { command?: string } = {},
  ): Promise<boolean> {
    const turn = this.turn;
    if (this.closed || !turn || turn.interrupted || turn.held) return false;
    // after the result, a familiar or workflow running in the background holds off idle. without one, a prompt could
    // land after idle and run outside any turn
    if (turn.result && !this.replied) return false;
    if (command === undefined) turn.steered.set(this.push(prompt), prompt);
    else {
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

  /**
   * with no familiar or workflow left and Claude Code not yet idle, a reply could land after idle, so idle releases
   * it, or a familiar or workflow that starts first.
   */
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
    if (ran.status !== 'completed' || turn.idle || this.holding)
      this.release(turn);
  }

  /** runs once a steered command has ended: sends its reply, or ends a turn Claude Code has let go idle. */
  private release(turn: Turn): void {
    const answer = turn.answer;
    turn.held = false;
    turn.answer = undefined;
    if (answer !== undefined && !turn.interrupted && !this.closed) {
      turn.idle = false;
      // kept out of `steered`, since an unread reply would go back to the queue and run its command again
      this.push(this.content(answer));
    } else if (turn.idle && !this.closed) {
      this.finish(turn, {
        ...turn.result!,
        ...(turn.interrupted ? { status: 'interrupted' as const } : {}),
      });
      void this.readUsage();
    }
  }

  respond(id: string, response: UserResponse): void {
    this.requests.get(id)?.resolve(response);
  }

  async interrupt(): Promise<void> {
    this.command?.abort();
    const turn = this.turn;
    if (!turn) return;
    turn.interrupted = true;
    // Claude Code is idle, and the abort stops the command that holds the turn
    if (turn.idle) {
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
      this.closed = true;
      this.finish(turn, {
        status: 'interrupted',
        text: [...turn.messages.values()].join('\n\n'),
        unread: receipt.still_queued.flatMap(
          (uuid) => turn.steered.get(uuid) ?? [],
        ),
      });
      this.query.close();
    }
    await turn.finished.promise;
  }

  async close(): Promise<void> {
    this.command?.abort();
    this.closed = true;
    this.input.close();
    this.query.close();
    await this.reading;
    await this.child?.closed;
    this.options.signal?.removeEventListener('abort', this.cancelConnection);
    await this.options.onProcess(undefined);
  }

  /**
   * the records of commands run since the last prompt go ahead of it, and a skill goes last, since the CLI dispatches a
   * command only from the last text block and the rest become its context.
   */
  private content(
    prompt: string,
    skill?: SkillCall,
  ): SDKUserMessage['message']['content'] {
    const blocks = [
      ...this.records,
      prompt,
      ...(skill ? [`/${skill.name}${skill.args ? ` ${skill.args}` : ''}`] : []),
    ];
    this.records = [];
    return blocks.length > 1
      ? blocks.map((text) => ({ type: 'text' as const, text }))
      : prompt;
  }

  /** returns the uuid the message went with. */
  private push(content: SDKUserMessage['message']['content']): string {
    const uuid = randomUUID();
    this.input.push({
      type: 'user',
      uuid,
      session_id: this.info.id,
      message: { role: 'user', content },
      parent_tool_use_id: null,
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
      await this.end(errorMessage(error));
    } finally {
      this.closed = true;
      for (const request of this.requests.values())
        request.resolve({ decision: 'cancel' });
    }
  }

  private receive(message: SDKMessage): void {
    if (message.type === 'system') {
      if (message.subtype === 'init') {
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
      } else if (message.subtype === 'commands_changed') {
        this.options.onEvent({
          type: 'skills',
          skills: skillsOf(message.commands),
        });
      } else if (
        // a command steered after the reply holds the turn until its reply goes. Claude Code can run again meanwhile, as
        // it does when a brew ends
        message.subtype === 'session_state_changed' &&
        this.turn?.held
      ) {
        this.turn.idle = message.state === 'idle';
        if (this.turn.idle && this.turn.answer !== undefined)
          this.release(this.turn);
      } else if (
        // more activity can follow a result, so a turn ends only at native idle
        message.subtype === 'session_state_changed' &&
        message.state === 'idle' &&
        this.turn?.result
      ) {
        this.finish(this.turn, this.turn.result);
        void this.readUsage();
      } else if (
        // ambient tasks are housekeeping, such as forked-skill workers
        message.subtype === 'task_started' &&
        (message.task_type === 'local_agent' ||
          message.task_type === 'local_workflow') &&
        !message.ambient &&
        !this.late(message)
      ) {
        // a workflow holds off idle as a familiar does, though its agents never reach the stream
        if (message.task_type === 'local_workflow')
          this.workflows.add(message.task_id);
        else {
          if (message.run_id) this.runs.set(message.task_id, message.run_id);
          this.subagent({
            id: message.task_id,
            parent: message.parent_task_id,
            name: message.description,
            kind: message.subagent_type ?? '',
            status: 'running',
            run: message.run_id,
          });
        }
        if (this.turn?.held && this.turn.answer !== undefined)
          this.release(this.turn);
      } else if (message.subtype === 'background_tasks_changed') {
        // the live set lists a shell once it runs in the background, however it got there, and never a foreground one
        for (const task of message.tasks)
          if (
            task.task_type === 'local_bash' &&
            !this.backgroundCommands.has(task.task_id)
          )
            this.backgroundCommand({
              id: task.task_id,
              description: task.description,
              status: 'running',
            });
      } else if (message.subtype === 'task_notification') {
        this.workflows.delete(message.task_id);
        const subagent = this.subagents.get(message.task_id);
        if (subagent && !this.late(message))
          this.subagent({ ...subagent, status: message.status });
        // a shell joins the live set before its notification, so the notification finds it listed here
        const command = this.backgroundCommands.get(message.task_id);
        if (command)
          this.backgroundCommand({ ...command, status: message.status });
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
        this.turn?.messages.set(id, (this.turn.messages.get(id) ?? '') + text);
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
        this.turn?.messages.set(id, text);
        this.options.onEvent({ type: 'text', id, text, replace: true });
      }
      for (const block of message.message.content) {
        if (block.type === 'tool_use')
          this.options.onEvent({
            type: 'tool',
            id: block.id,
            title: toolTitle(block.name, block.input, this.options.cwd),
            text: JSON.stringify(block.input, null, 2),
            done: false,
          });
      }
    } else if (message.type === 'assistant' && message.agent_id) {
      const subagent = this.subagents.get(message.agent_id);
      if (!subagent) return;
      let { activity, tools = 0, report } = subagent;
      for (const block of message.message.content)
        if (block.type === 'tool_use') {
          activity = toolTitle(block.name, block.input, this.options.cwd);
          tools++;
        } else if (block.type === 'text') {
          report =
            report &&
            this.reportMessages.get(subagent.id) === message.message.id
              ? `${report}\n${block.text}`
              : block.text;
          this.reportMessages.set(subagent.id, message.message.id);
        }
      if (tools !== (subagent.tools ?? 0) || report !== subagent.report)
        this.subagent({ ...subagent, activity, tools, report });
    } else if (
      message.type === 'user' &&
      message.parent_tool_use_id === null &&
      Array.isArray(message.message.content)
    ) {
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
          text: texts.join('\n'),
          done: true,
          ...(images.length ? { images } : {}),
        });
      }
    } else if (message.type === 'result') {
      // the session's running total, which a resumed session continues
      this.report({ cost: message.total_cost_usd });
      if (!this.turn) return;
      const success = message.subtype === 'success' && !message.is_error;
      this.turn.result = {
        status: this.turn.interrupted
          ? 'interrupted'
          : success
            ? 'completed'
            : 'failed',
        text:
          message.subtype === 'success'
            ? message.result
            : [...this.turn.messages.values()].join('\n\n'),
        ...(!success
          ? {
              error:
                message.subtype === 'success'
                  ? message.result
                  : message.errors.join('\n'),
            }
          : {}),
      };
    }
  }

  private subagent(subagent: Subagent): void {
    this.subagents.set(subagent.id, subagent);
    this.options.onEvent({ type: 'subagent', subagent });
  }

  private backgroundCommand(command: BackgroundCommand): void {
    this.backgroundCommands.set(command.id, command);
    this.options.onEvent({ type: 'command', command });
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

  /** context from the CLI's estimate, and limits and lines from the usage report Claude Code's `/usage` reads. */
  private async readUsage(): Promise<void> {
    const [context, report] = await Promise.allSettled([
      this.query.getContextUsage({ detail: 'summary' }),
      this.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
        skipBehaviors: true,
      }),
    ]);
    const update: Usage = {};
    const percentage =
      context.status === 'fulfilled'
        ? z.number().safeParse(context.value.percentage)
        : undefined;
    if (percentage?.success) update.context = percentage.data;
    const usage =
      report.status === 'fulfilled'
        ? usageReport.safeParse(report.value)
        : undefined;
    if (usage?.success) {
      const { session, rate_limits: limits } = usage.data;
      update.lines = {
        added: session.total_lines_added,
        removed: session.total_lines_removed,
      };
      update.limits = (
        [
          ['5H', limits?.five_hour],
          ['7D', limits?.seven_day],
        ] as const
      ).flatMap(([name, limit]) =>
        limit?.utilization == null
          ? []
          : [
              {
                window: name,
                percent: limit.utilization,
                ...(limit.resets_at
                  ? { resetsAt: Date.parse(limit.resets_at) / 1000 }
                  : {}),
              },
            ],
      );
    }
    if (!this.closed && Object.keys(update).length) this.report(update);
  }

  /** ends the turn a stopped CLI leaves, once its stderr is complete. */
  private async end(error: string): Promise<void> {
    const closed = this.closed;
    // set before the wait, so a send() can't start a turn on a dead process
    this.closed = true;
    const turn = this.turn;
    // a command running beside a turn was steered into it, and one run with no turn open outlives the CLI
    if (turn) this.command?.abort();
    // this also covers a receive() throw while the CLI lives; the SDK's SIGTERM bounds the wait
    this.query.close();
    await this.child?.closed;
    const text = withTail(error, this.child?.tail() ?? '');
    if (turn)
      this.finish(turn, {
        status: turn.interrupted ? 'interrupted' : 'failed',
        text: '',
        error: text,
      });
    // a turn reports the error through its result
    if (!turn && this.connected && !closed)
      this.options.onEvent({ type: 'notice', text });
  }

  private finish(turn: Turn, result: TurnResult): void {
    if (this.turn === turn) this.turn = undefined;
    turn.finished.resolve(result);
  }
}
