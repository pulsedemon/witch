import { execFile } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { errorMessage } from '../agents/stderr.js';
import type { Coordinator } from './coordinator.js';
import { parseStatus } from './repository.js';
import type {
  PullRequest,
  Repository,
  RepositoryWatch,
  Run,
} from './repository.js';

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

const succeeds = (promise: Promise<unknown>) =>
  promise.then(
    () => true,
    () => false,
  );

/** `git check-ignore` exits 1 for a path no rule ignores, and for a tracked file. */
const ignored = (cwd: string, path: string) =>
  succeeds(git(cwd, 'check-ignore', '-q', path));

/** what a switch would carry along or stop at. untracked files don't count, since `git switch` refuses to overwrite one. */
const changed = ({ staged, modified, conflicts }: Repository) =>
  !!(staged || modified || conflicts);

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
  if (status.branch !== branch || changed(status)) return undefined;
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
    if (await succeeds(git(cwd, 'branch', '-d', name))) deleted.push(name);
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

/**
 * pulls and rebuilds the checkout Witch runs from when it sits clean on `base`, the branch a pull request merged
 * into. running instances keep their code until they restart. returns a sentence saying what it did.
 */
export async function refreshInstall(
  root: string,
  base: string,
  run: Run = execute,
): Promise<string> {
  const status = parseStatus(
    await git(root, 'status', '--porcelain=v2', '--branch'),
  );
  if (status.branch !== base || changed(status))
    return `Witch's checkout at ${root} isn't clean on ${base}, so it wasn't rebuilt.`;
  await git(root, 'fetch');
  // a pull would overwrite an ignored file the incoming commits start tracking
  await git(root, 'merge', '--ff-only', '--no-overwrite-ignore', '@{upstream}');
  await run('pnpm', ['install', '--frozen-lockfile'], {
    cwd: root,
    timeout: 300_000,
  });
  await run('pnpm', ['build'], { cwd: root, timeout: 300_000 });
  return `Rebuilt Witch at ${await git(root, 'rev-parse', '--short', 'HEAD')}, for its next start.`;
}

/**
 * cleans up after the merged pull request whose branch the checkout sits on, once nothing staged, modified or
 * conflicted would block it and the conversation is idle with no error or queue on screen. a cleanup that acted,
 * kept the branch or failed isn't tried again; one that found the checkout changed waits for the next status read.
 */
export function watchMerges(
  repository: Pick<RepositoryWatch, 'snapshot' | 'subscribe'>,
  coordinator: Pick<Coordinator, 'snapshot' | 'subscribe' | 'cleanUpMerge'>,
  install?: string,
): () => void {
  const settled = new Set<string>();
  let attempted: string | undefined;
  let pending: NodeJS.Immediate | undefined;
  const check = () => {
    pending = undefined;
    const status = repository.snapshot;
    const pullRequest = status?.pullRequest;
    const { phase, error, queue } = coordinator.snapshot;
    if (
      pullRequest?.state !== 'MERGED' ||
      status!.branch !== pullRequest.branch ||
      changed(status!) ||
      phase !== 'idle' ||
      error ||
      queue.length ||
      settled.has(pullRequest.commit) ||
      attempted === pullRequest.commit
    )
      return;
    attempted = pullRequest.commit;
    void coordinator.cleanUpMerge(pullRequest, install).then(
      (acted) => {
        if (acted) settled.add(pullRequest.commit);
      },
      // a failed cleanup shows its error; operate can't refuse, since the phase was checked this tick
      () => settled.add(pullRequest.commit),
    );
  };
  // after the publish that called it: a turn's end settles its queue and error after publishing idle
  const schedule = () => {
    pending ??= setImmediate(check);
  };
  const stops = [
    repository.subscribe(() => {
      attempted = undefined;
      schedule();
    }),
    coordinator.subscribe(schedule),
  ];
  schedule();
  return () => {
    clearImmediate(pending);
    stops.forEach((stop) => stop());
  };
}
