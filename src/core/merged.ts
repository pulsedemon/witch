import { constants } from 'node:fs';

import type { FileHandle } from 'node:fs/promises';

import { readFile, readdir, rm } from 'node:fs/promises';

import { basename, join, resolve } from 'node:path';

import { setTimeout as delay } from 'node:timers/promises';

import { errorMessage } from '../errors.js';

import type { Memory } from '../memory/memory.js';

import { within } from '../paths.js';

import { unlessGone } from '../persistence/json.js';

import { tryOpenLocked } from '../persistence/lock.js';

import { runs } from '../persistence/process.js';

import type { StateStore } from '../persistence/store.js';

import { runCommand } from './command.js';

import type { Conversation } from './state.js';

import { gitHubRepository, parseStatus, statusArgs } from './repository.js';

import type { PullRequest, Repository, Run } from './repository.js';

/** a password prompt would draw over the TUI, and nothing could answer it. */
const gitIn =
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

type Git = ReturnType<typeof gitIn>;

interface CheckoutProgress {
  head?: string;
  target?: string;
  done?: boolean;
}

interface PlanRemoval {
  root?: string;
  /** absolute paths, since two plan directories can hold the same name */
  removed: string[];
  stayed: string[];
  ledgers: string[];
  /** the first reason a plan stayed */
  reason?: string;
  /** the first reason a plan directory couldn't be listed */
  unlisted?: string;
  done?: boolean;
}

export interface MergeCleanup {
  cwd?: string;
  /**
   * the base's upstream, such as `origin/main`, or the merged branch's remote copy of a base with no local branch, where
   * a linked worktree, or a checkout whose base one holds, detaches.
   */
  detached?: string;
  switchHead?: string;
  moved?: boolean;
  /** retain the remote used before policy lookup so a resumed cleanup cannot adopt a replacement. */
  remote?: { name: string; url: string };
  unset?: string;
  plans?: PlanRemoval;
  pull?: CheckoutProgress;
  deleted?: string[];
  configured?: string[];
  failures?: string[];
  pruned?: string[];
  pruning?: { name: string; head: string; retained: boolean };
  result?: { text: string; cleaned: boolean };
  install?: InstallProgress;
  /** the post-abort reconcile failed, so the checkpoints above may trail the checkout and resuming could repeat a step. */
  unconfirmed?: boolean;
}

export type CleanupResult = boolean | 'changed' | 'interrupted';

/** keep cancellation out of the error state so queued turns can run before cleanup resumes. */
export async function runMergeCleanup(
  pullRequest: PullRequest,
  progress: MergeCleanup,
  {
    store,
    memory,
    conversation: { id, cwd },
    install,
    signal,
    notice,
  }: {
    store: StateStore;
    memory: Memory;
    conversation: Conversation;
    install?: string;
    signal: AbortSignal;
    notice(text: string): void;
  },
): Promise<CleanupResult> {
  try {
    const reported = progress.result;

    const outcome = await cleanUpMerge(
      cwd,
      pullRequest,
      () => peerTurnIn(store, id, cwd, signal),
      { signal, progress },
    );

    if (typeof outcome !== 'object') return outcome ?? false;

    // first, so a failed rebuild doesn't lose the completed cleanup's notice
    if (!reported) notice(outcome.text);

    let acted = true;

    if (
      outcome.cleaned &&
      install &&
      (await memory.scopePaths(cwd)).project ===
        (await memory.scopePaths(install)).project
    ) {
      const resuming = !!progress.install;

      progress.install ??= {};

      notice(
        await refreshInstall(install, pullRequest.base, undefined, {
          signal,
          progress: progress.install,
        }),
      );

      if (resuming && !progress.install.built) acted = false;
    }

    signal.throwIfAborted();

    return acted;
  } catch (error) {
    if (error !== signal.reason) throw error;

    notice('Merge cleanup interrupted.');

    if (!progress.unconfirmed && !progress.install?.unconfirmed)
      return 'interrupted';

    const left = unconfirmedSteps(pullRequest, progress, install);

    notice(
      `Witch couldn't confirm how far merge cleanup got, so it won't resume.${left.length ? ` Left to check: ${list(left)}.` : ''}`,
    );

    // settled, so the watch doesn't resume from checkpoints that may trail the checkout
    return true;
  }
}

/** the steps an interrupted cleanup's progress doesn't record as done, in the order cleanup runs them. */
function unconfirmedSteps(
  { branch, base }: PullRequest,
  progress: MergeCleanup,
  install?: string,
): string[] {
  const steps: string[] = [];

  if (!progress.moved)
    steps.push(
      progress.detached
        ? `detaching at ${progress.detached}`
        : `switching to ${base}`,
    );

  if (
    !progress.deleted ||
    progress.unset === undefined ||
    !progress.plans?.done
  )
    steps.push(`deleting ${branch} with its config and plans`);

  if (!progress.pull?.done) steps.push(`fast-forwarding ${base}`);

  if (!progress.result) steps.push('pruning merged branches');

  // without install progress, cleanup stopped before checking whether the rebuild applies
  if (progress.install) {
    if (!progress.install.built)
      steps.push("updating and rebuilding Witch's checkout");
  } else if (install)
    steps.push("whether Witch's checkout needs updating and rebuilding");

  return steps;
}

interface InstallProgress {
  root?: string;
  checkout?: CheckoutProgress;
  installed?: boolean;
  built?: boolean;
  /** the post-abort reconcile of `checkout` failed. */
  unconfirmed?: boolean;
}

const topLevel = (git: Git) => git('rev-parse', '--show-toplevel');

/** whether another conversation's turn runs in `cwd`'s checkout, or a record that could be one is unreadable. */
async function peerTurnIn(
  store: StateStore,
  id: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const { records, unreadable } = await store.records();

  // the launch's sweep names it
  if (unreadable.length) return true;

  const top = await topLevel(gitIn(cwd, signal));

  for (const record of records)
    if (
      record.id !== id &&
      within(record.cwd, top) &&
      record.activity &&
      record.process &&
      (await runs(record.process))
    )
      return true;

  return false;
}

/** a Git config value, or '' when it's unset, which Git reports with exit 1. any other failure throws. */
const configValue = (git: Git, key: string) =>
  git('config', key).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === 1) return '';

    throw error;
  });

/** uses ssh batch mode to avoid passphrase and host key prompts unless the user configured an ssh command. */
const fetchRemote = async (git: Git, ...args: string[]) => {
  const own =
    process.env.GIT_SSH || (await configValue(git, 'core.sshCommand'));

  await git(
    ...(own ? [] : ['-c', 'core.sshCommand=ssh -o BatchMode=yes']),
    'fetch',
    ...args,
  );
};

const succeeds = (promise: Promise<unknown>, signal?: AbortSignal) =>
  promise.then(
    () => true,
    (error: unknown) => {
      if (error === signal?.reason) throw error;

      return false;
    },
  );

const read = async (git: Git) => parseStatus(await git(...statusArgs));

/** GitHub deletes a merged branch seconds after the merge, which the watch can see first. */
const deleting = ({ mergedAt }: PullRequest) =>
  !!mergedAt && Date.now() - Date.parse(mergedAt) < 15_000;

/** the default branch of a repository that retains its own merged heads; forks don't inherit the base's policy. */
async function retainedDefaultBranch(
  { url, number }: PullRequest,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const github = gitHubRepository(url);

  if (!github) return undefined;

  const [owner, name] = github.repository.split('/');

  const { stdout } = await runCommand(
    'gh',
    [
      'api',
      'graphql',
      '--hostname',
      github.host,
      '-f',
      'query=query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { deleteBranchOnMerge defaultBranchRef { name } pullRequest(number: $number) { isCrossRepository } } }',
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `number=${number}`,
      '--jq',
      '.data.repository | .deleteBranchOnMerge, .defaultBranchRef.name, .pullRequest.isCrossRepository',
    ],
    { cwd, timeout: 30_000, ...(signal ? { signal } : {}) },
  ).catch((error: unknown) => {
    if (error === signal?.reason) throw error;

    // the command line carries the whole query, so the error names gh's timeout, stderr or exit code where it has one
    const { stderr, killed, code } = error as {
      stderr?: unknown;
      killed?: unknown;
      code?: unknown;
    };

    throw new Error(
      [killed && 'gh timed out', String(stderr ?? '').trim()]
        .filter(Boolean)
        .join(': ') ||
        (typeof code === 'number'
          ? `gh exited with code ${code}`
          : errorMessage(error)),
      { cause: error },
    );
  });

  const [deletes, base, fork] = stdout.trim().split('\n');

  if (deletes !== 'true' && deletes !== 'false')
    throw new Error(`deleteBranchOnMerge was ${deletes || 'empty'}`);

  if (!base || base === 'null')
    throw new Error('the default branch was missing');

  if (fork !== 'true' && fork !== 'false')
    throw new Error(`isCrossRepository was ${fork || 'empty'}`);

  return deletes === 'false' && fork === 'false' ? base : undefined;
}

/** `git check-ignore` exits 1 for a path no rule ignores, and for a tracked file. any other failure throws. */
const ignored = (git: Git, path: string) =>
  git('check-ignore', '-q', path).then(
    () => true,
    (error: unknown) => {
      if ((error as { code?: unknown }).code !== 1) throw error;

      return false;
    },
  );

/**
 * what a switch would carry along or stop at. untracked files don't count, since `git switch` refuses to overwrite one.
 */
export const changed = ({ staged, modified, conflicts }: Repository) =>
  !!(staged || modified || conflicts);

/** checks after fetching because another terminal can switch or edit the checkout meanwhile. */
async function fastForward(
  git: Git,
  base: string,
  progress: CheckoutProgress = {},
): Promise<boolean> {
  await fetchRemote(git);

  const status = await read(git);

  if (status.branch !== base || changed(status)) return false;

  const head = await git('rev-parse', 'HEAD');

  if (progress.head && head !== progress.head && head !== progress.target)
    return false;

  progress.head = head;

  progress.target = await git('rev-parse', '@{upstream}');

  await git('merge', '--ff-only', '--no-overwrite-ignore', progress.target);

  progress.head = progress.target;

  progress.done = true;

  return true;
}

const list = (items: string[]) =>
  items.length > 1
    ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
    : items[0]!;

/** skips a checkout another Witch is updating; locking the git directory leaves no file behind. */
async function lockCheckout(git: Git): Promise<FileHandle | undefined> {
  return tryOpenLocked(
    await git('rev-parse', '--absolute-git-dir'),
    constants.O_RDONLY,
  );
}

/** whether the checkout sits where the cleanup moves it: on the base, or detached at the target when it detaches. */
const arrived = (
  progress: MergeCleanup,
  base: string,
  { branch }: Repository,
  head: string,
) =>
  progress.detached
    ? branch === 'HEAD' && head === progress.switchHead
    : branch === base;

/**
 * what a merged pull request leaves in the checkout at `cwd`: switches to the base and brings it up to date, or detaches
 * at the base's remote branch in a linked worktree or while one holds the base, deletes the branch and its gitignored
 * plans with their gitignored ledgers, and prunes unused merged branches with gone upstreams. when the repository
 * retains its own merged heads, it also prunes branches at their own upstream tip on the head's remote, excluding the
 * base and default branch. returns a sentence saying what it did, and whether it moved the checkout, `'changed'` when
 * the checkout left the branch or changed, or nothing when another Witch is updating it or `blocked` says one is working
 * in it.
 */
export async function cleanUpMerge(
  cwd: string,
  pullRequest: PullRequest,
  blocked: () => Promise<boolean>,
  {
    signal,
    progress = {},
  }: { signal?: AbortSignal; progress?: MergeCleanup } = {},
): Promise<{ text: string; cleaned: boolean } | 'changed' | undefined> {
  signal?.throwIfAborted();

  if (progress.cwd && progress.cwd !== cwd) return 'changed';

  progress.cwd = cwd;

  if (await blocked()) return undefined;

  const git = gitIn(cwd, signal);

  const lock = await lockCheckout(git).catch((error: unknown) => {
    if (error === signal?.reason) throw error;

    throw new Error(
      `#${pullRequest.number} merged, but its cleanup failed while locking ${pullRequest.branch}: ${errorMessage(error).trim()}`,
      { cause: error },
    );
  });

  if (!lock) return undefined;

  try {
    return await clean(git, cwd, pullRequest, blocked, progress, signal);
  } catch (error) {
    if (error === signal?.reason && progress.switchHead) {
      const reconcile = AbortSignal.timeout(1000);

      // a failed reconcile must not replace the interruption
      await reconcileCleanup(
        gitIn(cwd, reconcile),
        pullRequest,
        progress,
        reconcile,
      ).catch(() => (progress.unconfirmed = true));
    }

    throw error;
  } finally {
    await lock.close();
  }
}

async function clean(
  git: Git,
  cwd: string,
  pullRequest: PullRequest,
  blocked: () => Promise<boolean>,
  progress: MergeCleanup,
  signal?: AbortSignal,
): Promise<{ text: string; cleaned: boolean } | 'changed' | undefined> {
  const { number, branch, commit, base } = pullRequest;

  let policy: Promise<string | undefined> | undefined;

  const defaultBranch = () =>
    (policy ??= retainedDefaultBranch(pullRequest, cwd, signal));

  const stopped = (error: unknown): never => {
    if (error === signal?.reason) throw error;

    throw new Error(
      `#${number} merged, but its cleanup failed before deleting ${branch}: ${errorMessage(error).trim()}`,
      { cause: error },
    );
  };

  if (progress.switchHead) {
    const status = await read(git);

    const head = await git('rev-parse', 'HEAD');

    if (changed(status)) return 'changed';

    if (arrived(progress, base, status, head)) {
      const installed =
        progress.install?.root === progress.plans?.root
          ? progress.install?.checkout
          : undefined;

      const expected = installed?.done
        ? installed.head
        : progress.pull?.done
          ? progress.pull.head
          : progress.switchHead;

      if (
        head !== expected &&
        (progress.pull?.done || head !== progress.pull?.target)
      )
        return 'changed';

      progress.moved = true;

      if (progress.pull?.target === head) {
        progress.pull.head = head;

        progress.pull.done = true;
      }
    } else if (progress.moved || status.branch !== branch || head !== commit)
      return 'changed';

    if (progress.deleted?.includes(branch) && (await refHead(git, branch)))
      return 'changed';
  }

  if (progress.result) return progress.result;

  if (!progress.moved) {
    // a linked worktree never takes the base, which would leave the main checkout unable to switch back to it. the main
    // checkout detaches only while a worktree holds the base, and keeps that decision, so a retry after it lets go still
    // detaches
    if (progress.detached === undefined) {
      // separate reads keep newlines inside paths from becoming separators between them
      const [gitDir, commonDir, top] = await Promise.all([
        git('rev-parse', '--path-format=absolute', '--git-dir'),
        git('rev-parse', '--path-format=absolute', '--git-common-dir'),
        git('rev-parse', '--path-format=absolute', '--show-toplevel'),
      ]).catch(stopped);

      const holder = await git(
        'for-each-ref',
        '--format=%(worktreepath)',
        `refs/heads/${base}`,
      ).catch(stopped);

      // a stacked pull request's base can exist only on the merged branch's remote
      if (gitDir !== commonDir || (holder && holder !== top))
        progress.detached = (await refHead(git, base).catch(stopped))
          ? await git('rev-parse', '--abbrev-ref', `${base}@{upstream}`).catch(
              stopped,
            )
          : `${await configValue(git, `branch.${branch}.remote`).catch(stopped)}/${base}`;
    }

    if (!progress.remote && gitHubRepository(pullRequest.url)) {
      const name = await configValue(git, `branch.${branch}.remote`).catch(
        stopped,
      );

      if (name && name !== '.')
        progress.remote = {
          name,
          url: await git('remote', 'get-url', name).catch(stopped),
        };
    }

    const track = async () => {
      await fetchRemote(git, '--prune').catch(stopped);

      return (
        await git(
          'for-each-ref',
          '--format=%(upstream:short)%09%(upstream:track)%09%(upstream:remoteref)',
          `refs/heads/${branch}`,
        ).catch(stopped)
      ).split('\t');
    };

    let [upstream, tracking, merges] = await track();

    const onRemote = () =>
      !!upstream && merges === `refs/heads/${branch}` && tracking !== '[gone]';

    // a failed lookup falls back to waiting for GitHub's deletion, and is named only if the branch stays
    let unread = '';

    const keeps =
      onRemote() &&
      (await defaultBranch()
        .then((name) => name !== undefined && name !== branch)
        .catch((error: unknown) => {
          if (error === signal?.reason) throw error;

          unread = errorMessage(error).trim();

          return false;
        }));

    // GitHub can delete the branch, or someone push to it, while the lookup runs
    if (onRemote()) [upstream, tracking, merges] = await track();

    while (!keeps && onRemote() && deleting(pullRequest)) {
      await delay(2000, undefined, { signal }).catch(() =>
        signal?.throwIfAborted(),
      );

      [upstream, tracking, merges] = await track();
    }

    // a detach takes the base's upstream as it is now, so its own remote is fetched here, before the checks below, since
    // a slow fetch gives another terminal time to switch or edit
    if (progress.detached) {
      const remote = (name: string) =>
        configValue(git, `branch.${name}.remote`).catch(stopped);

      const own = await remote(base);

      if (own && own !== (await remote(branch)))
        await fetchRemote(git, own).catch(stopped);
    }

    // after the fetch, which can take a while: the watch's status is seconds old, and a commit made meanwhile would
    // go with the branch
    const status = await read(git).catch(stopped);

    if (status.branch !== branch || changed(status)) return 'changed';

    if ((await git('rev-parse', 'HEAD').catch(stopped)) !== commit)
      return {
        text: `#${number} merged, but ${branch}'s last commit isn't the one it merged, so it stays.`,
        cleaned: false,
      };

    if (!upstream)
      return {
        text: `#${number} merged, but ${branch} tracks no remote branch, so it stays.`,
        cleaned: false,
      };

    // `git switch -c feat/x origin/main` makes a branch that tracks main
    if (merges !== `refs/heads/${branch}`)
      return {
        text: `#${number} merged, but ${branch} tracks ${upstream} rather than its own remote branch, so it stays.`,
        cleaned: false,
      };

    // a kept branch has to be at the merged commit or gone. any other has to be gone, since GitHub deletes a merged head
    // branch but leaves a long-lived one such as develop
    if (keeps && tracking && tracking !== '[gone]')
      return {
        text: `#${number} merged, but ${branch}'s remote branch has changed since, so it stays.`,
        cleaned: false,
      };

    if (!keeps && tracking !== '[gone]')
      return {
        text: `#${number} merged, but ${branch} is still on its remote, so it stays${unread && ` (couldn't read whether the repository keeps merged branches: ${unread})`}.`,
        cleaned: false,
      };

    // again: a turn that started during the fetch changes nothing the status shows
    if (await blocked()) return undefined;

    if (progress.detached) {
      const upstream = (await refHead(git, base).catch(stopped))
        ? `${base}@{upstream}`
        : `refs/remotes/${progress.detached}`;

      const target = await git(
        'rev-parse',
        '--verify',
        `${upstream}^{commit}`,
      ).catch(stopped);

      progress.switchHead = target;

      // already at the fetched upstream, so there's nothing to fast-forward
      progress.pull = { head: target, target, done: true };
    } else progress.switchHead = await git('rev-parse', `refs/heads/${base}`);

    // a plain switch overwrites an ignored file the base tracks, and that file was never committed
    const failed = await git(
      'switch',
      '--no-overwrite-ignore',
      ...(progress.detached ? ['--detach'] : []),
      '--end-of-options',
      progress.detached ? progress.switchHead : base,
    ).then(
      () => undefined,
      (error: unknown) => {
        if (error === signal?.reason) throw error;

        return error;
      },
    );

    // a post-checkout hook runs after the switch has moved the checkout, can fail it, and can move it again
    const after = await read(git).catch(stopped);

    const head = await git('rev-parse', 'HEAD').catch(stopped);

    if (!arrived(progress, base, after, head)) {
      if (failed && after.branch === branch && head === commit) stopped(failed);

      return 'changed';
    }

    progress.moved = true;
  }

  const moved = progress.detached
    ? `detached at ${progress.detached}`
    : `switched to ${base}`;

  const pulled = progress.detached ? moved : `${moved} and pulled`;

  // deleted only while still at the merged commit, since another terminal can commit to it after the tip check. -d
  // would compare against the base before it's brought up to date
  if (!progress.deleted)
    try {
      if (await refHead(git, branch))
        await git('update-ref', '-d', `refs/heads/${branch}`, commit);

      progress.deleted = [branch];
    } catch (error) {
      if (error === signal?.reason) throw error;

      throw new Error(
        `#${number} merged: ${moved}, but ${branch} wasn't deleted: ${errorMessage(error)}`,
        { cause: error },
      );
    }

  // branch -D would drop it too, and a later branch of the same name would inherit its upstream
  const hasConfig =
    progress.unset === undefined && (await hasBranchConfig(git, branch));

  const unset = (progress.unset ??= hasConfig
    ? await git('config', '--remove-section', `branch.${branch}`).then(
        () => '',
        (error: unknown) => {
          if (error === signal?.reason) throw error;

          return `config section branch.${branch} stayed: ${errorMessage(error).trim()}`;
        },
      )
    : '');

  const {
    removed: plans,
    stayed,
    reason,
    unlisted,
  } = await removePlans(
    git,
    branch,
    (progress.plans ??= { removed: [], stayed: [], ledgers: [] }),
    signal,
  ).catch((error: unknown) => {
    if (error === signal?.reason) throw error;

    throw new Error(
      `#${number} merged: ${moved} and deleted branch ${branch}${unset && ` (${unset})`}, but could not locate its plans: ${errorMessage(error)}`,
      { cause: error },
    );
  });

  const named = (paths: string[]) =>
    `${paths.length > 1 ? 'plans' : 'plan'} ${list(paths.map((path) => basename(path)))}`;

  const removed = plans.length ? `, and ${named(plans)}` : '';

  const kept = [
    unset,
    reason && `${named(stayed)} stayed: ${reason}`,
    unlisted && `plans stayed: ${unlisted}`,
  ]
    .filter(Boolean)
    .join(' and ');

  // after the branch and its plans go, so a base that can't fast-forward still deletes them
  try {
    // fetch again on the base, which can track a different remote
    progress.pull ??= { head: progress.switchHead };

    if (!progress.pull.done && !(await fastForward(git, base, progress.pull)))
      throw new Error(`the checkout left ${base} or changed during the fetch`);
  } catch (error) {
    if (error === signal?.reason) throw error;

    throw new Error(
      `#${number} merged: ${moved} and deleted branch ${branch}${removed}${kept && ` (${kept})`}, but ${base} didn't fast-forward: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const deleted = progress.deleted;

  // with the config locked, branch -d deletes a branch and exits 0 with only a warning that its upstream stayed
  const configured = (progress.configured ??= []);

  const failures = (progress.failures ??= []);

  const pruned = (progress.pruned ??= []);

  await reconcilePruning(git, progress, signal);

  const readBranches = async (name?: string) =>
    (
      await git(
        'for-each-ref',
        ...(name ? [] : ['--merged', progress.pull!.head!]),
        // :short would print heads/<name> for a branch a tag shares a name with
        '--format=%(refname:lstrip=2)%09%(upstream:track)%09%(worktreepath)%09%(objectname)%09%(upstream)%09%(upstream:remotename)%09%(upstream:remoteref)',
        name ? `refs/heads/${name}` : 'refs/heads',
      )
    )
      .split('\n')
      .map((line) => {
        const [name, track, worktree, head, upstream, remote, merges] =
          line.split('\t');

        return { name, track, worktree, head, upstream, remote, merges };
      })
      .filter(
        ({ name, head, worktree }) =>
          name && head && name !== base && !worktree && !pruned.includes(name),
      );

  let refs = await readBranches().catch((error: unknown) => {
    if (error === signal?.reason) throw error;

    throw new Error(
      `#${number} merged: ${pulled}, deleted branch ${branch}${removed}${kept && ` (${kept})`}, but could not list other merged branches: ${errorMessage(error)}`,
      { cause: error },
    );
  });

  const retained = (ref: (typeof refs)[number]) =>
    progress.remote &&
    ref.track !== '[gone]' &&
    ref.upstream &&
    ref.remote === progress.remote.name &&
    ref.merges === `refs/heads/${ref.name}`;

  const retainedFailure = 'retained merged branches stayed:';

  for (let index = failures.length - 1; index >= 0; index--)
    if (failures[index]!.startsWith(retainedFailure)) failures.splice(index, 1);

  let keptDefault: string | undefined;

  let common: string | undefined;

  if (refs.some(retained))
    try {
      const name = await defaultBranch();

      if (name && refs.some((ref) => retained(ref) && ref.name !== name)) {
        const remote = progress.remote!;

        const checkRemote = async () => {
          if ((await git('remote', 'get-url', remote.name)) !== remote.url)
            throw new Error(`${remote.name}'s URL changed during cleanup`);
        };

        await checkRemote();

        await fetchRemote(git, remote.name).catch((error: unknown) => {
          if (error === signal?.reason) throw error;

          throw new Error(
            `couldn't refresh ${remote.name}: ${errorMessage(error).trim()}`,
            { cause: error },
          );
        });

        await checkRemote();

        refs = await readBranches();

        keptDefault = name;
      }
    } catch (error) {
      if (error === signal?.reason) throw error;

      failures.push(`${retainedFailure} ${errorMessage(error).trim()}`);
    }

  for (const ref of refs) {
    const { name, track, head, upstream } = ref;

    if (!name || !head) continue;

    const retaining = track !== '[gone]';

    if (retaining && (!keptDefault || name === keptDefault || !retained(ref)))
      continue;

    progress.pruning = { name, head, retained: retaining };

    try {
      if (retaining) {
        const remoteHead = await git('rev-parse', '--verify', upstream!);

        common ??= await git(
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        );

        const busy = await branchInOperation(common, name);

        const fresh = (await readBranches(name)).find(
          (candidate) => candidate.name === name,
        );

        if (
          busy ||
          !fresh ||
          fresh.head !== head ||
          fresh.upstream !== upstream ||
          !retained(fresh) ||
          remoteHead !== head
        ) {
          delete progress.pruning;

          continue;
        }

        await git('update-ref', '-d', `refs/heads/${name}`, head);
      } else await git('branch', '-d', '--end-of-options', name);
    } catch (error) {
      if (error === signal?.reason) throw error;

      failures.push(`branch ${name} stayed: ${errorMessage(error).trim()}`);

      pruned.push(name);

      delete progress.pruning;

      continue;
    }

    deleted.push(name);

    if (retaining) await removePrunedConfig(git, name, failures, signal);
    else if (
      await succeeds(git('config', '--get', `branch.${name}.merge`), signal)
    )
      configured.push(`branch.${name}`);

    pruned.push(name);

    delete progress.pruning;
  }

  const branches = `${deleted.length > 1 ? 'branches' : 'branch'} ${list(deleted)}`;

  const left = [
    kept,
    ...failures,
    configured.length &&
      `config ${configured.length > 1 ? 'sections' : 'section'} ${list(configured)} stayed`,
  ]
    .filter(Boolean)
    .join(' and ');

  return (progress.result = {
    text: `#${number} merged: ${pulled}, deleted ${branches}${removed}${left && `, but ${left}`}.`,
    cleaned: true,
  });
}

/** an absent ref is expected after an interrupted deletion, but a Git failure is not absence. */
async function refHead(git: Git, branch: string): Promise<string | undefined> {
  return git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).catch(
    (error: unknown) => {
      if ((error as { code?: unknown }).code === 1) return undefined;

      throw error;
    },
  );
}

async function hasBranchConfig(git: Git, branch: string): Promise<boolean> {
  const section = `^branch\\.${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`;

  return git('config', '--get-regexp', section).then(
    () => true,
    (error: unknown) => {
      if ((error as { code?: unknown }).code === 1) return false;

      throw error;
    },
  );
}

/** checkpoint mutations while the lock and cleaning phase still exclude queued work that could recreate a name. */
async function reconcileCleanup(
  git: Git,
  request: PullRequest,
  progress: MergeCleanup,
  signal: AbortSignal,
): Promise<void> {
  if (
    arrived(
      progress,
      request.base,
      await read(git),
      await git('rev-parse', 'HEAD'),
    )
  )
    progress.moved = true;

  if (!progress.moved) return;

  if (!progress.deleted && !(await refHead(git, request.branch)))
    progress.deleted = [request.branch];

  if (
    progress.deleted &&
    progress.unset === undefined &&
    !(await hasBranchConfig(git, request.branch))
  )
    progress.unset = '';

  if (progress.pull) await reconcilePull(git, progress.pull);

  await reconcilePruning(git, progress, signal);
}

async function reconcilePull(
  git: Git,
  progress: CheckoutProgress,
): Promise<void> {
  if (progress.target && (await git('rev-parse', 'HEAD')) === progress.target) {
    progress.head = progress.target;

    progress.done = true;
  }
}

async function reconcilePruning(
  git: Git,
  progress: MergeCleanup,
  signal?: AbortSignal,
): Promise<void> {
  if (!progress.pruning) return;

  const { name, head, retained } = progress.pruning;

  const current = await refHead(git, name);

  if (current === head) return;

  if (!current) {
    if (!progress.deleted!.includes(name)) progress.deleted!.push(name);

    if (retained)
      await removePrunedConfig(git, name, progress.failures!, signal);
    else if (
      await succeeds(git('config', '--get', `branch.${name}.merge`), signal)
    )
      progress.configured!.push(`branch.${name}`);
  } else
    progress.failures!.push(`branch ${name} stayed: its last commit changed`);

  progress.pruned!.push(name);

  delete progress.pruning;
}

async function removePrunedConfig(
  git: Git,
  name: string,
  failures: string[],
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (await hasBranchConfig(git, name))
      await git('config', '--remove-section', `branch.${name}`);
  } catch (error) {
    if (error === signal?.reason) throw error;

    failures.push(
      `config section branch.${name} stayed: ${errorMessage(error).trim()}`,
    );
  }
}

/** keep branches owned by rebase or bisect; their detached HEADs are absent from %(worktreepath). */
async function branchInOperation(
  common: string,
  name: string,
): Promise<boolean> {
  const worktrees = join(common, 'worktrees');

  const admins = [
    common,
    ...((await unlessGone(readdir(worktrees))) ?? []).map((entry) =>
      join(worktrees, entry),
    ),
  ];

  for (const admin of admins) {
    const [merge, apply, bisect, updates] = await Promise.all(
      [
        'rebase-merge/head-name',
        'rebase-apply/head-name',
        'BISECT_START',
        'rebase-merge/update-refs',
      ].map((file) => unlessGone(readFile(join(admin, file), 'utf8'))),
    );

    if (
      [merge, apply, bisect].some(
        (branch) =>
          branch?.replace(/\n+$/, '').replace(/^refs\/heads\//, '') === name,
      ) ||
      updates
        ?.split('\n')
        .some((ref, index) => index % 3 === 0 && ref === `refs/heads/${name}`)
    )
      return true;
  }

  return false;
}

/**
 * the option of a switch, checkout or worktree add that creates a branch, alone or among other short options, with
 * the name when it's attached.
 */
const creating = new Map([
  ['switch', /^(?:-[a-zA-Z]*?[cC]|--(?:force-)?create=?|--orphan=?)(.*)/],
  ['checkout', /^(?:-[a-zA-Z]*?[bB]|--orphan=?)(.*)/],
  ['worktree', /^-[a-zA-Z]*?[bB](.*)/],
]);

/**
 * the branch each git command in `text` creates, as written. a command that creates one it doesn't name counts as
 * the command itself, so that a plan with a step this misreads stays rather than going.
 */
function createdBranches(text: string): Set<string> {
  const created = new Set<string>();

  const add = (name: string) => created.add(name.replace(/[.,:]+$/, ''));

  // a backslash at a line's end continues the command
  for (const [command] of text
    .replace(/\\\n\s*/g, ' ')
    .matchAll(/\bgit [^\n`;&|)]*/g)) {
    // a quoted path with a space in it is one word
    const words = command.match(/"[^"]*"|'[^']*'|\S+/g)!.slice(1);

    // options before the subcommand, and the value of those that take one, such as -C <dir>
    while (words[0]?.startsWith('-'))
      words.splice(
        0,
        /^(?:-[Cc]|--(?:git-dir|work-tree|namespace|config-env))$/.test(
          words[0],
        )
          ? 2
          : 1,
      );

    const [subcommand = '', ...args] = words;

    if (subcommand === 'branch') {
      const names = args.filter((word) => !word.startsWith('-'));

      if (
        !names.length ||
        args.some((word) =>
          /^(?:-[dDlu]|--(?:delete|list|contains|no-contains|merged|no-merged|points-at|set-upstream-to|unset-upstream|edit-description))/.test(
            word,
          ),
        )
      )
        continue;

      // a rename or a copy creates its last name
      add(
        args.some((word) => /^(?:-[mMcC]|--move|--copy)$/.test(word))
          ? names.at(-1)!
          : names[0]!,
      );

      continue;
    }

    const option = creating.get(subcommand);

    if (!option || (subcommand === 'worktree' && args[0] !== 'add')) continue;

    const index = args.findIndex((word) => option.test(word));

    if (index >= 0) {
      // with no name after it, the option is only mentioned
      const name = option.exec(args[index]!)![1] || args[index + 1];

      if (name) add(name);
    }
    // a worktree without -b creates one named after its path, and --track one named after the remote branch
    else if (
      subcommand === 'worktree' ||
      args.some((word) => /^(?:-t|--track)/.test(word))
    )
      add(command);
  }

  return created;
}

/**
 * where a checkout keeps the gitignored plans and ledgers its merge cleanup removes with their branch. a repository
 * keeps its plans in whichever of `plans` its own instructions name.
 */
export const planDirectories = {
  plans: ['docs/superpowers/plans', 'docs/plans'],
  ledgers: '.superpowers/sdd',
} as const;

/**
 * removes the gitignored plans that create `branch` and no other branch, each with the gitignored ledgers whose
 * `plan-path` names it. returns those removed, those it failed to read, check or remove with the first reason, and
 * the first reason a plan directory couldn't be listed.
 */
async function removePlans(
  git: Git,
  branch: string,
  progress: PlanRemoval,
  signal?: AbortSignal,
): Promise<PlanRemoval> {
  if (progress.done) return progress;

  const top = await topLevel(git);

  progress.root = top;

  const ledgers = join(top, planDirectories.ledgers);

  const { removed, stayed } = progress;

  for (const directory of planDirectories.plans) {
    const plans = join(top, directory);

    let names: string[];

    try {
      names = (await unlessGone(readdir(plans))) ?? [];
    } catch (error) {
      progress.unlisted ??= errorMessage(error);

      continue;
    }

    for (const name of names) {
      const plan = join(plans, name);

      if (
        !name.endsWith('.md') ||
        removed.includes(plan) ||
        stayed.includes(plan)
      )
        continue;

      try {
        // a plan that isn't there, such as a dangling link, creates no branch
        const created = createdBranches(
          (await unlessGone(readFile(plan, 'utf8'))) ?? '',
        );

        // a plan for several branches has work left until its last one merges, so only a plan for this branch alone goes
        if (
          created.size !== 1 ||
          !created.has(branch) ||
          !(await ignored(git, plan))
        )
          continue;

        // the ledgers first, since only the plan leads to them
        for (const ledger of (await unlessGone(readdir(ledgers))) ?? []) {
          const folder = join(ledgers, ledger);

          if (progress.ledgers.includes(folder)) continue;

          const link = (
            (await unlessGone(readFile(join(folder, 'plan-path'), 'utf8'))) ??
            ''
          ).trim();

          if (
            link &&
            resolve(top, link) === plan &&
            (await ignored(git, folder))
          ) {
            signal?.throwIfAborted();

            await rm(folder, { recursive: true, force: true });

            progress.ledgers.push(folder);
          }
        }

        signal?.throwIfAborted();

        await rm(plan);

        removed.push(plan);
      } catch (error) {
        if (error === signal?.reason) throw error;

        stayed.push(plan);

        progress.reason ??= errorMessage(error).trim();
      }
    }
  }

  progress.done = true;

  return progress;
}

/**
 * pulls and rebuilds the checkout Witch runs from when it sits clean on `base`, the branch a pull request merged
 * into. holds the checkout lock through the refresh, or skips it with a notice when busy. running instances keep
 * their code until they restart. returns a sentence saying what it did.
 */
export async function refreshInstall(
  root: string,
  base: string,
  run: Run = runCommand,
  {
    signal,
    progress = {},
  }: { signal?: AbortSignal; progress?: InstallProgress } = {},
): Promise<string> {
  signal?.throwIfAborted();

  const git = gitIn(root, signal);

  const failed = (error: unknown): never => {
    if (error === signal?.reason) throw error;

    // tsc reports its errors on stdout, which the message leaves out
    const { stdout } = error as { stdout?: unknown };

    const tail =
      typeof stdout === 'string'
        ? stdout.trim().split('\n').slice(-20).join('\n')
        : '';

    throw new Error(
      `Witch's checkout at ${root} wasn't rebuilt: ${errorMessage(error).trim()}${tail && `\n${tail}`}`,
      { cause: error },
    );
  };

  const lock = await lockCheckout(git).catch(failed);

  if (!lock)
    return `Witch's checkout at ${root} is busy, so it wasn't rebuilt.`;

  try {
    progress.root ??= await topLevel(git);

    progress.checkout ??= {};

    const status = await read(git);

    const head = await git('rev-parse', 'HEAD');

    const checkout = progress.checkout;

    if (
      status.branch !== base ||
      changed(status) ||
      (checkout.head && head !== checkout.head && head !== checkout.target)
    )
      return `Witch's checkout at ${root} isn't clean on ${base}, so it wasn't rebuilt.`;

    if (!checkout.done && !(await fastForward(git, base, checkout)))
      return `Witch's checkout at ${root} isn't clean on ${base}, so it wasn't rebuilt.`;

    if (!progress.installed) {
      await run('pnpm', ['install', '--frozen-lockfile'], {
        cwd: root,
        timeout: 300_000,
        ...(signal ? { signal } : {}),
      });

      progress.installed = true;
    }

    if (!progress.built) {
      await run('pnpm', ['build'], {
        cwd: root,
        timeout: 300_000,
        ...(signal ? { signal } : {}),
      });

      progress.built = true;
    }

    return `Rebuilt Witch at ${await git('rev-parse', '--short', 'HEAD')}, for its next start.`;
  } catch (error) {
    if (error === signal?.reason && progress.checkout?.target)
      await reconcilePull(
        gitIn(root, AbortSignal.timeout(1000)),
        progress.checkout,
      ).catch(() => (progress.unconfirmed = true));

    return failed(error);
  } finally {
    await lock.close();
  }
}
