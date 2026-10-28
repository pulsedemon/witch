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
}

/** avoid optional locks that contend with the user's Git commands. */
export const statusArgs = [
  '--no-optional-locks',
  'status',
  '--porcelain=v2',
  '--branch',
] as const;

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

/** reads `gh pr view --json number,state,statusCheckRollup,url,headRefName,headRefOid,baseRefName`. */
export function parsePullRequest(json: string): PullRequest {
  const {
    number,
    url,
    state,
    headRefName,
    headRefOid,
    baseRefName,
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
  };
}

export type Run = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ stdout: string }>;

/** how soon a change is read, so one save's several writes take one read. */
const settle = 100;

/**
 * the Git status of `cwd` for the status line, with its branch's pull request read in the background every 90
 * seconds and whenever the branch changes. On macOS a change in the work tree or its Git dirs starts a read, at most
 * one per `interval`. Elsewhere, or once a watch fails, status is read every `interval`, since Linux's recursive watch
 * loses a file once it is replaced by rename. Each read shows until the next; a failed one leaves its field out.
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
        // the top level only until Git answers, so a plain directory such as the home folder costs no events
        this.watchers = [this.open(realpathSync(cwd), false)];
      } catch {
        // a missing directory polls, as before
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
    if (!this.watchers) {
      void this.refresh();
      return;
    }
    const branch = this.snapshot?.branch;
    if (branch && this.due(branch)) void this.fetchPullRequest(branch);
  }

  private due(branch: string): boolean {
    const known = this.pullRequest;
    return (
      branch !== 'HEAD' &&
      !this.fetching &&
      (known?.branch !== branch || Date.now() - known.at >= 90_000)
    );
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
      Math.max(settle, this.startedAt + this.interval - performance.now()),
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
      const { stdout } = await this.run('git', [...statusArgs], {
        cwd: this.cwd,
        timeout: 10_000,
      });
      repository = parseStatus(stdout);
    } catch (error) {
      // not a repository, or Git is busy; the status line leaves Git out
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
      // Git exits 128 outside a repository, which only a change can end; a timeout or a failed spawn may pass
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
          'number,state,statusCheckRollup,url,headRefName,headRefOid,baseRefName',
        ],
        { cwd: this.cwd, timeout: 30_000 },
      );
      value = parsePullRequest(stdout);
      if (this.project && project !== (await this.project())) value = undefined;
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

  /** an unchanged status publishes nothing, so a quiet repository costs no redraws. */
  private publish(repository: Repository | undefined): void {
    if (JSON.stringify(repository) === JSON.stringify(this.snapshot)) return;
    this.snapshot = repository;
    for (const listener of this.listeners) listener();
  }
}
