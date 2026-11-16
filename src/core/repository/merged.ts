import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { errorMessage } from '../../errors.js';
import type { Memory } from '../../memory/memory.js';
import { within } from '../../paths.js';
import { tryOpenLocked } from '../../persistence/lock.js';
import { runs } from '../../persistence/process.js';
import type { StateStore } from '../../persistence/store.js';
import { branchInOperation, operationIn } from './branch-operations.js';
import { runCommand } from './command.js';
import { retainedDefaultBranch } from './head-retention.js';
import { escapeRegExp, removePlans } from './merged-plans.js';
import type { PlanRemoval } from './merged-plans.js';
import { sharedRebuild } from './shared-rebuild.js';
import type { RebuildResult } from './shared-rebuild.js';
import type { Conversation } from '../state.js';
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

export type Git = ReturnType<typeof gitIn>;

interface CheckoutProgress {
  head?: string;
  target?: string;
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
  /** where a cleanup off the merged branch found the checkout, for the steps an unconfirmed one names. */
  left?: 'base' | 'elsewhere';
  /** the base's commit before a cleanup off the merged branch first fast-forwarded it. */
  baseHead?: string;
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
          notice,
        }),
      );

      if (resuming && !progress.install.result) acted = false;
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

  // a finished cleanup did all of its own steps, and one off the merged branch never moves or prunes
  if (!progress.result) {
    if (!progress.left && !progress.moved)
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

    if (progress.left ? progress.left === 'base' : !progress.pull?.done)
      steps.push(`fast-forwarding ${base}`);

    if (!progress.left) steps.push('pruning merged branches');
  }

  // without install progress, cleanup stopped before checking whether the rebuild applies
  if (progress.install) {
    if (!progress.install.built)
      steps.push("updating and rebuilding Witch's checkout");
  } else if (install)
    steps.push("whether Witch's checkout needs updating and rebuilding");

  return steps;
}

interface InstallProgress {
  result?: string;
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

/**
 * what a switch would carry along or stop at. untracked files don't count, since `git switch` refuses to overwrite one.
 */
export const changed = ({ staged, modified, conflicts }: Repository) =>
  !!(staged || modified || conflicts);

/**
 * checks after fetching because another terminal can switch or edit the checkout meanwhile. the second status read is the
 * last read before the merge, which lands on whatever is checked out by then.
 */
async function fastForward(
  git: Git,
  base: string,
  progress: CheckoutProgress = {},
): Promise<boolean> {
  await fetchRemote(git);

  const left = (status: Repository) =>
    status.branch !== base || changed(status);

  if (left(await read(git))) return false;

  // without --verify, rev-parse echoes a base named like an option back instead of resolving it
  const target = await git(
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${base}@{upstream}`,
  );

  const status = await read(git);
  const head = status.commit;

  if (left(status) || !head) return false;

  if (progress.head && head !== progress.head && head !== progress.target)
    return false;

  progress.head = head;
  progress.target = target;
  await git('merge', '--ff-only', '--no-overwrite-ignore', target);
  progress.head = target;
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
 * base and default branch. a checkout that left the branch stays where it is: it loses the branch with its config and
 * plans, and on the base it is fast-forwarded. returns a sentence saying what it did, and whether it deleted the merged
 * branch or moved the checkout or the base, `'changed'` when the checkout changed, moved during the cleanup or went back
 * onto the branch, or nothing when another Witch is updating it or `blocked` says one is working in it.
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
    const onBranch =
      !!progress.switchHead ||
      (!progress.deleted &&
        (await read(git).catch(stopping(pullRequest, signal))).branch ===
          pullRequest.branch);

    if (!onBranch)
      return await cleanLeft(git, cwd, pullRequest, blocked, progress, signal);

    delete progress.left;

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

/** wraps a failure in the cleanup's sentence, which says by default that the branch wasn't deleted yet. an abort passes through. */
const stopping =
  (
    { number, branch }: PullRequest,
    signal?: AbortSignal,
    did = `#${number} merged, but its cleanup failed before deleting ${branch}`,
  ) =>
  (error: unknown): never => {
    if (error === signal?.reason) throw error;

    throw new Error(`${did}: ${errorMessage(error).trim()}`, { cause: error });
  };

interface HeadRemote {
  upstream?: string;
  tracking?: string;
  merges?: string;
  /** the repository retains merged heads, and this one is still on its remote */
  keeps: boolean;
  /** why the retention policy couldn't be read */
  unread: string;
}

/**
 * the merged branch's remote copy once GitHub had its chance to delete it. an unqualified fetch reads the checked-out
 * branch's remote, so a checkout off the merged branch names `remote`.
 */
async function headRemote(
  git: Git,
  pullRequest: PullRequest,
  defaultBranch: () => Promise<string | undefined>,
  stopped: (error: unknown) => never,
  signal?: AbortSignal,
  remote?: string,
): Promise<HeadRemote> {
  const { branch } = pullRequest;

  const track = async () => {
    await fetchRemote(git, '--prune', ...(remote ? [remote] : [])).catch(
      stopped,
    );

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

  return { upstream, tracking, merges, keeps, unread };
}

/** why a merged branch whose last commit is `tip` has to stay, or nothing when it can go. */
function staying(
  { number, branch, commit }: PullRequest,
  tip: string,
  { upstream, tracking, merges, keeps, unread }: HeadRemote,
): { text: string; cleaned: false } | undefined {
  const stays = (why: string) => ({
    text: `#${number} merged, but ${why}, so it stays.`,
    cleaned: false as const,
  });

  if (tip !== commit)
    return stays(`${branch}'s last commit isn't the one it merged`);

  if (!upstream) return stays(`${branch} tracks no remote branch`);

  // `git switch -c feat/x origin/main` makes a branch that tracks main
  if (merges !== `refs/heads/${branch}`)
    return stays(
      `${branch} tracks ${upstream} rather than its own remote branch`,
    );

  // a kept branch has to be at the merged commit or gone. any other has to be gone, since GitHub deletes a merged head
  // branch but leaves a long-lived one such as develop
  if (keeps && tracking && tracking !== '[gone]')
    return stays(`${branch}'s remote branch has changed since`);

  if (!keeps && tracking !== '[gone]')
    return {
      text: `#${number} merged, but ${branch} is still on its remote, so it stays${unread && ` (couldn't read whether the repository keeps merged branches: ${unread})`}.`,
      cleaned: false,
    };

  return undefined;
}

/**
 * removes the merged branch's config section and its plans. returns the plans it removed, named, and what stayed with
 * the reason. `did` opens the error for plans it couldn't locate.
 */
async function removeLeftovers(
  git: Git,
  branch: string,
  progress: MergeCleanup,
  did: string,
  signal?: AbortSignal,
): Promise<{ plans: string; kept: string }> {
  // branch -D would drop it too, and a later branch of the same name would inherit its upstream
  const hasConfig =
    progress.unset === undefined &&
    (await hasBranchConfig(git, branch).catch((error: unknown) => {
      if (error === signal?.reason) throw error;

      throw new Error(
        `${did}, but could not read its config: ${errorMessage(error)}`,
        { cause: error },
      );
    }));

  const unset = (progress.unset ??= hasConfig
    ? await git('config', '--remove-section', `branch.${branch}`).then(
        () => '',
        (error: unknown) => {
          if (error === signal?.reason) throw error;

          return `config section branch.${branch} stayed: ${errorMessage(error).trim()}`;
        },
      )
    : '');

  const { removed, stayed, mentioned, reason, unlisted } = await removePlans(
    git,
    branch,
    (progress.plans ??= {
      removed: [],
      stayed: [],
      mentioned: [],
      ledgers: [],
    }),
    signal,
  ).catch((error: unknown) => {
    if (error === signal?.reason) throw error;

    throw new Error(
      `${did}${unset && ` (${unset})`}, but could not locate its plans: ${errorMessage(error)}`,
      { cause: error },
    );
  });

  const named = (paths: string[]) =>
    `${paths.length > 1 ? 'plans' : 'plan'} ${list(paths.map((path) => basename(path)))}`;

  return {
    plans: removed.length ? named(removed) : '',
    kept: [
      unset,
      reason && `${named(stayed)} stayed: ${reason}`,
      mentioned.length &&
        `${named(mentioned)} stayed: not recognized as for ${branch} alone`,
      unlisted && `plans stayed: ${unlisted}`,
    ]
      .filter(Boolean)
      .join(' and '),
  };
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

  const stopped = stopping(pullRequest, signal);

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
          ? await git(
              'rev-parse',
              '--abbrev-ref',
              '--verify',
              '--end-of-options',
              `${base}@{upstream}`,
            ).catch(stopped)
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

    const remote = await headRemote(
      git,
      pullRequest,
      defaultBranch,
      stopped,
      signal,
    );

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

    const stays = staying(
      pullRequest,
      await git('rev-parse', 'HEAD').catch(stopped),
      remote,
    );

    if (stays) return stays;

    // again: a turn that started during the fetch changes nothing the status shows
    if (await blocked()) return undefined;

    if (progress.detached) {
      const upstream = (await refHead(git, base).catch(stopped))
        ? `${base}@{upstream}`
        : `refs/remotes/${progress.detached}`;

      const target = await git(
        'rev-parse',
        '--verify',
        '--end-of-options',
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

  const { plans, kept } = await removeLeftovers(
    git,
    branch,
    progress,
    `#${number} merged: ${moved} and deleted branch ${branch}`,
    signal,
  );

  const removed = plans && `, and ${plans}`;

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

/**
 * the cleanup for a checkout that left the merged branch. it deletes the branch with its config and plans, fast-forwards
 * a checkout on the base and never moves the checkout. every run starts from the top: `progress.deleted` alone records
 * what became of the branch, so one recreated afterwards stays.
 */
async function cleanLeft(
  git: Git,
  cwd: string,
  pullRequest: PullRequest,
  blocked: () => Promise<boolean>,
  progress: MergeCleanup,
  signal?: AbortSignal,
): ReturnType<typeof clean> {
  const { number, branch, commit, base } = pullRequest;

  // a run that resumes after its deletion can't say the branch is still there
  const stopped = progress.deleted?.includes(branch)
    ? stopping(
        pullRequest,
        signal,
        `#${number} merged and branch ${branch} was deleted, but the rest of its cleanup failed`,
      )
    : stopping(pullRequest, signal);

  const look = async () => {
    const status = await read(git).catch(stopped);
    progress.left = status.branch === base ? 'base' : 'elsewhere';

    return status;
  };

  let status = await look();

  if (changed(status)) return 'changed';

  // a finished cleanup is here again for its install refresh. one interrupted in this very checkout waits for it to be
  // back on the base, where a refresh elsewhere resumes at once
  if (progress.result)
    return progress.install?.root !== undefined &&
      progress.install.root === progress.plans?.root &&
      status.branch !== base
      ? 'changed'
      : progress.result;

  const place = (pulled = false) =>
    status.branch === base
      ? `stayed on ${base}${pulled ? ' and pulled' : ''}`
      : status.branch === 'HEAD'
        ? 'left the detached checkout where it was'
        : `left ${status.branch} checked out`;

  const held = {
    text: `#${number} merged, but ${branch} is checked out, rebased or bisected in a worktree, so it stays.`,
    cleaned: false,
  };

  if (!(await refHead(git, branch).catch(stopped))) progress.deleted ??= [];
  // 'changed' would rerun this on every repository publish and keep the pull request on the status line
  else if (progress.deleted)
    return {
      text: `#${number} merged, but ${branch} was recreated, so it stays.`,
      cleaned: false,
    };

  if (!progress.deleted) {
    // the checkout is still the branch's while it rebases or bisects it, so its cleanup waits for it to come back
    if (
      await operationIn(
        await git('rev-parse', '--absolute-git-dir').catch(stopped),
        branch,
      ).catch(stopped)
    )
      return 'changed';

    let policy: Promise<string | undefined> | undefined;

    const name = await configValue(git, `branch.${branch}.remote`).catch(
      stopped,
    );

    const remote = await headRemote(
      git,
      pullRequest,
      () => (policy ??= retainedDefaultBranch(pullRequest, cwd, signal)),
      stopped,
      signal,
      name && name !== '.' ? name : undefined,
    );

    // again: a turn that started during the fetch changes nothing the status shows
    if (await blocked()) return undefined;

    const common = await git(
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ).catch(stopped);

    const top = await topLevel(git).catch(stopped);
    const tip = await refHead(git, branch).catch(stopped);

    if (tip) {
      const stays = staying(pullRequest, tip, remote);

      if (stays) return stays;

      status = await look();

      if (changed(status) || status.branch === branch) return 'changed';

      if (await branchInOperation(common, branch).catch(stopped)) return held;

      // last of the reads that spawn, so the window before the deletion is one spawn wide
      const line = await git(
        'for-each-ref',
        '--format=%(refname)%09%(worktreepath)',
        `refs/heads/${branch}`,
      ).catch(stopped);

      const holder = line.includes('\t')
        ? line.slice(line.indexOf('\t') + 1)
        : '';

      // the checkout went back onto the branch
      if (holder === top) return 'changed';

      if (holder) return held;

      if (line) {
        // a worktree's rebase or bisect detaches it, which empties its path above
        if (await branchInOperation(common, branch).catch(stopped)) return held;

        try {
          await git('update-ref', '-d', `refs/heads/${branch}`, commit);
        } catch (error) {
          if (error !== signal?.reason)
            throw new Error(
              `#${number} merged: ${place()}, but ${branch} wasn't deleted: ${errorMessage(error)}`,
              { cause: error },
            );

          const check = AbortSignal.timeout(1000);

          // a failed check must not replace the interruption
          await refHead(gitIn(cwd, check), branch).then(
            (head) => {
              if (!head) progress.deleted = [branch];
            },
            () => (progress.unconfirmed = true),
          );

          throw error;
        }

        progress.deleted = [branch];
      }
    }
  }

  // an absence is recorded before anything else changes, so a branch of this name that appears later stays
  const gone = !(progress.deleted ??= []).includes(branch);

  const did = (pulled = false) =>
    gone
      ? `${place(pulled)}. ${branch} was already gone`
      : `${place()} and deleted branch ${branch}`;

  const { plans, kept } = await removeLeftovers(
    git,
    branch,
    progress,
    `#${number} merged: ${did()}`,
    signal,
  );

  const removed = plans && (gone ? `; removed ${plans}` : `, and ${plans}`);
  const onBase = status.branch === base;

  if (onBase)
    try {
      progress.baseHead ??= await git('rev-parse', `refs/heads/${base}`);

      // new progress on each run: the base may have moved since an interrupted one, and --ff-only refuses anything else
      if (!(await fastForward(git, base)))
        throw new Error(
          `the checkout left ${base} or changed during the fetch`,
        );
    } catch (error) {
      if (error === signal?.reason) throw error;

      throw new Error(
        `#${number} merged: ${did()}${removed}${kept && ` (${kept})`}, but ${base} didn't fast-forward: ${errorMessage(error)}`,
        { cause: error },
      );
    }

  // the base's own ref, so a run interrupted inside the fast-forward still counts it after the checkout went elsewhere
  const advanced =
    progress.baseHead !== undefined &&
    (await refHead(git, base).catch(
      stopping(
        pullRequest,
        signal,
        `#${number} merged: ${did(onBase)}${removed}${kept && ` (${kept})`}, but ${base} couldn't be read`,
      ),
    )) !== progress.baseHead;

  return (progress.result = {
    text: gone
      ? `#${number} merged: ${did(onBase)}${removed}${kept && `, but ${kept}`}.`
      : `#${number} merged: ${place(onBase)}, deleted branch ${branch}${removed}${kept && `, but ${kept}`}.`,
    cleaned: !gone || advanced,
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
  const section = `^branch\\.${escapeRegExp(branch)}\\.`;

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

/**
 * pulls and rebuilds the checkout Witch runs from when it sits clean on `base`, the branch a pull request merged
 * into. joins another rebuild already running there; unrelated checkout work skips the refresh. running instances
 * keep their code until they restart.
 */
export async function refreshInstall(
  root: string,
  base: string,
  run: Run = runCommand,
  {
    signal,
    progress = {},
    notice,
  }: {
    signal?: AbortSignal;
    progress?: InstallProgress;
    notice?(text: string): void;
  } = {},
): Promise<string> {
  signal?.throwIfAborted();

  if (progress.result) return progress.result;

  const git = gitIn(root, signal);

  const failure = (error: unknown): Error => {
    if (error === signal?.reason) throw error;

    // tsc reports its errors on stdout, which the message leaves out
    const { stdout } = error as { stdout?: unknown };

    const tail =
      typeof stdout === 'string'
        ? stdout.trim().split('\n').slice(-20).join('\n')
        : '';

    return new Error(
      `Witch's checkout at ${root} wasn't rebuilt: ${errorMessage(error).trim()}${tail && `\n${tail}`}`,
      { cause: error },
    );
  };

  const directory = await git('rev-parse', '--absolute-git-dir').catch(
    (error: unknown) => {
      throw failure(error);
    },
  );

  const outcome = await sharedRebuild(directory, rebuild, {
    signal,
    failure,
    waiting: () =>
      notice?.(
        `Another Witch is rebuilding Witch at ${root}; waiting for its result.`,
      ),
  });

  if (outcome.built) {
    progress.installed = true;
    progress.built = true;
    progress.result = outcome.text;
  }

  return outcome.text;

  async function rebuild(): Promise<RebuildResult> {
    const lock = await lockCheckout(git);

    if (!lock)
      return {
        text: `Witch's checkout at ${root} is busy, so it wasn't rebuilt.`,
        built: false,
      };

    let failed = false;

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
        return {
          text: `Witch's checkout at ${root} isn't clean on ${base}, so it wasn't rebuilt.`,
          built: false,
        };

      if (!checkout.done && !(await fastForward(git, base, checkout)))
        return {
          text: `Witch's checkout at ${root} isn't clean on ${base}, so it wasn't rebuilt.`,
          built: false,
        };

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

      return {
        text: `Rebuilt Witch at ${await git('rev-parse', '--short', 'HEAD')}, for its next start.`,
        built: true,
      };
    } catch (error) {
      failed = true;

      if (error === signal?.reason && progress.checkout?.target)
        await reconcilePull(
          gitIn(root, AbortSignal.timeout(1000)),
          progress.checkout,
        ).catch(() => (progress.unconfirmed = true));

      throw error;
    } finally {
      await lock.close().catch((error: unknown) => {
        if (!failed) throw error;
      });
    }
  }
}
