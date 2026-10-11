import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  SpawnOptions,
  Query,
  SDKMessage,
  SDKUserMessage,
  ModelInfo,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { InputQueue } from './input-queue.js';
import type {
  AgentAdapter,
  AgentSession,
  Model,
  SessionInfo,
  SessionOptions,
  TurnResult,
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
const questions = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      header: z.string().optional(),
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

class ClaudeSession implements AgentSession {
  info: SessionInfo;
  closed = false;
  private readonly input = new InputQueue<SDKUserMessage>();
  private readonly query: Query;
  private readonly reading: Promise<void>;
  private registered = Promise.resolve();
  private readonly exited = Promise.withResolvers<void>();
  private readonly abort = new AbortController();
  private readonly cancelConnection = () => this.abort.abort();
  private readonly requests = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<UserResponse>>
  >();
  private currentMessage = '';
  private turn?: {
    finished: ReturnType<typeof Promise.withResolvers<TurnResult>>;
    result?: TurnResult;
    interrupted: boolean;
    messages: Map<string, string>;
  };

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
      cwd: options.cwd,
      model: options.model ?? '',
      permissionMode: '',
      hasHistory: !!options.resume,
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
        env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
        spawnClaudeCodeProcess: (settings) => {
          const child = start(settings);
          this.registered = options.onProcess(child.pid);
          child.once('exit', () => this.exited.resolve());
          child.once('error', () => this.exited.resolve());
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
    await this.query.initializationResult();
    await this.registered;
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
      description: model.description,
      efforts: model.supportedEffortLevels ?? [],
    }));
  }

  async selectModel(model: string, effort?: string): Promise<void> {
    if (this.turn)
      throw new Error('Stop the current turn before changing models');
    await this.query.setModel(model);
    await this.query.applyFlagSettings({
      effortLevel: effort ? effortLevel.parse(effort) : null,
    });
    this.info = { ...this.info, model };
    this.options.onEvent({ type: 'info', info: this.info });
  }

  async send(prompt: string): Promise<TurnResult> {
    if (this.closed) throw new Error('The Claude session is closed');
    if (this.turn) throw new Error('This agent is already running');
    const turn = {
      finished: Promise.withResolvers<TurnResult>(),
      interrupted: false,
      messages: new Map<string, string>(),
    };
    this.turn = turn;
    this.input.push({
      type: 'user',
      uuid: randomUUID(),
      session_id: this.info.id,
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
    });
    return turn.finished.promise;
  }

  respond(id: string, response: UserResponse): void {
    this.requests.get(id)?.resolve(response);
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    turn.interrupted = true;
    const receipt = await this.query.interrupt();
    if (receipt?.still_queued?.length) {
      this.query.close();
      await this.exited.promise;
      this.finish({
        status: 'interrupted',
        text: [...turn.messages.values()].join('\n\n'),
      });
      this.closed = true;
    }
    await turn.finished.promise;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.input.close();
    this.query.close();
    await this.reading;
    await this.exited.promise;
    this.options.signal?.removeEventListener('abort', this.cancelConnection);
    await this.options.onProcess(undefined);
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
      if (this.turn)
        this.finish({
          status: this.turn.interrupted ? 'interrupted' : 'failed',
          text: '',
          error: 'Claude exited before reporting idle',
        });
    } catch (error) {
      this.finish({
        status: this.turn?.interrupted ? 'interrupted' : 'failed',
        text: '',
        error: String(error),
      });
      if (!this.closed)
        this.options.onEvent({ type: 'notice', text: String(error) });
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
          cwd: message.cwd,
          hasHistory: true,
        };
        this.options.onEvent({ type: 'info', info: this.info });
      } else if (
        message.subtype === 'session_state_changed' &&
        message.state === 'idle' &&
        this.turn?.result
      ) {
        this.finish(this.turn.result);
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
            title: block.name,
            text: JSON.stringify(block.input, null, 2),
            done: false,
            cwd: this.info.cwd,
          });
      }
    } else if (
      message.type === 'user' &&
      Array.isArray(message.message.content)
    ) {
      for (const block of message.message.content) {
        if (block.type === 'tool_result')
          this.options.onEvent({
            type: 'tool',
            id: block.tool_use_id,
            title: '',
            text:
              typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content, null, 2),
            done: true,
            cwd: this.info.cwd,
          });
      }
    } else if (message.type === 'result' && this.turn) {
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

  private finish(result: TurnResult): void {
    const turn = this.turn;
    this.turn = undefined;
    turn?.finished.resolve(result);
  }
}
