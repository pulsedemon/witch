import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { JsonRpc } from './json-rpc.js';
import type { RpcMessage } from './json-rpc.js';
import type {
  AgentAdapter,
  AgentSession,
  Model,
  SessionInfo,
  SessionOptions,
  Skill,
  SkillCall,
  TurnResult,
  UserRequest,
  UserResponse,
} from './types.js';

const object = z.record(z.string(), z.unknown());
const nativeSession = z.object({
  thread: z.object({ id: z.string() }),
  model: z.string(),
  cwd: z.string(),
  approvalPolicy: z.unknown(),
  approvalsReviewer: z.string().optional(),
  reasoningEffort: z.string().nullish(),
});
const modelPage = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      description: z.string(),
      supportedReasoningEfforts: z.array(
        z.object({ reasoningEffort: z.string() }),
      ),
    }),
  ),
  nextCursor: z.string().nullable(),
});
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
const questionList = z.array(
  z.object({
    id: z.string(),
    question: z.string(),
    isSecret: z.boolean().optional(),
    options: z.array(z.object({ label: z.string() })).nullable(),
  }),
);

type Launch = (
  executable: string,
  cwd: string,
  signal?: AbortSignal,
) => ChildProcessWithoutNullStreams;
const launch: Launch = (executable, cwd, signal) =>
  spawn(executable, ['app-server', '--stdio'], { cwd, stdio: 'pipe', signal });

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly label = 'Codex';

  constructor(private readonly start: Launch = launch) {}

  async connect(options: SessionOptions): Promise<AgentSession> {
    const child = this.start(options.executable, options.cwd, options.signal);
    const rpc = new JsonRpc(child);
    const session = new CodexSession(rpc, options);
    try {
      await options.onProcess(child.pid);
      await session.initialize();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
}

class CodexSession implements AgentSession {
  info: SessionInfo;
  closed = false;
  private turn?: {
    started: ReturnType<typeof Promise.withResolvers<string>>;
    finished: ReturnType<typeof Promise.withResolvers<TurnResult>>;
    messages: Map<string, string>;
  };
  private requests = new Map<string, RpcMessage>();
  private closing = false;
  /** an exit before this rejects the connect, which reports it. */
  private connected = false;
  private settings?: ReturnType<typeof Promise.withResolvers<void>>;
  /** the thread's settings as Codex last reported them, which `model/rerouted` leaves alone. */
  private native: { model: string; effort?: string } = { model: '' };
  private readonly malformed = new Set<string>();
  /** each listed skill's SKILL.md, which a skill input names. */
  private readonly skillPaths = new Map<string, string>();

  constructor(
    private readonly rpc: JsonRpc,
    private readonly options: SessionOptions,
  ) {
    this.info = {
      id: options.resume ?? '',
      agent: 'codex',
      cwd: options.cwd,
      model: options.model ?? '',
      permissionMode: '',
      hasHistory: !!options.resume,
    };
    rpc.onMessage = (message) => this.receive(message);
    rpc.onExit = (error) => {
      this.settings?.reject(error);
      this.closed = true;
      this.finish('failed', error.message);
      if (this.connected && !this.closing)
        options.onEvent({ type: 'notice', text: error.message });
    };
  }

  async initialize(): Promise<void> {
    await this.rpc.request('initialize', {
      clientInfo: {
        name: 'witch',
        title: 'Witch',
        version: '0.1.0',
      },
      capabilities: { experimentalApi: true },
    });
    this.rpc.notify('initialized');
    const result = object.parse(
      await this.rpc.request('config/read', { cwd: this.options.cwd }),
    );
    const config = object.parse(result.config);
    const sandbox =
      config.sandbox_workspace_write == null
        ? {}
        : object.parse(config.sandbox_workspace_write);
    const roots = [
      ...new Set([
        ...z.array(z.string()).parse(sandbox.writable_roots ?? []),
        ...this.options.memoryDirectories,
      ]),
    ];
    const parameters = {
      cwd: this.options.cwd,
      model: this.options.model,
      config: { 'sandbox_workspace_write.writable_roots': roots },
      ...(this.options.resume ? { threadId: this.options.resume } : {}),
    };
    this.updateInfo(
      await this.rpc.request(
        this.options.resume ? 'thread/resume' : 'thread/start',
        parameters,
      ),
    );
    this.connected = true;
  }

  async models(): Promise<Model[]> {
    const models: Model[] = [];
    let cursor: string | null = null;
    do {
      const page = modelPage.parse(
        await this.rpc.request('model/list', { cursor, limit: 100 }),
      );
      models.push(
        ...page.data.map((model) => ({
          id: model.id,
          label: model.displayName,
          description: model.description,
          efforts: model.supportedReasoningEfforts.map(
            (effort) => effort.reasoningEffort,
          ),
        })),
      );
      cursor = page.nextCursor;
    } while (cursor);
    return models;
  }

  /** enabled skills, first per name, as the TUI offers them. */
  async skills(): Promise<Skill[]> {
    const { data } = skillList.parse(
      await this.rpc.request('skills/list', {
        cwds: [this.options.cwd],
        forceReload: true,
      }),
    );
    this.skillPaths.clear();
    const skills: Skill[] = [];
    for (const skill of data.flatMap((entry) => entry.skills)) {
      if (!skill.enabled || this.skillPaths.has(skill.name)) continue;
      this.skillPaths.set(skill.name, skill.path);
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

  /** Codex can't clear effort, so `null` keeps the effort in force as an omitted one does. */
  async selectModel(model: string, effort?: string | null): Promise<void> {
    if (this.turn)
      throw new Error('Stop the current turn before changing models');
    // Codex notifies only when the settings change
    if (
      model === this.native.model &&
      (effort == null || effort === this.native.effort)
    ) {
      this.info = { ...this.info, model, effort: effort ?? this.info.effort };
      this.options.onEvent({ type: 'info', info: this.info });
      return;
    }
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

  async send(prompt: string, skill?: SkillCall): Promise<TurnResult> {
    if (this.turn) throw new Error('This agent is already running');
    if (skill && !this.skillPaths.has(skill.name)) await this.skills();
    const path = skill && this.skillPaths.get(skill.name);
    const turn = {
      started: Promise.withResolvers<string>(),
      finished: Promise.withResolvers<TurnResult>(),
      messages: new Map<string, string>(),
    };
    this.turn = turn;
    try {
      const response = z.object({ turn: z.object({ id: z.string() }) }).parse(
        await this.rpc.request('turn/start', {
          threadId: this.info.id,
          // the TUI sends a selected skill as an item, which Codex resolves by path
          input: [
            { type: 'text', text: prompt, text_elements: [] },
            ...(skill && path
              ? [{ type: 'skill', name: skill.name, path }]
              : []),
          ],
          effort: this.info.effort,
        }),
      );
      turn.started.resolve(response.turn.id);
      this.info = { ...this.info, hasHistory: true };
      this.options.onEvent({ type: 'info', info: this.info });
    } catch (error) {
      turn.started.resolve('');
      this.finish('failed', String(error));
    }
    return turn.finished.promise;
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    const id = await turn.started.promise;
    if (id && this.turn === turn)
      await this.rpc.request('turn/interrupt', {
        threadId: this.info.id,
        turnId: id,
      });
    await turn.finished.promise;
  }

  respond(id: string, response: UserResponse): void {
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

  async close(): Promise<void> {
    this.closing = true;
    try {
      await this.interrupt();
    } finally {
      await this.rpc.close();
      await this.options.onProcess(undefined);
    }
  }

  private updateInfo(response: unknown): void {
    const data = nativeSession.parse(response);
    const policy =
      typeof data.approvalPolicy === 'string'
        ? data.approvalPolicy
        : JSON.stringify(data.approvalPolicy);
    this.native = {
      model: data.model,
      effort: data.reasoningEffort ?? undefined,
    };
    this.info = {
      ...this.info,
      id: data.thread.id,
      model: data.model,
      cwd: data.cwd,
      permissionMode: `${policy}${data.approvalsReviewer ? ` / ${data.approvalsReviewer}` : ''}`,
      effort: this.options.effort ?? data.reasoningEffort ?? undefined,
    };
    this.options.onEvent({ type: 'info', info: this.info });
  }

  /** one malformed notification posts a notice per method and fails only what it settles. */
  private receive(message: RpcMessage): void {
    if (message.id !== undefined && message.method) {
      this.requestInput(message);
      return;
    }
    try {
      this.notification(message);
    } catch (error) {
      const text = `Witch could not read Codex's ${message.method} notification: ${error instanceof Error ? error.message : String(error)}`;
      if (message.method === 'turn/completed') this.finish('failed', text);
      else if (message.method === 'thread/settings/updated')
        this.settings?.reject(new Error(text));
      if (this.malformed.has(message.method!)) return;
      this.malformed.add(message.method!);
      this.options.onEvent({ type: 'notice', text });
    }
  }

  private notification(message: RpcMessage): void {
    const data = message.params == null ? {} : object.parse(message.params);
    switch (message.method) {
      case 'thread/settings/updated': {
        const settings = object.parse(data.threadSettings);
        this.native = {
          model: z.string().parse(settings.model),
          effort: z.string().nullish().parse(settings.effort) ?? undefined,
        };
        this.info = { ...this.info, ...this.native };
        this.options.onEvent({ type: 'info', info: this.info });
        this.settings?.resolve();
        break;
      }
      case 'skills/changed':
        if (!this.closing)
          void this.skills().then(
            (skills) => this.options.onEvent({ type: 'skills', skills }),
            (error: unknown) =>
              this.options.onEvent({ type: 'notice', text: String(error) }),
          );
        break;
      case 'item/agentMessage/delta': {
        const id = z.string().parse(data.itemId);
        const text = z.string().parse(data.delta);
        this.turn?.messages.set(id, (this.turn.messages.get(id) ?? '') + text);
        this.options.onEvent({ type: 'text', id, text });
        break;
      }
      case 'item/started':
      case 'item/completed': {
        const item = object.parse(data.item);
        const id = z.string().parse(item.id);
        const type = z.string().parse(item.type);
        if (type === 'agentMessage') {
          if (typeof item.text === 'string') {
            this.turn?.messages.set(id, item.text);
            this.options.onEvent({
              type: 'text',
              id,
              text: item.text,
              replace: true,
            });
          }
        } else if (!['userMessage', 'reasoning'].includes(type)) {
          this.options.onEvent({
            type: 'tool',
            id,
            title: typeof item.command === 'string' ? item.command : type,
            text:
              typeof item.aggregatedOutput === 'string'
                ? item.aggregatedOutput
                : JSON.stringify(item, null, 2),
            done: message.method === 'item/completed',
            cwd: typeof item.cwd === 'string' ? item.cwd : this.info.cwd,
          });
        }
        break;
      }
      case 'item/commandExecution/outputDelta':
        this.options.onEvent({
          type: 'tool',
          id: z.string().parse(data.itemId),
          title: '',
          text: z.string().parse(data.delta),
          done: false,
          append: true,
          cwd: this.info.cwd,
        });
        break;
      case 'turn/completed': {
        const turn = object.parse(data.turn);
        const status = z.string().parse(turn.status);
        const error =
          turn.error == null ? undefined : object.parse(turn.error).message;
        if (['completed', 'interrupted', 'failed'].includes(status))
          this.finish(
            status as TurnResult['status'],
            typeof error === 'string' ? error : undefined,
          );
        else
          this.finish('failed', `Codex ended the turn with status ${status}`);
        break;
      }
      case 'model/rerouted':
        if (typeof data.toModel === 'string') {
          this.info = { ...this.info, model: data.toModel };
          this.options.onEvent({ type: 'info', info: this.info });
        }
        break;
      case 'serverRequest/resolved': {
        const id = String(data.requestId);
        this.requests.delete(id);
        this.options.onEvent({ type: 'request-resolved', id });
        break;
      }
      case 'error':
        this.options.onEvent({
          type: 'notice',
          text: z.string().parse(object.parse(data.error).message),
        });
    }
  }

  private requestInput(message: RpcMessage): void {
    let request;
    try {
      request = this.parseRequest(message);
    } catch (error) {
      const text = `Witch could not read Codex's ${message.method} request: ${error instanceof Error ? error.message : String(error)}`;
      this.rpc.reject(message.id!, text);
      this.options.onEvent({ type: 'notice', text });
      return;
    }
    if (!request) {
      this.rpc.reject(
        message.id!,
        `Unsupported native request: ${message.method}`,
      );
      this.options.onEvent({
        type: 'notice',
        text: `Unsupported native request: ${message.method}`,
      });
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
    if (
      [
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
        'item/permissions/requestApproval',
      ].includes(message.method ?? '')
    )
      return { ...request, kind: 'approval' };
    return undefined;
  }

  private finish(status: TurnResult['status'], error?: string): void {
    const turn = this.turn;
    this.turn = undefined;
    for (const id of this.requests.keys())
      this.options.onEvent({ type: 'request-resolved', id });
    this.requests.clear();
    turn?.finished.resolve({
      status,
      text: [...turn.messages.values()].join('\n\n'),
      ...(error ? { error } : {}),
    });
  }
}
