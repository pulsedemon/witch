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

/** a subagent the native agent started; a later event with the same id replaces it. */
export interface Subagent {
  id: string;
  /** the subagent that started this one; absent when the main agent did. */
  parent?: string;
  name: string;
  /** its native type or role, empty when the agent reports none. */
  kind: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  /** the run this state belongs to; a running start under another run is a restart. */
  run?: string;
  /** its latest tool call, titled as the transcript titles one. */
  activity?: string;
  /** the tool calls it has made. */
  tools?: number;
  /** its latest message, which is its report once it ends. */
  report?: string;
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
    }
  | { type: 'request'; request: UserRequest }
  | { type: 'request-resolved'; id: string }
  | { type: 'info'; info: SessionInfo }
  | { type: 'usage'; usage: Usage }
  /** the native skill list changed; it replaces the one `skills()` gave. */
  | { type: 'skills'; skills: Skill[] }
  | { type: 'subagent'; subagent: Subagent }
  | { type: 'notice'; text: string };

export interface TurnResult {
  status: 'completed' | 'interrupted' | 'failed';
  text: string;
  error?: string;
}

export interface AgentSession {
  readonly info: SessionInfo;
  readonly usage: Usage;
  readonly closed: boolean;
  /** an adapter may ignore `refresh`. */
  models(refresh?: boolean): Promise<Model[]>;
  skills(): Promise<Skill[]>;
  /** `skill` runs that native skill with the prompt as its context. */
  send(prompt: string, skill?: SkillCall): Promise<TurnResult>;
  /** an omitted effort keeps the one in force; `null` resets it where the native agent can. */
  selectModel(model: string, effort?: string | null): Promise<void>;
  respond(id: string, response: UserResponse): void;
  /**
   * does nothing with no turn in flight. the session may close after an
   * interrupt, and the coordinator then reconnects with resume.
   */
  interrupt(): Promise<void>;
  close(): Promise<void>;
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
}

export interface AgentAdapter {
  id: string;
  label: string;
  connect(options: SessionOptions): Promise<AgentSession>;
}
