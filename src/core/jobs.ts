import { writeFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ps } from '../persistence/process.js';
import { quote } from '../shell.js';

const mark = 'WITCH_JOBS';

export const jobCheckpointSchema = z.object({
  version: z.literal(1),
  members: z.array(z.tuple([z.string(), z.number().int().positive()])),
  excluded: z.array(z.string()),
});

export type JobCheckpoint = z.infer<typeof jobCheckpointSchema>;

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
  name: string;
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

/** reads `ps -o pid=,ppid=,pgid=,stat=,lstart=,ucomm=` lines, leaving zombies out so a job whose processes have all exited drops. */
export function parseProcesses(lines: string[]): Row[] {
  return lines.flatMap((line) => {
    const [pid, ppid, pgid, stat, ...rest] = line.trim().split(/\s+/);
    return stat!.startsWith('Z')
      ? []
      : [
          {
            pid: Number(pid),
            ppid: Number(ppid),
            pgid: Number(pgid),
            name: rest.slice(5).join(' '),
            leadsSession: stat!.includes('s'),
            identity: `${pid} ${rest.slice(0, 5).join(' ')}`,
          },
        ];
  });
}

async function processTable(): Promise<Row[]> {
  return parseProcesses(await ps('pid=,ppid=,pgid=,stat=,lstart=,ucomm='));
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

/** the listed processes whose environment holds `entry`. ps prints no environment for Apple's platform binaries. */
async function carrying(entry: string, pids: number[]): Promise<number[]> {
  return (await ps('pid=,command=', pids, { environment: true })).flatMap(
    (line) => {
      const [, pid, rest] = /^\s*(\d+)\s(.*)$/s.exec(line) ?? [];
      return pid && ` ${rest} `.includes(` ${entry} `) ? [Number(pid)] : [];
    },
  );
}

/** each listed process's argv[0], which LaunchServices and Chromium set to the executable's full path. */
async function executables(pids: number[]): Promise<Map<number, string>> {
  return new Map(
    (await ps('pid=,comm=', pids)).flatMap((line) => {
      const [, pid, path] = /^\s*(\d+)\s(.*)$/s.exec(line) ?? [];
      return pid ? [[Number(pid), path!] as const] : [];
    }),
  );
}

/**
 * the process groups of the agents' commands, which both agents start as session leaders, of the groups handed to
 * `track`, and of any group a process inside one moves to. a listed group keeps its generation while a process from
 * the last read remains in it, so a command orphaned to launchd still shows.
 *
 * tmux processes, the apps described below and their observed descendants are excluded, including after reparenting.
 * their entire groups are withheld, but ordinary peers keep their ownership and return with a new generation once the
 * exclusion ends.
 * exclusion stops at this Witch so running it inside tmux leaves its own agent commands available.
 *
 * with a `directory`, Claude Code runs `script` as its `CLAUDE_ENV_FILE` ahead of each Bash command, in the shell that
 * leads the command's group. the script records that shell's pid in the directory, and the next read takes the group
 * as handed over. every command also carries `environment`, the mark, which `ps -E` reads from each launchd child no
 * read has seen and the processes below it, though not from Apple's platform binaries. a marked process's group, and
 * those below it, are then tracked. a marked launchd child that runs an app's main executable while leading its own
 * group, as LaunchServices starts apps, or a helper from an app's Frameworks directory is excluded instead. an orphan
 * no read saw is missed unless its group was handed over or reported, or a process in it carries the mark.
 */
export class JobWatch {
  /** the report script's path, `<directory>/env`. */
  readonly script?: string;
  /** what every agent command's environment gains. */
  readonly environment: Record<string, string>;
  /** each listed group's generation. */
  private groups: ReadonlyMap<number, number> = new Map();
  /** the groups handed to `track` or reported by shells that no read has yet found empty. */
  private readonly handed = new Set<number>();
  private generation = 0;
  /** ordinary owned processes and their groups, including peers in temporarily withheld groups. */
  private members: Map<string, number>;
  /** excluded identities still present at the last successful read. */
  private excluded: Set<string>;
  /** every process's identity as of the last read, unset until a read succeeds. */
  private seen?: Set<string>;
  private readonly timer: ReturnType<typeof setInterval>;
  private polling?: Promise<Row[]>;
  private active = true;
  private activityChanges = 0;
  /** when activity last changed or a read last found something it tracks, from `performance.now()`. */
  private busyAt = 0;
  private paused = false;

  constructor(
    private readonly options: {
      /** how often the process table is read, in milliseconds. */
      interval?: number;
      /** how long the watch keeps reading after activity or its last job ends, in milliseconds. */
      settle?: number;
      /** how long a job has to exit on SIGTERM before SIGKILL, in milliseconds. */
      grace?: number;
      /** reads the process table, from `ps` without it. */
      processes?: () => Promise<Row[]>;
      /** describes the tracked processes for `list`, from `ps` without it. */
      describe?: (pids: number[]) => Promise<Detail[]>;
      /** an existing directory this instance alone reports into; without it nothing reports or is marked. */
      directory?: string;
      /** the listed processes whose environment holds the mark, from `ps` without it. */
      marked?: (pids: number[]) => Promise<number[]>;
      /** each listed process's argv[0], from `ps -o comm=` without it. */
      executables?: (pids: number[]) => Promise<Map<number, string>>;
      resume?: JobCheckpoint;
    } = {},
  ) {
    const { directory, resume } = options;
    this.members = new Map(resume?.members);
    this.excluded = new Set(resume?.excluded);
    this.environment = directory ? { [mark]: directory } : {};
    if (directory) {
      this.script = join(directory, 'env');
      // a failed report must not stop commands under errexit; >| also tolerates noclobber.
      // nested Claude sessions must not reuse this report script
      writeFileSync(
        this.script,
        `{ true >| ${quote(directory)}/$$; } 2>/dev/null || :\nexport ${mark}=${quote(directory)}\nunset CLAUDE_ENV_FILE\n`,
      );
    }
    // a failed read leaves the groups as they were, and the next tick reads again unless the watch is paused
    this.timer = setInterval(() => {
      if (!this.paused) void this.poll().catch(() => {});
    }, options.interval ?? 2000);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  /** preserves hidden ordinary members and historical exclusions for the next watcher's identity checks. */
  async checkpoint(): Promise<JobCheckpoint> {
    if (this.polling) await this.polling;
    await this.poll();
    return {
      version: 1,
      members: [...this.members],
      excluded: [...this.excluded],
    };
  }

  /** tracks a group Witch started itself from the next read, even once its leader has exited. */
  track(group: number): void {
    this.handed.add(group);
    this.paused = false;
  }

  /** whether a turn, familiar or brew is running, any of which can start a job. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.activityChanges++;
    this.busyAt = performance.now();
    if (active) this.paused = false;
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
   * leaves untracked groups and stale generations unsignaled. otherwise sends SIGTERM, then SIGKILL after `grace`,
   * since a Node process stuck in a loop cannot run its signal handlers. returns once the listed generation is gone,
   * and rejects if it outlasts SIGKILL by a second.
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
    const changes = this.activityChanges;
    const began = performance.now();
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
    const excluded = new Set<string>();
    const boundaries = rows.filter(
      ({ name, identity }) => name === 'tmux' || this.excluded.has(identity),
    );
    while (boundaries.length) {
      const row = boundaries.pop()!;
      if (row.pid === process.pid || excluded.has(row.identity)) continue;
      excluded.add(row.identity);
      boundaries.push(...(children.get(row.pid) ?? []));
    }
    const excludedGroups = new Set(
      rows
        .filter(({ identity }) => excluded.has(identity))
        .map(({ pgid }) => pgid),
    );
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
    // stopping Witch's own group would end Witch. Codex's `shell_zsh_fork` and a Claude hook that sources
    // `$CLAUDE_ENV_FILE`, both off by default, put marked processes there, since neither agent is spawned detached
    const own = rows.find(({ pid }) => pid === process.pid)?.pgid;
    const walk = () => {
      while (pending.length) {
        const row = pending.pop()!;
        if (excluded.has(row.identity)) continue;
        if (row.pgid !== own) groups.add(row.pgid);
        pending.push(...(children.get(row.pid) ?? []));
      }
    };
    walk();
    // the first read only records identities so pre-existing processes cannot be adopted by their marks
    const { directory } = this.options;
    const { seen } = this;
    if (directory && seen) {
      const below = (row: Row): Row[] =>
        excluded.has(row.identity)
          ? []
          : [row, ...(children.get(row.pid) ?? []).flatMap(below)];
      const roots = rows.filter(
        ({ ppid, pgid, identity }) =>
          ppid === 1 && !seen.has(identity) && !groups.has(pgid),
      );
      const candidates = roots.flatMap(below);
      if (candidates.length) {
        const marked = new Set(
          await (
            this.options.marked ??
            ((pids) => carrying(`${mark}=${directory}`, pids))
          )(candidates.map(({ pid }) => pid)),
        );
        // LaunchServices starts an app in a group of its own, and `open --env` hands it the mark, as VS Code's `code`
        // does. the app, its terminals and its frameworks' helpers, such as its crash handler, are the user's. a
        // command's own run of a bundle's main executable stays a job unless it leads its own group
        const markedRoots = roots.filter(({ pid }) => marked.has(pid));
        const paths = markedRoots.length
          ? await (this.options.executables ?? executables)(
              markedRoots.map(({ pid }) => pid),
            )
          : new Map<number, string>();
        for (const root of markedRoots) {
          // the outermost bundle only, outside any framework, since Xcode's toolchain, framework builds of python3 and
          // IDE-bundled JDKs run from inside a bundle without being its app
          const bundle =
            /^(?:(?!\.app\/|\.framework\/).)*\.app\/Contents\/(MacOS|Frameworks)\//.exec(
              paths.get(root.pid) ?? '',
            );
          if (!bundle || (root.pid !== root.pgid && bundle[1] === 'MacOS'))
            continue;
          // excluded like a tmux tree, so a process that joins the app's group later can't bring the app back
          for (const row of below(root)) {
            excluded.add(row.identity);
            excludedGroups.add(row.pgid);
          }
        }
        // an unmarked root can sit above a command's session in a group that isn't the command's
        pending.push(...candidates.filter(({ pid }) => marked.has(pid)));
        walk();
      }
    }
    const owned = rows.filter(
      ({ identity, pgid }) => groups.has(pgid) && !excluded.has(identity),
    );
    for (const group of excludedGroups) groups.delete(group);
    // a returning or replaced group must invalidate selections from its earlier listing
    this.groups = new Map(
      [...groups].map((group) => [
        group,
        (held.has(group) ? this.groups.get(group) : undefined) ??
          ++this.generation,
      ]),
    );
    const tracked = rows.filter(({ pgid }) => groups.has(pgid));
    this.members = new Map(owned.map(({ identity, pgid }) => [identity, pgid]));
    this.seen = new Set(rows.map(({ identity }) => identity));
    this.excluded = excluded;
    for (const group of handed)
      if (!rows.some(({ pgid }) => pgid === group)) this.handed.delete(group);
    const tracking =
      this.groups.size > 0 || this.members.size > 0 || this.handed.size > 0;
    if (tracking) this.busyAt = performance.now();
    // read only while something could start a job, and for `settle` after, so an app opened as a turn ends is seen and excluded
    this.paused =
      !this.active &&
      !tracking &&
      !excluded.size &&
      changes === this.activityChanges &&
      began - this.busyAt >= (this.options.settle ?? 5000);
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
