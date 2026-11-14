import type { TestContext } from 'vitest';
import type { PullRequest, Repository } from '../../src/core/repository.js';
import { orderedCleanup } from './cleanup.js';
import { notices } from './coordinator.js';
import { git, unitCoordinationFixture } from './coordination.js';
import { until } from './within.js';
import { record as savedRecord } from './copilot-reviews.js';
import {
  pullRequest as openPullRequest,
  repositoryRead,
} from './repository.js';

export const head = (n: number) => String(n).repeat(40);

export const repairPrefix =
  'Witch started this turn to repair the merge conflict';

/** a session that claims pull request #7 on `feat/x`, with a way to feed it repository reads. */
export async function setup(t: TestContext, name = 'A') {
  const register = orderedCleanup(t.onTestFinished);

  const f = await unitCoordinationFixture(register, async (references) => ({
    assigned: references,
  }));

  const x = await f.start(name);

  const c = x.coordinator;

  const cwd = c.snapshot.conversation!.cwd;

  await git('-C', cwd, 'symbolic-ref', 'HEAD', 'refs/heads/feat/x');

  const project = (await f.memory.scopePaths(cwd)).project;

  const pullRequest = (fields: Partial<PullRequest> = {}) =>
    openPullRequest({ commit: head(1), mergeable: 'CONFLICTING', ...fields });

  /** a read of the pull request; a conflicting one carries its conflict, as `RepositoryWatch` publishes it. */
  const read = (
    fields: Partial<PullRequest> = {},
    kept?: PullRequest,
  ): Repository => {
    const current = pullRequest(fields);

    const conflict = current.mergeable === 'CONFLICTING' ? current : kept;

    return repositoryRead({
      commit: current.commit,
      pullRequest: current,
      pullRequestProject: project,
      ...(conflict
        ? { conflict: { pullRequest: conflict, baseTip: 'f00' } }
        : {}),
    });
  };

  const observe = (
    repository: Repository,
    client: { coordinator: typeof c; coordination: typeof x.coordination } = x,
  ) => {
    client.coordination.updateRepository(repository);

    client.coordinator.conflict = repository.conflict;

    client.coordinator.repair.observe(repository);
  };

  c.repair.setRefresh(async () => {});

  await x.claim(pullRequest().url, 'repair task');

  const repairs = (agent = x.a) =>
    agent.inputs.filter(({ prompt }) => prompt.startsWith(repairPrefix));

  const idle = (coordinator = c) =>
    until('idle', () => coordinator.snapshot.phase === 'idle');

  return {
    f,
    x,
    c,
    cwd,
    pullRequest,
    read,
    observe,
    repairs,
    idle,
    record: (client = x) => savedRecord(f, client),
    notices: (coordinator = c) => notices(coordinator),
  };
}
