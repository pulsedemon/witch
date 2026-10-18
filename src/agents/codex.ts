import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { JsonRpc } from './json-rpc.js';
import type { RpcMessage } from './json-rpc.js';
import { errorMessage } from './stderr.js';
import { shortPath, toolTitle } from './tool-title.js';
import type {
  AgentAdapter,
  AgentSession,
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

const object = z.record(z.string(), z.unknown());
const nativeSession = z.object({
  thread: z.object({ id: z.string() }),
  model: z.string(),
  approvalPolicy: z.unknown(),
  approvalsReviewer: z.string().optional(),
  reasoningEffort: z.string().nullish(),
});
const modelPage = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
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
const tokenUsage = z.object({
  tokenUsage: z.object({
    last: z.object({ totalTokens: z.number() }),
    modelContextWindow: z.number().nullable(),
  }),
});
const rateWindow = z
  .object({
    usedPercent: z.number(),
    windowDurationMins: z.number().nullable(),
    resetsAt: z.number().nullable(),
  })
  .nullish();
const rateLimits = z.object({
  limitId: z.string().nullish(),
  primary: rateWindow,
  secondary: rateWindow,
});
type RateWindow = NonNullable<z.infer<typeof rateWindow>>;
const questionList = z.array(
  z.object({
    id: z.string(),
    question: z.string(),
    isSecret: z.boolean().optional(),
    options: z.array(z.object({ label: z.string() })).nullable(),
  }),
);

/** lines a unified diff adds and removes; only lines inside a hunk count, so file headers stay out. */
function diffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let hunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) hunk = true;
    else if (line.startsWith('diff ')) hunk = false;
    else if (hunk && line.startsWith('+')) added++;
    else if (hunk && line.startsWith('-')) removed++;
  }
  return { added, removed };
}

/** `5H` for 300 minutes, `7D` for 10080. */
function windowName(minutes: number): string {
  return minutes % 1440 === 0
    ? `${minutes / 1440}D`
    : `${Math.round(minutes / 60)}H`;
}

const changedFiles = z.array(z.object({ path: z.string() })).catch([]);
const mcpCall = z.object({
  server: z.string(),
  tool: z.string(),
  arguments: z.unknown(),
});
const imageContent = z.object({
  type: z.literal('image'),
  data: z.string(),
  mimeType: z.string(),
});
const mcpResult = z.object({ content: z.array(z.unknown()) });
const turnId = z.object({ turn: z.object({ id: z.string() }) });
/** item types besides agentMessage that get no tool row or familiar activity. */
const untooled = ['userMessage', 'reasoning'];

/** an item's name and what it acts on; a command shows as itself. */
function itemTitle(
  type: string,
  item: Record<string, unknown>,
  cwd: string,
): string {
  if (typeof item.command === 'string') return item.command;
  if (type === 'fileChange')
    return [
      type,
      ...changedFiles
        .parse(item.changes)
        .map(({ path }) => shortPath(path, cwd)),
    ].join('  ');
  const call = type === 'mcpToolCall' ? mcpCall.safeParse(item) : undefined;
  if (call?.success)
    return toolTitle(
      `${call.data.server}.${call.data.tool}`,
      call.data.arguments,
      cwd,
    );
  if (typeof item.tool === 'string')
    return toolTitle(item.tool, item.arguments ?? item, cwd);
  return toolTitle(type, item, cwd);
}

/** a viewed image file, or the images an MCP tool returned. */
function itemImages(type: string, item: Record<string, unknown>): string[] {
  if (type === 'imageView' && typeof item.path === 'string') return [item.path];
  const result = mcpResult.safeParse(item.result);
  if (!result.success) return [];
  return result.data.content.flatMap((part) => {
    const image = imageContent.safeParse(part);
    return image.success
      ? [`data:${image.data.mimeType};base64,${image.data.data}`]
      : [];
  });
}

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
  usage: Usage = {};
  closed = false;
  private turn?: {
    started: ReturnType<typeof Promise.withResolvers<string>>;
    finished: ReturnType<typeof Promise.withResolvers<TurnResult>>;
    messages: Map<string, string>;
    interrupted: boolean;
    /** the user's `!` command this turn runs, as typed. */
    command?: string;
  };
  private requests = new Map<string, RpcMessage>();
  private closing = false;
  /** an exit before this rejects the connect, which reports it. */
  private connected = false;
  private settings?: ReturnType<typeof Promise.withResolvers<void>>;
  /** the thread's settings as Codex last reported them, which `model/rerouted` leaves alone. */
  private native: { model: string; effort?: string } = { model: '' };
  private readonly malformed = new Set<string>();
  /** spawned threads by id. */
  private readonly subagents = new Map<string, Subagent>();
  /** each listed skill's SKILL.md, which a skill input names. */
  private readonly skillPaths = new Map<string, string>();
  /** each turn's latest diff count, since a turn's diff grows as it edits. */
  private readonly turnLines = new Map<
    string,
    { added: number; removed: number }
  >();
  /** the account limit the windows belong to, and its windows by slot, which a sparse update merges into. */
  private limitId?: string;
  private readonly windows: { primary?: RateWindow; secondary?: RateWindow } =
    {};

  constructor(
    private readonly rpc: JsonRpc,
    private readonly options: SessionOptions,
  ) {
    this.info = {
      id: options.resume ?? '',
      agent: 'codex',
      model: options.model ?? '',
      permissionMode: '',
      hasHistory: !!options.resume,
      effort: options.effort,
    };
    rpc.onMessage = (message) => this.receive(message);
    rpc.onExit = (error) => {
      // a turn or settings change in flight reports the exit itself
      const reported = !!(this.turn || this.settings);
      this.settings?.reject(error);
      this.closed = true;
      this.finish(
        this.turn?.interrupted ? 'interrupted' : 'failed',
        error.message,
      );
      if (!reported && this.connected && !this.closing)
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
      config: {
        'sandbox_workspace_write.writable_roots': roots,
        // in the thread's config, so app-server's own children stay unmarked
        ...Object.fromEntries(
          Object.entries(this.options.mark?.environment ?? {}).map(
            ([key, value]) => [`shell_environment_policy.set.${key}`, value],
          ),
        ),
      },
      ...(this.options.resume ? { threadId: this.options.resume } : {}),
    };
    this.updateInfo(
      await this.rpc.request(
        this.options.resume ? 'thread/resume' : 'thread/start',
        parameters,
      ),
    );
    this.connected = true;
    void this.readLimits();
    void this.readCost();
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

  /** Codex can't clear its thread's effort, so `null` only stops requesting one. */
  async selectModel(model: string, effort?: string | null): Promise<void> {
    if (this.turn)
      throw new Error('Stop the current turn before changing models');
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
    this.info = {
      ...this.info,
      model: this.native.model,
      effort: effort === undefined ? this.info.effort : (effort ?? undefined),
    };
    this.options.onEvent({ type: 'info', info: this.info });
  }

  async send(prompt: string, skill?: SkillCall): Promise<TurnResult> {
    if (this.turn) throw new Error('This agent is already running');
    const path = skill && this.skillPaths.get(skill.name);
    const turn = {
      started: Promise.withResolvers<string>(),
      finished: Promise.withResolvers<TurnResult>(),
      messages: new Map<string, string>(),
      interrupted: false,
    };
    this.turn = turn;
    try {
      const response = turnId.parse(
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
      this.finish('failed', errorMessage(error));
    }
    return turn.finished.promise;
  }

  /** Codex records the command and its output in the thread, and its turn ends without a reply. */
  async shell(command: string): Promise<TurnResult> {
    if (this.turn) throw new Error('This agent is already running');
    const turn = {
      // the turn's id comes with `turn/started`, since the request answers with nothing
      started: Promise.withResolvers<string>(),
      finished: Promise.withResolvers<TurnResult>(),
      messages: new Map<string, string>(),
      interrupted: false,
      command,
    };
    this.turn = turn;
    try {
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
  async steer(prompt: string): Promise<boolean> {
    // a prompt steered into a shell command's turn would never be answered
    if (this.turn?.command !== undefined) return false;
    const id = await this.turn?.started.promise;
    if (!id) return false;
    try {
      await this.rpc.request('turn/steer', {
        threadId: this.info.id,
        expectedTurnId: id,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
      });
      return true;
    } catch {
      // any refusal leaves the prompt to the next turn, the expected one being a turn that has just ended
      return false;
    }
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    turn.interrupted = true;
    const id = await turn.started.promise;
    if (id && this.turn === turn)
      try {
        await this.rpc.request('turn/interrupt', {
          threadId: this.info.id,
          turnId: id,
        });
      } catch (error) {
        // an exit has ended the turn by the time its rejection lands here
        if (!this.closed) throw error;
      }
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
      nativeEffort: this.native.effort,
      permissionMode: `${policy}${data.approvalsReviewer ? ` / ${data.approvalsReviewer}` : ''}`,
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
      if (child) this.subagentNotification(message, child);
      else this.notification(message);
    } catch (error) {
      const text = `Witch could not read Codex's ${message.method} notification: ${errorMessage(error)}`;
      // a subagent's notification settles nothing of this thread's
      if (!child && message.method === 'turn/completed')
        this.finish('failed', text);
      else if (message.method === 'thread/settings/updated')
        this.settings?.reject(new Error(text));
      if (this.malformed.has(message.method!)) return;
      this.malformed.add(message.method!);
      this.options.onEvent({ type: 'notice', text });
    }
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

  /** a thread's next turn can start before its last turn's items and end arrive, which then belong to no run. */
  private subagentNotification(message: RpcMessage, threadId: string): void {
    const subagent = this.subagents.get(threadId);
    if (
      subagent &&
      (message.method === 'item/started' || message.method === 'item/completed')
    ) {
      const params = object.parse(message.params);
      if (subagent.run !== undefined && params.turnId !== subagent.run) return;
      const item = object.parse(params.item);
      const type = z.string().parse(item.type);
      if (type === 'agentMessage') {
        if (
          message.method === 'item/completed' &&
          typeof item.text === 'string'
        )
          this.subagent({ ...subagent, report: item.text });
      } else if (message.method === 'item/started' && !untooled.includes(type))
        this.subagent({
          ...subagent,
          activity: itemTitle(type, item, this.options.cwd),
          tools: (subagent.tools ?? 0) + 1,
        });
      return;
    }
    if (
      message.method !== 'turn/started' &&
      message.method !== 'turn/completed'
    )
      return;
    // shown before a completion parses, so a malformed one still lists the thread
    if (!subagent || message.method === 'turn/started') {
      if (!subagent) void this.readSubagent(threadId);
      // a new turn is a new run, so it starts without the last one's activity, tool count and report
      const { id, parent, name, kind } = subagent ?? {
        id: threadId,
        parent: undefined,
        name: 'agent',
        kind: '',
      };
      const run = turnId.safeParse(message.params).data?.turn.id;
      this.subagent({
        id,
        ...(parent === undefined ? {} : { parent }),
        name,
        kind,
        status: 'running',
        ...(run ? { run } : {}),
      });
    }
    if (message.method === 'turn/completed') {
      const { turn } = z
        .object({ turn: z.object({ id: z.string(), status: z.string() }) })
        .parse(message.params);
      const current = this.subagents.get(threadId)!;
      if (current.run !== undefined && turn.id !== current.run) return;
      this.subagent({
        ...current,
        status:
          turn.status === 'completed'
            ? 'completed'
            : turn.status === 'interrupted'
              ? 'stopped'
              : 'failed',
      });
    }
  }

  /** a spawned thread's parent, nickname and role, which no notification carries. */
  private async readSubagent(threadId: string): Promise<void> {
    try {
      const { thread } = z
        .object({
          thread: z.object({
            parentThreadId: z.string().nullable(),
            agentNickname: z.string().nullable(),
            agentRole: z.string().nullable(),
          }),
        })
        .parse(await this.rpc.request('thread/read', { threadId }));
      if (this.closing) return;
      this.subagent({
        ...this.subagents.get(threadId)!,
        parent:
          thread.parentThreadId === this.info.id
            ? undefined
            : (thread.parentThreadId ?? undefined),
        name: thread.agentNickname || 'agent',
        kind: thread.agentRole ?? '',
      });
    } catch {
      // the subagent keeps its defaults
    }
  }

  private subagent(subagent: Subagent): void {
    this.subagents.set(subagent.id, subagent);
    this.options.onEvent({ type: 'subagent', subagent });
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
        this.info = {
          ...this.info,
          model: this.native.model,
          nativeEffort: this.native.effort,
        };
        this.options.onEvent({ type: 'info', info: this.info });
        this.settings?.resolve();
        break;
      }
      case 'turn/started':
        // a send learned the id from `turn/start` already, and a shell command learns it here
        this.turn?.started.resolve(turnId.parse(data).turn.id);
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
        } else if (!untooled.includes(type)) {
          const images = itemImages(type, item);
          // Codex titles a user's command with its shell wrapper
          const command =
            item.source === 'userShell' ? this.turn?.command : undefined;
          this.options.onEvent({
            type: 'tool',
            id,
            title: command ?? itemTitle(type, item, this.options.cwd),
            text:
              typeof item.aggregatedOutput === 'string'
                ? item.aggregatedOutput
                : type === 'commandExecution'
                  ? ''
                  : // image data shows as the image, not as base64 text
                    JSON.stringify(
                      item,
                      (_key, value: unknown) =>
                        imageContent.safeParse(value).success
                          ? { ...(value as object), data: '…' }
                          : value,
                      2,
                    ),
            done: message.method === 'item/completed',
            cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
            ...(images.length ? { images } : {}),
            ...(command === undefined ? {} : { shell: true }),
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
        });
        break;
      case 'thread/tokenUsage/updated': {
        const { tokenUsage: usage } = tokenUsage.parse(data);
        if (usage.modelContextWindow)
          this.report({
            context: (usage.last.totalTokens / usage.modelContextWindow) * 100,
          });
        break;
      }
      case 'turn/diff/updated': {
        const turn = z
          .object({ turnId: z.string(), diff: z.string() })
          .parse(data);
        this.turnLines.set(turn.turnId, diffLines(turn.diff));
        const lines = { added: 0, removed: 0 };
        for (const { added, removed } of this.turnLines.values()) {
          lines.added += added;
          lines.removed += removed;
        }
        this.report({ lines });
        break;
      }
      case 'account/rateLimits/updated':
        this.mergeLimits(rateLimits.parse(object.parse(data.rateLimits)));
        break;
      case 'turn/completed': {
        if (!this.closing) void this.readCost();
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
        // a final error comes back as the failed turn's error, which the coordinator posts
        if (data.willRetry || !this.turn)
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
      const text = `Witch could not read Codex's ${message.method} request: ${errorMessage(error)}`;
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

  private report(update: Usage): void {
    this.usage = { ...this.usage, ...update };
    this.options.onEvent({ type: 'usage', usage: this.usage });
  }

  /** the status line leaves out what Codex can't report, such as limits on an API key. */
  private async readLimits(): Promise<void> {
    try {
      const response = object.parse(
        await this.rpc.request('account/rateLimits/read', {
          excludeResetCreditDetails: true,
        }),
      );
      this.mergeLimits(rateLimits.parse(response.rateLimits));
    } catch {
      // limits stay unreported
    }
  }

  /** an estimate, absent when Codex has no billing route for the thread. */
  private async readCost(): Promise<void> {
    try {
      const response = z
        .object({
          threadUsage: z
            .object({ estimatedUsageUsdMicros: z.number().nullable() })
            .nullish(),
        })
        .parse(
          await this.rpc.request('account/usage/read', {
            threadId: this.info.id,
          }),
        );
      const micros = response.threadUsage?.estimatedUsageUsdMicros;
      if (micros != null) this.report({ cost: micros / 1_000_000 });
    } catch {
      // the cost stays unreported
    }
  }

  /** an update for another limit is left out, and a window it leaves null keeps its last value. */
  private mergeLimits(update: z.infer<typeof rateLimits>): void {
    if (update.limitId) {
      if (this.limitId && update.limitId !== this.limitId) return;
      this.limitId = update.limitId;
    }
    if (update.primary) this.windows.primary = update.primary;
    if (update.secondary) this.windows.secondary = update.secondary;
    // a window of unknown length has no name to show
    const windows = [this.windows.primary, this.windows.secondary].flatMap(
      (window) =>
        window?.windowDurationMins == null
          ? []
          : [{ ...window, minutes: window.windowDurationMins }],
    );
    windows.sort((a, b) => a.minutes - b.minutes);
    this.report({
      limits: windows.map(({ minutes, usedPercent, resetsAt }) => ({
        window: windowName(minutes),
        percent: usedPercent,
        ...(resetsAt != null ? { resetsAt } : {}),
      })),
    });
  }

  private finish(status: TurnResult['status'], error?: string): void {
    const turn = this.turn;
    this.turn = undefined;
    // a shell command's turn that never reported its start would hold an interrupt waiting for it
    turn?.started.resolve('');
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
