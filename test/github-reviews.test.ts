import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  isCopilot,
  readGitHubReviews,
  reviewCommitPushed,
} from '../src/core/github-reviews.js';
import type { PullRequest, Run } from '../src/core/repository.js';

const pr: PullRequest = {
  number: 12,
  url: 'https://github.com/team/project/pull/12',
  state: 'OPEN',
  branch: 'feat/reviews',
  commit: 'old-head',
  base: 'main',
};

const bot = { __typename: 'Bot', login: 'copilot-pull-request-reviewer' };

const page = (nodes: unknown[], cursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
});

const comment = (id: string) => ({
  id,
  body: `finding ${id}`,
  url: `${pr.url}#discussion_${id}`,
  author: bot,
  createdAt: '2026-10-30T23:00:00Z',
  updatedAt: '2026-10-30T23:00:00Z',
  pullRequestReview: { id: 'review-1' },
});

const review = (id: string) => ({
  id,
  body: `summary ${id}`,
  url: `${pr.url}#${id}`,
  author: bot,
  state: 'COMMENTED',
  submittedAt: '2026-10-30T23:00:01Z',
  commit: { oid: 'fresh-head' },
});

const thread = (id: string, comments = page([comment(`comment-${id}`)])) => ({
  id,
  isResolved: false,
  isOutdated: true,
  path: 'src/example.ts',
  line: null,
  comments,
});

const metadata = {
  id: 'pr-id',
  number: 12,
  url: pr.url,
  state: 'OPEN',
  headRefName: 'feat/reviews',
  headRefOid: 'fresh-head',
  baseRefName: 'main',
  isDraft: false,
};

function fixture() {
  const first = {
    ...metadata,
    closingIssuesReferences: page([
      { url: 'https://github.com/team/project/issues/4' },
    ]),
    reviewRequests: page([]),
    reviews: page([review('review-1')]),
    comments: page([]),
    reviewThreads: page([thread('thread-1')]),
  };

  const tails = new Map<string, unknown>();
  let final = { ...metadata };

  let checks = [
    {
      check_runs: [
        {
          id: 7,
          name: 'copilot-pull-request-reviewer',
          status: 'completed',
          conclusion: 'success',
          head_sha: 'fresh-head',
        },
      ],
    },
  ];

  const run: Run = async (command, args, options) => {
    assert.equal(command, 'gh');

    assert.equal(options.cwd, '/checkout');

    assert.equal(options.timeout, 30_000);

    assert.ok(options.signal);

    assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'github.com']);

    let result: unknown;

    if (args.includes('graphql')) {
      const query = args.find((arg) => arg.startsWith('query='))!;

      if (query.includes('repository(owner:')) {
        assert.ok(args.includes('owner=team'));

        assert.ok(args.includes('name=project'));

        assert.ok(args.includes('number=12'));

        result = {
          data: {
            viewer: { login: 'owner' },
            repository: { pullRequest: first },
          },
        };
      } else if (args.some((arg) => arg.startsWith('cursor='))) {
        const id = args.find((arg) => arg.startsWith('id='))!.slice(3);
        const cursor = args.find((arg) => arg.startsWith('cursor='))!.slice(7);

        assert.ok(query.includes('after:$cursor'));

        result = tails.get(`${id}/${cursor}`);

        assert.ok(result, `unexpected page ${id}/${cursor}`);
      } else result = { data: { node: final } };
    } else if (args[3]!.startsWith('repos/team/project/rules/')) {
      assert.equal(
        args[3],
        'repos/team/project/rules/branches/main?per_page=100',
      );

      assert.deepEqual(args.slice(4), ['--paginate', '--slurp']);

      result = [
        [
          { type: 'deletion' },
          {
            type: 'copilot_code_review',
            parameters: {
              review_on_push: true,
              review_draft_pull_requests: false,
            },
          },
        ],
        [
          {
            type: 'pull_request',
            parameters: { required_approving_review_count: 0 },
          },
        ],
      ];
    } else {
      assert.equal(
        args[3],
        'repos/team/project/commits/fresh-head/check-runs?per_page=100&filter=all',
      );

      assert.deepEqual(args.slice(4), ['--paginate', '--slurp']);

      result = checks;
    }

    return { stdout: JSON.stringify(result) };
  };

  return {
    first,
    tails,
    run,
    final(value: typeof final) {
      final = value;
    },
    checks(value: typeof checks) {
      checks = value;
    },
    read: () =>
      readGitHubReviews(pr, '/checkout', new AbortController().signal, run),
  };
}

test('submitted feedback survives removal of the request and preserves source relationships', async () => {
  const f = fixture();

  f.first.reviews.nodes.push({
    ...review('draft'),
    submittedAt: null,
    state: 'PENDING',
  });

  const result = await f.read();

  assert.equal(result.pullRequest.commit, 'fresh-head');

  assert.equal(result.viewer, 'owner');

  assert.equal(result.draft, false);

  assert.deepEqual(result.copilotRules, [
    { review_on_push: true, review_draft_pull_requests: false },
  ]);

  assert.deepEqual(result.requested, []);

  assert.deepEqual(
    result.reviews.map(({ id }) => id),
    ['review-1'],
  );

  assert.deepEqual(result.closingIssues, [
    'https://github.com/team/project/issues/4',
  ]);

  assert.deepEqual(
    result.threads.map(({ id, isResolved, isOutdated, comments }) => ({
      id,
      isResolved,
      isOutdated,
      comments: comments.map(({ id, pullRequestReview }) => [
        id,
        pullRequestReview?.id,
      ]),
    })),
    [
      {
        id: 'thread-1',
        isResolved: false,
        isOutdated: true,
        comments: [['comment-thread-1', 'review-1']],
      },
    ],
  );
});

test('a completed check does not hide a review that arrives on the next read', async () => {
  const f = fixture();
  f.first.reviews = page([]);
  f.first.reviewThreads = page([]);
  const before = await f.read();

  assert.equal(before.checks[0]!.status, 'completed');

  assert.deepEqual(before.reviews, []);

  f.first.reviews = page([review('delayed')]);

  assert.deepEqual(
    (await f.read()).reviews.map(({ id }) => id),
    ['delayed'],
  );
});

test('every root page and nested thread-comment page reaches the snapshot', async () => {
  const f = fixture();
  f.first.closingIssuesReferences.pageInfo = page([], 'issues-next').pageInfo;
  f.first.reviewRequests.pageInfo = page([], 'requests-next').pageInfo;
  f.first.reviews.pageInfo = page([], 'reviews-next').pageInfo;
  f.first.comments.pageInfo = page([], 'comments-next').pageInfo;

  f.first.reviewThreads = page(
    [thread('thread-1', page([comment('first')], 'nested-next'))],
    'threads-next',
  );

  const continuations = [
    [
      'issues-next',
      'closingIssuesReferences',
      [{ url: 'https://github.com/team/project/issues/5' }],
    ],
    ['requests-next', 'reviewRequests', [{ requestedReviewer: bot }]],
    ['reviews-next', 'reviews', [review('review-2')]],
    ['comments-next', 'comments', [comment('issue-comment')]],
    ['threads-next', 'reviewThreads', [thread('thread-2')]],
  ] as const;

  for (const [cursor, field, nodes] of continuations)
    f.tails.set(`pr-id/${cursor}`, {
      data: { node: { [field]: page([...nodes]) } },
    });

  f.tails.set('thread-1/nested-next', {
    data: { node: { comments: page([comment('second')]) } },
  });

  const result = await f.read();

  assert.deepEqual(
    result.closingIssues.map((url) => url.split('/').at(-1)),
    ['4', '5'],
  );

  assert.deepEqual(result.requested, [{ requestedReviewer: bot }]);

  assert.deepEqual(
    result.reviews.map(({ id }) => id),
    ['review-1', 'review-2'],
  );

  assert.deepEqual(
    result.comments.map(({ id }) => id),
    ['issue-comment'],
  );

  assert.deepEqual(
    result.threads.map(({ id, comments }) => [
      id,
      comments.map(({ id }) => id),
    ]),
    [
      ['thread-1', ['first', 'second']],
      ['thread-2', ['comment-thread-2']],
    ],
  );
});

test('a failed nested page refuses an incomplete snapshot', async () => {
  const f = fixture();

  f.first.reviewThreads = page([
    thread('thread-1', page([comment('first')], 'next')),
  ]);

  f.tails.set('thread-1/next', {
    data: { node: null },
    errors: [{ message: 'permission lost' }],
  });

  await assert.rejects(f.read(), /permission lost/);
});

test.each(['null', 'repeat'])(
  'an unfinished cursor cannot masquerade as complete: %s',
  async (kind) => {
    const f = fixture();

    f.first.comments.pageInfo = {
      hasNextPage: true,
      endCursor: kind === 'null' ? null : 'next',
    };

    f.tails.set('pr-id/next', {
      data: { node: { comments: page([comment('later')], 'next') } },
    });

    await assert.rejects(f.read(), /Incomplete GitHub comments pagination/);
  },
);

test('a head change during collection rejects mixed-revision feedback', async () => {
  const f = fixture();

  f.final({ ...metadata, headRefOid: 'another-head' });

  await assert.rejects(f.read(), /changed while its reviews/);
});

test('a check from another commit cannot establish this heads progress', async () => {
  const f = fixture();

  f.checks([
    {
      check_runs: [
        {
          id: 8,
          name: 'copilot-pull-request-reviewer',
          status: 'completed',
          conclusion: 'success',
          head_sha: 'wrong-head',
        },
      ],
    },
  ]);

  await assert.rejects(f.read(), /checks for another/);
});

test('only the Copilot Bot identity qualifies', () => {
  assert.equal(isCopilot(bot), true);

  assert.equal(isCopilot({ ...bot, __typename: 'User' }), false);

  assert.equal(isCopilot({ ...bot, login: 'Copilot' }), false);

  assert.equal(isCopilot(null), false);
});

test('pushed commit verification treats a commit GitHub lacks as unpushed and rethrows other failures', async () => {
  const failing =
    (stderr: string): Run =>
    async () => {
      throw Object.assign(new Error('Command failed: gh api'), { stderr });
    };

  const verify = (run: Run) =>
    reviewCommitPushed(
      pr,
      'fix-sha',
      '/checkout',
      new AbortController().signal,
      run,
    );

  assert.equal(await verify(failing('gh: Not Found (HTTP 404)\n')), false);

  await assert.rejects(
    verify(failing('gh: Server Error (HTTP 502)\n')),
    /Command failed/,
  );
});

test.each([
  ['identical', 0, true],
  ['ahead', 0, true],
  ['behind', 2, false],
  ['diverged', 1, false],
] as const)(
  'pushed commit verification interprets %s relative to the PR head',
  async (status, behind_by, expected) => {
    const run: Run = async (_command, args) => {
      assert.equal(args[3], 'repos/team/project/compare/fix-sha...old-head');

      return { stdout: JSON.stringify({ status, behind_by }) };
    };

    assert.equal(
      await reviewCommitPushed(
        pr,
        'fix-sha',
        '/checkout',
        new AbortController().signal,
        run,
      ),
      expected,
    );
  },
);
