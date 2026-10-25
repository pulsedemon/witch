import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  RepositoryWatch,
  parsePullRequest,
  parseStatus,
} from '../src/core/repository.js';
import type { Run } from '../src/core/repository.js';
import { scratch } from './fixtures/scratch.js';
import { until } from './fixtures/within.js';

const execute = promisify(execFile);

test("Git's status counts staged, modified and untracked entries, and the branch's distance from its upstream", async () => {
  const root = await scratch('witch-repository-');
  const git = (cwd: string, ...args: string[]) =>
    execute('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd,
    });
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  await git(root, 'init', '--bare', '-b', 'main', remote);
  await git(root, 'clone', remote, work);
  await writeFile(join(work, 'a.txt'), 'a\n');
  await writeFile(join(work, 'b.txt'), 'b\n');
  await git(work, 'add', '.');
  await git(work, 'commit', '-m', 'first');
  await git(work, 'push', '-u', 'origin', 'HEAD:main');
  await git(work, 'commit', '--allow-empty', '-m', 'ahead');
  await writeFile(join(work, 'a.txt'), 'changed\n');
  await writeFile(join(work, 'c.txt'), 'c\n');
  await git(work, 'add', 'c.txt');
  await writeFile(join(work, 'b.txt'), 'staged\n');
  await git(work, 'add', 'b.txt');
  await writeFile(join(work, 'b.txt'), 'and modified\n');
  await mkdir(join(work, 'new'));
  await writeFile(join(work, 'new', 'one.txt'), '1');
  await writeFile(join(work, 'new', 'two.txt'), '2');
  const { stdout } = await git(work, 'status', '--porcelain=v2', '--branch');
  // b.txt is staged and modified; the new directory is one entry
  assert.deepEqual(parseStatus(stdout), {
    branch: 'main',
    ahead: 1,
    behind: 0,
    staged: 2,
    modified: 2,
    conflicts: 0,
    untracked: 1,
  });
});

test('a detached head reads as HEAD, and branch.ab and unmerged entries count', () => {
  assert.deepEqual(
    parseStatus(
      [
        '# branch.oid 0123',
        '# branch.head (detached)',
        '# branch.ab +0 -3',
        'u UU N... 100644 100644 100644 100644 a b c conflicted.txt',
        '',
      ].join('\n'),
    ),
    {
      branch: 'HEAD',
      ahead: 0,
      behind: 3,
      staged: 0,
      modified: 0,
      conflicts: 1,
      untracked: 0,
    },
  );
});

const view = (fields: object) =>
  JSON.stringify({
    number: 4,
    url: 'https://x.test/4',
    headRefName: 'feat/x',
    headRefOid: 'a1b2c3',
    baseRefName: 'develop',
    ...fields,
  });

test("a pull request's checks fail on a failed run or status, stay pending while any runs or none exist, and pass otherwise", () => {
  const checks = (rollup: object[]) =>
    parsePullRequest(view({ state: 'OPEN', statusCheckRollup: rollup })).checks;
  const done = (conclusion: string) => ({
    __typename: 'CheckRun',
    status: 'COMPLETED',
    conclusion,
  });
  assert.equal(checks([]), 'pending');
  assert.equal(checks([done('SUCCESS'), done('SKIPPED')]), 'passing');
  assert.equal(
    checks([
      done('SUCCESS'),
      { __typename: 'CheckRun', status: 'IN_PROGRESS' },
    ]),
    'pending',
  );
  assert.equal(
    checks([
      done('FAILURE'),
      { __typename: 'CheckRun', status: 'QUEUED', conclusion: null },
    ]),
    'failing',
  );
  assert.equal(
    checks([{ __typename: 'StatusContext', state: 'ERROR' }]),
    'failing',
  );
  assert.equal(
    checks([{ __typename: 'StatusContext', state: 'EXPECTED' }]),
    'pending',
  );
  assert.deepEqual(
    parsePullRequest(view({ state: 'MERGED', statusCheckRollup: [] })),
    {
      number: 4,
      url: 'https://x.test/4',
      state: 'MERGED',
      branch: 'feat/x',
      commit: 'a1b2c3',
      base: 'develop',
    },
  );
});

test('the watch reads the pull request once per branch, again when the branch changes or 90 seconds pass, and publishes only changes', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });
  let branch = 'main';
  const reads: string[] = [];
  let fields: string | undefined;
  const watch = new RepositoryWatch('/work', async (command, args) => {
    if (command === 'gh') {
      reads.push(branch);
      fields = args.at(-1);
    }
    return {
      stdout:
        command === 'gh'
          ? view({ state: 'OPEN', statusCheckRollup: [] })
          : `# branch.head ${branch}\n`,
    };
  });
  let published = 0;
  watch.subscribe(() => published++);
  try {
    await delay(20);
    assert.equal(watch.snapshot?.pullRequest?.number, 4);
    assert.match(fields ?? '', /,headRefName,headRefOid,baseRefName$/);
    const settled = published;
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(published, settled);
    branch = 'feat/x';
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(watch.snapshot?.branch, 'feat/x');
    assert.deepEqual(reads, ['main', 'feat/x']);
    vi.advanceTimersByTime(85_000);
    await delay(20);
    assert.deepEqual(reads, ['main', 'feat/x']);
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.deepEqual(reads, ['main', 'feat/x', 'feat/x']);
  } finally {
    watch.close();
  }
});

test('a failed git read leaves Git out, and a failed gh read leaves the pull request out until the next read 90 seconds on', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });
  let repository = false;
  let reads = 0;
  const watch = new RepositoryWatch('/work', async (command) => {
    if (command === 'gh') {
      reads++;
      throw new Error('no pull requests found for branch "main"');
    }
    if (!repository) throw new Error('fatal: not a git repository');
    return { stdout: '# branch.head main\n' };
  });
  try {
    await delay(20);
    assert.equal(watch.snapshot?.branch, undefined);
    repository = true;
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(watch.snapshot?.branch, 'main');
    assert.equal(watch.snapshot?.pullRequest, undefined);
    assert.equal(reads, 1);
    vi.advanceTimersByTime(85_000);
    await delay(20);
    assert.equal(reads, 1);
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(reads, 2);
    repository = false;
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(watch.snapshot?.branch, undefined);
  } finally {
    watch.close();
  }
});

test('a read still running skips the next ticks, and a pull request read for a branch left meanwhile is dropped', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });
  let branch = 'main';
  const git: PromiseWithResolvers<{ stdout: string }>[] = [];
  const gh: PromiseWithResolvers<{ stdout: string }>[] = [];
  const watch = new RepositoryWatch('/work', (command) => {
    const read = Promise.withResolvers<{ stdout: string }>();
    (command === 'gh' ? gh : git).push(read);
    return read.promise;
  });
  try {
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(git.length, 1);
    git[0]!.resolve({ stdout: `# branch.head ${branch}\n` });
    await delay(20);
    assert.equal(watch.snapshot?.branch, 'main');
    assert.equal(gh.length, 1);
    branch = 'feat/x';
    for (let tick = 0; tick < 3; tick++) {
      vi.advanceTimersByTime(5000);
      await delay(20);
      git.at(-1)!.resolve({ stdout: `# branch.head ${branch}\n` });
      await delay(20);
    }
    assert.equal(watch.snapshot?.branch, 'feat/x');
    assert.equal(gh.length, 1);
    gh[0]!.resolve({ stdout: view({ state: 'OPEN', statusCheckRollup: [] }) });
    await delay(20);
    assert.equal(watch.snapshot?.pullRequest, undefined);
  } finally {
    watch.close();
  }
});

test('a detached head reads no pull request', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });
  const calls: Parameters<Run>[] = [];
  const watch = new RepositoryWatch('/work', async (...args) => {
    calls.push(args);
    return { stdout: '# branch.head (detached)\n' };
  });
  try {
    await delay(20);
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(watch.snapshot?.branch, 'HEAD');
    assert.equal(calls.length, 2);
    for (const call of calls)
      assert.deepEqual(call, [
        'git',
        ['--no-optional-locks', 'status', '--porcelain=v2', '--branch'],
        { cwd: '/work', timeout: 10_000 },
      ]);
  } finally {
    watch.close();
  }
});

test('a cached pull request keeps its observed project until a fresh scoped read', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });
  let project = 'project-a';
  const watch = new RepositoryWatch(
    '/work',
    async (command) => ({
      stdout:
        command === 'gh' ? view({ state: 'MERGED' }) : '# branch.head feat/x\n',
    }),
    async () => project,
  );
  try {
    await until(
      'initial scoped observation',
      () => watch.snapshot?.pullRequestProject === 'project-a',
    );
    project = 'project-b';
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(watch.snapshot?.pullRequestProject, 'project-a');
    vi.advanceTimersByTime(85_000);
    await until(
      'fresh scoped observation',
      () => watch.snapshot?.pullRequestProject === 'project-b',
    );
    assert.equal(watch.snapshot?.pullRequest?.state, 'MERGED');
  } finally {
    watch.close();
  }
});

test('a project change during a pull request read invalidates the observation', async () => {
  let project = 'project-a';
  let scopeReads = 0;
  const watch = new RepositoryWatch(
    '/work',
    async (command) => {
      if (command === 'git') return { stdout: '# branch.head feat/x\n' };
      project = 'project-b';
      return { stdout: view({ state: 'MERGED' }) };
    },
    async () => {
      scopeReads++;
      return project;
    },
  );
  try {
    await until('scope recheck', () => scopeReads === 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(watch.snapshot?.pullRequest, undefined);
  } finally {
    watch.close();
  }
});
