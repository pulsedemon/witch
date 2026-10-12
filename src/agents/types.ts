export interface Model {
  id: string;
  label: string;
  description: string;
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
  cwd: string;
  model: string;
  permissionMode: string;
  hasHistory: boolean;
  /** the requested effort in force; undefined when none was requested. */
  effort?: string;
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
    }
  | { type: 'request'; request: UserRequest }
  | { type: 'request-resolved'; id: string }
  | { type: 'info'; info: SessionInfo }
  /** the native skill list changed; it replaces the one `skills()` gave. */
  | { type: 'skills'; skills: Skill[] }
  | { type: 'notice'; text: string };

export interface TurnResult {
  status: 'completed' | 'interrupted' | 'failed';
  text: string;
  error?: string;
}

export interface AgentSession {
  readonly info: SessionInfo;
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
