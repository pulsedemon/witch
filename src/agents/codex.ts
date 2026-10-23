import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { JsonRpc } from './json-rpc.js';
import type { RpcMessage } from './json-rpc.js';
import { wholeFile } from './file-diff.js';
import { errorMessage } from './stderr.js';
import { shortPath, toolTitle } from './tool-title.js';
import type {
  AgentAdapter,
  AgentSession,
  BackgroundCommand,
  FileDiff,
  Hunk,
  Model,
  ModelDiscoveryOptions,
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
const stringValue = z.string();
const nullishString = stringValue.nullish();
const commandStatus = z.enum(['completed', 'failed', 'declined']);
const completedTurn = z.object({
  turn: z.object({ id: stringValue, status: stringValue }),
});
const turnDiff = z.object({ turnId: stringValue, diff: stringValue });
type Notification = {
  method: RpcMessage['method'];
  params: Record<string, unknown>;
  item?: Record<string, unknown>;
};

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
const messageQuestions = z.array(
  z.object({
    title: z.string(),
    options: z.array(z.string()).nullish(),
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

/** the hunks of a Codex update's diff, which has no file headers and can end with a move's note. */
function hunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const line of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header)
      hunks.push({
        oldStart: Number(header[1]),
        newStart: Number(header[2]),
        lines: [],
      });
    else if (/^[ +-]/.test(line)) hunks.at(-1)?.lines.push(line);
  }
  return hunks;
}

function fileDiffs(changes: z.infer<typeof fileChanges>): FileDiff[] {
  return changes.map(({ path, kind, diff }) =>
    kind.type === 'update'
      ? {
          path,
          kind: 'update',
          ...(kind.move_path ? { movePath: kind.move_path } : {}),
          hunks: hunks(diff),
        }
      : wholeFile(path, kind.type, diff),
  );
}

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

/** `5H` for 300 minutes, `7D` for 10080. */
function windowName(minutes: number): string {
  return minutes % 1440 === 0
    ? `${minutes / 1440}D`
    : `${Math.round(minutes / 60)}H`;
}

const changedFiles = z.array(z.object({ path: z.string() })).catch([]);
const fileChanges = z.array(
  z.object({
    path: z.string(),
    kind: z.object({
      type: z.enum(['add', 'delete', 'update']),
      move_path: z.string().nullish(),
    }),
    diff: z.string(),
  }),
);
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
const untooled = ['userMessage', 'reasoning', 'contextCompaction'];

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

async function initializeRpc(rpc: JsonRpc): Promise<void> {
  await rpc.request('initialize', {
    clientInfo: { name: 'witch', title: 'Witch', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  rpc.notify('initialized');
}

async function readModels(rpc: JsonRpc): Promise<Model[]> {
  const models: Model[] = [];
  let cursor: string | null = null;
  do {
    const page = modelPage.parse(
      await rpc.request('model/list', { cursor, limit: 100 }),
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

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly label = 'Codex';

  constructor(private readonly start: Launch = launch) {}

  async models(options: ModelDiscoveryOptions): Promise<Model[]> {
    const rpc = new JsonRpc(
      this.start(options.executable, options.cwd, options.signal),
    );
    try {
      await initializeRpc(rpc);
      return await readModels(rpc);
    } finally {
      await rpc.close();
    }
  }

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
  /** a turn ends at its own `turn/completed`, which no familiar holds back. */
  readonly replied = false;
  private turn?: {
    started: ReturnType<typeof Promise.withResolvers<string>>;
    finished: ReturnType<typeof Promise.withResolvers<TurnResult>>;
    messages: Map<string, string>;
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
  /** an exit before this rejects the connect, which reports it. */
  private connected = false;
  private settings?: ReturnType<typeof Promise.withResolvers<void>>;
  /** the thread's settings as Codex last reported them, which `model/rerouted` leaves alone. */
  private native: { model: string; effort?: string } = { model: '' };
  private readonly malformed = new Set<string>();
  /** spawned threads by id. */
  private readonly subagents = new Map<string, Subagent>();
  private readonly commands = new Map<
    string,
    {
      threadId: string;
      turnId: string;
      ended: boolean;
      command?: BackgroundCommand;
    }
  >();
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
      this.stopBackgroundCommands();
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
    const parameters = {
      cwd: this.options.cwd,
      model: this.options.model,
      // an omitted selection restores the thread's saved workspace roots
      runtimeWorkspaceRoots: [
        ...new Set([this.options.cwd, ...this.options.memoryDirectories]),
      ],
      // in the thread's config, so app-server's own children stay unmarked
      config: Object.fromEntries(
        Object.entries(this.options.mark?.environment ?? {}).map(
          ([key, value]) => [`shell_environment_policy.set.${key}`, value],
        ),
      ),
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

  models(): Promise<Model[]> {
    return readModels(this.rpc);
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

  private beginTurn(): NonNullable<CodexSession['turn']> {
    if (this.turn) throw new Error('This agent is already running');
    const turn = {
      started: Promise.withResolvers<string>(),
      finished: Promise.withResolvers<TurnResult>(),
      messages: new Map<string, string>(),
      interrupted: false,
    };
    this.turn = turn;
    return turn;
  }

  async send(prompt: string, skill?: SkillCall): Promise<TurnResult> {
    const path = skill && this.skillPaths.get(skill.name);
    const turn = this.beginTurn();
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
      if (this.turn === turn) this.turn.id = response.turn.id;
      this.info = { ...this.info, hasHistory: true };
      this.options.onEvent({ type: 'info', info: this.info });
    } catch (error) {
      turn.started.resolve('');
      this.finish('failed', errorMessage(error));
    }
    return turn.finished.promise;
  }

  async contextUsage(): Promise<number | undefined> {
    return this.usage.context;
  }

  async compact(): Promise<TurnResult> {
    if (this.closed) throw new Error('The Codex session is closed');
    const turn = this.beginTurn();
    turn.compaction = { completed: false };
    try {
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
    if (this.turn?.command !== undefined || this.turn?.compaction) return false;
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
    this.stopBackgroundCommands();
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
      const item =
        message.method === 'item/started' ||
        message.method === 'item/completed';
      if (
        child &&
        !item &&
        message.method !== 'turn/started' &&
        message.method !== 'turn/completed'
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
      this.commandNotification(notification);
      if (child) this.subagentNotification(notification, child);
      else this.notification(notification, diff);
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

  /** late command ends belong to their original turn, even after a familiar starts its next one. */
  private commandNotification(message: Notification): void {
    if (this.closing || this.closed) return;
    const { params, item } = message;
    if (!item && message.method !== 'turn/completed') return;
    if (item && item.type !== 'commandExecution') return;
    const threadId = stringValue.parse(params.threadId);
    if (threadId !== this.info.id && !this.subagents.has(threadId)) return;
    if (!item) {
      const completed = turnId.parse(params).turn.id;
      for (const entry of this.commands.values())
        if (entry.threadId === threadId && entry.turnId === completed)
          entry.ended = true;
      void this.readBackgroundCommands(threadId);
      return;
    }
    const id = `${threadId}/${stringValue.parse(item.id)}`;
    if (message.method === 'item/started') {
      this.commands.set(id, {
        threadId,
        turnId: stringValue.parse(params.turnId),
        ended: false,
      });
    } else {
      const command = this.commands.get(id)?.command;
      if (command) {
        const status = commandStatus.parse(item.status);
        this.options.onEvent({
          type: 'command',
          command: {
            ...command,
            status: status === 'completed' ? 'completed' : 'failed',
          },
        });
      }
      this.commands.delete(id);
    }
  }

  /** the native list includes foreground commands, so only ended turns can supply candidates. */
  private async readBackgroundCommands(threadId: string): Promise<void> {
    const candidates = [...this.commands].filter(
      ([, entry]) =>
        entry.threadId === threadId && entry.ended && !entry.command,
    );
    if (!candidates.length) return;
    try {
      const { data } = z
        .object({
          data: z.array(z.object({ itemId: z.string(), command: z.string() })),
        })
        .parse(
          await this.rpc.request('thread/backgroundTerminals/list', {
            threadId,
          }),
        );
      if (this.closing || this.closed) return;
      const listed = new Map(
        data.map(({ itemId, command }) => [`${threadId}/${itemId}`, command]),
      );
      for (const [id, entry] of candidates) {
        const description = listed.get(id);
        if (
          description === undefined ||
          this.commands.get(id) !== entry ||
          entry.command
        )
          continue;
        entry.command = { id, description, status: 'running' };
        this.options.onEvent({ type: 'command', command: entry.command });
      }
    } catch (error) {
      if (!this.closing && !this.closed)
        this.options.onEvent({
          type: 'notice',
          text: `Witch could not list Codex's background commands: ${errorMessage(error)}`,
        });
    }
  }

  private stopBackgroundCommands(): void {
    for (const { command } of this.commands.values())
      if (command)
        this.options.onEvent({
          type: 'command',
          command: { ...command, status: 'stopped' },
        });
    this.commands.clear();
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
  private subagentNotification(message: Notification, threadId: string): void {
    const subagent = this.subagents.get(threadId);
    const { params, item } = message;
    if (subagent && item) {
      if (subagent.run !== undefined && params.turnId !== subagent.run) return;
      const type = stringValue.parse(item.type);
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
      const { turn } = completedTurn.parse(params);
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
        this.turn?.messages.set(id, (this.turn.messages.get(id) ?? '') + text);
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
            this.turn?.messages.set(id, item.text);
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
          const images = itemImages(type, item);
          // Codex titles a user's command with its shell wrapper
          const command =
            item.source === 'userShell' ? this.turn?.command : undefined;
          this.options.onEvent({
            type: 'tool',
            id,
            title: command ?? itemTitle(type, item, this.options.cwd),
            // a change's diff comes before it applies and stays after it fails or is declined
            text: diff
              ? item.status === 'failed' || item.status === 'declined'
                ? `Patch ${item.status}`
                : ''
              : typeof item.aggregatedOutput === 'string'
                ? item.aggregatedOutput
                : type === 'commandExecution'
                  ? ''
                  : // image data shows as the image, not as base64 text
                    JSON.stringify(
                      item,
                      (_key, value: unknown) =>
                        typeof value === 'object' &&
                        value !== null &&
                        'type' in value &&
                        value.type === 'image' &&
                        imageContent.safeParse(value).success
                          ? { ...value, data: '…' }
                          : value,
                      2,
                    ),
            done: message.method === 'item/completed',
            cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
            ...(images.length ? { images } : {}),
            ...(diff ? { diff } : {}),
            ...(command === undefined ? {} : { shell: true }),
          });
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
        const turn = object.parse(data.turn);
        if (this.turn?.compaction && turn.id !== this.turn.id) break;
        if (!this.closing) void this.readCost();
        const status = stringValue.parse(turn.status);
        const error =
          turn.error == null ? undefined : object.parse(turn.error).message;
        const completed = turnId.safeParse(data).data?.turn.id;
        if (['completed', 'interrupted', 'failed'].includes(status))
          this.finish(
            status as TurnResult['status'],
            typeof error === 'string' ? error : undefined,
            completed,
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

  private finish(
    status: TurnResult['status'],
    error?: string,
    completedTurnId = this.turn?.id,
  ): void {
    const turn = this.turn;
    if (turn?.compaction) {
      if (turn.interrupted) status = 'interrupted';
      else if (status === 'completed' && !turn.compaction.completed) {
        status = 'failed';
        error = 'Codex ended compaction without confirming history replacement';
      }
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
      text: turn.compaction ? '' : [...turn.messages.values()].join('\n\n'),
      ...(error ? { error } : {}),
    });
  }
}
