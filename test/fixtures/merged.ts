import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PullRequest } from '../../src/core/repository/pull-requests.js';
import { quote } from '../../src/shell.js';
import { git } from './git.js';
import { execute } from './merged-environment.js';
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

/** a pull request url `headRetention` reads as GitHub's, which `pullRequest`'s url isn't. */
export const url = 'https://github.test/o/r/pull/7';

const lookup = [
  'api graphql --hostname github.test',
  '-f query=query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { deleteBranchOnMerge defaultBranchRef { name } pullRequest(number: $number) { isCrossRepository } } }',
  '-f owner=o -f name=r -F number=7',
  '--jq .data.repository | .deleteBranchOnMerge, .defaultBranchRef.name, .pullRequest.isCrossRepository',
].join(' ');

/** a `gh` script that prints `settings`, the lines of deleteBranchOnMerge, the default branch and isCrossRepository. */
export const answering = (settings: string) =>
  `[ "$*" = ${quote(lookup)} ] || exit 1\nprintf ${quote(settings)}`;

/** runs `body` with `script` as the `gh` on PATH. */
export async function withGh<T>(
  root: string,
  script: string,
  body: () => Promise<T>,
): Promise<T> {
  const bin = join(root, 'bin');
  await write(join(bin, 'gh'), `#!/bin/sh\n${script}\n`);
  await chmod(join(bin, 'gh'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;

  try {
    return await body();
  } finally {
    process.env.PATH = previousPath;
  }
}

/** runs `body` with a node `git` first on PATH that runs `script` before passing the command on. */
export async function withGit<T>(
  root: string,
  script: string,
  body: () => Promise<T>,
): Promise<T> {
  const realGit = (await execute('/usr/bin/which', ['git'])).stdout.trim();
  const previousPath = process.env.PATH;
  const bin = join(root, 'bin');

  await write(
    join(bin, 'git'),
    `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const run = (args, stdio = 'inherit') => spawnSync(${JSON.stringify(realGit)}, args, { stdio });
${script}
process.exit(run(args).status ?? 1);
`,
  );

  await chmod(join(bin, 'git'), 0o755);
  process.env.PATH = `${bin}:${previousPath}`;

  try {
    return await body();
  } finally {
    process.env.PATH = previousPath;
  }
}
