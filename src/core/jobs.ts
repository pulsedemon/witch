import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** a process group one of the agents' commands started. */
export interface Job {
  /** the group's id, which `stop` signals. */
  group: number;
  /** tells this group from a later one that reuses its id; `stop` checks it. */
  generation: number;
  /** the command line of its oldest process other than the leader, since the leader is usually the agent's wrapper shell, or the leader's when it runs alone. */
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
  /** the pid and start time, which tell a process from a later one that reuses its pid. */
  identity: string;
}

interface Detail {
  pid: number;
  pgid: number;
  cpu: number;
  startedAt: number;
  command: string;
}

/**
 * `ps` with C's dates in UTC and C's decimals, which Date and Number parse whatever the time zone. LC_ALL goes, since
 * it overrides both; LC_ALL=C instead would escape non-ASCII in commands.
 */
async function ps(args: string[]): Promise<string[]> {
  const { stdout } = await execute('/bin/ps', args, {
    env: {
      ...process.env,
      LC_ALL: undefined,
      LC_TIME: 'C',
      LC_NUMERIC: 'C',
      TZ: 'UTC',
    },
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
            startedAt: new Date(`${match[4]!} UTC`).getTime(),
            command: match[5]!,
          },
        ]
      : [];
  });
}

/**
 * the process groups of the agents' commands, which both agents start as session leaders, and of any group a
 * process inside one moves to. a group keeps its generation while a process from the last read remains in it, so a
 * command orphaned to launchd still shows; one orphaned before any read sees it never does.
 */
export class JobWatch {
  /** each tracked group's generation. */
  private groups: ReadonlyMap<number, number> = new Map();
  private generation = 0;
  /** the tracked groups' processes as of the last read, by identity, with the group each was in. */
  private members = new Map<string, number>();
  private readonly timer: ReturnType<typeof setInterval>;
  private polling?: Promise<Row[]>;

  constructor(
    private readonly options: {
      /** how often the process table is read, in milliseconds. */
      interval?: number;
      /** how long a job has to exit on SIGTERM before SIGKILL, in milliseconds. */
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
    // a read during describe replaces the map, so this keeps the generations of the read these rows came from
    const groups = this.groups;
    const pids = rows
      .filter(({ pgid }) => groups.has(pgid))
      .map(({ pid }) => pid);
    if (!pids.length) return [];
    // ps reports a process's group as it is by then, which can be one the read never tracked
    const details = (await describe(pids)).filter(({ pgid }) =>
      groups.has(pgid),
    );
    return [...Map.groupBy(details, ({ pgid }) => pgid)]
      .map(([group, members]) => {
        const byStart = members.toSorted((a, b) => a.startedAt - b.startedAt);
        const named = byStart.find(({ pid }) => pid !== group) ?? byStart[0]!;
        return {
          group,
          generation: groups.get(group)!,
          command: named.command,
          cpu: members.reduce((total, { cpu }) => total + cpu, 0),
          startedAt: byStart[0]!.startedAt,
        };
      })
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * sends the group SIGTERM, then SIGKILL once `grace` passes, since a Node process stuck in a loop never runs the
   * handlers it registered. returns once the listed generation is gone, and rejects if it outlasts SIGKILL by a second.
   */
  async stop(job: Pick<Job, 'group' | 'generation'>): Promise<void> {
    const steps = [
      ['SIGTERM', this.options.grace ?? 2000],
      ['SIGKILL', 1000],
    ] as const;
    for (const [signal, wait] of steps) {
      if (!(await this.running(job))) return;
      try {
        process.kill(-job.group, signal);
      } catch (error) {
        // the group can empty between the read and the signal, and a group of only zombies refuses signals
        if (!(await this.running(job))) return;
        throw error;
      }
      for (const end = Date.now() + wait; Date.now() < end;) {
        await delay(100);
        if (!(await this.running(job))) return;
      }
    }
    throw new Error(`Job ${job.group} has not stopped.`);
  }

  /** checked before each signal, so a group that ended, or a later one that reuses its id, is left alone. */
  private async running({
    group,
    generation,
  }: Pick<Job, 'group' | 'generation'>): Promise<boolean> {
    await this.poll();
    return this.groups.get(group) === generation;
  }

  /** a read already in flight is shared, since overlapping reads would race on the groups. */
  private poll(): Promise<Row[]> {
    this.polling ??= this.read().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async read(): Promise<Row[]> {
    const rows = await (this.options.processes ?? processTable)();
    const children = Map.groupBy(rows, ({ ppid }) => ppid);
    // Witch's children include the agents, whose commands lead sessions and whose MCP servers do not; a server's own
    // detached helpers sit a level deeper and are never reached. VS Code's launcher, which memory editing runs, starts
    // `open` the same way, so it shows as a job until it exits
    const pending = [
      ...(children.get(process.pid) ?? []).flatMap(({ pid }) =>
        (children.get(pid) ?? []).filter(({ leadsSession }) => leadsSession),
      ),
      // a command's process orphaned to launchd is reached by its identity, so a group it starts or moves to later is too
      ...rows.filter(
        ({ ppid, identity }) => ppid === 1 && this.members.has(identity),
      ),
    ];
    const held = new Set(
      rows
        .filter(({ pgid, identity }) => this.members.get(identity) === pgid)
        .map(({ pgid }) => pgid),
    );
    const groups = new Set(held);
    while (pending.length) {
      const row = pending.pop()!;
      groups.add(row.pgid);
      pending.push(...(children.get(row.pid) ?? []));
    }
    // a group none of whose processes carry over is a new one, even under an id tracked before
    this.groups = new Map(
      [...groups].map((group) => [
        group,
        held.has(group) ? this.groups.get(group)! : ++this.generation,
      ]),
    );
    this.members = new Map(
      rows
        .filter(({ pgid }) => groups.has(pgid))
        .map(({ identity, pgid }) => [identity, pgid]),
    );
    return rows;
  }
}
