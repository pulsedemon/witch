import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** a process group one of the agents' commands started. */
export interface Job {
  /** the group's id, which `stop` signals. */
  group: number;
  /** the command line of its earliest-started process other than the leader, usually the agent's wrapper shell, or of the leader when it runs alone. */
  command: string;
  /** its processes' summed CPU use, in percent of one core. */
  cpu: number;
  /** when its earliest running process started, in epoch milliseconds. */
  startedAt: number;
}

export interface Row {
  pid: number;
  ppid: number;
  pgid: number;
  leadsSession: boolean;
  /** the pid and start time, which tell a process from a later one given its id. */
  identity: string;
}

interface Detail {
  pid: number;
  pgid: number;
  cpu: number;
  startedAt: number;
  command: string;
}

/** `ps` with C's dates and decimals, which Date and Number parse, and the user's own character set for commands. */
async function ps(args: string[]): Promise<string[]> {
  const { stdout } = await execute('/bin/ps', args, {
    env: { ...process.env, LC_ALL: undefined, LC_TIME: 'C', LC_NUMERIC: 'C' },
  });
  return stdout.split('\n').filter(Boolean);
}

/** leaves zombies out, so a job whose processes have all exited drops. */
async function processTable(): Promise<Row[]> {
  return (await ps(['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='])).flatMap(
    (line) => {
      const [pid, ppid, pgid, stat, ...started] = line.trim().split(/\s+/);
      return stat!.startsWith('Z')
        ? []
        : [
            {
              pid: Number(pid),
              ppid: Number(ppid),
              pgid: Number(pgid),
              leadsSession: stat!.includes('s'),
              identity: `${pid} ${started.join(' ')}`,
            },
          ];
    },
  );
}

const detail =
  /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\w+ \w+ +\d+ [\d:]+ \d+)\s+(.*)$/;

async function describe(pids: number[]): Promise<Detail[]> {
  let lines: string[];
  try {
    lines = await ps([
      '-ww',
      '-p',
      pids.join(','),
      '-o',
      'pid=,pgid=,%cpu=,lstart=,command=',
    ]);
  } catch (error) {
    // ps exits 1 when none of the processes still runs
    if (error instanceof Error && 'code' in error && error.code === 1)
      return [];
    throw error;
  }
  return lines.flatMap((line) => {
    const match = detail.exec(line);
    return match
      ? [
          {
            pid: Number(match[1]),
            pgid: Number(match[2]),
            cpu: Number(match[3]),
            startedAt: new Date(match[4]!).getTime(),
            command: match[5]!,
          },
        ]
      : [];
  });
}

/**
 * the process groups of the agents' commands, which both agents start as session leaders, and of any group a
 * process inside one moves to. a group stays listed while a process it held at the last read remains, so a command
 * orphaned to launchd still shows and a later group given its id does not; one orphaned before the next poll never
 * does.
 */
export class JobWatch {
  /** each tracked group's processes as of the last read, by identity. */
  private groups = new Map<number, Set<string>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private polling?: Promise<Row[]>;

  constructor(
    private readonly options: {
      interval?: number;
      /** how long a job has to exit on SIGTERM before SIGKILL. */
      grace?: number;
      /** reads the process table, from `ps` without it. */
      processes?: () => Promise<Row[]>;
    } = {},
  ) {
    // a failed read leaves the groups as they were, and the next tick reads again
    this.timer = setInterval(
      () => void this.poll().catch(() => {}),
      options.interval ?? 2000,
    );
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  /** the tracked jobs as of a fresh read, oldest first. */
  async list(): Promise<Job[]> {
    const rows = await this.poll();
    const pids = rows
      .filter(({ pgid }) => this.groups.has(pgid))
      .map(({ pid }) => pid);
    if (!pids.length) return [];
    return [...Map.groupBy(await describe(pids), ({ pgid }) => pgid)]
      .map(([group, members]) => {
        const byStart = members.toSorted((a, b) => a.startedAt - b.startedAt);
        const named = byStart.find(({ pid }) => pid !== group) ?? byStart[0]!;
        return {
          group,
          command: named.command,
          cpu: members.reduce((total, { cpu }) => total + cpu, 0),
          startedAt: byStart[0]!.startedAt,
        };
      })
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * sends the group SIGTERM, then SIGKILL once `grace` passes, since a process stuck in a loop never runs the
   * handlers it registered. returns once no process remains in the group.
   */
  async stop(group: number): Promise<void> {
    const steps = [
      ['SIGTERM', this.options.grace ?? 2000],
      ['SIGKILL', 1000],
    ] as const;
    for (const [signal, wait] of steps) {
      if (!(await this.running(group))) return;
      try {
        process.kill(-group, signal);
      } catch (error) {
        // the group can empty, or hold only zombies, which refuse signals, between the read and the signal
        if (!(await this.running(group))) return;
        throw error;
      }
      for (const end = Date.now() + wait; Date.now() < end;) {
        await delay(100);
        if (!(await this.running(group))) return;
      }
    }
    throw new Error(`Job ${group} has not stopped.`);
  }

  /** only a tracked group with a running process is ever signalled. */
  private async running(group: number): Promise<boolean> {
    await this.poll();
    return this.groups.has(group);
  }

  /** a read already in flight is shared, since overlapping reads would race on the groups. */
  private poll(): Promise<Row[]> {
    this.polling ??= this.read().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  /** records the commands' groups and drops the ones no process it held remains in. */
  private async read(): Promise<Row[]> {
    const rows = await (this.options.processes ?? processTable)();
    const children = Map.groupBy(rows, ({ ppid }) => ppid);
    const held = ({ pgid, identity }: Row) =>
      !!this.groups.get(pgid)?.has(identity);
    // Witch's children include the agents, whose commands lead sessions and whose MCP servers do not; a server's own
    // detached helpers sit a level deeper and are never reached
    const pending = [
      ...(children.get(process.pid) ?? []).flatMap(({ pid }) =>
        (children.get(pid) ?? []).filter(({ leadsSession }) => leadsSession),
      ),
      // a command's process orphaned to launchd is reached through its group, so what it starts later is too
      ...rows.filter((row) => row.ppid === 1 && held(row)),
    ];
    const groups = new Set(rows.filter(held).map(({ pgid }) => pgid));
    while (pending.length) {
      const row = pending.pop()!;
      groups.add(row.pgid);
      pending.push(...(children.get(row.pid) ?? []));
    }
    this.groups = new Map([...groups].map((group) => [group, new Set()]));
    for (const row of rows) this.groups.get(row.pgid)?.add(row.identity);
    return rows;
  }
}
