import { z } from 'zod';
import { isAbsolute } from 'node:path';
import type { ControlBinding } from '../persistence/control.js';
import type { FamiliarAction, FamiliarOutcome } from './familiar-report.js';
import type { CommandPrefixes } from './tool-title.js';

export interface Model {
  id: string;
  label: string;
  efforts: string[];
}

/** a native skill or command run by sending `/name args`; the composer offers it after `/` unless it is `builtin`. */
export interface Skill {
  name: string;
  description: string;
  argumentHint?: string;
  /** Claude Code's own command, which `/name args` runs natively but the composer doesn't offer. */
  builtin?: true;
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
  permissionMode: string;
  hasHistory: boolean;
  /** the requested effort in force; undefined when none was requested. */
  effort?: string;
  /** the effort the agent reports in force, its own default included. */
  nativeEffort?: string;
}

/** a session's usage as its agent reports it; each part is absent until reported. */
export interface Usage {
  /** percent of the context window in use. */
  context?: number;
  /** the native agent's context capacity in tokens. */
  contextWindow?: number;
  /** the account's usage limits, shortest window first. */
  limits?: Limit[];
  /** lines the session's edits added and removed. */
  lines?: { added: number; removed: number };
}

export interface Limit {
  /** the window's length, such as `5H` or `7D`. */
  window: string;
  percent: number;
  /** in epoch seconds. */
  resetsAt?: number;
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
  /** a transient notice is a diagnostic of this connection, shown but not saved. */
  | { type: 'notice'; text: string; transient?: boolean };

export interface TurnResult {
  status: 'completed' | 'interrupted' | 'failed';
  text: string;
  error?: string;
  /** prompts steered into the turn that the agent reports, when interrupted, it will never read. */
  unread?: string[];
  /** already executed command records to include as context with the next prompt, never to enqueue. */
  unreadContext?: string[];
  /** the input passed to send() is proven unwritten; absent when delivery is uncertain. */
  inputUnsent?: boolean;
}

export interface AgentStopOptions {
  /** absolute performance.now() deadline, shared by interruption and closure. */
  deadline?: number;
  /** retains the runtime's restart teardown policy. */
  restart?: boolean;
}

export interface AgentSession {
  familiar?: {
    runtime: 'claude' | 'codex';
    report(action: FamiliarAction, deadline: number): Promise<FamiliarOutcome>;
  };
  readonly info: SessionInfo;
  readonly usage: Usage;
  readonly closed: boolean;
  /** the turn in flight has replied and stays open only while familiars or workflows run, as Claude Code's does. it then takes a command or a model change. */
  readonly replied: boolean;
  /** an adapter may ignore `refresh`. */
  models(refresh?: boolean): Promise<Model[]>;
  skills(): Promise<Skill[]>;
  /** current native context percentage, or undefined when no usable sample is available. */
  contextUsage(): Promise<number | undefined>;
  /** replaces native history in place; resolves after native completion, independently of replacement events. */
  compact(): Promise<TurnResult>;
  /** generated context must not replace the user's request in native authorization evidence. */
  send(
    prompt: string,
    skill?: SkillCall,
    context?: string,
  ): Promise<TurnResult>;
  /**
   * runs a command the user typed after `!`, unsandboxed in the session's directory, and gives it and its output to
   * the agent without a reply. its output streams as tool events, the first marked `shell`.
   */
  shell(command: string): Promise<TurnResult>;
  /**
   * adds the prompt to the turn in flight, which the agent reads at its next
   * tool step or before the turn ends; false when no turn can take it, and
   * false while a shell command runs. it never refuses while `replied`, and
   * `command` is passed only then: the command runs first, as `shell` runs
   * one, and holds the turn open, and once it completes the prompt goes as
   * its reply. with `skill`, the prompt is that command, run natively: Claude
   * runs it once the current native turn ends, within this turn, and Codex,
   * which expands a skill only at a turn's start, refuses it.
   */
  steer(
    prompt: string,
    options?: { command?: string; skill?: SkillCall },
  ): Promise<boolean>;
  /**
   * an omitted effort keeps the one in force; `null` resets it where the native agent can. refused during a turn
   * unless it has `replied`.
   */
  selectModel(model: string, effort?: string | null): Promise<void>;
  respond(id: string, response: UserResponse): void;
  /**
   * does nothing with no turn or shell command in flight. the session may close
   * after an interrupt, and the coordinator then reconnects with resume.
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
  familiarBinding?: ControlBinding;
  commandPrefixes?: CommandPrefixes;
  cwd: string;
  executable: string;
  resume?: string;
  model?: string;
  /** the effort to start with; omitted keeps the native default. */
  effort?: string;
  memoryDirectories: string[];
  signal?: AbortSignal;
  onEvent(event: AgentEvent): void;
  onProcess(pid: number | undefined): Promise<void>;
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
  /** cancellation rejects with an `Error` named `AbortError`. */
  connect(options: SessionOptions): Promise<AgentSession>;
}
