import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { ConversationRecord } from '../core/state.js';

const execute = promisify(execFile);

/**
 * `ps -o format` for the listed processes, or every process without a list. Dates and decimals are C's, which Date
 * and Number parse, and dates are in UTC so a time zone change keeps every identity. LC_ALL goes, since it overrides
 * both; LC_ALL=C instead would escape non-ASCII in commands.
 */
export async function ps(format: string, pids?: number[]): Promise<string[]> {
  try {
    const { stdout } = await execute(
      '/bin/ps',
      [...(pids ? ['-p', pids.join(',')] : ['-A']), '-o', format],
      {
        env: {
          ...process.env,
          LC_ALL: undefined,
          LC_TIME: 'C',
          LC_NUMERIC: 'C',
          TZ: 'UTC',
        },
      },
    );
    return stdout.split('\n').filter(Boolean);
  } catch (error) {
    // ps exits 1 when none of the listed processes still runs. a full listing always holds Witch, so there it failed
    if (pids && error instanceof Error && 'code' in error && error.code === 1)
      return [];
    throw error;
  }
}

export async function identifyProcess(
  pid: number,
): Promise<ConversationRecord['process']> {
  const [started] = await ps('lstart=', [pid]);
  return started === undefined ? undefined : { pid, started: started.trim() };
}

export async function stopPreviousProcess(
  recorded: NonNullable<ConversationRecord['process']>,
): Promise<void> {
  const current = await identifyProcess(recorded.pid);
  if (!current || current.started !== recorded.started) return;
  try {
    process.kill(recorded.pid, 'SIGTERM');
  } catch (error) {
    // it can exit between the check above and the signal
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    await delay(100);
    const remaining = await identifyProcess(recorded.pid);
    if (!remaining || remaining.started !== recorded.started) return;
  }
  throw new Error(
    `The previous agent process (${recorded.pid}) has not stopped. Stop it before restarting Witch.`,
  );
}
