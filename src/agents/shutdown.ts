import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const nativeStopTimeoutMs = 8000;
const terminateGraceMs = 2000;
const killWaitMs = 1000;
export const terminationReserveMs = terminateGraceMs + killWaitMs;

export class NativeStopTimeout extends Error {
  constructor() {
    super('Native agent shutdown timed out');
  }
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

/** returns whether SIGKILL was needed; a sent signal alone does not establish process exit. */
export async function terminateChild(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<void>,
  deadline: number,
): Promise<boolean> {
  const running = () =>
    child.pid !== undefined &&
    child.exitCode === null &&
    child.signalCode === null;
  if (running()) child.kill('SIGTERM');
  try {
    await beforeDeadline(
      closed,
      Math.min(deadline - killWaitMs, performance.now() + terminateGraceMs),
    );
    return false;
  } catch (error) {
    if (!(error instanceof NativeStopTimeout)) throw error;
  }
  const escalated = running();
  if (escalated) child.kill('SIGKILL');
  await beforeDeadline(closed, deadline);
  return escalated;
}
