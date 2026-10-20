import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);

export interface PullRequest {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  /** the branch it merges, that branch's last commit, and the branch it merges into. */
  branch: string;
  commit: string;
  base: string;
  /** an open pull request's checks, pending while it has none. */
  checks?: 'passing' | 'failing' | 'pending';
}

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

/**
 * the Git status of `cwd` for the status line, read every 5 seconds, with its branch's pull request read in the
 * background every 90 seconds and whenever the branch changes. Each read shows until the next; a failed one leaves
 * its field out.
 */
export class RepositoryWatch {
  snapshot?: Repository;
  private readonly listeners = new Set<() => void>();
  private readonly timer: ReturnType<typeof setInterval>;
  private pullRequest?: { branch: string; at: number; value?: PullRequest };
  private fetching = false;
  private refreshing = false;

  constructor(
    private readonly cwd: string,
    private readonly run: Run = execute,
  ) {
    this.timer = setInterval(() => void this.refresh(), 5000);
    this.timer.unref();
    void this.refresh();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  close(): void {
    clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    // a status read can outlast the interval, and a slower, older read would publish over a newer one
    if (this.refreshing) return;
    this.refreshing = true;
    let repository: Repository | undefined;
    try {
      // optional locks would contend with the user's own Git commands
      const { stdout } = await this.run(
        'git',
        ['--no-optional-locks', 'status', '--porcelain=v2', '--branch'],
        { cwd: this.cwd, timeout: 10_000 },
      );
      repository = parseStatus(stdout);
    } catch {
      // not a repository, or Git is busy; the status line leaves Git out
    } finally {
      this.refreshing = false;
    }
    const known = this.pullRequest;
    if (repository && known?.branch === repository.branch)
      repository.pullRequest = known.value;
    this.publish(repository);
    if (
      repository &&
      repository.branch !== 'HEAD' &&
      !this.fetching &&
      (known?.branch !== repository.branch || Date.now() - known.at >= 90_000)
    )
      void this.fetchPullRequest(repository.branch);
  }

  private async fetchPullRequest(branch: string): Promise<void> {
    this.fetching = true;
    let value: PullRequest | undefined;
    try {
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
    } catch {
      // no pull request, no gh or no network
    } finally {
      this.fetching = false;
    }
    this.pullRequest = { branch, at: Date.now(), value };
    if (this.snapshot?.branch === branch)
      this.publish({ ...this.snapshot, pullRequest: value });
  }

  /** an unchanged status publishes nothing, so a quiet repository costs no redraws. */
  private publish(repository: Repository | undefined): void {
    if (JSON.stringify(repository) === JSON.stringify(this.snapshot)) return;
    this.snapshot = repository;
    for (const listener of this.listeners) listener();
  }
}
