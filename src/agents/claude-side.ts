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
import { errorMessage, watchChild, withTail } from './stderr.js';
import type { ChildExit } from './stderr.js';
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
    side = query({
      prompt: input,
      options: {
        cwd: options.cwd,
        pathToClaudeCodeExecutable: options.executable,
        abortController: abort,
        ...promptless,
        ...overrides,
        spawnClaudeCodeProcess: (settings) => {
          const process = start(settings);
          child = watchChild(process);
          return process;
        },
      },
    });
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
