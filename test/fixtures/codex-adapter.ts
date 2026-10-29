import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../../src/agents/codex.js';
import type {
  AgentEvent,
  AgentSession,
  CommandMark,
} from '../../src/agents/types.js';
import type { RpcMessage } from '../../src/agents/json-rpc.js';
import { until } from './within.js';
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
  let child: ChildProcessWithoutNullStreams;
  const adapter = new CodexAdapter(
    (_, directory, signal) =>
      (child = spawn(process.execPath, [codex, ...(mode ? [mode] : [])], {
        cwd: directory,
        stdio: 'pipe',
        signal,
      })),
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
  return { session, cwd, child: child! };
}

/** lets a held fixture event go, so a reverted guard can't hang cleanup. */
export async function close(session: AgentSession, cwd: string) {
  await writeFile(join(cwd, 'release'), 'yes');
  await session.close();
}

export async function appears(path: string) {
  await until(path, () =>
    access(path).then(
      () => true,
      () => false,
    ),
  );
}

export function settled(promise: Promise<unknown>) {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  return () => done;
}

export const commandFrame = (
  id: string,
  turnId = 'turn-1',
  threadId = 'native-thread',
  status = 'inProgress',
  exitCode = 0,
): RpcMessage => ({
  method: status === 'inProgress' ? 'item/started' : 'item/completed',
  params: {
    threadId,
    turnId,
    item: {
      type: 'commandExecution',
      id,
      command: `provisional ${id}`,
      source: 'agent',
      processId: null,
      cwd: '/fixture',
      status,
      aggregatedOutput: status === 'inProgress' ? null : 'finished\n',
      exitCode: status === 'inProgress' ? null : exitCode,
    },
  },
});
export const turnFrame = (
  id = 'turn-1',
  status = 'completed',
  threadId = 'native-thread',
): RpcMessage => ({
  method: status === 'inProgress' ? 'turn/started' : 'turn/completed',
  params: { threadId, turn: { id, status, error: null } },
});
export async function controlledFixture(mode = 'brews') {
  const events: AgentEvent[] = [];
  const context = await fixture((event) => events.push(event), {
    mode,
  });
  const { session, cwd } = context;
  let sequence = 0;
  const write = async (name: string, value: unknown) => {
    await writeFile(join(cwd, `${name}.next`), JSON.stringify(value));
    await rename(join(cwd, `${name}.next`), join(cwd, name));
  };
  const emit = async (...frames: RpcMessage[]) => {
    const index = ++sequence;
    const text = `fixture barrier ${index}`;
    await write(`events-${index}.json`, [
      ...frames,
      {
        method: 'error',
        params: { error: { message: text }, willRetry: true },
      },
    ]);
    await until(text, () =>
      events.some((event) => event.type === 'notice' && event.text === text),
    );
    await session.skills();
  };
  const reply = async (index: number, response: unknown, kind = 'list') => {
    await appears(join(cwd, `${kind}-${index}.json`));
    await write(`${kind}-reply-${index}.json`, response);
    await appears(join(cwd, `${kind}-replied-${index}`));
    await emit();
  };
  return {
    ...context,
    events,
    emit,
    reply,
    commands: () =>
      events.flatMap((e) => (e.type === 'command' ? [e.command] : [])),
  };
}
