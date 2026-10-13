import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  RepositoryWatch,
  parsePullRequest,
  parseStatus,
} from '../src/core/repository.js';

const execute = promisify(execFile);

await test("Git's status counts staged, modified and untracked entries, and the branch's distance from its upstream", async () => {
  const root = await mkdtemp(join(tmpdir(), 'witch-repository-'));
  const git = (cwd: string, ...args: string[]) =>
    execute('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd,
    });
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('a detached head reads as HEAD, and branch.ab and unmerged entries count', () => {
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
  JSON.stringify({ number: 4, url: 'https://x.test/4', ...fields });

await test("a pull request's checks fail on a failed run or status, stay pending while any runs or none exist, and pass otherwise", () => {
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
    { number: 4, url: 'https://x.test/4', state: 'MERGED' },
  );
});

await test('the watch reads the pull request once per branch, again when the branch changes or 90 seconds pass, and publishes only changes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  let branch = 'main';
  const reads: string[] = [];
  const watch = new RepositoryWatch('/work', async (command) => {
    if (command === 'gh') reads.push(branch);
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
    const settled = published;
    t.mock.timers.tick(5000);
    await delay(20);
    assert.equal(published, settled);
    branch = 'feat/x';
    t.mock.timers.tick(5000);
    await delay(20);
    assert.equal(watch.snapshot?.branch, 'feat/x');
    assert.deepEqual(reads, ['main', 'feat/x']);
    t.mock.timers.tick(85_000);
    await delay(20);
    assert.deepEqual(reads, ['main', 'feat/x']);
    t.mock.timers.tick(5000);
    await delay(20);
    assert.deepEqual(reads, ['main', 'feat/x', 'feat/x']);
  } finally {
    watch.close();
  }
});

await test('a failed git read leaves Git out, and a failed gh read leaves the pull request out until the next read 90 seconds on', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
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
    t.mock.timers.tick(5000);
    await delay(20);
    assert.equal(watch.snapshot?.branch, 'main');
    assert.equal(watch.snapshot?.pullRequest, undefined);
    assert.equal(reads, 1);
    t.mock.timers.tick(85_000);
    await delay(20);
    assert.equal(reads, 1);
    t.mock.timers.tick(5000);
    await delay(20);
    assert.equal(reads, 2);
  } finally {
    watch.close();
  }
});
