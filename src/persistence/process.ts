import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { signalGroup } from '../agents/shutdown.js';
import type { ConversationRecord, ProcessIdentity } from '../core/state.js';
import type { ConversationStore } from './store.js';

const execute = promisify(execFile);

// ps replaces argument separators with spaces; KERN_PROCARGS2 preserves them.
const argumentsQuery = `
my $mib = pack('i*', 1, 8);
my $maximum = pack('i', 0);
my $size = pack('Q', length($maximum));
syscall(202, $mib, 2, $maximum, $size, 0, 0) == 0 or die "Cannot read KERN_ARGMAX: $!";
for my $pid (@ARGV) {
  $mib = pack('i*', 1, 49, $pid);
  my $buffer = "\\0" x unpack('i', $maximum);
  $size = pack('Q', length($buffer));
  if (syscall(202, $mib, 3, $buffer, $size, 0, 0) != 0) {
    next if $!{ESRCH} || $!{EINVAL} || $!{EPERM} || $!{EACCES};
    die "Cannot read arguments for $pid: $!";
  }
  my $count = unpack('i', $buffer);
  $buffer = substr($buffer, 4, unpack('Q', $size) - 4);
  # the saved executable path is padded to eight bytes on 64-bit macOS.
  $buffer = substr($buffer, (index($buffer, "\\0") + 8) & ~7);
  my @args = split(/\\0/, $buffer, -1);
  print join("\\0", $pid, $count, @args[0 .. $count - 1]), "\\0";
}
`;

/** preserves argv boundaries; exited or inaccessible processes are omitted. */
export async function processArguments(
  pids: readonly number[],
): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();

  if (!pids.length) return result;

  if (process.platform === 'linux') {
    for (const pid of pids) {
      try {
        const content = await readFile(`/proc/${pid}/cmdline`, 'utf8');

        if (content) result.set(pid, content.split('\0').slice(0, -1));
      } catch (error) {
        if (
          !['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw error;
      }
    }

    return result;
  }

  const { stdout } = await execute('/usr/bin/perl', [
    '-e',
    argumentsQuery,
    ...pids.map(String),
  ]);

  const fields = stdout.split('\0');

  for (let at = 0; at < fields.length - 1;) {
    const pid = Number(fields[at++]);
    const count = Number(fields[at++]);
    result.set(pid, fields.slice(at, at + count));
    at += count;
  }

  return result;
}

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
  options: { environment?: boolean; timeout?: number } = {},
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
        ...(options.timeout === undefined
          ? {}
          : { timeout: options.timeout, killSignal: 'SIGKILL' as const }),
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

/** Witch's own identity from the first read that included it, since a running process keeps its pid and start. */
let own: ProcessIdentity | undefined;

export async function identifyProcesses(
  pids: readonly number[],
  options: { timeout?: number } = {},
): Promise<Map<number, ProcessIdentity>> {
  const known = own && pids.includes(process.pid) ? own : undefined;

  const probed = [...new Set(pids)].filter(
    (pid) => !known || pid !== known.pid,
  );

  const identities = new Map<number, ProcessIdentity>(
    known ? [[known.pid, known]] : [],
  );

  if (!probed.length) return identities;

  for (const line of await ps('pid=,lstart=', probed, options)) {
    const [, id, started] = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)!;
    const pid = Number(id);
    identities.set(pid, { pid, started: started! });
  }

  own ??= identities.get(process.pid);

  return identities;
}

export async function identifyProcess(
  pid: number,
): Promise<ProcessIdentity | undefined> {
  return (await identifyProcesses([pid])).get(pid);
}

/** the native processes a conversation records, besides its `!` shell. */
export const nativeProcessKeys = [
  'process',
  'usageProcess',
  'answerProcess',
] as const;

/** stops the processes a record left by a crash holds and returns whether it held any; a shell that won't stop throws at once, a native process once every native stop settles. */
export async function stopLeftProcesses(
  record: Pick<
    ConversationRecord,
    'shell' | (typeof nativeProcessKeys)[number]
  >,
): Promise<boolean> {
  const natives = nativeProcessKeys.flatMap((key) => {
    const identity = record[key];

    return identity ? [identity] : [];
  });

  if (!record.shell && !natives.length) return false;

  // the shell goes first, so a CLI that won't stop still leaves the command killed
  if (record.shell) await stopPreviousShell(record.shell);

  const stopped = await Promise.allSettled(natives.map(stopPreviousProcess));

  for (const result of stopped)
    if (result.status === 'rejected') throw result.reason;

  return true;
}

/** session callbacks that save the identity of each native process a session reports, so a later Witch can stop it. */
export function processReports(
  conversation: ConversationRecord,
  files: ConversationStore,
  track: (pid: number) => void,
) {
  const identify =
    (key: (typeof nativeProcessKeys)[number] | 'shell') =>
    async (pid?: number) => {
      const id = pid === undefined ? undefined : await identifyProcess(pid);

      if (files.closed) return;

      conversation[key] = id;
      await files.save(conversation);
    };

  return {
    onProcess: identify('process'),
    onUsageProcess: identify('usageProcess'),
    onAnswerProcess: identify('answerProcess'),
    // a `!cmd &` shell can exit before the next read, so its group goes over at spawn
    onShell: async (pid?: number) => {
      if (pid !== undefined) track(pid);

      await identify('shell')(pid);
    },
  };
}

export function sameProcess(
  left: ProcessIdentity | undefined,
  right: ProcessIdentity,
): boolean {
  return left?.pid === right.pid && left.started === right.started;
}

/** false once the recorded process has exited, even when a later one holds its pid. */
export async function runs(recorded: ProcessIdentity): Promise<boolean> {
  return sameProcess(await identifyProcess(recorded.pid), recorded);
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

async function stopPreviousProcess(recorded: ProcessIdentity): Promise<void> {
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
async function stopPreviousShell(recorded: ProcessIdentity): Promise<void> {
  if (!(await runs(recorded))) return;

  signalGroup(recorded.pid, 'SIGKILL');
  await ends(recorded, 'shell command');
  signalGroup(recorded.pid, 'SIGKILL');
}
