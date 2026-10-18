import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { killGroup } from '../agents/user-shell.js';
import type { ProcessIdentity } from '../core/state.js';

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
): Promise<ProcessIdentity | undefined> {
  const [started] = await ps('lstart=', [pid]);
  return started === undefined ? undefined : { pid, started: started.trim() };
}

/** false once the recorded process has exited, even when a later one holds its pid. */
async function runs(recorded: ProcessIdentity): Promise<boolean> {
  const current = await identifyProcess(recorded.pid);
  return current?.started === recorded.started;
}

/** waits up to 5 s for the recorded process to exit, and throws if it hasn't. */
async function ends(recorded: ProcessIdentity, what: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    await delay(100);
    if (!(await runs(recorded))) return;
  }
  throw new Error(
    `The previous ${what} (${recorded.pid}) has not stopped. Stop it before restarting Witch.`,
  );
}

export async function stopPreviousProcess(
  recorded: ProcessIdentity,
): Promise<void> {
  if (!(await runs(recorded))) return;
  try {
    process.kill(recorded.pid, 'SIGTERM');
  } catch (error) {
    // it can exit between the check above and the signal
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
  await ends(recorded, 'agent process');
}

/** kills a recorded `!` command's group, then the group again once its shell exits, for a child forked as the first kill landed. */
export async function stopPreviousShell(
  recorded: ProcessIdentity,
): Promise<void> {
  if (!(await runs(recorded))) return;
  killGroup(recorded.pid);
  await ends(recorded, 'shell command');
  killGroup(recorded.pid);
}
