import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import type { AgentAdapter } from './types.js';

export interface AgentRegistration {
  adapter: AgentAdapter;
  executable?: string;
}

async function findExecutable(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const executable = join(directory, name);
    if (
      await access(executable, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return executable;
  }
  return undefined;
}

export async function installedAgents(): Promise<AgentRegistration[]> {
  return Promise.all(
    [new CodexAdapter(), new ClaudeAdapter()].map(async (adapter) => ({
      adapter,
      executable: await findExecutable(adapter.id),
    })),
  );
}
