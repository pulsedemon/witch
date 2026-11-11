import { execFile } from 'node:child_process';
import { realpathSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

export const execute = promisify(execFile);

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
 * loses a file once it is replaced by rename. each read shows until the next; a failed one leaves its field out.
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
    project?: string;
  };
  /** a failed read confirms nothing, so it leaves this. */
  private conflict?: { branch: string; conflict: Conflict };
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
    const known = this.pullRequest;
    if (repository && known?.branch === repository.branch) {
      repository.pullRequest = known.value;
      if (known.project !== undefined)
        repository.pullRequestProject = known.project;
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
  }

  private fetchPullRequest(branch: string): Promise<void> {
    return (this.fetching ??= this.fetch(branch));
  }

  private async fetch(branch: string): Promise<void> {
    this.requested = false;
    const started = Date.now();
    const commit = this.snapshot?.commit;
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
          'number,state,statusCheckRollup,url,headRefName,headRefOid,baseRefName,mergeable,mergedAt',
        ],
        { cwd: this.cwd, timeout: 30_000 },
      );
      value = parsePullRequest(stdout);
      if (value.checks === 'none' && (await this.checksExpected(value)))
        value.checks = 'pending';
      const conflict = await this.conflicted(branch, value);
      if (this.project && project !== (await this.project())) value = undefined;
      if (
        this.closed ||
        this.snapshot?.branch !== branch ||
        this.snapshot.commit !== commit
      ) {
        value = undefined;
        this.refreshPullRequest();
      }
      if (value) this.conflict = conflict;
    } catch {
      // no pull request, no gh or no network
      value = undefined;
    } finally {
      this.fetching = undefined;
    }
    this.pullRequest = { branch, at: Date.now(), started, value, project };
    if (this.snapshot?.branch === branch)
      this.publish({
        ...this.snapshot,
        pullRequest: value,
        ...(project === undefined ? {} : { pullRequestProject: project }),
      });
  }

  private async checksExpected(pr: PullRequest): Promise<boolean> {
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
    } catch {
      return true;
    }
  }

  /** an `UNKNOWN` read of the same pull request keeps the conflict, even at a pushed head or a new base, until GitHub confirms mergeability. */
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
    return value.mergeable === 'UNKNOWN' &&
      known?.branch === branch &&
      value.url === known.conflict.pullRequest.url
      ? known
      : undefined;
  }

  /** the base branch's current tip, which gh's `baseRefOid` isn't, from the pull request's own repository. */
  private async tip({ url, base }: PullRequest): Promise<string | undefined> {
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
    } catch {
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
    }
    if (JSON.stringify(repository) === JSON.stringify(this.snapshot)) return;
    this.snapshot = repository;
    for (const listener of this.listeners) listener();
  }
}
