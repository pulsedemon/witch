import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../../src/agents/codex.js';
import type { readContextCatalog } from '../../src/agents/codex-compaction-policy.js';
import type {
  AgentEvent,
  AgentSession,
  CommandMark,
  SessionOptions,
} from '../../src/agents/types.js';
import type { RpcMessage } from '../../src/agents/json-rpc.js';
import { writeJson } from '../../src/persistence/json.js';
import { appears, until } from './within.js';
import { scratch } from './scratch.js';
import type { ControlBinding } from '../../src/persistence/control.js';
import type { CommandPrefixes } from '../../src/agents/tool-title.js';

const codex = fileURLToPath(new URL('codex.mjs', import.meta.url));

/** protocol-only fixtures omit the separate native model-window catalog. */
export const unreportedContextCatalog: typeof readContextCatalog =
  async () => ({ models: [] });

export async function fixture(
  onEvent: (event: AgentEvent) => void = () => {},
  {
    effort,
    resume,
    mode,
    signal,
    mark,
    familiarBinding,
    commandPrefixes,
    onClient,
    onAnswerProcess,
    model,
    automaticCompaction,
    configuration,
    contextCatalog,
  }: {
    effort?: string;
    resume?: string;
    mode?: string;
    signal?: AbortSignal;
    mark?: CommandMark;
    familiarBinding?: ControlBinding;
    commandPrefixes?: CommandPrefixes;
    onClient?: (message: RpcMessage) => void;
    onAnswerProcess?: SessionOptions['onAnswerProcess'];
    model?: string;
    automaticCompaction?: true;
    configuration?: Record<string, unknown>;
    contextCatalog?: typeof readContextCatalog;
  } = {},
) {
  const cwd = await scratch('witch-codex-');

  if (configuration) await writeJson(join(cwd, 'config.json'), configuration);

  let child: ChildProcessWithoutNullStreams;

  const adapter = new CodexAdapter((_, directory, signal) => {
    child = spawn(process.execPath, [codex, ...(mode ? [mode] : [])], {
      cwd: directory,
      stdio: 'pipe',
      signal,
    });

    if (onClient) {
      const write = child.stdin.write;

      child.stdin.write = (...args) => {
        onClient(JSON.parse(args[0] as string) as RpcMessage);

        return Reflect.apply(write, child.stdin, args) as boolean;
      };
    }

    return child;
  }, contextCatalog);

  const session = await adapter.connect({
    cwd,
    executable: 'codex',
    model,
    automaticCompaction,
    effort,
    resume,
    signal,
    memoryDirectories: ['/shared/global', '/shared/project'],
    onEvent,
    onProcess: async () => {},
    onAnswerProcess,
    mark,
    familiarBinding,
    commandPrefixes,
  });

  return { session, cwd, child: child! };
}

/** lets a held fixture event go, so a reverted guard can't hang cleanup. */
export async function close(session: AgentSession, cwd: string) {
  await writeFile(join(cwd, 'release'), 'yes');

  await session.close();
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

/** writes each batch of native frames as the fixture's next events file, then waits until its barrier notice is `noticed`. */
export function frameWriter(
  cwd: string,
  noticed: (text: string) => boolean,
): (...frames: RpcMessage[]) => Promise<void> {
  let sequence = 0;

  return async (...frames) => {
    const index = ++sequence;

    const text = `fixture barrier ${index}`;

    await writeJson(join(cwd, `events-${index}.json`), [
      ...frames,
      {
        method: 'error',
        params: { error: { message: text }, willRetry: true },
      },
    ]);

    await until(text, () => noticed(text));
  };
}

export async function controlledFixture(
  mode = 'brews',
  commandPrefixes?: CommandPrefixes,
) {
  const events: AgentEvent[] = [];

  const context = await fixture((event) => events.push(event), {
    mode,
    commandPrefixes,
  });

  const { session, cwd } = context;

  const write = (name: string, value: unknown) =>
    writeJson(join(cwd, name), value);

  const frames = frameWriter(cwd, (text) =>
    events.some((event) => event.type === 'notice' && event.text === text),
  );

  const emit = async (...batch: RpcMessage[]) => {
    await frames(...batch);

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
