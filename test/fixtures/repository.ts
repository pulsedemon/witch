import type { PullRequest, Repository } from '../../src/core/repository.js';

/** open pull request #7 from `feat/x` into `main`; only an open one gets `checks`, as `parsePullRequest` reads it. */
export function pullRequest(fields: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    state: 'OPEN',
    branch: 'feat/x',
    commit: 'a1b2c3',
    base: 'main',
    ...((fields.state ?? 'OPEN') === 'OPEN' ? { checks: 'passing' } : {}),
    ...fields,
  };
}

/** a clean checkout of `feat/x` with nothing ahead, behind or changed. */
export function repositoryRead(fields: Partial<Repository> = {}): Repository {
  return {
    branch: 'feat/x',
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    conflicts: 0,
    untracked: 0,
    ...fields,
  };
}
