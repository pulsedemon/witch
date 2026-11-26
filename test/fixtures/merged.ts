import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PullRequest } from '../../src/core/repository/pull-requests.js';
import { quote } from '../../src/shell.js';
import { git, identity } from './git.js';
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

export async function ignoredVendor() {
  const state = await merged({ 'vendor/lib.js': 'tracked\n' });
  const { checkout } = state;
  await git(checkout, 'rm', '--cached', 'vendor/lib.js');

  await write(
    join(checkout, '.gitignore'),
    'docs/superpowers/\n.superpowers/\nvendor/lib.js\n',
  );

  await git(checkout, 'add', '.gitignore');
  await git(checkout, 'commit', '-m', 'ignore vendor');
  await git(checkout, 'push');
  await write(join(checkout, 'vendor/lib.js'), 'installed\n');

  return { ...state, tip: await git(checkout, 'rev-parse', 'HEAD') };
}

export async function editingSequence(root: string) {
  const editor = join(root, 'editor.cjs');

  await write(
    editor,
    `#!${process.execPath}
const fs = require('node:fs');
const path = process.argv[2];
fs.writeFileSync(path, fs.readFileSync(path, 'utf8').replace(/^pick /m, 'edit '));
`,
  );

  await chmod(editor, 0o755);

  return editor;
}

/** upload-pack's stdin and stdout belong to its protocol, so setup commands inherit neither. */
export async function duringFetch(
  root: string,
  checkout: string,
  script: string,
  onBase = false,
) {
  const realGit = (await execute('/usr/bin/which', ['git'])).stdout.trim();
  const pack = join(root, 'upload-pack.cjs');
  const marker = join(root, 'fetched');

  await write(
    pack,
    `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const git = ${JSON.stringify(realGit)};
const run = (...args) => {
  const result = spawnSync(git, [...${JSON.stringify(identity)}, ...args], { stdio: 'ignore' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const ready = ${
      onBase
        ? `spawnSync(git, ['-C', ${JSON.stringify(checkout)}, 'branch', '--show-current'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).stdout.trim() === 'main'`
        : 'true'
    };
if (!existsSync(${JSON.stringify(marker)}) && ready) {
  writeFileSync(${JSON.stringify(marker)}, '');
  ${script}
}
process.exit(spawnSync(git, ['upload-pack', ...process.argv.slice(2)], { stdio: 'inherit' }).status ?? 1);
`,
  );

  await chmod(pack, 0o755);
  await git(checkout, 'config', 'remote.origin.uploadpack', pack);
}

export async function pushingOnBase(
  root: string,
  checkout: string,
  other: string,
) {
  await duringFetch(
    root,
    checkout,
    `run('-C', ${JSON.stringify(other)}, 'push', '-q', 'origin', 'main');`,
    true,
  );
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
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
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
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}
