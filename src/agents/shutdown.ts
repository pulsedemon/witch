import type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
} from 'node:child_process';
import type { AgentStopOptions } from './types.js';

const nativeStopTimeoutMs = 8000;
export const terminateGraceMs = 2000;
const killWaitMs = 1000;
export const terminationReserveMs = terminateGraceMs + killWaitMs;

/** carries shutdown policy through startup cancellation before a session exists. */
export class NativeStop extends Error {
  override readonly name = 'AbortError';

  constructor(readonly options: AgentStopOptions) {
    super('Native agent stop requested');
  }
}

export class NativeStopTimeout extends Error {
  constructor() {
    super('Native agent shutdown timed out');
  }
}

/** the stop policy an aborted startup carries, so closing what it started honours the caller's deadline. */
export function stopOptions(
  signal: AbortSignal | undefined,
): AgentStopOptions | undefined {
  const reason: unknown = signal?.reason;
  return reason instanceof NativeStop ? reason.options : undefined;
}

export function stopDeadline(
  deadline = performance.now() + nativeStopTimeoutMs,
): number {
  return deadline;
}

export async function beforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new NativeStopTimeout()),
          Math.max(0, deadline - performance.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function running(child: ChildProcess): boolean {
  return (
    child.pid !== undefined &&
    child.exitCode === null &&
    child.signalCode === null
  );
}

/** when a SIGTERM's grace ends: after `terminateGraceMs`, or early enough to leave the kill its wait. */
export function graceDeadline(deadline: number): number {
  return Math.min(deadline - killWaitMs, performance.now() + terminateGraceMs);
}

/** whether the group still has a member; other errors are thrown. */
export function signalGroup(
  group: number,
  signal: NodeJS.Signals | 0,
): boolean {
  try {
    process.kill(-group, signal);
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    // macOS answers EPERM while the group's last members are still exiting, or only an unreaped shell holds it, so they count until ESRCH
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw error;
  }
}

/** returns whether SIGKILL was needed; a sent signal alone does not establish process exit. */
export async function terminateChild(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<void>,
  deadline: number,
): Promise<boolean> {
  if (running(child)) child.kill('SIGTERM');
  try {
    await beforeDeadline(closed, graceDeadline(deadline));
    return false;
  } catch (error) {
    if (!(error instanceof NativeStopTimeout)) throw error;
  }
  const escalated = running(child);
  if (escalated) child.kill('SIGKILL');
  await beforeDeadline(closed, deadline);
  return escalated;
}
