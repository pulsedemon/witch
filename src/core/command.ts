import { execFile, spawn } from 'node:child_process';
import type { ExecFileException, ExecFileOptions } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { killGroup } from '../agents/user-shell.js';
import { ps } from '../persistence/process.js';
import type { Run } from './repository.js';

const execute = promisify(execFile);

export async function runCommand(
  command: string,
  args: string[],
  options: Parameters<Run>[2] & Pick<ExecFileOptions, 'env' | 'killSignal'>,
): ReturnType<Run> {
  if (options.signal)
    return cancellable(command, args, options.signal, options);
  try {
    return await execute(command, args, options);
  } catch (error) {
    const failure = error as ExecFileException;
    if (failure.killed === true)
      failure.message = `Timed out after ${options.timeout} ms: ${failure.message}`;
    throw error;
  }
}

/** execFile cannot create a process group; cancellation must stop children before checkout changes resume. */
async function cancellable(
  command: string,
  args: string[],
  signal: AbortSignal,
  options: Parameters<Run>[2],
): ReturnType<Run> {
  signal.throwIfAborted();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  let failure: Error | undefined;
  let stopped = false;
  let timedOut = false;
  const interrupt = () => {
    stopped = true;
    if (child.pid) killGroup(child.pid);
  };
  for (const name of ['stdout', 'stderr'] as const) {
    child[name].setEncoding('utf8');
    child[name].on('data', (text: string) => {
      if (failure) return;
      if (Buffer.byteLength(output[name]) + Buffer.byteLength(text) > 1 << 20) {
        failure = Object.assign(
          new Error(`${name} maxBuffer length exceeded`),
          {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          },
        );
        interrupt();
      } else output[name] += text;
    });
  }
  signal.addEventListener('abort', interrupt, { once: true });
  const timer =
    options.timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          interrupt();
        }, options.timeout)
      : undefined;
  const exited = () => {
    if (stopped) interrupt();
  };
  child.once('exit', exited);
  try {
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once('error', (error) => {
        failure = error;
      });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (stopped && child.pid) {
      const deadline = Date.now() + 3000;
      while (
        (await ps('pgid=,stat=', undefined, { timeout: 1000 })).some((line) => {
          const [group, state] = line.trim().split(/\s+/);
          return Number(group) === child.pid && !state?.startsWith('Z');
        })
      ) {
        if (Date.now() >= deadline)
          throw new Error(`Command process group ${child.pid} did not stop`);
        await delay(20);
      }
    }
    signal.throwIfAborted();
    if (failure) throw Object.assign(failure, output);
    if (result.code !== 0 || timedOut)
      throw Object.assign(
        new Error(
          `${timedOut ? `Timed out after ${options.timeout} ms: ` : ''}Command failed: ${[command, ...args].join(' ')}\n${output.stderr}`,
        ),
        {
          ...result,
          ...output,
          killed: stopped,
        },
      );
    return output;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', interrupt);
    child.off('exit', exited);
  }
}
