import { setTimeout as delay } from 'node:timers/promises';
import { AbortError, query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options,
  Query,
  SDKUserMessage,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { InputQueue } from './input-queue.js';
import { errorMessage } from '../errors.js';
import { watchChild, withTail, type ChildExit } from './stderr.js';
import type { ModelDiscoveryOptions } from './types.js';

export type ClaudeLaunch = (
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

/** a side query reads native state without a session record, hooks or MCP servers. */
export const promptless = {
  settingSources: ['user', 'project', 'local'],
  persistSession: false,
  settings: { disableAllHooks: true },
  strictMcpConfig: true,
  mcpServers: {},
} satisfies Options;

/** `env` without `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_*_MODEL`, which can pin an alias to an older model. */
export function withoutModelPins(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        name !== 'ANTHROPIC_MODEL' &&
        !/^ANTHROPIC_DEFAULT_\w+_MODEL$/.test(name),
    ),
  );
}

/** a query that sends no prompt; the caller owns `input` and `abort`, and `overrides` replace the promptless defaults. */
export function promptlessQuery(
  start: ClaudeLaunch,
  { cwd, executable }: Pick<ModelDiscoveryOptions, 'cwd' | 'executable'>,
  input: InputQueue<SDKUserMessage>,
  abort: AbortController,
  onSpawn: (child: ChildProcessWithoutNullStreams) => void,
  overrides: Options = {},
): Query {
  return query({
    prompt: input,
    options: {
      cwd,
      pathToClaudeCodeExecutable: executable,
      abortController: abort,
      ...promptless,
      ...overrides,
      spawnClaudeCodeProcess: (settings) => {
        const child = start(settings);
        onSpawn(child);
        return child;
      },
    },
  });
}

/** bounds stderr collection when startup fails while the CLI is still alive. */
export async function startupFailure(
  error: unknown,
  child: ChildExit | undefined,
): Promise<Error> {
  await Promise.race([child?.closed, delay(1000)]);
  const failure = new Error(
    withTail(errorMessage(error), child?.tail() ?? ''),
    { cause: error },
  );
  if (error instanceof AbortError) failure.name = 'AbortError';
  return failure;
}

/** a query that sends no prompt, for reading native state; joins its child's exit before settling. */
export async function sideQuery<T>(
  start: ClaudeLaunch,
  options: ModelDiscoveryOptions,
  read: (query: Query) => Promise<T>,
  overrides: Options = {},
): Promise<T> {
  const input = new InputQueue<SDKUserMessage>();
  const abort = new AbortController();
  const cancel = () => abort.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let child: ChildExit | undefined;
  let side: Query | undefined;
  let reading: Promise<void> | undefined;
  try {
    side = promptlessQuery(
      start,
      options,
      input,
      abort,
      (process) => {
        child = watchChild(process);
      },
      overrides,
    );
    const stream = side;
    reading = (async () => {
      for await (const message of stream) void message;
    })().catch(() => {});
    return await read(side);
  } catch (error) {
    throw await startupFailure(error, child);
  } finally {
    input.close();
    side?.close();
    await reading;
    await child?.closed;
    options.signal?.removeEventListener('abort', cancel);
  }
}
