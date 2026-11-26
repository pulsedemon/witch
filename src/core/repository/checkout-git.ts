import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tryOpenLocked } from '../../persistence/lock.js';
import { escapeRegExp } from '../../regexp.js';
import { parseStatus, statusArgs } from './repository.js';
import type { Repository } from './repository.js';
import { runCommand } from './command.js';

/** a password prompt would draw over the TUI, and nothing could answer it. */
export const gitIn =
  (cwd: string, signal?: AbortSignal) =>
  async (...args: string[]) =>
    (
      await runCommand('git', args, {
        cwd,
        timeout: 60_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        ...(signal ? { signal } : {}),
      })
    ).stdout.trim();

export type Git = ReturnType<typeof gitIn>;

export const unlessExit1 = <T>(promise: Promise<T>, absent: T): Promise<T> =>
  promise.catch((error: unknown) => {
    if ((error as { code?: unknown } | null | undefined)?.code === 1)
      return absent;

    throw error;
  });

/** a Git config value, or '' when it's unset, which Git reports with exit 1. any other failure throws. */
export const configValue = (git: Git, key: string) =>
  unlessExit1(git('config', key), '');

class FetchRefConflict extends Error {}

/** uses ssh batch mode to avoid passphrase and host key prompts unless the user configured an ssh command. */
export const fetchRemote = async (git: Git, ...args: string[]) => {
  const own =
    process.env.GIT_SSH || (await configValue(git, 'core.sshCommand'));

  try {
    await git(
      ...(own ? [] : ['-c', 'core.sshCommand=ssh -o BatchMode=yes']),
      'fetch',
      ...args,
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;

    const { code, stderr, killed } = error as {
      code?: unknown;
      stderr?: unknown;
      killed?: unknown;
    };

    const diagnostics =
      typeof stderr === 'string'
        ? stderr
            .split(/\r?\n/)
            .filter((line) => /^(?:remote: )?(?:error|fatal):/.test(line))
        : [];

    if (
      code === 1 &&
      !killed &&
      diagnostics.length &&
      diagnostics.every(
        (line) =>
          /^error: cannot lock ref 'refs\/remotes\/[^']+': is at [0-9a-f]+ but expected [0-9a-f]+$/.test(
            line,
          ) ||
          /^error: fetching ref refs\/remotes\/\S+ failed: incorrect old value provided$/.test(
            line,
          ),
      )
    )
      throw new FetchRefConflict(error.message, { cause: error });

    throw error;
  }
};

/** cleanup wrappers retain the fetch failure as their cause. */
export function isFetchRefConflict(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause)
    if (cause instanceof FetchRefConflict) return true;

  return false;
}

export interface CheckoutProgress {
  head?: string;
  target?: string;
  done?: boolean;
}

export const topLevel = (git: Git) => git('rev-parse', '--show-toplevel');

/**
 * the commit `ref` names. --end-of-options keeps a ref named like an option from being read as a flag, and --verify
 * keeps rev-parse from echoing that separator ahead of the commit.
 */
export const commitAt = (git: Git, ref: string) =>
  git('rev-parse', '--verify', '--end-of-options', ref);

export const succeeds = (promise: Promise<unknown>, signal?: AbortSignal) =>
  promise.then(
    () => true,
    (error: unknown) => {
      if (error === signal?.reason) throw error;

      return false;
    },
  );

export const read = async (git: Git) => parseStatus(await git(...statusArgs));

/**
 * what a switch would carry along or stop at. untracked files don't count, since `git switch` refuses to overwrite one.
 */
export const changed = ({ staged, modified, conflicts }: Repository) =>
  !!(staged || modified || conflicts);

/**
 * checks after fetching because another terminal can switch or edit the checkout meanwhile. the second status read is the
 * last read before the merge, which lands on whatever is checked out by then.
 */
export async function fastForward(
  git: Git,
  base: string,
  progress: CheckoutProgress = {},
): Promise<boolean> {
  await fetchRemote(git);

  const left = (status: Repository) =>
    status.branch !== base || changed(status);

  const before = await read(git);

  if (left(before) || !before.commit) return false;

  const target = await commitAt(git, `${base}@{upstream}^{commit}`);

  const ahead =
    target !== before.commit && (await isAncestor(git, target, before.commit));

  const status = await read(git);
  const head = status.commit;

  if (left(status) || !head || head !== before.commit) return false;

  if (progress.head && head !== progress.head && head !== progress.target)
    return false;

  progress.head = head;
  progress.target = ahead ? head : target;
  await git('merge', '--ff-only', '--no-overwrite-ignore', target);
  progress.head = progress.target;
  progress.done = true;

  return true;
}

/** git answers no with exit 1; any other failure throws. */
export const isAncestor = (git: Git, ancestor: string, commit: string) =>
  unlessExit1(
    git('merge-base', '--is-ancestor', ancestor, commit).then(() => true),
    false,
  );

/** skips a checkout another Witch is updating; locking the git directory leaves no file behind. */
export async function lockCheckout(git: Git): Promise<FileHandle | undefined> {
  return tryOpenLocked(
    await git('rev-parse', '--absolute-git-dir'),
    constants.O_RDONLY,
  );
}

/** an absent ref is expected after an interrupted deletion, but a Git failure is not absence. */
export async function refHead(
  git: Git,
  branch: string,
): Promise<string | undefined> {
  return unlessExit1<string | undefined>(
    git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`),
    undefined,
  );
}

export async function hasBranchConfig(
  git: Git,
  branch: string,
): Promise<boolean> {
  const section = `^branch\\.${escapeRegExp(branch)}\\.`;

  return unlessExit1(
    git('config', '--get-regexp', section).then(() => true),
    false,
  );
}

export function reconcilePull(progress: CheckoutProgress, head: string): void {
  if (progress.target && head === progress.target) {
    progress.head = progress.target;
    progress.done = true;
  }
}
