import { execFile } from 'node:child_process';
import { realpathSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);

export const pullRequestSchema = z.object({
  number: z.number(),
  url: z.string(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  /** the branch it merges, that branch's last commit, and the branch it merges into. */
  branch: z.string(),
  commit: z.string(),
  base: z.string(),
  /** an open pull request's checks, pending while it has none. */
  checks: z.enum(['passing', 'failing', 'pending']).optional(),
  /** an open pull request's mergeability as GitHub last computed it, `UNKNOWN` while it computes. */
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).optional(),
});

export type PullRequest = z.infer<typeof pullRequestSchema>;

export interface Repository {
  /** `HEAD` when detached. */
  branch: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  conflicts: number;
  /** entries, so a wholly untracked directory counts once. */
  untracked: number;
  pullRequest?: PullRequest;
  pullRequestProject?: string;
  /** the branch's pull request as last read conflicting, with its base's tip when that read looked it up. */
  conflict?: Conflict;
}

export interface Conflict {
  pullRequest: PullRequest;
  baseTip?: string;
}

/**
 * avoid optional locks that contend with the user's Git commands. fsmonitor stays off: a repository's
 * configured command would run, and the builtin daemon's cookie files would wake the watch on every read.
 */
export const statusArgs = [
  '-c',
  'core.fsmonitor=false',
  '--no-optional-locks',
  'status',
  '--porcelain=v2',
  '--branch',
] as const;

/**
 * blanks the filter drivers the repository's own config defines, since status runs a clean filter on a file whose stat
 * data changed; the user's own filters stay. an empty `process` stops `clean` too, and `required` would fail the read.
 * set through the environment, since `-c` splits a name at its `=`. a name Node decoded lossily can't be set, so it throws.
 */
async function filterless(
  run: Run,
  cwd: string,
): Promise<NodeJS.ProcessEnv | undefined> {
  const { stdout } = await run(
    'git',
    ['config', '-z', '--name-only', '--show-scope', '--list'],
    { cwd, timeout: 10_000 },
  );
  const entries = stdout.split('\0');
  const drivers = new Set<string>();
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const name = /^filter\.(.*)\.(?:clean|process)$/s.exec(
      entries[index + 1]!,
    )?.[1];
    if (name === undefined || !['local', 'worktree'].includes(entries[index]!))
      continue;
    if (name.includes('\uFFFD'))
      throw new Error("a filter driver's name isn't valid UTF-8");
    drivers.add(name);
  }
  if (!drivers.size) return undefined;
  const env: NodeJS.ProcessEnv = { ...process.env };
  let count = Number(process.env.GIT_CONFIG_COUNT) || 0;
  const set = (key: string, value: string) => {
    env[`GIT_CONFIG_KEY_${count}`] = key;
    env[`GIT_CONFIG_VALUE_${count++}`] = value;
  };
  for (const name of drivers) {
    set(`filter.${name}.process`, '');
    set(`filter.${name}.required`, 'false');
  }
  env.GIT_CONFIG_COUNT = String(count);
  return env;
}

/** reads `git status --porcelain=v2 --branch`. */
export function parseStatus(text: string): Repository {
  const repository: Repository = {
    branch: 'HEAD',
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    conflicts: 0,
    untracked: 0,
  };
  for (const line of text.split('\n')) {
    const [kind, field, value, other] = line.split(' ');
    if (kind === '#' && field === 'branch.head' && value !== '(detached)')
      repository.branch = value!;
    else if (kind === '#' && field === 'branch.ab') {
      repository.ahead = Number(value);
      repository.behind = -Number(other);
    } else if (kind === '1' || kind === '2') {
      if (field![0] !== '.') repository.staged++;
      if (field![1] !== '.') repository.modified++;
    } else if (kind === 'u') repository.conflicts++;
    else if (kind === '?') repository.untracked++;
  }
  return repository;
}

const pullRequestView = z.object({
  number: z.number(),
  url: z.string(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  statusCheckRollup: z
    .array(
      z.union([
        z.object({
          __typename: z.literal('CheckRun'),
          status: z.string(),
          conclusion: z.string().nullish(),
        }),
        z.object({ __typename: z.literal('StatusContext'), state: z.string() }),
      ]),
    )
    .nullish(),
});

/** reads `gh pr view --json number,state,statusCheckRollup,url,headRefName,headRefOid,baseRefName,mergeable`. */
export function parsePullRequest(json: string): PullRequest {
  const {
    number,
    url,
    state,
    headRefName,
    headRefOid,
    baseRefName,
    mergeable,
    statusCheckRollup,
  } = pullRequestView.parse(JSON.parse(json));
  const pullRequest = {
    number,
    url,
    state,
    branch: headRefName,
    commit: headRefOid,
    base: baseRefName,
  };
  if (state !== 'OPEN') return pullRequest;
  const checks = statusCheckRollup ?? [];
  const failing = checks.some((check) =>
    check.__typename === 'CheckRun'
      ? check.status === 'COMPLETED' &&
        !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion ?? '')
      : ['FAILURE', 'ERROR'].includes(check.state),
  );
  const pending = checks.some((check) =>
    check.__typename === 'CheckRun'
      ? check.status !== 'COMPLETED'
      : ['PENDING', 'EXPECTED'].includes(check.state),
  );
  return {
    ...pullRequest,
    checks:
      !checks.length || (!failing && pending)
        ? 'pending'
        : failing
          ? 'failing'
          : 'passing',
    mergeable,
  };
}

export type Run = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeout: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
) => Promise<{ stdout: string }>;

/** how soon a change is read, so one save's several writes take one read. */
const debounce = 100;

/** how often a watch retries a read Git failed with exit 128, since a fix such as `git init` in a parent or a global config edit sends no event. */
const retry = 60_000;

/**
 * the Git status of `cwd` for the status line, with its branch's pull request read in the background every 90
 * seconds, after 10 while GitHub hasn't computed its mergeability, and whenever the branch changes or
 * `refreshPullRequest` asks. on macOS a change in the work tree or its Git dirs starts a read, at most
 * one per `interval`, and a read Git failed with exit 128 is retried each minute. elsewhere, or once a watch fails,
 * status is read every `interval`, since Linux's recursive watch loses a file once it is replaced by rename. each read
 * shows until the next; a failed one leaves its field out.
 */
export class RepositoryWatch {
  snapshot?: Repository;
  private readonly listeners = new Set<() => void>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly interval: number;
  private pullRequest?: {
    branch: string;
    at: number;
    value?: PullRequest;
    project?: string;
  };
  /** a failed read confirms nothing, so it leaves this. */
  private conflict?: { branch: string; conflict: Conflict };
  private requested = false;
  private fetching = false;
  private refreshing = false;
  /** unset while polling. */
  private watchers?: FSWatcher[];
  private located = false;
  private scheduled?: ReturnType<typeof setTimeout>;
  /** a change arrived during the read in progress. */
  private stale = false;
  private startedAt = -Infinity;

  constructor(
    private readonly cwd: string,
    private readonly run: Run = execute,
    private readonly project?: () => Promise<string>,
    options: { interval?: number } = {},
  ) {
    this.interval = options.interval ?? 5000;
    if (process.platform === 'darwin')
      try {
        // the top level only until Git answers, so a plain directory such as home gets no events from below it
        this.watchers = [this.open(realpathSync(cwd), false)];
      } catch {
        // a missing directory polls
      }
    this.timer = setInterval(() => this.tick(), this.interval);
    this.timer.unref();
    void this.refresh();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  close(): void {
    clearInterval(this.timer);
    clearTimeout(this.scheduled);
    this.unwatch();
  }

  private open(directory: string, recursive: boolean): FSWatcher {
    const watcher = watch(directory, { recursive, persistent: false }, () =>
      this.changed(),
    );
    watcher.on('error', () => this.unwatch());
    return watcher;
  }

  /** leaves the timer polling. */
  private unwatch(): void {
    for (const watcher of this.watchers ?? []) watcher.close();
    this.watchers = undefined;
  }

  private tick(): void {
    if (
      !this.watchers ||
      (!this.snapshot && performance.now() - this.startedAt >= retry)
    ) {
      void this.refresh();
      return;
    }
    const branch = this.snapshot?.branch;
    if (branch && this.due(branch)) void this.fetchPullRequest(branch);
  }

  /** reads the branch's pull request on the next tick, or on the first after a read in progress. */
  refreshPullRequest(): void {
    this.requested = true;
  }

  private due(branch: string): boolean {
    const known = this.pullRequest;
    if (branch === 'HEAD' || this.fetching) return false;
    if (this.requested || known?.branch !== branch) return true;
    const wait = known.value?.mergeable === 'UNKNOWN' ? 10_000 : 90_000;
    return Date.now() - known.at >= wait;
  }

  /** reads soon after a change, but no sooner than `interval` after the previous read started. */
  private changed(): void {
    if (this.refreshing) {
      this.stale = true;
      return;
    }
    if (this.scheduled) return;
    this.scheduled = setTimeout(
      () => {
        this.scheduled = undefined;
        void this.refresh();
      },
      Math.max(debounce, this.startedAt + this.interval - performance.now()),
    );
    this.scheduled.unref();
  }

  /** widens the watch to the work tree and the Git dirs outside it, all of which `git status` reads. */
  private async locate(): Promise<void> {
    this.located = true;
    let paths: string[];
    try {
      const { stdout } = await this.run(
        'git',
        [
          'rev-parse',
          '--path-format=absolute',
          '--show-toplevel',
          '--git-dir',
          '--git-common-dir',
        ],
        { cwd: this.cwd, timeout: 10_000 },
      );
      paths = stdout.split('\n').filter(Boolean);
    } catch {
      // the top-level watch would miss changes below it, so poll instead
      this.unwatch();
      return;
    }
    const previous = this.watchers;
    if (!previous) return;
    const roots: string[] = [];
    for (const path of paths.toSorted((a, b) => a.length - b.length))
      if (!roots.some((root) => path === root || path.startsWith(root + sep)))
        roots.push(path);
    const opened: FSWatcher[] = [];
    try {
      for (const root of roots) opened.push(this.open(root, true));
    } catch {
      for (const watcher of opened) watcher.close();
      this.unwatch();
      return;
    }
    // the new watches open before the old one closes, and a read covers anything between them
    this.watchers = opened;
    for (const watcher of previous) watcher.close();
    this.changed();
  }

  private async refresh(): Promise<void> {
    // a status read can outlast the interval, and a slower, older read would publish over a newer one
    if (this.refreshing) return;
    this.refreshing = true;
    this.stale = false;
    this.startedAt = performance.now();
    let repository: Repository | undefined;
    let failure: unknown;
    try {
      const env = await filterless(this.run, this.cwd);
      const { stdout } = await this.run(
        'git',
        // a submodule's own config could run a filter; merge cleanup's own read still counts dirty submodules
        [...statusArgs, '--ignore-submodules=dirty'],
        {
          cwd: this.cwd,
          timeout: 10_000,
          env: {
            ...(env ?? process.env),
            GIT_NO_LAZY_FETCH: '1',
            // older Git ignores GIT_NO_LAZY_FETCH, so transports stay disabled too
            GIT_ALLOW_PROTOCOL: '',
          },
        },
      );
      repository = parseStatus(stdout);
    } catch (error) {
      // unavailable status leaves Git out, including when a partial clone lacks an object
      failure = error;
    } finally {
      this.refreshing = false;
    }
    const known = this.pullRequest;
    if (repository && known?.branch === repository.branch) {
      repository.pullRequest = known.value;
      if (known.project !== undefined)
        repository.pullRequestProject = known.project;
    }
    this.publish(repository);
    if (this.watchers) {
      if (repository && !this.located) void this.locate();
      // exit 128 is any Git fatal error, such as outside a repository, and waits for tick's minute retry; a timeout or a failed spawn may pass sooner
      if (
        this.stale ||
        (failure !== undefined && (failure as { code?: unknown }).code !== 128)
      )
        this.changed();
    }
    if (repository && this.due(repository.branch))
      void this.fetchPullRequest(repository.branch);
  }

  private async fetchPullRequest(branch: string): Promise<void> {
    this.fetching = true;
    this.requested = false;
    let value: PullRequest | undefined;
    let project: string | undefined;
    try {
      project = await this.project?.();
      const { stdout } = await this.run(
        'gh',
        [
          'pr',
          'view',
          '--json',
          'number,state,statusCheckRollup,url,headRefName,headRefOid,baseRefName,mergeable',
        ],
        { cwd: this.cwd, timeout: 30_000 },
      );
      value = parsePullRequest(stdout);
      if (this.project && project !== (await this.project())) value = undefined;
      if (value) this.conflict = await this.conflicted(branch, value);
    } catch {
      // no pull request, no gh or no network
    } finally {
      this.fetching = false;
    }
    this.pullRequest = { branch, at: Date.now(), value, project };
    if (this.snapshot?.branch === branch)
      this.publish({
        ...this.snapshot,
        pullRequest: value,
        ...(project === undefined ? {} : { pullRequestProject: project }),
      });
  }

  /** an `UNKNOWN` read at the same head and base keeps the conflict, since GitHub is still computing it. */
  private async conflicted(
    branch: string,
    value: PullRequest,
  ): Promise<{ branch: string; conflict: Conflict } | undefined> {
    if (value.mergeable === 'CONFLICTING') {
      const baseTip = await this.tip(value);
      return {
        branch,
        conflict: { pullRequest: value, ...(baseTip ? { baseTip } : {}) },
      };
    }
    const known = this.conflict;
    const { url, commit, base } = known?.conflict.pullRequest ?? {};
    return value.mergeable === 'UNKNOWN' &&
      known?.branch === branch &&
      value.url === url &&
      value.commit === commit &&
      value.base === base
      ? known
      : undefined;
  }

  /** the base branch's current tip, which gh's `baseRefOid` isn't, from the pull request's own repository. */
  private async tip({ url, base }: PullRequest): Promise<string | undefined> {
    const [, host, repository] =
      /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\//.exec(url) ?? [];
    if (!host || !repository) return;
    try {
      const { stdout } = await this.run(
        'gh',
        [
          'api',
          '--hostname',
          host,
          `repos/${repository}/commits/${base}`,
          '--jq',
          '.sha',
        ],
        { cwd: this.cwd, timeout: 30_000 },
      );
      return stdout.trim() || undefined;
    } catch {
      return;
    }
  }

  /** an unchanged status publishes nothing, so a quiet repository costs no redraws. */
  private publish(repository: Repository | undefined): void {
    if (repository) {
      repository = { ...repository };
      if (this.conflict?.branch === repository.branch)
        repository.conflict = this.conflict.conflict;
      else delete repository.conflict;
    }
    if (JSON.stringify(repository) === JSON.stringify(this.snapshot)) return;
    this.snapshot = repository;
    for (const listener of this.listeners) listener();
  }
}
