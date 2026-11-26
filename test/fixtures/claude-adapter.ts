import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJson } from '../../src/persistence/json.js';
import { ClaudeAdapter } from '../../src/agents/claude/adapter.js';
import type { AgentEvent, SessionOptions } from '../../src/agents/types.js';
import { scratch } from './scratch.js';
import { until } from './within.js';

const claude = fileURLToPath(new URL('./claude.mjs', import.meta.url));

export async function launcher(
  mode?: string,
  usageMode = 'background',
  { sessionState = true } = {},
) {
  const cwd = await scratch('witch-claude-');
  const children: ChildProcessWithoutNullStreams[] = [];
  const args: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];

  const sideChildren: {
    child: ChildProcessWithoutNullStreams;
    cwd: string;
    args: string[];
    env: NodeJS.ProcessEnv;
  }[] = [];

  const adapter = new ClaudeAdapter((options) => {
    // side queries include the latest-model read, which leaves every settings file out
    if (
      options.args.includes('--no-session-persistence') &&
      !options.args.includes('--tools=Read,Grep,Glob')
    ) {
      const directory = join(cwd, `usage-${sideChildren.length}`);
      mkdirSync(directory);

      const executable =
        usageMode === 'spawn-error'
          ? join(directory, 'missing-claude')
          : process.execPath;

      const child = spawn(executable, [claude, usageMode], {
        cwd: directory,
        stdio: 'pipe',
        signal: options.signal,
      });

      sideChildren.push({
        child,
        cwd: directory,
        args: options.args,
        env: options.env,
      });

      return child;
    }

    assert.ok(options.args.some((arg) => arg.includes('user,project,local')));
    assert.equal(options.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
    args.push(options.args);
    envs.push(options.env);

    const child = spawn(
      process.execPath,
      [
        claude,
        options.args.includes('--tools=Read,Grep,Glob')
          ? 'peer-answer'
          : (mode ?? ''),
        ...(!sessionState ? ['--no-session-state'] : []),
      ],
      { cwd, stdio: 'pipe', signal: options.signal },
    );

    children.push(child);

    return child;
  });

  const connect = (options: Partial<SessionOptions> = {}) =>
    adapter.connect({
      cwd,
      executable: '/fake/claude',
      memoryDirectories: [],
      onEvent: () => {},
      onProcess: async () => {},
      ...options,
    });

  return { cwd, children, args, envs, sideChildren, adapter, connect };
}

export async function fixture(
  onEvent: (event: AgentEvent) => void = () => {},
  mode?: string,
  options: { sessionState?: boolean } = {},
) {
  const { cwd, children, connect } = await launcher(
    mode,
    'background',
    options,
  );

  const session = await connect({ onEvent });

  return { session, cwd, child: children[0]! };
}

/** resolves on the first text event, so an interrupt can't land ahead of the queued prompt. */
export function working() {
  const seen = Promise.withResolvers<void>();

  const onEvent = (event: AgentEvent) => {
    if (event.type === 'text' && event.text === 'Working.') seen.resolve();
  };

  return { seen: seen.promise, onEvent };
}

/** the JSON lines the fixture wrote, or none while the file is missing or half written. */
export async function jsonLines(file: string): Promise<unknown[]> {
  try {
    return (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}

export const content = async (cwd: string) =>
  JSON.parse(await readFile(join(cwd, 'content.json'), 'utf8')) as unknown;

export function frameWriter(
  cwd: string,
  received: (name: string) => boolean,
  child: ChildProcessWithoutNullStreams,
) {
  let stdout = '';
  let stderr = '';

  const captureOut = (chunk: Buffer) => {
    stdout = (stdout + chunk.toString()).slice(-16384);
  };

  const captureErr = (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-16384);
  };

  child.stdout.on('data', captureOut);
  child.stderr.on('data', captureErr);

  child.once('close', () => {
    child.stdout.off('data', captureOut);
    child.stderr.off('data', captureErr);
  });

  let sequence = 0;

  return async (...frames: object[]) => {
    const index = ++sequence;
    await writeJson(join(cwd, `events-${index}.json`), frames);
    const started = performance.now();

    try {
      await until('native frame barrier', () => received(`barrier-${index}`));
    } catch (cause) {
      throw new Error(
        JSON.stringify(
          {
            expected: `barrier-${index}`,
            file: join(cwd, `events-${index}.json`),
            frames,
            elapsedMs: performance.now() - started,
            child: {
              pid: child.pid,
              exitCode: child.exitCode,
              signalCode: child.signalCode,
            },
            stdout,
            stderr,
          },
          null,
          2,
        ),
        { cause },
      );
    }
  };
}
