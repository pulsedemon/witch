import { execFile } from 'node:child_process';
import { realpathSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { promisify } from 'node:util';
import { z } from 'zod';
import { errorMessage, issuesText } from '../../errors.js';
import { within } from '../../paths.js';

const execute = promisify(execFile);

export const pullRequestSchema = z.object({
  number: z.number(),
  url: z.string(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  /** the branch it merges, that branch's last commit, and the branch it merges into. */
  branch: z.string(),
  commit: z.string(),
  base: z.string(),
  /** an empty rollup starts as none; the watch keeps it pending while checks are expected. */
  checks: z.enum(['passing', 'failing', 'pending', 'none']).optional(),
  /** the checks that make it failing, with their details pages. */
  failed: z
    .array(z.object({ name: z.string(), url: z.string().optional() }))
    .optional(),
  /** an open pull request's mergeability as GitHub last computed it, `UNKNOWN` while it computes. */
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).optional(),
  /** a merged pull request's merge time, as GitHub's ISO 8601 timestamp. */
  mergedAt: z.string().optional(),
});

export type PullRequest = z.infer<typeof pullRequestSchema>;

export interface Repository {
  /** `HEAD` when detached. */
  branch: string;
  commit?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  conflicts: number;
  /** entries, so a wholly untracked directory counts once. */
  untracked: number;
  pullRequest?: PullRequest;
  /** the branch's last read answered that it has no pull request, or `HEAD` is detached. unset while a read is pending or failed. */
  pullRequestAbsent?: true;
  pullRequestProject?: string;
  /** why the branch's last pull request read, or its checks or base tip read, failed unexpectedly; unset once they work or while `gh` has no answer. */
  pullRequestFailure?: string;
  /** the branch's pull request as last read conflicting, with its base's tip when that read looked it up. */
  conflict?: Conflict;
  /** open pull requests of branches this checkout left, newest first, and a merged one until its cleanup settles. */
  followed?: PullRequest[];
  /** the project `followed` was read in. */
  followedProject?: string;
  /**
   * why the last read for a pull request this checkout left failed unexpectedly: its number or branch with the reason,
   * `previous branch` for the branch checked out before startup, or a failed project read's own reason.
   */
  followedFailure?: string;
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

/** a status read's environment: the repository's own filters blanked, and no lazy fetch or transport. */
export async function statusEnv(
  run: Run,
  cwd: string,
): Promise<NodeJS.ProcessEnv> {
  return {
    ...((await filterless(run, cwd)) ?? process.env),
    GIT_NO_LAZY_FETCH: '1',
    // older Git ignores GIT_NO_LAZY_FETCH, so transports stay disabled too
    GIT_ALLOW_PROTOCOL: '',
  };
}

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
    else if (kind === '#' && field === 'branch.oid' && value !== '(initial)')
      repository.commit = value;
    else if (kind === '#' && field === 'branch.upstream')
      repository.upstream = value;
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

/** the fields `gh pr view` and GitHub's GraphQL API name a pull request with. */
export const gitHubPullRequestFields = z.object({
  number: z.number(),
  url: z.string(),
  state: pullRequestSchema.shape.state,
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string(),
});

export function fromGitHub({
  number,
  url,
  state,
  headRefName,
  headRefOid,
  baseRefName,
}: z.infer<typeof gitHubPullRequestFields>): Pick<
  PullRequest,
  'number' | 'url' | 'state' | 'branch' | 'commit' | 'base'
> {
  return {
    number,
    url,
    state,
    branch: headRefName,
    commit: headRefOid,
    base: baseRefName,
  };
}

/** the host and `owner/name` of a pull request's repository, read from the pull request's URL. */
export function gitHubRepository(
  url: string,
): { host: string; repository: string } | undefined {
  const [, host, repository] =
    /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\//.exec(url) ?? [];

  return host && repository ? { host, repository } : undefined;
}

const pullRequestView = gitHubPullRequestFields.extend({
  mergeable: pullRequestSchema.shape.mergeable.unwrap(),
  mergedAt: z.string().nullish(),
  statusCheckRollup: z
    .array(
      z.union([
        z.object({
          __typename: z.literal('CheckRun'),
          name: z.string(),
          detailsUrl: z.string().nullish(),
          status: z.string(),
          conclusion: z.string().nullish(),
        }),
        z.object({
          __typename: z.literal('StatusContext'),
          context: z.string(),
          targetUrl: z.string().nullish(),
          state: z.string(),
        }),
      ]),
    )
    .nullish(),
});

/** reads `gh pr view --json number,state,statusCheckRollup,url,headRefName,headRefOid,baseRefName,mergeable,mergedAt`. */
export function parsePullRequest(json: string): PullRequest {
  const view = pullRequestView.parse(JSON.parse(json));
  const { state, mergeable, mergedAt, statusCheckRollup } = view;
  const pullRequest = fromGitHub(view);

  if (state !== 'OPEN')
    return mergedAt ? { ...pullRequest, mergedAt } : pullRequest;

  // GitHub's rollup holds each check's latest run, so a rerun in progress hides its earlier failure
  const checks = statusCheckRollup ?? [];

  const named = (name: string, url: string | null | undefined) => [
    { name, ...(url ? { url } : {}) },
  ];

  const failed = checks.flatMap((entry) =>
    entry.__typename === 'CheckRun'
      ? entry.status === 'COMPLETED' &&
        !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(entry.conclusion ?? '')
        ? named(entry.name, entry.detailsUrl)
        : []
      : ['FAILURE', 'ERROR'].includes(entry.state)
        ? named(entry.context, entry.targetUrl)
        : [],
  );

  const failing = failed.length > 0;

  const pending = checks.some((check) =>
    check.__typename === 'CheckRun'
      ? check.status !== 'COMPLETED'
      : ['PENDING', 'EXPECTED'].includes(check.state),
  );

  return {
    ...pullRequest,
    checks: !checks.length
      ? 'none'
      : failing
        ? 'failing'
        : pending
          ? 'pending'
          : 'passing',
    ...(failing ? { failed } : {}),
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
    maxBuffer?: number;
  },
) => Promise<{ stdout: string; stderr?: string }>;

/**
 * `gh` ran and said no, as without a pull request, a network or a login, ran out of time, or isn't installed. execFile
 * rejects with an exit status or no code for those, and with another errno when the spawn itself failed. an answer that
 * can't be parsed has no code either, and isn't one of them.
 */
function unavailable(error: unknown): boolean {
  if (error instanceof SyntaxError || error instanceof z.ZodError) return false;

  const { code } = error as { code?: unknown };

  return typeof code !== 'string' || code === 'ENOENT';
}

/** a failed read on one line; zod's own message is a JSON document. */
const reason = (error: unknown) =>
  error instanceof z.ZodError ? issuesText(error) : errorMessage(error);

/** `gh pr view` found no pull request, which answers a read where any other failure leaves it open. */
const missing = (error: unknown) =>
  /no pull requests found/.test(
    `${String((error as { stderr?: unknown }).stderr ?? '')}\n${errorMessage(error)}`,
  );

/** how long a pull request read stands before the next. */
const reread = 90_000;

/** a pull request as a read found it. */
interface Reading {
  value: PullRequest;
  /** when that read began, which orders it against other reads of the same pull request */
  started: number;
  /** when it was read or its next read was last attempted, which the interval counts from */
  at: number;
  /** why its last read by URL, or the read that found it, failed in a way nobody expects */
  failure?: string;
}

/** a branch waiting for a read by name. */
interface Queued {
  /** when its read last ran */
  at: number;
  /** why that read failed in a way nobody expects */
  failure?: string;
}

/** a reading taken now, with what its read failed at. */
function reading(
  value: PullRequest,
  started: number,
  failures: string[],
): Reading {
  const result: Reading = { value, started, at: Date.now() };

  if (failures.length) result.failure = failures.join('; ');

  return result;
}

/** how soon a change is read, so one save's several writes take one read. */
const debounce = 100;
/**
 * how long a watch goes without a read before it reads anyway, since FSEvents can drop an event under load and a fix
 * for a read Git failed with exit 128, such as `git init` in a parent or a global config edit, sends none.
 */
const fallback = 60_000;

/**
 * the Git status of `cwd` for the status line, with its branch's pull request read in the background every 90
 * seconds, after 10 while GitHub hasn't computed its mergeability, and whenever the head or upstream status changes or
 * `refreshPullRequest` asks. on macOS a change in the work tree or its Git dirs starts a read, at most
 * one per `interval`, and a minute without a read starts one, so a change whose event is lost shows within a minute
 * and one `interval`. elsewhere, or once a watch fails, status is read every `interval`, since Linux's recursive watch
 * loses a file once it is replaced by rename. each read shows until the next; a failed one leaves its field out, and a
 * pull request read that failed for a reason nobody expects says why in `pullRequestFailure`. the pull request of a
 * branch the checkout left stays in `followed`, an open one read by its URL every 90 seconds, until it closes, the
 * checkout returns to its branch, `unfollow` drops it or the project changes. while `gh` has no answer for one, it
 * keeps its last reading.
 */
export class RepositoryWatch {
  snapshot?: Repository;
  private readonly listeners = new Set<() => void>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly interval: number;
  private pullRequest?: {
    branch: string;
    at: number;
    /** when the read began, so a merge recorded while it ran counts as after it */
    started: number;
    value?: PullRequest;
    absent: boolean;
    project?: string;
    failure?: string;
  };
  /** a failed read confirms nothing, so it leaves this. */
  private conflict?: { branch: string; conflict: Conflict };
  /** the branch of the last status read that worked, so a failed read between two branches still counts as leaving. */
  private branch?: string;
  /** the checked-out branch's own pull request as last read, which a later failed or empty read leaves. */
  private kept?: Reading;
  private readonly followed: Reading[] = [];
  /** the order each branch was last left in, which `followed` keeps, newest first. */
  private readonly left = new Map<string, number>();
  private departures = 0;
  /** branches left with no pull request read, or with one that merged or closed. */
  private readonly names = new Map<string, Queued>();
  /** when each URL last left `followed` for good, so a read begun before that can't bring it back. */
  private readonly departed = new Map<string, number>();
  /** the last answer of a project read, which everything followed belongs to. */
  private current?: { project?: string };
  /** why the last round's project read failed. */
  private projectFailure?: string;
  /** whether Git answered for the branch checked out before this one. until it does, each status read asks again. */
  private recalled = false;
  private recalling = false;
  private recallFailure?: string;
  private following?: Promise<void>;
  private requested = false;
  private fetching?: Promise<void>;
  private refreshing?: Promise<void>;
  private closed = false;
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
    this.closed = true;
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
    this.readFollowed();

    if (!this.watchers || performance.now() - this.startedAt >= fallback) {
      void this.refresh();

      return;
    }

    const branch = this.snapshot?.branch;

    if (branch && this.due(branch)) void this.fetchPullRequest(branch);
  }

  /** when the read behind the pull request last read began. */
  get pullRequestReadAt(): number | undefined {
    return this.pullRequest?.started;
  }

  /** reads the branch's pull request on the next tick, or on the first after a read in progress. */
  refreshPullRequest(): void {
    this.requested = true;
  }

  /** an admission needs a read started after its request, including when an older read is still running. */
  async readPullRequest(): Promise<void> {
    await this.refreshing;
    await this.refresh();
    await this.fetching;
    const branch = this.snapshot?.branch;

    if (this.closed || !branch || branch === 'HEAD') return;

    await this.fetchPullRequest(branch);
    await this.refreshing;
    await this.refresh();
  }

  private due(branch: string): boolean {
    const known = this.pullRequest;

    if (this.closed || branch === 'HEAD' || this.fetching) return false;

    if (this.requested || known?.branch !== branch) return true;

    const wait = known.value?.mergeable === 'UNKNOWN' ? 10_000 : reread;

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
      if (!roots.some((root) => within(path, root))) roots.push(path);

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

  private refresh(): Promise<void> {
    // a status read can outlast the interval, and a slower, older read would publish over a newer one
    if (this.closed) return Promise.resolve();

    return (this.refreshing ??= this.readStatus());
  }

  private async readStatus(): Promise<void> {
    this.stale = false;
    // this read covers a change still waiting for its own, such as when the minute timer starts it first
    clearTimeout(this.scheduled);
    this.scheduled = undefined;
    this.startedAt = performance.now();
    let repository: Repository | undefined;
    let failure: unknown;

    try {
      const { stdout } = await this.run(
        'git',
        // a submodule's own config could run a filter; merge cleanup's own read still counts dirty submodules
        [...statusArgs, '--ignore-submodules=dirty'],
        {
          cwd: this.cwd,
          timeout: 10_000,
          env: await statusEnv(this.run, this.cwd),
        },
      );

      repository = parseStatus(stdout);
    } catch (error) {
      // unavailable status leaves Git out, including when a partial clone lacks an object
      failure = error;
    } finally {
      this.refreshing = undefined;
    }

    if (this.closed) return;

    const previous = this.snapshot;

    if (
      repository &&
      (!previous ||
        previous.branch !== repository.branch ||
        previous.commit !== repository.commit ||
        previous.upstream !== repository.upstream ||
        previous.ahead !== repository.ahead ||
        previous.behind !== repository.behind)
    )
      this.refreshPullRequest();

    if (repository) this.arrive(repository.branch);

    const known = this.pullRequest;

    if (repository?.branch === 'HEAD') repository.pullRequestAbsent = true;

    if (repository && known?.branch === repository.branch) {
      repository.pullRequest = known.value;

      if (known.absent) repository.pullRequestAbsent = true;

      if (known.project !== undefined)
        repository.pullRequestProject = known.project;

      if (known.failure !== undefined)
        repository.pullRequestFailure = known.failure;
    }

    this.publish(repository);

    if (this.watchers) {
      if (repository && !this.located) void this.locate();

      // exit 128 is any Git fatal error, such as outside a repository, and waits for tick's minute read; a timeout or a failed spawn may pass sooner
      if (
        this.stale ||
        (failure !== undefined && (failure as { code?: unknown }).code !== 128)
      )
        this.changed();
    }

    if (repository && this.due(repository.branch))
      void this.fetchPullRequest(repository.branch);

    this.readFollowed();
  }

  private fetchPullRequest(branch: string): Promise<void> {
    return (this.fetching ??= this.fetch(branch));
  }

  private async fetch(branch: string): Promise<void> {
    this.requested = false;
    const started = Date.now();
    const commit = this.snapshot?.commit;
    let value: PullRequest | undefined;
    /** the value before a checkout that moved meanwhile drops it */
    let read: PullRequest | undefined;
    let absent = false;
    let project: string | undefined;
    const failures = new Set<string>();

    // the checks and base tip reads keep their fallbacks when they fail, and say why when nobody expects the failure
    const report = (error: unknown) => {
      if (!unavailable(error)) failures.add(reason(error));
    };

    try {
      project = await this.readProject();

      const view = await this.view().catch((error: unknown) => {
        if (!unavailable(error)) throw error;

        absent = missing(error);
      });

      if (view) {
        value = await this.withChecks(view, report);
        const conflict = await this.conflicted(branch, value, report);

        if (this.project && project !== (await this.readProject()))
          value = undefined;

        read = value;

        if (
          this.closed ||
          this.snapshot?.branch !== branch ||
          this.snapshot.commit !== commit
        ) {
          value = undefined;
          this.refreshPullRequest();
        }

        if (value) this.conflict = conflict;
      }
    } catch (error) {
      value = undefined;
      failures.add(reason(error));
    } finally {
      this.fetching = undefined;
    }

    let failure = [...failures].join('; ') || undefined;

    if (read?.branch === branch) {
      const found = reading(read, started, []);

      // a read by URL taken back on a return to the branch can be newer than this one
      if (this.branch === branch) {
        if (this.kept?.value.url !== read.url || this.kept.started <= started)
          this.kept = found;
      }
      // the checkout left during the read, so this is the read its leaving had none of
      else if (
        read.state !== 'CLOSED' &&
        started > (this.departed.get(read.url) ?? -Infinity)
      ) {
        if (failure !== undefined)
          found.failure = `#${read.number}: ${failure}`;

        this.follow(found);
        this.names.delete(branch);
        failure = undefined;
        this.publish(this.snapshot);
      }
    }

    this.pullRequest = {
      branch,
      at: Date.now(),
      started,
      value,
      absent,
      project,
      failure,
    };

    if (this.snapshot?.branch !== branch) return;

    const repository: Repository = {
      ...this.snapshot,
      pullRequest: value,
      ...(project === undefined ? {} : { pullRequestProject: project }),
    };

    if (absent) repository.pullRequestAbsent = true;
    else delete repository.pullRequestAbsent;

    if (failure === undefined) delete repository.pullRequestFailure;
    else repository.pullRequestFailure = failure;

    this.publish(repository);
  }

  /** `gh`'s answer for the checked-out branch's pull request, or for a branch name or URL. rejects with `gh`'s own error, or a parse error for an answer that isn't a pull request. */
  private async view(selector?: string): Promise<PullRequest> {
    const { stdout } = await this.run(
      'gh',
      [
        'pr',
        'view',
        ...(selector === undefined ? [] : [selector]),
        '--json',
        'number,state,statusCheckRollup,url,headRefName,headRefOid,baseRefName,mergeable,mergedAt',
      ],
      { cwd: this.cwd, timeout: 30_000 },
    );

    return parsePullRequest(stdout);
  }

  /** an empty rollup reads as pending while the head's workflows will report checks. */
  private async withChecks(
    value: PullRequest,
    report: (error: unknown) => void,
  ): Promise<PullRequest> {
    if (value.checks === 'none' && (await this.checksExpected(value, report)))
      value.checks = 'pending';

    return value;
  }

  /** another project's answer empties everything followed first, so nothing read under one project is used under the next. */
  private async readProject(): Promise<string | undefined> {
    const project = await this.project?.();

    if (this.current && this.current.project !== project) {
      this.followed.length = 0;
      this.names.clear();
      this.left.clear();
      this.departed.clear();
      this.kept = undefined;
    }

    this.current = { project };

    return project;
  }

  /** drops a followed pull request, as once its merge is cleaned up. */
  unfollow(url: string): void {
    this.departed.set(url, Date.now());

    if (this.drop(url)) this.publish(this.snapshot);
  }

  private drop(url: string): boolean {
    const index = this.followed.findIndex(({ value }) => value.url === url);

    if (index >= 0) this.followed.splice(index, 1);

    return index >= 0;
  }

  /**
   * a newer read of a pull request already followed replaces it in place, and an older one is dropped. a new one sorts
   * by when its branch was left, however late its read found it.
   */
  private follow(reading: Reading): void {
    const index = this.followed.findIndex(
      ({ value }) => value.url === reading.value.url,
    );

    if (index < 0) {
      const order = ({ value }: Reading) => this.left.get(value.branch) ?? 0;

      const later = this.followed.filter(
        (entry) => order(entry) > order(reading),
      );

      this.followed.splice(later.length, 0, reading);
    } else if (this.followed[index]!.started <= reading.started)
      this.followed[index] = reading;
  }

  /** follows the pull request of the branch a status read shows the checkout left, and takes back the one it returned to. */
  private arrive(branch: string): void {
    const left = this.branch;
    this.branch = branch;

    if (!this.recalled && !this.recalling) void this.recall();

    if (left === undefined || left === branch) return;

    const kept = this.kept;

    const index = this.followed.findIndex(
      ({ value }) => value.branch === branch,
    );

    const [returned] = index < 0 ? [] : this.followed.splice(index, 1);

    // a failure of its read by URL is not the branch's own
    this.kept = returned && {
      value: returned.value,
      started: returned.started,
      at: returned.at,
    };

    this.names.delete(branch);

    if (left === 'HEAD') return;

    this.left.set(left, ++this.departures);

    if (kept && kept.value.state !== 'CLOSED') this.follow(kept);

    // a branch whose pull request closed or merged can have a newer one
    if (kept?.value.state !== 'OPEN') this.queue(left);
  }

  /** queues a read by name, unless `gh` would take the name for a flag, which Git's own commands refuse to create. */
  private queue(name: string): void {
    if (!name.startsWith('-')) this.names.set(name, { at: -Infinity });
  }

  /** the branch checked out before this one, which a restart on the base would otherwise forget. */
  private async recall(): Promise<void> {
    this.recalling = true;
    let name: string | undefined;
    let failure: string | undefined;

    try {
      const { stdout } = await this.run(
        'git',
        ['rev-parse', '--verify', '--quiet', '--symbolic-full-name', '@{-1}'],
        { cwd: this.cwd, timeout: 10_000 },
      );

      name = /^refs\/heads\/(.+)$/.exec(stdout.trim())?.[1];
      this.recalled = true;
    } catch (error) {
      // with --verify --quiet, Git exits 1 when there is no previous branch. any other failure is asked again
      this.recalled = (error as { code?: unknown }).code === 1;

      if (!this.recalled) failure = `previous branch: ${reason(error)}`;
    } finally {
      this.recalling = false;
    }

    if (this.closed) return;

    if (failure !== this.recallFailure) {
      this.recallFailure = failure;
      this.publish(this.snapshot);
    }

    if (!name || name === this.branch) return;

    this.queue(name);
    this.readFollowed();
  }

  private readFollowed(): void {
    const now = Date.now();

    if (
      this.closed ||
      this.following ||
      ![...this.names.values(), ...this.followed].some(
        ({ at }) => now - at >= reread,
      )
    )
      return;

    this.following = this.round(now).finally(() => {
      this.following = undefined;
    });
  }

  /**
   * reads the pull requests that were due at `now`: a queued branch by name, which follows an open one, and a followed
   * one by URL. the project is read before and after, and a round that saw it change accepts nothing. a failure stays
   * with the name or pull request whose read it was, so a round changes only those it read.
   */
  private async round(now: number): Promise<void> {
    const accepted: (() => void)[] = [];
    let failure: string | undefined;

    try {
      const project = await this.readProject();
      const due = (at: number) => now - at >= reread;
      const asked = new Set<string>();

      for (const [name, { at }] of [...this.names]) {
        const last = this.names.get(name);

        // the checkout can return to a branch, or the project change, while an earlier read runs
        if (!due(at) || !last) continue;

        const started = Date.now();
        // its last failure shows until this read answers
        const queued: Queued = { ...last, at: started };
        this.names.set(name, queued);
        asked.add(name);
        // a return to the branch drops the name, and leaving again queues it anew for a later read to answer
        const current = () => this.names.get(name) === queued;
        const failures: string[] = [];

        try {
          const value = await this.view(name);

          const open =
            value.state === 'OPEN' &&
            value.branch === name &&
            this.branch !== name &&
            (await this.withChecks(value, (error) => {
              if (!unavailable(error))
                failures.push(`${name}: ${reason(error)}`);
            }));

          accepted.push(() => {
            if (!current()) return;

            this.names.delete(name);

            if (
              open &&
              this.branch !== name &&
              started > (this.departed.get(open.url) ?? -Infinity)
            )
              this.follow(reading(open, started, failures));
          });
        } catch (error) {
          if (missing(error))
            accepted.push(() => {
              if (current()) this.names.delete(name);
            });
          else if (!unavailable(error))
            queued.failure = `${name}: ${reason(error)}`;
          else {
            // gh has no answer for any name right now, so those not read yet wait out the interval with this one
            for (const [other, waiting] of this.names)
              if (!asked.has(other)) waiting.at = started;

            break;
          }
        }
      }

      for (const entry of [...this.followed]) {
        if (!due(entry.at) || !this.followed.includes(entry)) continue;

        const started = Date.now();
        entry.at = started;

        // a merged one waits for its cleanup, and only its project is checked
        if (entry.value.state === 'MERGED') continue;

        const { url, number } = entry.value;
        const failures: string[] = [];

        try {
          const value = await this.withChecks(await this.view(url), (error) => {
            if (!unavailable(error))
              failures.push(`#${number}: ${reason(error)}`);
          });

          accepted.push(() => {
            const current = this.followed.find(
              (entry) => entry.value.url === url,
            );

            // one removed while its read ran stays removed, and one read again since keeps that newer answer
            if (!current || current.started > started) return;

            if (value.state !== 'CLOSED')
              this.follow(reading(value, started, failures));
            else if (this.drop(url)) this.departed.set(url, Date.now());
          });
        } catch (error) {
          if (unavailable(error)) {
            // as for the names: gh has no answer right now, so the rest wait out the interval too
            for (const other of this.followed) other.at = started;

            break;
          }

          accepted.push(() => {
            const current = this.followed.find(
              (entry) => entry.value.url === url,
            );

            if (!current || current.started > started) return;

            this.follow({
              ...current,
              started,
              at: started,
              failure: `#${number}: ${reason(error)}`,
            });
          });
        }
      }

      if ((await this.readProject()) === project)
        for (const accept of accepted) accept();
    } catch (error) {
      // the project read failed, so everything due waits out another interval
      for (const waiting of [...this.names.values(), ...this.followed])
        if (now - waiting.at >= reread) waiting.at = Date.now();

      failure = reason(error);
    }

    this.projectFailure = failure;
    this.publish(this.snapshot);
  }

  private async checksExpected(
    pr: PullRequest,
    report: (error: unknown) => void,
  ): Promise<boolean> {
    const github = gitHubRepository(pr.url);

    if (!github) return true;

    const [owner, name] = github.repository.split('/');

    const tree = z
      .object({
        __typename: z.literal('Tree'),
        entries: z.array(z.object({ name: z.string(), type: z.string() })),
      })
      .nullable();

    const fields = '__typename ... on Tree { entries { name type } }';

    const api = async (args: string[]) => {
      const { stdout } = await this.run(
        'gh',
        ['api', '--hostname', github.host, ...args],
        { cwd: this.cwd, timeout: 30_000 },
      );

      return JSON.parse(stdout) as unknown;
    };

    try {
      const { data } = z
        .object({
          data: z.object({
            repository: z.object({
              object: tree,
              pullRequest: z.object({
                headRefOid: z.string(),
                baseRefName: z.string(),
                baseRef: z.object({
                  target: z.object({
                    statusCheckRollup: z
                      .object({
                        contexts: z.object({ totalCount: z.number() }),
                      })
                      .nullable(),
                  }),
                }),
                headRepository: z.object({ object: tree }),
              }),
            }),
          }),
          errors: z.array(z.unknown()).max(0).optional(),
        })
        .parse(
          await api([
            'graphql',
            '-f',
            `query=query($owner:String!,$name:String!,$number:Int!,$head:String!,$base:String!) {
              repository(owner:$owner,name:$name) {
                object(expression:$base) { ${fields} }
                pullRequest(number:$number) {
                  headRefOid baseRefName
                  baseRef { target { ... on Commit { statusCheckRollup { contexts(first:1) { totalCount } } } } }
                  headRepository { object(expression:$head) { ${fields} } }
                }
              }
            }`,
            '-f',
            `owner=${owner}`,
            '-f',
            `name=${name}`,
            '-F',
            `number=${pr.number}`,
            '-f',
            `head=${pr.commit}:.github/workflows`,
            '-f',
            `base=refs/heads/${pr.base}:.github/workflows`,
          ]),
        );

      const found = data.repository.pullRequest;

      if (
        found.headRefOid !== pr.commit ||
        found.baseRefName !== pr.base ||
        found.baseRef.target.statusCheckRollup?.contexts.totalCount ||
        [data.repository.object, found.headRepository.object].some((entry) =>
          entry?.entries.some(
            ({ name, type }) => type === 'blob' && /\.ya?ml$/.test(name),
          ),
        )
      )
        return true;

      // read classic required checks through REST; GraphQL can hide their protection rule from readers.
      const branch = z
        .object({
          protection: z.object({
            required_status_checks: z.object({ contexts: z.array(z.string()) }),
          }),
        })
        .parse(
          await api([
            `repos/${github.repository}/branches/${encodeURIComponent(pr.base)}`,
          ]),
        );

      if (branch.protection.required_status_checks.contexts.length) return true;

      const rules = z
        .array(z.array(z.object({ type: z.string() })))
        .parse(
          await api([
            `repos/${github.repository}/rules/branches/${encodeURIComponent(pr.base)}?per_page=100`,
            '--paginate',
            '--slurp',
          ]),
        )
        .flat();

      if (
        rules.some(({ type }) =>
          [
            'required_status_checks',
            'workflows',
            'copilot_code_review',
            'code_scanning',
          ].includes(type),
        )
      )
        return true;

      const { stdout } = await this.run(
        'gh',
        ['pr', 'view', pr.url, '--json', 'headRefOid,baseRefName'],
        { cwd: this.cwd, timeout: 30_000 },
      );

      const current = gitHubPullRequestFields
        .pick({ headRefOid: true, baseRefName: true })
        .parse(JSON.parse(stdout));

      return (
        current.headRefOid !== pr.commit || current.baseRefName !== pr.base
      );
    } catch (error) {
      report(error);

      return true;
    }
  }

  /** an `UNKNOWN` read of the same pull request keeps the conflict, even at a pushed head or a new base, until GitHub confirms mergeability. */
  private async conflicted(
    branch: string,
    value: PullRequest,
    report: (error: unknown) => void,
  ): Promise<{ branch: string; conflict: Conflict } | undefined> {
    if (value.mergeable === 'CONFLICTING') {
      const baseTip = await this.tip(value, report);

      return {
        branch,
        conflict: { pullRequest: value, ...(baseTip ? { baseTip } : {}) },
      };
    }

    const known = this.conflict;

    return value.mergeable === 'UNKNOWN' &&
      known?.branch === branch &&
      value.url === known.conflict.pullRequest.url
      ? known
      : undefined;
  }

  /** the base branch's current tip, which gh's `baseRefOid` isn't, from the pull request's own repository. */
  private async tip(
    { url, base }: PullRequest,
    report: (error: unknown) => void,
  ): Promise<string | undefined> {
    const github = gitHubRepository(url);

    if (!github) return;

    try {
      const { stdout } = await this.run(
        'gh',
        [
          'api',
          '--hostname',
          github.host,
          `repos/${github.repository}/commits/${base}`,
          '--jq',
          '.sha',
        ],
        { cwd: this.cwd, timeout: 30_000 },
      );

      return stdout.trim() || undefined;
    } catch (error) {
      report(error);

      return;
    }
  }

  /** an unchanged status publishes nothing, so a quiet repository costs no redraws. */
  private publish(repository: Repository | undefined): void {
    if (this.closed) return;

    if (repository) {
      repository = { ...repository };

      if (this.conflict?.branch === repository.branch)
        repository.conflict = this.conflict.conflict;
      else delete repository.conflict;

      delete repository.followed;
      delete repository.followedProject;
      delete repository.followedFailure;

      if (this.followed.length) {
        repository.followed = this.followed.map(({ value }) => value);

        if (this.current?.project !== undefined)
          repository.followedProject = this.current.project;
      }

      const failure = [
        this.recallFailure,
        ...[...this.names.values(), ...this.followed].map(
          ({ failure }) => failure,
        ),
        this.projectFailure,
      ]
        .filter((text) => text !== undefined)
        .join('; ');

      if (failure) repository.followedFailure = failure;
    }

    if (JSON.stringify(repository) === JSON.stringify(this.snapshot)) return;

    this.snapshot = repository;

    for (const listener of this.listeners) listener();
  }
}
