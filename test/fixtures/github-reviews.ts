import type { GitHubReviews } from '../../src/core/github-reviews.js';

export function reviewSource(): GitHubReviews {
  const url = 'https://github.com/team/project/pull/12';
  const bot = { __typename: 'Bot', login: 'copilot-pull-request-reviewer' };
  return {
    pullRequest: {
      number: 12,
      url,
      state: 'OPEN',
      branch: 'feat/reviews',
      commit: 'a'.repeat(40),
      base: 'main',
    },
    viewer: 'owner',
    closingIssues: ['https://github.com/team/project/issues/4'],
    requested: [],
    checks: [],
    reviews: [
      {
        id: 'review-1',
        body: 'Check the retry deadline.',
        url: `${url}#pullrequestreview-1`,
        author: bot,
        state: 'COMMENTED',
        submittedAt: '2026-10-30T23:00:00Z',
        commit: { oid: 'a'.repeat(40) },
      },
    ],
    comments: [],
    threads: [
      {
        id: 'thread-1',
        isResolved: false,
        isOutdated: false,
        path: 'src/example.ts',
        line: 12,
        comments: [
          {
            id: 'comment-1',
            body: 'The retry crosses the deadline.',
            url: `${url}#discussion_r1`,
            author: bot,
            createdAt: '2026-10-30T23:00:00Z',
            updatedAt: '2026-10-30T23:00:00Z',
            pullRequestReview: { id: 'review-1' },
          },
        ],
      },
    ],
  };
}
