import { z } from 'zod';
import type { Run } from './repository.js';

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

export async function checksExpected(
  run: Run,
  cwd: string,
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
    const { stdout } = await run(
      'gh',
      ['api', '--hostname', github.host, ...args],
      { cwd, timeout: 30_000 },
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

    const { stdout } = await run(
      'gh',
      ['pr', 'view', pr.url, '--json', 'headRefOid,baseRefName'],
      { cwd, timeout: 30_000 },
    );

    const current = gitHubPullRequestFields
      .pick({ headRefOid: true, baseRefName: true })
      .parse(JSON.parse(stdout));

    return current.headRefOid !== pr.commit || current.baseRefName !== pr.base;
  } catch (error) {
    report(error);

    return true;
  }
}

/** the base branch's current tip, which gh's `baseRefOid` isn't, from the pull request's own repository. */
export async function readBaseTip(
  run: Run,
  cwd: string,
  { url, base }: PullRequest,
  report: (error: unknown) => void,
): Promise<string | undefined> {
  const github = gitHubRepository(url);

  if (!github) return;

  try {
    const { stdout } = await run(
      'gh',
      [
        'api',
        '--hostname',
        github.host,
        `repos/${github.repository}/commits/${base}`,
        '--jq',
        '.sha',
      ],
      { cwd, timeout: 30_000 },
    );

    return stdout.trim() || undefined;
  } catch (error) {
    report(error);

    return;
  }
}
