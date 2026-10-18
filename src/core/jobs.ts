import { writeFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ps } from '../persistence/process.js';

/** a process group one of the agents' commands, or a `!` command Witch runs, started. */
export interface Job {
  /** the group's id, which `stop` signals. */
  group: number;
  /** tells this group from a later one that reuses its id; `stop` checks it. */
  generation: number;
  /** the command line of its oldest process other than the leader, or the leader's when it runs alone. the leader is usually the agent's wrapper shell. */
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

/** reads `ps -o pid=,ppid=,pgid=,stat=,lstart=` lines, leaving zombies out so a job whose processes have all exited drops. */
export function parseProcesses(lines: string[]): Row[] {
  return lines.flatMap((line) => {
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
  });
}

async function processTable(): Promise<Row[]> {
  return parseProcesses(await ps('pid=,ppid=,pgid=,stat=,lstart='));
}

const detail =
  /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\w+ \w+ +\d+ [\d:]+ \d+)\s+(.*)$/s;

/** reads `ps -o pid=,pgid=,%cpu=,lstart=,command=` lines with dates in UTC. */
export function parseDetails(lines: string[]): Detail[] {
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

async function describe(pids: number[]): Promise<Detail[]> {
  return parseDetails(await ps('pid=,pgid=,%cpu=,lstart=,command=', pids));
}

/** `text` in single quotes, for zsh and bash. */
function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * the process groups of the agents' commands, which both agents start as session leaders, of the groups handed to
 * `track`, and of any group a process inside one moves to. a group keeps its generation while a process from the last
 * read remains in it, so a command orphaned to launchd still shows.
 *
 * with a `directory`, Claude Code runs `script` as its `CLAUDE_ENV_FILE` ahead of each Bash command, in the shell that
 * leads the command's group. the script records that shell's pid in the directory, and the next read takes the group
 * as handed over. an orphan no read saw is missed unless its group was handed over or reported.
 */
export class JobWatch {
  /** the report script's path, `<directory>/env`. */
  readonly script?: string;
  /** what every agent command's environment gains. */
  readonly environment: Record<string, string>;
  /** each tracked group's generation. */
  private groups: ReadonlyMap<number, number> = new Map();
  /** the groups handed to `track` that no read has yet found empty. */
  private readonly handed = new Set<number>();
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
      /** describes the tracked processes for `list`, from `ps` without it. */
      describe?: (pids: number[]) => Promise<Detail[]>;
      /** an existing directory this instance alone reports into; without it nothing reports. */
      directory?: string;
    } = {},
  ) {
    const { directory } = options;
    this.environment = directory ? { WITCH_JOBS: directory } : {};
    if (directory) {
      this.script = join(directory, 'env');
      // the braces send a failed write's error to /dev/null, `>|` writes under noclobber, and the unset keeps a Claude
      // Code that a command starts from reading this file
      writeFileSync(
        this.script,
        `{ true >| ${quote(directory)}/$$; } 2>/dev/null\nexport WITCH_JOBS=${quote(directory)}\nunset CLAUDE_ENV_FILE\n`,
      );
    }
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

  /** tracks a group Witch started itself from the next read, even once its leader has exited. */
  track(group: number): void {
    this.handed.add(group);
  }

  /** the tracked jobs as of a fresh read, oldest first. */
  async list(): Promise<Job[]> {
    const tracked = await this.poll();
    // a read during describe replaces the map, so this keeps the generations of the read these rows came from
    const groups = this.groups;
    if (!tracked.length) return [];
    // ps reports a process's group as it is by then, which can be one the read never tracked
    const details = (
      await (this.options.describe ?? describe)(tracked.map(({ pid }) => pid))
    ).filter(({ pgid }) => groups.has(pgid));
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
    // a group handed over while this read's ps runs can be missing from its rows, so it waits for the next read
    const handed = [...this.handed];
    // a report collected after ps could name a group ps never saw, which this read would drop. one in the copy alone
    // would be lost when its shell still runs now and exits before the next read
    for (const pid of await this.reports()) {
      handed.push(pid);
      this.handed.add(pid);
    }
    const rows = await (this.options.processes ?? processTable)();
    const children = Map.groupBy(rows, ({ ppid }) => ppid);
    // the agents' commands lead sessions and their MCP servers don't. a server's detached helpers sit a level deeper
    // and are never reached, nor is any command of a Codex from npm, whose Node launcher runs app-server as its child.
    // VS Code's launcher for memory editing starts `open` as a session leader, so it shows as a job until it exits
    const pending = [
      ...(children.get(process.pid) ?? []).flatMap(({ pid }) =>
        (children.get(pid) ?? []).filter(({ leadsSession }) => leadsSession),
      ),
      ...rows.filter(({ pgid }) => handed.includes(pgid)),
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
    const tracked = rows.filter(({ pgid }) => groups.has(pgid));
    this.members = new Map(
      tracked.map(({ identity, pgid }) => [identity, pgid]),
    );
    for (const group of handed)
      if (!rows.some(({ pgid }) => pgid === group)) this.handed.delete(group);
    return tracked;
  }

  /** takes the pids reported since the last read. */
  private async reports(): Promise<number[]> {
    const { directory } = this.options;
    if (!directory) return [];
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      // an agent's command can remove the directory, and /jobs should keep what the other paths reach
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const pids = names.filter((name) => /^\d+$/.test(name));
    await Promise.all(
      pids.map((name) => rm(join(directory, name), { force: true })),
    );
    return pids.map(Number);
  }
}
