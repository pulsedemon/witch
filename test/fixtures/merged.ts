import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PullRequest } from '../../src/core/repository.js';
import { git } from './git.js';
import { scratch } from './scratch.js';

export const write = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });

  await writeFile(path, text);
};

/** `checkout` is on `feat/x`; with `worktree`, it's a linked worktree of `launcher`, a clone that holds `main`. */
export async function merged(
  files: Record<string, string> = {},
  ignore: string[] = [],
  worktree = false,
): Promise<{
  root: string;
  origin: string;
  launcher: string;
  checkout: string;
  other: string;
  tip: string;
}> {
  const root = await scratch('witch-merged-');
  const origin = join(root, 'origin.git');
  const launcher = join(root, 'launcher');
  const checkout = join(root, 'checkout');
  const other = join(root, 'other');
  const main = worktree ? launcher : checkout;

  await git(root, 'init', '--bare', origin);

  await git(root, 'clone', origin, main);

  await write(
    join(main, '.gitignore'),
    ['docs/superpowers/', '.superpowers/', ...ignore, ''].join('\n'),
  );

  for (const [name, text] of Object.entries(files))
    await write(join(main, name), text);

  await git(main, 'add', '.');

  await git(main, 'commit', '-m', 'base');

  await git(main, 'push', '-u', 'origin', 'main');

  if (worktree)
    await git(launcher, 'worktree', 'add', '-b', 'feat/x', checkout);
  else await git(checkout, 'switch', '-c', 'feat/x');

  await write(join(checkout, 'x.txt'), 'x\n');

  await git(checkout, 'add', '.');

  await git(checkout, 'commit', '-m', 'x');

  await git(checkout, 'push', '-u', 'origin', 'feat/x');

  await git(root, 'clone', origin, other);

  return {
    root,
    origin,
    launcher,
    checkout,
    other,
    tip: await git(checkout, 'rev-parse', 'HEAD'),
  };
}

export async function merge(other: string, branch: string, keep = false) {
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

export const pullRequest = (tip: string): PullRequest => ({
  number: 7,
  url: 'https://x.test/7',
  state: 'MERGED',
  branch: 'feat/x',
  commit: tip,
  base: 'main',
});

export const idle = async () => false;

// `git branch` would also list a detached HEAD
export const branches = async (checkout: string) =>
  (
    await git(
      checkout,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads',
    )
  ).split('\n');
