import { execFile } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { errorMessage } from '../agents/stderr.js';
import { parseStatus } from './repository.js';
import type { PullRequest } from './repository.js';

const execute = promisify(execFile);

/** a passphrase or password prompt would draw over the TUI, and nothing could answer it. */
const git = async (cwd: string, ...args: string[]) =>
  (
    await execute('git', args, {
      cwd,
      timeout: 60_000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
      },
    })
  ).stdout.trim();

/** `git check-ignore` exits 1 for a path no rule ignores, and for a tracked file. */
const ignored = (cwd: string, path: string) =>
  git(cwd, 'check-ignore', '-q', path).then(
    () => true,
    () => false,
  );

const list = (items: string[]) =>
  items.length > 1
    ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
    : items[0]!;

/**
 * what a merged pull request leaves in the checkout at `cwd`: switches to the base, deletes the branch and its
 * gitignored plans with their ledgers, brings the base up to date, and deletes the other merged branches whose remote
 * branch is gone. returns a sentence saying what it did, and whether it moved the checkout, or nothing when the
 * checkout left the branch or changed.
 */
export async function cleanUpMerge(
  cwd: string,
  pullRequest: PullRequest,
): Promise<{ text: string; cleaned: boolean } | undefined> {
  const { number, branch, commit, base } = pullRequest;
  await git(cwd, 'fetch', '--prune');
  // after the fetch, which can take a while: the watch's status is seconds old, and a commit made meanwhile would
  // go with the branch
  const status = parseStatus(
    await git(cwd, 'status', '--porcelain=v2', '--branch'),
  );
  if (
    status.branch !== branch ||
    status.staged ||
    status.modified ||
    status.conflicts
  )
    return undefined;
  if ((await git(cwd, 'rev-parse', 'HEAD')) !== commit)
    return {
      text: `#${number} merged, but ${branch}'s last commit isn't the one it merged, so it stays.`,
      cleaned: false,
    };
  // GitHub deletes a merged pull request's branch, and a long-lived head branch such as develop keeps its own
  if (
    (await git(
      cwd,
      'for-each-ref',
      '--format=%(upstream:track)',
      `refs/heads/${branch}`,
    )) !== '[gone]'
  )
    return {
      text: `#${number} merged, but ${branch} is still on its remote, so it stays.`,
      cleaned: false,
    };
  // a plain switch overwrites an ignored file the base tracks, and that file was never committed
  await git(cwd, 'switch', '--no-overwrite-ignore', base);
  // the tip check makes -D safe; -d would compare against the base before it's brought up to date
  await git(cwd, 'branch', '-D', branch);
  const plans = await removePlans(cwd, branch);
  const removed = plans.length
    ? `, and ${plans.length > 1 ? 'plans' : 'plan'} ${list(plans)}`
    : '';
  // after the deletions, so a base that can't fast-forward leaves no merged branch or plan behind
  try {
    await git(
      cwd,
      'merge',
      '--ff-only',
      '--no-overwrite-ignore',
      '@{upstream}',
    );
  } catch (error) {
    throw new Error(
      `#${number} merged: switched to ${base} and deleted branch ${branch}${removed}, but ${base} didn't fast-forward: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const deleted = [branch];
  const refs = await git(
    cwd,
    'for-each-ref',
    '--merged',
    'HEAD',
    // :short would print heads/<name> for a branch a tag shares a name with
    '--format=%(refname:lstrip=2)%09%(upstream:track)',
    'refs/heads',
  );
  for (const line of refs.split('\n')) {
    const [name, track] = line.split('\t');
    // a merged pull request's remote branch is gone and a long-lived branch's isn't; -d refuses a branch checked
    // out in a worktree
    if (!name || track !== '[gone]') continue;
    if (
      await git(cwd, 'branch', '-d', name).then(
        () => true,
        () => false,
      )
    )
      deleted.push(name);
  }
  const branches = `${deleted.length > 1 ? 'branches' : 'branch'} ${list(deleted)}`;
  return {
    text: `#${number} merged: switched to ${base} and pulled, deleted ${branches}${removed}.`,
    cleaned: true,
  };
}

/** the gitignored plans whose every branch-creating step creates `branch`, and each ledger whose `plan-path` names one. */
async function removePlans(cwd: string, branch: string): Promise<string[]> {
  const top = await git(cwd, 'rev-parse', '--show-toplevel');
  const plans = join(top, 'docs/superpowers/plans');
  const ledgers = join(top, '.superpowers/sdd');
  const removed: string[] = [];
  for (const name of await readdir(plans).catch(() => [])) {
    const plan = join(plans, name);
    if (!name.endsWith('.md')) continue;
    const created = new Set(
      Array.from(
        (await readFile(plan, 'utf8')).matchAll(
          /git (?:switch -c|checkout -b) ([\w./-]*[\w-])/g,
        ),
        (match) => match[1],
      ),
    );
    // a plan for several branches has work left until its last one merges, so only a plan for this branch alone goes
    if (
      created.size !== 1 ||
      !created.has(branch) ||
      !(await ignored(top, plan))
    )
      continue;
    await rm(plan);
    removed.push(name);
    for (const ledger of await readdir(ledgers).catch(() => [])) {
      const folder = join(ledgers, ledger);
      const link = (
        await readFile(join(folder, 'plan-path'), 'utf8').catch(() => '')
      ).trim();
      if (link && resolve(top, link) === plan && (await ignored(top, folder)))
        await rm(folder, { recursive: true, force: true });
    }
  }
  return removed;
}
