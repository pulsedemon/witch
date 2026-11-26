import { execFile, spawn } from 'node:child_process';
import type { ExecFileException, ExecFileOptions } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { running, signalGroup } from '../../agents/shutdown.js';
import { ps } from '../../persistence/process.js';
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
  const limit = options.maxBuffer ?? 1 << 20;
  let failure: Error | undefined;
  let stopped = false;
  let timedOut = false;
  /** the command's group, until a signal finds it without a member, since an empty group's id can be reused. */
  let group = child.pid;
  let watch: ReturnType<typeof setInterval> | undefined;

  const signalOwned = (sent: NodeJS.Signals | 0) => {
    if (group === undefined || signalGroup(group, sent)) return;

    group = undefined;
    clearInterval(watch);
  };

  /** stops reading once a stopped command has exited, since a descendant outside the group can hold the pipes open. */
  const release = () => {
    if (!stopped || running(child)) return;

    child.stdout.destroy();
    child.stderr.destroy();
  };

  const interrupt = () => {
    stopped = true;
    signalOwned('SIGKILL');
    release();
  };

  /** kills again while stopped, since a member can fork during the kill. */
  const probe = () => signalOwned(stopped ? 'SIGKILL' : 0);

  for (const name of ['stdout', 'stderr'] as const) {
    child[name].setEncoding('utf8');

    child[name].on('data', (text: string) => {
      if (failure) return;

      if (Buffer.byteLength(output[name]) + Buffer.byteLength(text) > limit) {
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
    probe();

    // members the command left behind can exit at any time
    if (group !== undefined) watch = setInterval(probe, 20);

    release();
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

    if (stopped) {
      const deadline = Date.now() + 3000;

      // the watch can forget the group during any of these waits
      const members = async () =>
        group !== undefined &&
        // bounds a hung listing; a slow one under load must not fail the stop
        (await ps('pgid=,stat=', undefined, { timeout: 10_000 })).some(
          (line) => {
            const [id, state] = line.trim().split(/\s+/);

            return Number(id) === group && !state?.startsWith('Z');
          },
        );

      while (await members()) {
        if (Date.now() >= deadline)
          throw new Error(`Command process group ${group} did not stop`);

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
    clearInterval(watch);
    signal.removeEventListener('abort', interrupt);
    child.off('exit', exited);
  }
}
