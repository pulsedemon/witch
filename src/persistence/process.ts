import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { killGroup } from '../agents/user-shell.js';
import type { ProcessIdentity } from '../core/state.js';

const execute = promisify(execFile);

export async function bootSession(): Promise<string> {
  if (process.platform === 'linux')
    return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const { stdout } = await execute('/usr/sbin/sysctl', [
    '-n',
    'kern.bootsessionuuid',
  ]);
  return stdout.trim();
}

/**
 * `ps -o format` for the listed processes, or every process without a list, with each command's environment after it
 * when `environment` is set. dates and decimals are C's, which Date and Number parse, and dates are in UTC so a time
 * zone change keeps every identity. Linux's C.UTF-8 keeps command text intact even when a user's locale is unavailable.
 */
export async function ps(
  format: string,
  pids?: number[],
  options: { environment?: boolean } = {},
): Promise<string[]> {
  try {
    const { stdout } = await execute(
      '/bin/ps',
      [
        ...(process.platform === 'linux'
          ? [options.environment ? 'eww' : 'ww']
          : options.environment
            ? ['-E']
            : []),
        ...(pids ? ['-p', pids.join(',')] : ['-A']),
        '-o',
        format,
      ],
      {
        env: {
          ...process.env,
          LC_ALL: process.platform === 'linux' ? 'C.UTF-8' : undefined,
          LC_TIME: 'C',
          LC_NUMERIC: 'C',
          TZ: 'UTC',
        },
        // an environment is about 5 KB, so the default 1 MiB overflows at about 200 processes
        ...(options.environment ? { maxBuffer: 64 << 20 } : {}),
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

export async function identifyProcesses(
  pids: readonly number[],
): Promise<Map<number, ProcessIdentity>> {
  if (!pids.length) return new Map();
  const lines = await ps('pid=,lstart=', [...new Set(pids)]);
  return new Map(
    lines.map((line) => {
      const [, id, started] = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)!;
      const pid = Number(id);
      return [pid, { pid, started: started! }];
    }),
  );
}

export async function identifyProcess(
  pid: number,
): Promise<ProcessIdentity | undefined> {
  return (await identifyProcesses([pid])).get(pid);
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
