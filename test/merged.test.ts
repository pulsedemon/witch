import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { cleanUpMerge } from '../src/core/merged.js';
import type { PullRequest } from '../src/core/repository.js';
import { scratch } from './fixtures/scratch.js';

const execute = promisify(execFile);

const git = async (cwd: string, ...args: string[]) =>
  (
    await execute(
      'git',
      [
        '-c',
        'init.defaultBranch=main',
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        ...args,
      ],
      { cwd },
    )
  ).stdout.trim();

const write = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

const exists = (path: string) =>
  readFile(path).then(
    () => true,
    () => false,
  );

async function merged(
  files: Record<string, string> = {},
  ignore: string[] = [],
): Promise<{
  root: string;
  origin: string;
  checkout: string;
  other: string;
  tip: string;
}> {
  const root = await scratch('witch-merged-');
  const origin = join(root, 'origin.git');
  const checkout = join(root, 'checkout');
  const other = join(root, 'other');
  await git(root, 'init', '--bare', origin);
  await git(root, 'clone', origin, checkout);
  await write(
    join(checkout, '.gitignore'),
    ['docs/superpowers/', '.superpowers/', ...ignore, ''].join('\n'),
  );
  for (const [name, text] of Object.entries(files))
    await write(join(checkout, name), text);
  await git(checkout, 'add', '.');
  await git(checkout, 'commit', '-m', 'base');
  await git(checkout, 'push', '-u', 'origin', 'main');
  await git(checkout, 'switch', '-c', 'feat/x');
  await write(join(checkout, 'x.txt'), 'x\n');
  await git(checkout, 'add', '.');
  await git(checkout, 'commit', '-m', 'x');
  await git(checkout, 'push', '-u', 'origin', 'feat/x');
  await git(root, 'clone', origin, other);
  return {
    root,
    origin,
    checkout,
    other,
    tip: await git(checkout, 'rev-parse', 'HEAD'),
  };
}

/** merges `branch` into origin's main from `other`, deleting the remote branch unless `keep`. */
async function merge(other: string, branch: string, keep = false) {
  await git(other, 'pull');
  await git(
    other,
    'merge',
    '--no-ff',
    '-m',
    `merge ${branch}`,
    `origin/${branch}`,
  );
  await git(other, 'push', 'origin', 'main');
  if (!keep) await git(other, 'push', 'origin', '--delete', branch);
}

const pullRequest = (tip: string): PullRequest => ({
  number: 7,
  url: 'https://x.test/7',
  state: 'MERGED',
  branch: 'feat/x',
  commit: tip,
  base: 'main',
});

const plans = (checkout: string) => join(checkout, 'docs/superpowers/plans');

const branches = async (checkout: string) =>
  (await git(checkout, 'branch', '--format=%(refname:short)')).split('\n');

await test("a merged branch's checkout switches to the base, and loses the branch, its ignored plan and ledger, and the merged branches whose remote branch is gone", async () => {
  const { root, checkout, other, tip } = await merged();
  await git(checkout, 'switch', 'main');
  for (const name of ['feat/old', 'feat/live', 'feat/wt']) {
    await git(checkout, 'switch', '-c', name, 'main');
    await write(join(checkout, `${name.slice(5)}.txt`), name);
    await git(checkout, 'add', '.');
    await git(checkout, 'commit', '-m', name);
    await git(checkout, 'push', '-u', 'origin', name);
    await merge(other, name, name === 'feat/live');
    await git(checkout, 'switch', 'main');
  }
  await git(checkout, 'switch', '-c', 'feat/new', 'origin/main');
  await git(checkout, 'switch', 'main');
  await git(checkout, 'worktree', 'add', join(root, 'wt'), 'feat/wt');
  await git(checkout, 'pull');
  await write(join(plans(checkout), 'tracked.md'), '`git switch -c feat/x`.\n');
  await git(checkout, 'add', '-f', 'docs/superpowers/plans/tracked.md');
  await git(checkout, 'commit', '-m', 'tracked plan');
  await git(checkout, 'push', 'origin', 'main');
  await git(checkout, 'switch', 'feat/x');
  await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`.\n');
  await write(join(plans(checkout), 'x2.md'), '`git switch -c feat/x-2`.\n');
  await write(
    join(plans(checkout), 'stack.md'),
    '`git switch -c feat/a`\n\nlater\n\n`git switch -c feat/x`\n',
  );
  await write(
    join(plans(checkout), 'multi.md'),
    '`git switch -c feat/x`\n\nlater\n\n`git switch -c feat/b`\n',
  );
  await write(join(plans(checkout), 'y.md'), 'on branch feat/x\n');
  await write(
    join(checkout, '.superpowers/sdd/x/plan-path'),
    'docs/superpowers/plans/x.md\n',
  );
  await write(
    join(checkout, '.superpowers/sdd/y/plan-path'),
    'docs/superpowers/plans/y.md\n',
  );
  await merge(other, 'feat/x');
  const result = await cleanUpMerge(checkout, pullRequest(tip));
  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
  assert.equal(
    await git(checkout, 'rev-parse', 'HEAD'),
    await git(other, 'rev-parse', 'origin/main'),
  );
  assert.deepEqual(await branches(checkout), [
    'feat/live',
    'feat/new',
    'feat/wt',
    'main',
  ]);
  assert.deepEqual((await readdir(plans(checkout))).sort(), [
    'multi.md',
    'stack.md',
    'tracked.md',
    'x2.md',
    'y.md',
  ]);
  assert.deepEqual(await readdir(join(checkout, '.superpowers/sdd')), ['y']);
  assert.deepEqual(result, {
    text: '#7 merged: switched to main and pulled, deleted branches feat/x and feat/old, and plan x.md.',
    cleaned: true,
  });
});

await test('a head branch still on its remote stays', async () => {
  const { checkout, other, tip } = await merged();
  await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`.\n');
  await merge(other, 'feat/x', true);
  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip)), {
    text: '#7 merged, but feat/x is still on its remote, so it stays.',
    cleaned: false,
  });
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  assert.ok(await exists(join(plans(checkout), 'x.md')));
});

await test("a squash merge's branch goes too", async () => {
  const { checkout, other, tip } = await merged();
  await git(other, 'pull');
  await git(other, 'merge', '--squash', 'origin/feat/x');
  await git(other, 'commit', '-m', 'squash');
  await git(other, 'push', 'origin', 'main');
  await git(other, 'push', 'origin', '--delete', 'feat/x');
  await cleanUpMerge(checkout, pullRequest(tip));
  assert.deepEqual(await branches(checkout), ['main']);
  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
  assert.equal(
    await git(checkout, 'rev-parse', 'HEAD'),
    await git(other, 'rev-parse', 'origin/main'),
  );
});

await test("a branch whose last commit isn't the merged one stays, and so does everything else", async () => {
  const { checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`.\n');
  await git(checkout, 'commit', '--allow-empty', '-m', 'after');
  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip)), {
    text: "#7 merged, but feat/x's last commit isn't the one it merged, so it stays.",
    cleaned: false,
  });
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  assert.ok(await exists(join(plans(checkout), 'x.md')));
});

await test('a checkout that changed since the watch looked is left alone', async () => {
  const { checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`.\n');
  await writeFile(join(checkout, 'x.txt'), 'changed\n');
  assert.equal(await cleanUpMerge(checkout, pullRequest(tip)), undefined);
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  assert.equal(await readFile(join(checkout, 'x.txt'), 'utf8'), 'changed\n');
  assert.deepEqual(await branches(checkout), ['feat/x', 'main']);
  assert.ok(await exists(join(plans(checkout), 'x.md')));
  await git(checkout, 'checkout', '--', 'x.txt');
  await git(checkout, 'switch', 'main');
  assert.equal(await cleanUpMerge(checkout, pullRequest(tip)), undefined);
  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
  assert.deepEqual(await branches(checkout), ['feat/x', 'main']);
  assert.ok(await exists(join(plans(checkout), 'x.md')));
});

await test('an ignored file the base or the merge would start tracking stops the cleanup before overwriting it', async () => {
  {
    const { checkout, other } = await merged({ 'config.local': 'base\n' });
    const first = await git(checkout, 'rev-parse', 'HEAD');
    await git(checkout, 'rm', '--cached', '-q', 'config.local');
    await writeFile(
      join(checkout, '.gitignore'),
      'docs/superpowers/\n.superpowers/\nconfig.local\n',
    );
    await git(checkout, 'add', '.gitignore');
    await git(checkout, 'commit', '-m', 'untrack');
    const tip = await git(checkout, 'rev-parse', 'HEAD');
    await git(other, 'pull');
    await git(other, 'merge', '--no-ff', '-m', 'merge', first);
    await git(other, 'push', 'origin', 'main');
    await git(other, 'push', 'origin', '--delete', 'feat/x');
    await writeFile(join(checkout, 'config.local'), 'mine');
    await assert.rejects(cleanUpMerge(checkout, pullRequest(tip)));
    assert.equal(
      await readFile(join(checkout, 'config.local'), 'utf8'),
      'mine',
    );
    assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  }
  {
    const { checkout, other, tip } = await merged({}, ['secret.txt']);
    await merge(other, 'feat/x');
    await writeFile(join(other, 'secret.txt'), 'theirs');
    await git(other, 'add', '-f', 'secret.txt');
    await git(other, 'commit', '-m', 'secret');
    await git(other, 'push', 'origin', 'main');
    await writeFile(join(checkout, 'secret.txt'), 'mine');
    await assert.rejects(cleanUpMerge(checkout, pullRequest(tip)), (error) => {
      const message = (error as Error).message;
      assert.ok(
        message.startsWith(
          '#7 merged: switched to main and deleted branch feat/x',
        ),
        message,
      );
      assert.ok(message.trim().endsWith('Aborting'), message);
      return true;
    });
    assert.equal(await readFile(join(checkout, 'secret.txt'), 'utf8'), 'mine');
    assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
  }
});
