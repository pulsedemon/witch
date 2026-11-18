import { z } from 'zod';
import { isAbsolute } from 'node:path';
import type { ControlBinding } from '../persistence/control.js';
import type { FamiliarAction, FamiliarOutcome } from './familiar-report.js';
import type { CommandPrefixes } from './tool-title.js';

export const contextWindowChoiceSchema = z.enum(['default', 'maximum']);

export type ContextWindowChoice = z.infer<typeof contextWindowChoiceSchema>;

export interface Model {
  id: string;
  label: string;
  efforts: string[];
  contextWindows?: { default: number; maximum: number };
}

/** a native skill or command run by sending `/name args`; the composer offers it after `/` unless it is `builtin`. */
export interface Skill {
  name: string;
  description: string;
  argumentHint?: string;
  /** Claude Code's own command, which `/name args` runs natively but the composer doesn't offer. */
  builtin?: true;
  /** other names Claude Code runs a built-in under, such as `cost` for `usage`. */
  aliases?: string[];
}

/** a `/name args` prompt the coordinator matched to a listed skill or native command. */
export interface SkillCall {
  name: string;
  args: string;
  builtin?: true;
}

/** one spell cast; the id is native and names it across replays and reconnects. */
export interface Cast {
  id: string;
  name: string;
}

export interface SessionInfo {
  id: string;
  agent: string;
  model: string;
  /** the resolved model before the session's active refusal fallback. */
  modelBeforeFallback?: string;
  permissionMode: string;
  permissionProfile?: string;
  hasHistory: boolean;
  /** the requested effort in force; undefined when none was requested. */
  effort?: string;
  contextWindow?: ContextWindowChoice;
  /** the effort the agent reports in force, its own default included. */
  nativeEffort?: string;
}

/** a session's usage as its agent reports it; each part is absent until reported. */
export interface Usage {
  /** percent of the context window in use. */
  context?: number;
  /** the native agent's context capacity in tokens. */
  contextWindow?: number;
  /** the same model's 1M-context id while `contextWindow` is below 1M. */
  longContext?: string;
  account?: AccountReading;
  /** lines the session's edits added and removed. */
  lines?: { added: number; removed: number };
}

export interface Limit {
  /** the window's length, such as `5H` or `7D`. */
  window: string;
  percent: number;
  /** in epoch seconds. */
  resetsAt?: number;
  /** epoch ms when the adapter last received this window's value; a report that omits the window keeps it. */
  observedAt: number;
}

/** a weekly window that blocks only the models its native label names. */
export interface ModelLimit extends Limit {
  /** the runtime's label for those models, such as `Fable`. */
  model: string;
}

/** the native limit behind a confirmed exhaustion; a field the runtime didn't report is absent. */
export interface ExhaustedLimit {
  /** the window's length, such as `5H` or `7D`. */
  window?: string;
  /** the runtime's label for the only models it blocks. */
  model?: string;
  /** in epoch seconds. */
  resetsAt?: number;
  /** why account credits could not cover the request, in the runtime's words. */
  credits?: string;
}

export type Funding = (
  | {
      kind: 'credits';
      balance: string | null;
      unlimited: boolean;
      available: boolean;
    }
  | {
      kind: 'extra-usage';
      enabled: boolean;
      used: number | null;
      limit: number | null;
      currency: string | null;
      /** native currency exponent; absence retains the reported minor units. */
      decimalPlaces?: number | null;
    }
  | { kind: 'unavailable' }
) & {
  /** source observation time, conservatively bounded when native caching hides its exact age. */
  observedAt: number;
};

export interface AccountReading {
  limits: readonly Limit[];
  /** kept apart from `limits`, which block every model. */
  modelLimits?: readonly ModelLimit[];
  funding?: Funding;
  /** permission to spend account credits, independent of model access. */
  creditAccess?: {
    state: 'available' | 'unavailable' | 'unknown';
    observedAt: number;
  };
  /** native account and quota identity, when reported. */
  identity?: string;
}

export const taskStatuses = [
  'running',
  'completed',
  'failed',
  'stopped',
] as const;

export type TaskStatus = (typeof taskStatuses)[number];

/** a subagent the native agent started; a later event with the same id replaces it. */
export interface Subagent {
  id: string;
  /** the subagent that started this one; absent when the main agent did. */
  parent?: string;
  name: string;
  /** its native type or role, empty when the agent reports none. */
  kind: string;
  runtime?: string;
  model?: string;
  status: TaskStatus;
  /** the run this state belongs to; a running start under another run is a restart. */
  run?: string;
  /** its latest tool call, titled as the transcript titles one. */
  activity?: string;
  /** the tool calls it has made. */
  tools?: number;
  /** its latest message, which is its report once it ends. */
  report?: string;
  /** the transient notices its native session posted, oldest first. */
  notices?: string[];
  /** the spells it has cast, oldest first. */
  spells?: Cast[];
}

/** a command the native agent left running in the background; a running event starts it, a later one with another status ends it, and a repeated start changes nothing. */
export interface BackgroundCommand {
  id: string;
  familiar?: string;
  /** what the agent said it's for, or the command when it said nothing. */
  description: string;
  status: TaskStatus;
}

/** a run of lines from a unified diff, each starting with ' ', '+' or '-', numbered on each side from its start. */
const hunkSchema = z.object({
  oldStart: z.number(),
  newStart: z.number(),
  lines: z.array(z.string()),
});

export type Hunk = z.infer<typeof hunkSchema>;

/** a file a tool changed. */
const fileDiffSchema = z.object({
  /** absolute. */
  path: z.string().refine(isAbsolute, 'File paths must be absolute.'),
  kind: z.enum(['add', 'delete', 'update']),
  /** where an update moved the file. */
  movePath: z.string().optional(),
  hunks: z.array(hunkSchema),
  /** set when the lines were left out, with Git's counts, or `'binary'`. */
  unshown: z
    .union([
      z.object({ added: z.number(), removed: z.number() }),
      z.literal('binary'),
    ])
    .optional(),
});

export type FileDiff = z.infer<typeof fileDiffSchema>;

const questionSchema = z.object({
  id: z.string(),
  title: z.string(),
  options: z.array(z.string()),
  multiple: z.boolean().optional(),
  secret: z.boolean().optional(),
});

export type Question = z.infer<typeof questionSchema>;

export const userRequestSchema = z.object({
  id: z.string(),
  kind: z.enum(['approval', 'question', 'elicitation']),
  title: z.string(),
  detail: z.string(),
  diff: z.array(fileDiffSchema).optional(),
  questions: z.array(questionSchema).optional(),
  /** the native question already returned; its answer continues through normal prompt delivery. */
  replyAsPrompt: z.boolean().optional(),
  /** the adapter resolves this request explicitly; settling a Witch turn keeps it. */
  survivesTurn: z.boolean().optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
  url: z.string().optional(),
});

export type UserRequest = z.infer<typeof userRequestSchema>;

export const userResponseSchema = z.object({
  decision: z.enum(['accept', 'decline', 'cancel']),
  answers: z.record(z.string(), z.array(z.string())).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
});

export type UserResponse = z.infer<typeof userResponseSchema>;

export type AgentEvent =
  | { type: 'text'; id: string; text: string; replace?: boolean }
  /** the runtime withdrew the output of these earlier text and tool events; an id it never sent is ignored. */
  | { type: 'retracted'; ids: string[] }
  | {
      type: 'tool';
      id: string;
      title: string;
      /** the file path `title` shows, so its row links the path whole. */
      path?: string;
      /** the complete label, including the native name or original command, shown on expansion. */
      expandedTitle?: string;
      singleLine?: true;
      text: string;
      done: boolean;
      cwd?: string;
      append?: boolean;
      /** image paths or `data:` URLs the tool returned, kept out of `text`. */
      images?: string[];
      /** the files the tool changed, drawn below its text. */
      diff?: FileDiff[];
      /** the user's `!` command, which shows expanded. */
      shell?: boolean;
      /** the call failed or was declined; set with `done`. */
      failed?: true;
      /** the call ran a shell command, which can change files it doesn't report. */
      command?: true;
    }
  | { type: 'request'; request: UserRequest }
  | { type: 'request-resolved'; id: string }
  | { type: 'closed' }
  | { type: 'compacted' }
  | { type: 'info'; info: SessionInfo }
  | { type: 'usage'; usage: Usage }
  /** the native skill list changed; it replaces the one `skills()` gave. */
  | { type: 'skills'; skills: Skill[] }
  | { type: 'spell'; cast: Cast }
  | { type: 'subagent'; subagent: Subagent }
  | { type: 'command'; command: BackgroundCommand }
  /** the native agent reports whether it runs, which Claude Code also does on its own between turns. */
  | { type: 'running'; running: boolean }
  /** the agent itself, not a familiar, reported reasoning just now; its content never travels. */
  | { type: 'reasoned' }
  /** confirmed exhaustion in a native continuation outside the dispatched turn. */
  | { type: 'exhausted'; limit?: ExhaustedLimit }
  /** a transient notice is a diagnostic of this connection, shown but not saved. */
  | { type: 'notice'; text: string; transient?: boolean };

export interface TurnResult {
  status: 'completed' | 'interrupted' | 'failed';
  text: string;
  error?: string;
  /** steered prompts the agent will never read, reported on interruption or a failed turn. */
  unread?: string[];
  /** already executed command records to include as context with the next prompt, never to enqueue. */
  unreadContext?: string[];
  /** the input passed to send() is proven unwritten; absent when delivery is uncertain. */
  inputUnsent?: boolean;
  /** the input passed to send() was written, but the agent reports it never read it. */
  inputUnread?: true;
  /** the adapter confirmed native usage exhaustion. */
  exhausted?: true;
  /** set with `exhausted` when the adapter knows which limit ran out. */
  limit?: ExhaustedLimit;
}

export interface AgentStopOptions {
  /** absolute performance.now() deadline, shared by interruption and closure. */
  deadline?: number;
  /** retains the runtime's restart teardown policy. */
  restart?: boolean;
}

export interface AnswerInput {
  outputSchema: Record<string, unknown>;
  requestFile: string;
}

type TurnPurpose = 'user' | 'peer-answer' | 'pr-review' | 'pr-repair';

export interface SendOptions {
  skill?: SkillCall;
  context?: string;
  purpose?: TurnPurpose;
  answer?: AnswerInput;
  images?: readonly string[];
}

export interface AgentSession {
  familiar?: {
    report(action: FamiliarAction, deadline: number): Promise<FamiliarOutcome>;
  };
  readonly info: SessionInfo;
  readonly usage: Usage;
  /** reads the account again, joining a read already in flight; the result arrives as a `usage` event. */
  readAccountUsage?(): Promise<void>;

  readonly closed: boolean;
  /** the turn in flight has replied and stays open only while familiars or workflows run, as Claude Code's does. it then takes a command or a model change. */
  readonly replied: boolean;
  /** an adapter may ignore `refresh`. */
  models(refresh?: boolean): Promise<Model[]>;

  skills(): Promise<Skill[]>;

  /** current native context percentage, or undefined when no usable sample is available. */
  contextUsage(): Promise<number | undefined>;

  /** supplies context through a native hook that runs before post-compaction inference. */
  restoreCompactionContext?(
    read: () => Promise<string | undefined>,
  ): () => void;

  /** replaces native history in place; resolves after native completion, independently of replacement events. */
  compact(): Promise<TurnResult>;

  /** queues native compaction within an ordinary turn without interrupting it; undefined refuses delivery. */
  compactDuringTurn?(): Promise<TurnResult> | undefined;

  /**
   * generated context never replaces the user's request in native authorization evidence; an automatic prompt is
   * Witch's instruction for a turn with no new user request. `images` are absolute paths of prepared PNG or JPEG files.
   */
  send(prompt: string, options?: SendOptions): Promise<TurnResult>;

  /**
   * runs a command the user typed after `!`, unsandboxed in the session's directory, and gives it and its output to
   * the agent without a reply. its output streams as tool events, the first marked `shell`.
   */
  shell(command: string): Promise<TurnResult>;

  /**
   * adds the prompt to the turn in flight, which the agent reads at its next
   * tool step or before the turn ends; false when no turn can take it, when
   * its images can't be read, and while a shell command runs. otherwise it
   * never refuses while `replied`, and `command` is passed only then: the
   * command runs first, as `shell` runs one, and holds the turn open, and
   * once it completes the prompt goes as its reply. with `skill`, the prompt
   * is that command, run natively: Claude runs it once the current native
   * turn ends, within this turn, and Codex, which expands a skill only at a
   * turn's start, refuses it.
   * `contextOnly` never returns as unread user input; its owner supplies fresh
   * context after interruption.
   */
  steer(
    prompt: string,
    options?: {
      command?: string;
      skill?: SkillCall;
      contextOnly?: true;
      images?: readonly string[];
    },
  ): Promise<boolean>;

  /**
   * an omitted effort or window choice keeps the one in force; `null` resets effort where the native agent can.
   * refused during a turn unless it has `replied`.
   */
  selectModel(
    model: string,
    effort?: string | null,
    contextWindow?: ContextWindowChoice,
  ): Promise<void>;

  /** refuses a new choice the runtime would accept now and fail at the next turn; restoring a model the session already ran skips it. */
  checkModel?(model: string): Promise<void>;

  respond(id: string, response: UserResponse): void;

  /**
   * stops the active turn or shell command and disables automatic continuation of native background work.
   * the session may close afterward; the coordinator then reconnects with resume.
   */
  interrupt(options?: AgentStopOptions): Promise<void>;

  /** transfers unsent command records to the conversation on disconnect; valid after close. */
  takeUnreadContext?(): string[];

  close(options?: AgentStopOptions): Promise<void>;
}

/** lets /jobs tell the processes an agent's commands leave under launchd from any other's. */
export interface CommandMark {
  /** entries for every command's environment. */
  environment: Record<string, string>;
  /** a script a shell runs ahead of each command, which reports the shell's pid and exports `environment`. */
  script?: string;
}

export interface SessionOptions {
  answer?: AnswerInput & {
    permissionProfile?: string;
  };
  familiarBinding?: ControlBinding;
  commandPrefixes?: CommandPrefixes;
  cwd: string;
  executable: string;
  resume?: string;
  /** a saved fallback and its origin, reconciled with native initialization. */
  resumedModel?: Pick<SessionInfo, 'model' | 'modelBeforeFallback'>;
  model?: string;
  contextWindow?: ContextWindowChoice;
  /** the effort to start with; omitted keeps the native default. */
  effort?: string;
  memoryDirectories: string[];
  /** owned conversations use Witch's policy; isolated probes and answers retain native defaults. */
  automaticCompaction?: true;
  /** Codex only: starts the thread with no MCP server and fails if Codex still exposes one. */
  withoutMcp?: boolean;
  signal?: AbortSignal;
  onEvent(event: AgentEvent): void;

  onProcess(pid: number | undefined): Promise<void>;

  onAnswerProcess?(pid: number | undefined): Promise<void>;

  /** the end report follows successful registration and closure of the separate usage process. */
  onUsageProcess?(pid: number | undefined): Promise<void>;

  /**
   * an adapter that runs a `!` command itself reports its shell when it starts and `undefined` once it ends. the end
   * comes once the start's report resolves, and none comes when it rejects.
   */
  onShell?(pid: number | undefined): Promise<void>;
  mark?: CommandMark;
}

export type ModelDiscoveryOptions = Pick<
  SessionOptions,
  'cwd' | 'executable' | 'signal'
>;

export interface AgentAdapter {
  id: string;
  label: string;
  /** discovers the native catalog without a conversation; joins child shutdown before settling. */
  models(options: ModelDiscoveryOptions): Promise<Model[]>;

  /** reads native account usage without a conversation; omitted observations keep their previous timestamp. */
  accountUsage(
    options: ModelDiscoveryOptions,
    previous: AccountReading,
  ): Promise<AccountReading>;

  /** each family alias's current concrete model, read past native model pins. */
  latest?(options: ModelDiscoveryOptions): Promise<Record<string, string>>;

  /** cancellation rejects with an `Error` named `AbortError`. */
  connect(options: SessionOptions): Promise<AgentSession>;
}
