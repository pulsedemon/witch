import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { pullRequestSchema } from './repository.js';
import type { PullRequest, Run } from './repository.js';

const execute = promisify(execFile);
const runCommand: Run = (command, args, options) =>
  execute(command, args, { ...options, maxBuffer: 16 * 1024 * 1024 });

const actor = z.object({ __typename: z.string(), login: z.string() });
const comment = z.object({
  id: z.string(),
  body: z.string(),
  url: z.string(),
  author: actor.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const review = comment.omit({ createdAt: true, updatedAt: true }).extend({
  state: z.string(),
  submittedAt: z.string().nullable(),
  commit: z.object({ oid: z.string() }).nullable(),
});
const reviewComment = comment.extend({
  pullRequestReview: z.object({ id: z.string() }).nullable(),
});
const thread = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string(),
  line: z.number().nullable(),
  comments: z.array(reviewComment),
});
const check = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  head_sha: z.string(),
});
const requested = z.object({
  requestedReviewer: z
    .object({ __typename: z.string(), login: z.string().optional() })
    .nullable(),
});
const pageInfo = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
const connection = <T extends z.ZodType>(item: T) =>
  z.object({ nodes: z.array(item), pageInfo });

export const githubReviewsSchema = z.object({
  pullRequest: pullRequestSchema,
  viewer: z.string(),
  closingIssues: z.array(z.string()),
  requested: z.array(requested),
  checks: z.array(check),
  reviews: z.array(review),
  comments: z.array(comment),
  threads: z.array(thread),
});

export type GitHubReviews = z.infer<typeof githubReviewsSchema>;
export type ReviewComment = z.infer<typeof comment>;

export function isCopilot(
  author: z.infer<typeof requested>['requestedReviewer'],
): boolean {
  return (
    author?.__typename === 'Bot' &&
    author.login === 'copilot-pull-request-reviewer'
  );
}

const commentFields =
  'id body url author { __typename login } createdAt updatedAt';
const reviewCommentFields = `${commentFields} pullRequestReview { id }`;
const threadFields = `id isResolved isOutdated path line
  comments(first:100) { nodes { ${reviewCommentFields} } pageInfo { hasNextPage endCursor } }`;
const reviewFields =
  'id body url author { __typename login } state submittedAt commit { oid }';
const requestedFields =
  'requestedReviewer { __typename ... on Bot { login } ... on User { login } }';
const metadata = z.object({
  id: z.string(),
  number: z.number(),
  url: z.string(),
  state: pullRequestSchema.shape.state,
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string(),
});
const fields = 'id number url state headRefName headRefOid baseRefName';
const pagedThread = thread.extend({ comments: connection(reviewComment) });
const initial = metadata.extend({
  closingIssuesReferences: connection(z.object({ url: z.string() })),
  reviewRequests: connection(requested),
  reviews: connection(review),
  comments: connection(comment),
  reviewThreads: connection(pagedThread),
});

function target(pr: PullRequest) {
  const url = new URL(pr.url);
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !match)
    throw new Error(`Invalid pull request URL: ${pr.url}`);
  return {
    host: url.hostname,
    owner: match[1]!,
    name: match[2]!,
    number: Number(match[3]),
  };
}

function client(pr: PullRequest, cwd: string, signal: AbortSignal, run: Run) {
  const { host, owner, name, number } = target(pr);
  const api = async (args: string[]) => {
    signal.throwIfAborted();
    const { stdout } = await run('gh', ['api', '--hostname', host, ...args], {
      cwd,
      signal,
      timeout: 30_000,
    });
    signal.throwIfAborted();
    return JSON.parse(stdout) as unknown;
  };
  const graphql = async (
    query: string,
    variables: Record<string, string | number>,
  ) => {
    const response = z
      .object({
        data: z.record(z.string(), z.unknown()).nullish(),
        errors: z.array(z.object({ message: z.string() })).optional(),
      })
      .parse(
        await api([
          'graphql',
          '-f',
          `query=${query}`,
          ...Object.entries(variables).flatMap(([key, value]) => [
            typeof value === 'number' ? '-F' : '-f',
            `${key}=${value}`,
          ]),
        ]),
      );
    if (response.errors?.length)
      throw new Error(response.errors.map(({ message }) => message).join('\n'));
    if (!response.data) throw new Error('GitHub returned no review data.');
    return response.data;
  };
  return { api, graphql, owner, name, number };
}

/** every connection must finish before a snapshot can replace the previous one. */
export async function readGitHubReviews(
  pr: PullRequest,
  cwd: string,
  signal: AbortSignal,
  run: Run = runCommand,
): Promise<GitHubReviews> {
  const { api, graphql, owner, name, number } = client(pr, cwd, signal, run);
  const data = await graphql(
    `query($owner:String!,$name:String!,$number:Int!) {
    viewer { login }
    repository(owner:$owner,name:$name) { pullRequest(number:$number) {
      ${fields}
      closingIssuesReferences(first:100) { nodes { url } pageInfo { hasNextPage endCursor } }
      reviewRequests(first:100) { nodes { ${requestedFields} } pageInfo { hasNextPage endCursor } }
      reviews(first:100) { nodes { ${reviewFields} } pageInfo { hasNextPage endCursor } }
      comments(first:100) { nodes { ${commentFields} } pageInfo { hasNextPage endCursor } }
      reviewThreads(first:100) { nodes { ${threadFields} } pageInfo { hasNextPage endCursor } }
    } }
  }`,
    { owner, name, number },
  );
  const first = z
    .object({
      viewer: z.object({ login: z.string() }),
      repository: z.object({ pullRequest: initial }),
    })
    .parse(data);
  const found = first.repository.pullRequest;
  const all = async <T extends z.ZodType>(
    parent: string,
    type: 'PullRequest' | 'PullRequestReviewThread',
    field: string,
    selection: string,
    schema: T,
    firstPage: z.infer<ReturnType<typeof connection<T>>>,
  ): Promise<z.infer<T>[]> => {
    const nodes = [...firstPage.nodes];
    let page = firstPage;
    const cursors = new Set<string>();
    while (page.pageInfo.hasNextPage) {
      const cursor = page.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor))
        throw new Error(`Incomplete GitHub ${field} pagination.`);
      cursors.add(cursor);
      const next = await graphql(
        `query($id:ID!,$cursor:String!) {
        node(id:$id) { ... on ${type} {
          ${field}(first:100,after:$cursor) { nodes { ${selection} } pageInfo { hasNextPage endCursor } }
        } }
      }`,
        { id: parent, cursor },
      );
      const node = z.record(z.string(), z.unknown()).parse(next.node);
      page = connection(schema).parse(node[field]);
      nodes.push(...page.nodes);
    }
    return nodes;
  };
  const [closingIssues, requests, reviews, comments, threads, checkPages] =
    await Promise.all([
      all(
        found.id,
        'PullRequest',
        'closingIssuesReferences',
        'url',
        z.object({ url: z.string() }),
        found.closingIssuesReferences,
      ),
      all(
        found.id,
        'PullRequest',
        'reviewRequests',
        requestedFields,
        requested,
        found.reviewRequests,
      ),
      all(
        found.id,
        'PullRequest',
        'reviews',
        reviewFields,
        review,
        found.reviews,
      ),
      all(
        found.id,
        'PullRequest',
        'comments',
        commentFields,
        comment,
        found.comments,
      ),
      all(
        found.id,
        'PullRequest',
        'reviewThreads',
        threadFields,
        pagedThread,
        found.reviewThreads,
      ),
      api([
        `repos/${owner}/${name}/commits/${found.headRefOid}/check-runs?per_page=100&filter=all`,
        '--paginate',
        '--slurp',
      ]),
    ]);
  const completeThreads = await Promise.all(
    threads.map(async (entry) => ({
      ...entry,
      comments: await all(
        entry.id,
        'PullRequestReviewThread',
        'comments',
        reviewCommentFields,
        reviewComment,
        entry.comments,
      ),
    })),
  );
  const current = metadata.parse(
    (
      await graphql(
        `query($id:ID!) {
    node(id:$id) { ... on PullRequest { ${fields} } }
  }`,
        { id: found.id },
      )
    ).node,
  );
  if (
    current.headRefOid !== found.headRefOid ||
    current.state !== found.state ||
    current.headRefName !== found.headRefName
  )
    throw new Error(
      'The pull request changed while its reviews were being read.',
    );
  const checks = z
    .array(z.object({ check_runs: z.array(check) }))
    .parse(checkPages)
    .flatMap((page) => page.check_runs);
  if (checks.some((entry) => entry.head_sha !== current.headRefOid))
    throw new Error('GitHub returned checks for another pull request head.');
  return {
    pullRequest: {
      number: current.number,
      url: current.url,
      state: current.state,
      branch: current.headRefName,
      commit: current.headRefOid,
      base: current.baseRefName,
    },
    viewer: first.viewer.login,
    closingIssues: closingIssues.map(({ url }) => url),
    requested: requests,
    reviews: reviews.filter(({ submittedAt }) => submittedAt !== null),
    comments,
    threads: completeThreads,
    checks,
  };
}

export async function reviewCommitPushed(
  pr: PullRequest,
  commit: string,
  cwd: string,
  signal: AbortSignal,
  run: Run = runCommand,
): Promise<boolean> {
  const { api, owner, name } = client(pr, cwd, signal, run);
  const comparison = z
    .object({ status: z.string(), behind_by: z.number() })
    .parse(
      await api([
        `repos/${owner}/${name}/compare/${encodeURIComponent(commit)}...${encodeURIComponent(pr.commit)}`,
      ]),
    );
  return (
    comparison.behind_by === 0 &&
    ['identical', 'ahead'].includes(comparison.status)
  );
}
