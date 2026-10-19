export interface Model {
  id: string;
  label: string;
  efforts: string[];
}

/** a native skill the composer offers after `/`, run by sending `/name args`. */
export interface Skill {
  name: string;
  description: string;
  argumentHint?: string;
}

/** a `/name args` prompt the coordinator matched to a listed skill. */
export interface SkillCall {
  name: string;
  args: string;
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
  /** the session's estimated cost in US dollars. */
  cost?: number;
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

export type TaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** a subagent the native agent started; a later event with the same id replaces it. */
export interface Subagent {
  id: string;
  /** the subagent that started this one; absent when the main agent did. */
  parent?: string;
  name: string;
  /** its native type or role, empty when the agent reports none. */
  kind: string;
  status: TaskStatus;
  /** the run this state belongs to; a running start under another run is a restart. */
  run?: string;
  /** its latest tool call, titled as the transcript titles one. */
  activity?: string;
  /** the tool calls it has made. */
  tools?: number;
  /** its latest message, which is its report once it ends. */
  report?: string;
}

/** a command the native agent left running in the background; a running event starts it, a later one with another status ends it, and a repeated start changes nothing. */
export interface BackgroundCommand {
  id: string;
  /** what the agent said it's for, or the command when it said nothing. */
  description: string;
  status: TaskStatus;
}

export interface Question {
  id: string;
  title: string;
  options: string[];
  multiple?: boolean;
  secret?: boolean;
}

export interface UserRequest {
  id: string;
  kind: 'approval' | 'question' | 'elicitation';
  title: string;
  detail: string;
  questions?: Question[];
  schema?: Record<string, unknown>;
  url?: string;
}

export interface UserResponse {
  decision: 'accept' | 'decline' | 'cancel';
  answers?: Record<string, string[]>;
  content?: Record<string, unknown>;
}

export type AgentEvent =
  | { type: 'text'; id: string; text: string; replace?: boolean }
  | {
      type: 'tool';
      id: string;
      title: string;
      text: string;
      done: boolean;
      cwd?: string;
      append?: boolean;
      /** image paths or `data:` URLs the tool returned, kept out of `text`. */
      images?: string[];
      /** the user's `!` command, which shows expanded. */
      shell?: boolean;
    }
  | { type: 'request'; request: UserRequest }
  | { type: 'request-resolved'; id: string }
  | { type: 'info'; info: SessionInfo }
  | { type: 'usage'; usage: Usage }
  /** the native skill list changed; it replaces the one `skills()` gave. */
  | { type: 'skills'; skills: Skill[] }
  | { type: 'subagent'; subagent: Subagent }
  | { type: 'command'; command: BackgroundCommand }
  | { type: 'notice'; text: string };

export interface TurnResult {
  status: 'completed' | 'interrupted' | 'failed';
  text: string;
  error?: string;
  /** prompts steered into the turn that the agent reports, when interrupted, it will never read. */
  unread?: string[];
}

export interface AgentSession {
  readonly info: SessionInfo;
  readonly usage: Usage;
  readonly closed: boolean;
  /**
   * the turn in flight has replied and stays open only while familiars or workflows run, as Claude Code's does. it then runs a
   * steered spell, sent as `/name args`, as a turn of its own, and takes a command or a model change.
   */
  readonly replied: boolean;
  /** an adapter may ignore `refresh`. */
  models(refresh?: boolean): Promise<Model[]>;
  skills(): Promise<Skill[]>;
  /** `skill` runs that native skill with the prompt as its context. */
  send(prompt: string, skill?: SkillCall): Promise<TurnResult>;
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
   * its reply.
   */
  steer(prompt: string, options?: { command?: string }): Promise<boolean>;
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
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

/** lets /jobs tell the processes an agent's commands leave under launchd from any other's. */
export interface CommandMark {
  /** entries for every command's environment. */
  environment: Record<string, string>;
  /** a script a shell runs ahead of each command, which reports the shell's pid and exports `environment`. */
  script?: string;
}

export interface SessionOptions {
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
  /**
   * an adapter that runs a `!` command itself reports its shell when it starts and `undefined` once it ends. the end
   * comes once the start's report resolves, and none comes when it rejects.
   */
  onShell?(pid: number | undefined): Promise<void>;
  mark?: CommandMark;
}

export interface AgentAdapter {
  id: string;
  label: string;
  connect(options: SessionOptions): Promise<AgentSession>;
}
