import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ProcessIdentity } from '../core/state.js';
import { ps } from './process.js';

const execute = promisify(execFile);
export const scratchProbeTimeout = 10_000;

export type ScratchUse = 'used' | 'unused' | 'unknown';

export interface ScratchCandidate {
  directory: string;
  owner?: ProcessIdentity;
  previousBoot: boolean;
  requiresBoot?: boolean;
  lockFd: number;
}

export interface ScratchObservation {
  before: readonly string[];
  after: readonly string[];
  commands: readonly string[];
  files: string;
}

interface Process extends ProcessIdentity {
  ppid: number;
  uid: number;
  time: number;
  name: string;
}

interface FileReference {
  pid: number;
  fd: string;
  type: string;
  name: string;
}

function processes(lines: readonly string[]): Map<number, Process> {
  const rows = new Map<number, Process>();
  for (const line of lines) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\w+ \w+ +\d+ [\d:]+ \d+)\s+(.+?)\s*$/.exec(
        line,
      );
    if (!match) throw new Error('Incomplete process observation.');
    const [, pid, ppid, uid, state, started, name] = match;
    if (state!.startsWith('Z')) continue;
    const time = Date.parse(`${started!} UTC`);
    if (!Number.isFinite(time)) throw new Error('Unknown process start time.');
    rows.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      uid: Number(uid),
      started: started!,
      time,
      name: name!,
    });
  }
  return rows;
}

function files(output: string): {
  pids: Set<number>;
  references: FileReference[];
} {
  if (!output.endsWith('\0\n')) throw new Error('Incomplete file observation.');
  const pids = new Set<number>();
  const references: FileReference[] = [];
  let pid: number | undefined;
  let reference: FileReference | undefined;
  for (const field of output.split('\0')) {
    const value = field.replace(/^\n/, '');
    if (!value) continue;
    switch (value[0]) {
      case 'p':
        if (!/^p\d+$/.test(value)) throw new Error('Invalid process field.');
        pid = Number(value.slice(1));
        pids.add(pid);
        reference = undefined;
        break;
      case 'f':
        if (pid === undefined || value.length === 1)
          throw new Error('File observation has no owner.');
        reference = { pid, fd: value.slice(1), type: '', name: '' };
        references.push(reference);
        break;
      case 't':
        if (!reference) throw new Error('File observation has no descriptor.');
        reference.type = value.slice(1);
        break;
      case 'n':
        if (!reference) throw new Error('File observation has no descriptor.');
        reference.name = value.slice(1);
        break;
      default:
        throw new Error('Unexpected file observation field.');
    }
  }
  return { pids, references };
}

function beneath(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

/** launchd parenting and hidden environments cannot rule out a surviving reader. */
function independent(
  row: Process,
  owner: ProcessIdentity,
  rows: ReadonlyMap<number, Process>,
): boolean {
  const began = Date.parse(`${owner.started} UTC`);
  if (!Number.isFinite(began)) return false;
  const seen = new Set<number>();
  let current: Process | undefined = row;
  while (current && current.pid > 1 && !seen.has(current.pid)) {
    if (current.pid === owner.pid && current.started === owner.started)
      return false;
    if (current.name === 'tmux') return false;
    if (current.time < began) return true;
    seen.add(current.pid);
    current = rows.get(current.ppid);
  }
  return false;
}

/** an older pane can accept scratch through tmux and survive its server without a visible mark. */
export async function scratchRequiresBoot(): Promise<boolean> {
  try {
    const rows = processes(
      await ps('pid=,ppid=,uid=,stat=,lstart=,ucomm=', undefined, {
        timeout: scratchProbeTimeout,
      }),
    );
    return (
      !rows.has(process.pid) ||
      [...rows.values()].some(({ name }) => name === 'tmux')
    );
  } catch {
    return true;
  }
}

/** classifies native observations without changing a candidate or trusting missing records. */
export function classifyScratch(
  candidates: readonly ScratchCandidate[],
  observation: ScratchObservation,
): ReadonlyMap<string, ScratchUse> {
  const results = new Map<string, ScratchUse>(
    candidates.map(({ directory }) => [directory, 'unknown']),
  );
  try {
    const before = processes(observation.before);
    const after = processes(observation.after);
    if (!before.has(process.pid) || !after.has(process.pid)) return results;
    const opened = files(observation.files);
    const commands = new Map<number, string>();
    for (const line of observation.commands) {
      const match = /^\s*(\d+)\s(.*)$/.exec(line);
      if (!match) return results;
      commands.set(Number(match[1]), match[2]!);
    }
    for (const {
      directory,
      owner,
      previousBoot,
      requiresBoot,
      lockFd,
    } of candidates) {
      const referenced = opened.references.some(
        ({ pid, fd, name }) =>
          beneath(name, directory) &&
          !(pid === process.pid && fd === String(lockFd) && name === directory),
      );
      const named = [...commands.values()].some((command) => {
        let index = command.indexOf(directory);
        while (index >= 0) {
          const end = index + directory.length;
          const next = command[end];
          if (next === undefined || /[\s/'"\\]/.test(next)) return true;
          index = command.indexOf(directory, end);
        }
        return false;
      });
      if (
        referenced ||
        named ||
        (!previousBoot &&
          owner &&
          after.get(owner.pid)?.started === owner.started)
      ) {
        results.set(directory, 'used');
        continue;
      }
      if (!previousBoot && (!owner || requiresBoot !== false)) continue;
      const relevant = [...after.values()].filter(
        (row) =>
          row.pid > 1 &&
          ((row.uid === process.getuid!() &&
            before.get(row.pid)?.started === row.started) ||
            (!previousBoot && !independent(row, owner!, after))),
      );
      const uncertain = relevant.some((row) => {
        const earlier = before.get(row.pid);
        return (
          earlier?.started !== row.started ||
          earlier.ppid !== row.ppid ||
          !opened.pids.has(row.pid) ||
          !commands.has(row.pid) ||
          (!previousBoot && !independent(row, owner!, after))
        );
      });
      const incomplete = opened.references.some(
        ({ pid, fd, type, name }) =>
          relevant.some((row) => row.pid === pid) &&
          (fd === 'err' ||
            !type ||
            type === 'unknown' ||
            ((['cwd', 'rtd', 'txt', 'twd'].includes(fd) ||
              ['REG', 'DIR'].includes(type)) &&
              (!name.startsWith('/') || name.includes('\\')))),
      );
      const disappeared = [...before.values()].some(
        (row) =>
          !previousBoot &&
          !independent(row, owner!, before) &&
          after.get(row.pid)?.started !== row.started,
      );
      if (!uncertain && !incomplete && !disappeared)
        results.set(directory, 'unused');
    }
  } catch {
    // an incomplete native observation supplies no deletion permission.
  }
  return results;
}

export async function inspectScratch(
  candidates: readonly ScratchCandidate[],
): Promise<ReadonlyMap<string, ScratchUse>> {
  if (!candidates.length) return new Map();
  const unknown = new Map<string, ScratchUse>(
    candidates.map(({ directory }) => [directory, 'unknown']),
  );
  try {
    const canonical = await Promise.all(
      candidates.map(async (candidate) => ({
        ...candidate,
        directory: await realpath(candidate.directory),
      })),
    );
    const format = 'pid=,ppid=,uid=,stat=,lstart=,ucomm=';
    const before = await ps(format, undefined, {
      timeout: scratchProbeTimeout,
    });
    const [commands, opened] = await Promise.allSettled([
      ps('pid=,command=', undefined, {
        environment: true,
        timeout: scratchProbeTimeout,
      }),
      execute(
        process.platform === 'linux' ? '/usr/bin/lsof' : '/usr/sbin/lsof',
        ['-nP', '-F0pfnt'],
        {
          timeout: scratchProbeTimeout,
          killSignal: 'SIGKILL',
          maxBuffer: 64 << 20,
        },
      ),
    ]);
    if (
      commands.status !== 'fulfilled' ||
      opened.status !== 'fulfilled' ||
      opened.value.stderr
    )
      return unknown;
    const after = await ps(format, undefined, { timeout: scratchProbeTimeout });
    const results = classifyScratch(canonical, {
      before,
      after,
      commands: commands.value,
      files: opened.value.stdout,
    });
    return new Map(
      candidates.map(({ directory }, index) => [
        directory,
        results.get(canonical[index]!.directory) ?? 'unknown',
      ]),
    );
  } catch {
    return unknown;
  }
}
