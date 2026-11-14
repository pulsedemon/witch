import assert from 'node:assert/strict';
import { test } from 'vitest';
import { RepositoryWatch } from '../src/core/repository.js';
import { view } from './fixtures/repository.js';

/** a watch on branch `main` whose every `gh` call gets what `gh` returns now. */
function watching(gh: (args: string[]) => string) {
  let reads = 0;
  const watch = new RepositoryWatch('/work', async (command, args) => {
    if (command !== 'gh') return { stdout: '# branch.head main\n' };
    if (args[0] === 'pr' && args[1] === 'view' && args[2] === '--json') reads++;
    return { stdout: gh(args) };
  });
  return { watch, reads: () => reads };
}

const rejection = (message: string, code?: number | string) =>
  Object.assign(new Error(message), code === undefined ? {} : { code });

test('a pull request answer the watch cannot parse says why on the snapshot, keeps polling quietly and clears once a read works', async () => {
  let answer = '{}';
  const { watch, reads } = watching(() => answer);
  // read through a call, since an assertion on the property would narrow it for the rest of the test
  const pullRequest = () => watch.snapshot?.pullRequest;
  try {
    await watch.readPullRequest();
    assert.match(
      watch.snapshot?.pullRequestFailure ?? '',
      /^number: .*; url: /,
    );
    assert.equal(pullRequest(), undefined);
    let published = 0;
    watch.subscribe(() => published++);
    const before = reads();
    await watch.readPullRequest();
    assert.equal(reads(), before + 1);
    assert.equal(published, 0);
    answer = view({ state: 'OPEN', statusCheckRollup: [] });
    await watch.readPullRequest();
    assert.equal(pullRequest()?.number, 4);
    assert.equal('pullRequestFailure' in watch.snapshot!, false);
  } finally {
    watch.close();
  }
});

test('a gh that says no, runs out of time or is not installed leaves no failure on the snapshot', async () => {
  let failure: Error = rejection('no pull requests found', 1);
  const { watch, reads } = watching(() => {
    throw failure;
  });
  try {
    // the read the constructor starts
    await watch.readPullRequest();
    for (const next of [
      failure,
      rejection('timed out'),
      rejection('spawn gh ENOENT', 'ENOENT'),
    ]) {
      failure = next;
      const before = reads();
      await watch.readPullRequest();
      assert.equal(reads(), before + 1, next.message);
      assert.equal(watch.snapshot?.branch, 'main');
      assert.equal('pullRequestFailure' in watch.snapshot!, false);
    }
  } finally {
    watch.close();
  }
});

test('a gh that could not be started for another reason says why on the snapshot', async () => {
  const { watch } = watching(() => {
    throw rejection('spawn gh EMFILE', 'EMFILE');
  });
  try {
    await watch.readPullRequest();
    assert.equal(watch.snapshot?.pullRequestFailure, 'spawn gh EMFILE');
  } finally {
    watch.close();
  }
});

test('a checks or base tip read that fails unexpectedly keeps its fallback and says why, and one gh refuses stays quiet', async () => {
  const refused = (): string => {
    throw rejection('HTTP 404', 1);
  };
  let checks = refused;
  let tip = refused;
  const conflicting = view({
    state: 'OPEN',
    url: 'https://github.example/owner/repo/pull/4',
    statusCheckRollup: [],
    mergeable: 'CONFLICTING',
  });
  const { watch } = watching((args) =>
    args[0] === 'pr'
      ? conflicting
      : args.some((arg) => arg.includes('/commits/'))
        ? tip()
        : checks(),
  );
  const read = async () => {
    await watch.readPullRequest();
    const { pullRequest, pullRequestFailure, conflict } = watch.snapshot!;
    return {
      checks: pullRequest?.checks,
      conflicting: conflict !== undefined,
      tip: conflict?.baseTip,
      failure: pullRequestFailure,
    };
  };
  const fallback = { checks: 'pending', conflicting: true, tip: undefined };
  try {
    assert.deepEqual(await read(), { ...fallback, failure: undefined });
    checks = () => '{"data":{}}';
    const { failure, ...rest } = await read();
    assert.match(failure ?? '', /^data\.repository: /);
    assert.deepEqual(rest, fallback);
    checks = refused;
    tip = () => {
      throw rejection('spawn gh EMFILE', 'EMFILE');
    };
    assert.deepEqual(await read(), { ...fallback, failure: 'spawn gh EMFILE' });
    checks = () => '{';
    assert.match((await read()).failure ?? '', / in JSON .*; spawn gh EMFILE$/);
    checks = refused;
    tip = () => 'f00\n';
    assert.deepEqual(await read(), {
      ...fallback,
      tip: 'f00',
      failure: undefined,
    });
  } finally {
    watch.close();
  }
});
