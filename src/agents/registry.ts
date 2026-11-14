import { findExecutable } from './executable.js';
import { ClaudeAdapter } from './claude/claude.js';
import { CodexAdapter } from './codex/codex.js';
import type { AgentAdapter } from './types.js';

export interface AgentRegistration {
  adapter: AgentAdapter;
  executable?: string;
}

export async function installedAgents(): Promise<AgentRegistration[]> {
  return Promise.all(
    [new CodexAdapter(), new ClaudeAdapter()].map(async (adapter) => ({
      adapter,
      executable: findExecutable(adapter.id),
    })),
  );
}
