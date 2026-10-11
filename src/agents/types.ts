export type AgentId = string;

export interface Model {
  id: string;
  label: string;
  description: string;
  efforts: string[];
}

export interface SessionInfo {
  id: string;
  agent: AgentId;
  cwd: string;
  model: string;
  permissionMode: string;
  hasHistory: boolean;
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
  | { type: 'notice'; text: string };

export interface TurnResult {
  status: 'completed' | 'interrupted' | 'failed';
  text: string;
  error?: string;
}

export interface AgentSession {
  readonly info: SessionInfo;
  readonly closed: boolean;
  models(refresh?: boolean): Promise<Model[]>;
  send(prompt: string): Promise<TurnResult>;
  selectModel(model: string, effort?: string): Promise<void>;
  respond(id: string, response: UserResponse): void;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface SessionOptions {
  cwd: string;
  executable: string;
  resume?: string;
  model?: string;
  effort?: string;
  memoryDirectories: string[];
  signal?: AbortSignal;
  onEvent(event: AgentEvent): void;
  onProcess(pid: number | undefined): Promise<void>;
}

export interface AgentAdapter {
  id: AgentId;
  label: string;
  connect(options: SessionOptions): Promise<AgentSession>;
}
