import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../../src/agents/codex.js';
import type {
  AgentEvent,
  AgentSession,
  CommandMark,
} from '../../src/agents/types.js';
import { scratch } from './scratch.js';
import type { ControlBinding } from '../../src/persistence/control.js';

const codex = fileURLToPath(new URL('codex.mjs', import.meta.url));

export async function fixture(
  onEvent: (event: AgentEvent) => void = () => {},
  {
    effort,
    resume,
    mode,
    signal,
    mark,
    familiarBinding,
  }: {
    effort?: string;
    resume?: string;
    mode?: string;
    signal?: AbortSignal;
    mark?: CommandMark;
    familiarBinding?: ControlBinding;
  } = {},
) {
  const cwd = await scratch('witch-codex-');
  const adapter = new CodexAdapter((_, directory, signal) =>
    spawn(process.execPath, [codex, ...(mode ? [mode] : [])], {
      cwd: directory,
      stdio: 'pipe',
      signal,
    }),
  );
  const session = await adapter.connect({
    cwd,
    executable: 'codex',
    effort,
    resume,
    signal,
    memoryDirectories: ['/shared/global', '/shared/project'],
    onEvent,
    onProcess: async () => {},
    mark,
    familiarBinding,
  });
  return { session, cwd };
}

/** lets a held fixture event go, so a reverted guard can't hang cleanup. */
export async function close(session: AgentSession, cwd: string) {
  await writeFile(join(cwd, 'release'), 'yes');
  await session.close();
}
