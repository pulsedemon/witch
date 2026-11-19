import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { errorMessage } from '../../errors.js';
import type { Memory } from '../../memory/memory.js';
import { within } from '../../paths.js';
import { runs } from '../../persistence/process.js';
import type { StateStore } from '../../persistence/store.js';
import { branchInOperation, operationIn } from './branch-operations.js';
import {
  changed,
  commitAt,
  configValue,
  fastForward,
  fetchRemote,
  gitIn,
  hasBranchConfig,
  isFetchRefConflict,
  lockCheckout,
  read,
  reconcilePull,
  refHead,
  succeeds,
  topLevel,
} from './checkout-git.js';
import type { CheckoutProgress, Git } from './checkout-git.js';
import { refreshInstall } from './install-refresh.js';
import type { InstallProgress } from './install-refresh.js';
import { headRetention } from './head-retention.js';
import { removePlans } from './merged-plans.js';
import type { PlanRemoval } from './merged-plans.js';
import type { Conversation } from '../state.js';
import { gitHubRepository } from './repository.js';
import type { PullRequest, Repository } from './repository.js';

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
  /** why the last attempt deferred, for the watch's notice. */
  deferred?: string;
}

export type CleanupResult = boolean | 'changed' | 'interrupted' | 'retry';

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
  delete progress.deferred;

  try {
    const reported = progress.result;

    const outcome = await cleanUpMerge(
      cwd,
      pullRequest,
      async () => {
        const peer = await peerTurnIn(store, id, cwd, signal);

        if (peer) progress.deferred = peer;

        return !!peer;
      },
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
    if (error !== signal.reason) {
      if (isFetchRefConflict(error)) {
        progress.deferred = 'a shared remote ref changed during fetch';

        return 'retry';
      }

      const message = errorMessage(error).trim();

      // the cleanup's and the rebuild's own sentences already say what failed
      notice(
        /^(#\d+ merged|Witch's checkout at|Another Witch)/.test(message)
          ? message
          : `#${pullRequest.number} merged, but its cleanup failed: ${message}`,
      );

      throw error;
    }

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

/** why another conversation holds `cwd`'s checkout, or nothing: its turn runs there, or a record that could be one is unreadable. */
async function peerTurnIn(
  store: StateStore,
  id: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const { records, unreadable } = await store.records();
  const [broken] = unreadable;

  // named with its cause: one that broke after launch missed the launch's sweep
  if (broken)
    return `${broken.file} can't be read: ${broken.error.replace(/\s+/g, ' ')}`;

  const top = await topLevel(gitIn(cwd, signal));

  for (const record of records)
    if (
      record.id !== id &&
      within(record.cwd, top) &&
      record.activity &&
      record.process &&
      (await runs(record.process))
    )
      return 'another Witch conversation has a turn running in this checkout';

  return undefined;
}

/** GitHub deletes a merged branch seconds after the merge, which the watch can see first. */
const deleting = ({ mergedAt }: PullRequest) =>
  !!mergedAt && Date.now() - Date.parse(mergedAt) < 15_000;

const list = (items: string[]) =>
  items.length > 1
    ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
    : items[0]!;

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

  const lock = await lockCheckout(git).catch(
    failing(
      `#${pullRequest.number} merged, but its cleanup failed while locking ${pullRequest.branch}`,
      signal,
    ),
  );

  if (!lock) {
    progress.deferred = 'another Witch is updating this checkout';

    return undefined;
  }

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

/** cancellation identity keeps interrupted cleanup resumable. */
const failing =
  (did: string, signal?: AbortSignal) =>
  (error: unknown): never => {
    if (error === signal?.reason) throw error;

    throw new Error(`${did}: ${errorMessage(error).trim()}`, { cause: error });
  };

const stopping = ({ number, branch }: PullRequest, signal?: AbortSignal) =>
  failing(
    `#${number} merged, but its cleanup failed before deleting ${branch}`,
    signal,
  );

async function pullBase(
  git: Git,
  base: string,
  progress?: CheckoutProgress,
): Promise<void> {
  if (!(await fastForward(git, base, progress)))
    throw new Error(`the checkout left ${base} or changed during the fetch`);
}

interface HeadRemote {
  upstream?: string;
  tracking?: string;
  merges?: string;
  /** a same-repository, non-default head can be cleaned up while its remote tip is unchanged */
  eligible: boolean;
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
  policy: () => ReturnType<typeof headRetention>,
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

  const retention = onRemote()
    ? await policy().catch((error: unknown) => {
        if (error === signal?.reason) throw error;

        unread = errorMessage(error).trim();

        return undefined;
      })
    : undefined;

  const eligible =
    retention !== undefined && retention.defaultBranch !== branch;

  // GitHub can delete the branch, or someone push to it, while the lookup runs
  if (onRemote()) [upstream, tracking, merges] = await track();

  while (
    (!eligible || retention?.deletes) &&
    onRemote() &&
    deleting(pullRequest)
  ) {
    await delay(2000, undefined, { signal }).catch(() =>
      signal?.throwIfAborted(),
    );

    [upstream, tracking, merges] = await track();
  }

  return { upstream, tracking, merges, eligible, unread };
}

/** why a merged branch whose last commit is `tip` has to stay, or nothing when it can go. */
function staying(
  { number, branch, commit }: PullRequest,
  tip: string,
  { upstream, tracking, merges, eligible, unread }: HeadRemote,
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

  // only an unchanged remote tip permits deleting a local head whose remote branch remains
  if (eligible && tracking && tracking !== '[gone]')
    return stays(`${branch}'s remote branch has changed since`);

  if (!eligible && tracking !== '[gone]')
    return {
      text: `#${number} merged, but ${branch} is still on its remote, so it stays${unread && ` (couldn't read whether the repository keeps merged branches: ${unread})`}.`,
      cleaned: false,
    };

  return undefined;
}

/**
 * removes the merged branch's config section and its plans. returns the plans it removed, named, and what stayed with
 * the reason. `did` opens the error for a config it couldn't read or plans it couldn't locate.
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
    (await hasBranchConfig(git, branch).catch(
      failing(`${did}, but could not read its config`, signal),
    ));

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
  ).catch(
    failing(
      `${did}${unset && ` (${unset})`}, but could not locate its plans`,
      signal,
    ),
  );

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
  let retention: ReturnType<typeof headRetention> | undefined;
  const policy = () => (retention ??= headRetention(pullRequest, cwd, signal));

  if (await resumeCheck(git, pullRequest, progress)) return 'changed';

  if (progress.result) return progress.result;

  if (!progress.moved) {
    const result = await leaveBranch(
      git,
      pullRequest,
      blocked,
      progress,
      policy,
      signal,
    );

    if (result === 'blocked') return undefined;

    if (result) return result;
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
      failing(
        `#${number} merged: ${moved}, but ${branch} wasn't deleted`,
        signal,
      )(error);
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

    if (!progress.pull.done) await pullBase(git, base, progress.pull);
  } catch (error) {
    failing(
      `#${number} merged: ${moved} and deleted branch ${branch}${removed}${kept && ` (${kept})`}, but ${base} didn't fast-forward`,
      signal,
    )(error);
  }

  await pruneMerged(
    git,
    base,
    progress,
    policy,
    `#${number} merged: ${pulled}, deleted branch ${branch}${removed}${kept && ` (${kept})`}, but could not list other merged branches`,
    signal,
  );

  const deleted = progress.deleted!;
  const configured = progress.configured!;
  const failures = progress.failures!;
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

async function resumeCheck(
  git: Git,
  pullRequest: PullRequest,
  progress: MergeCleanup,
): Promise<'changed' | undefined> {
  const { branch, commit, base } = pullRequest;

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

      if (progress.pull) reconcilePull(progress.pull, head);
    } else if (progress.moved || status.branch !== branch || head !== commit)
      return 'changed';

    if (progress.deleted?.includes(branch) && (await refHead(git, branch)))
      return 'changed';
  }
}

async function leaveBranch(
  git: Git,
  pullRequest: PullRequest,
  blocked: () => Promise<boolean>,
  progress: MergeCleanup,
  policy: () => ReturnType<typeof headRetention>,
  signal?: AbortSignal,
): Promise<
  { text: string; cleaned: false } | 'changed' | 'blocked' | undefined
> {
  const { branch, commit, base } = pullRequest;
  const stopped = stopping(pullRequest, signal);

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

  const remote = await headRemote(git, pullRequest, policy, stopped, signal);

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
  if (await blocked()) return 'blocked';

  let created: string | undefined;

  if (progress.detached) {
    const upstream = (await refHead(git, base).catch(stopped))
      ? `${base}@{upstream}`
      : `refs/remotes/${progress.detached}`;

    const target = await commitAt(git, `${upstream}^{commit}`).catch(stopped);
    progress.switchHead = target;
    // already at the fetched upstream, so there's nothing to fast-forward
    progress.pull = { head: target, target, done: true };
  } else {
    const local = await refHead(git, base).catch(stopped);

    // a stacked pull request's base can exist only on the merged branch's remote, and the switch creates it from there
    if (!local)
      created = `refs/remotes/${await configValue(git, `branch.${branch}.remote`).catch(stopped)}/${base}`;

    progress.switchHead =
      local ?? (await commitAt(git, `${created}^{commit}`).catch(stopped));
  }

  // a plain switch overwrites an ignored file the base tracks, and that file was never committed
  const failed = await git(
    'switch',
    '--no-overwrite-ignore',
    ...(progress.detached ? ['--detach'] : created ? ['--track'] : []),
    '--end-of-options',
    progress.detached ? progress.switchHead : (created ?? base),
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
    ? failing(
        `#${number} merged and branch ${branch} was deleted, but the rest of its cleanup failed`,
        signal,
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
    const own = await git('rev-parse', '--absolute-git-dir').catch(stopped);

    // the checkout is still the branch's while it rebases or bisects it, so its cleanup waits for it to come back
    if (await operationIn(own, branch).catch(stopped)) return 'changed';

    const name = await configValue(git, `branch.${branch}.remote`).catch(
      stopped,
    );

    const remote = await headRemote(
      git,
      pullRequest,
      () => headRetention(pullRequest, cwd, signal),
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

      // again: one this checkout started during the fetch is its own to finish, not a worktree's hold
      if (await operationIn(own, branch).catch(stopped)) return 'changed';

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
      await pullBase(git, base);
    } catch (error) {
      failing(
        `#${number} merged: ${did()}${removed}${kept && ` (${kept})`}, but ${base} didn't fast-forward`,
        signal,
      )(error);
    }

  // the base's own ref, so a run interrupted inside the fast-forward still counts it after the checkout went elsewhere
  const advanced =
    progress.baseHead !== undefined &&
    (await refHead(git, base).catch(
      failing(
        `#${number} merged: ${did(onBase)}${removed}${kept && ` (${kept})`}, but ${base} couldn't be read`,
        signal,
      ),
    )) !== progress.baseHead;

  return (progress.result = {
    text: gone
      ? `#${number} merged: ${did(onBase)}${removed}${kept && `, but ${kept}`}.`
      : `#${number} merged: ${place(onBase)}, deleted branch ${branch}${removed}${kept && `, but ${kept}`}.`,
    cleaned: !gone || advanced,
  });
}

/** checkpoint mutations while the lock and cleaning phase still exclude queued work that could recreate a name. */
async function reconcileCleanup(
  git: Git,
  request: PullRequest,
  progress: MergeCleanup,
  signal: AbortSignal,
): Promise<void> {
  const status = await read(git);
  const head = await git('rev-parse', 'HEAD');

  if (arrived(progress, request.base, status, head)) progress.moved = true;

  if (!progress.moved) return;

  if (!progress.deleted && !(await refHead(git, request.branch)))
    progress.deleted = [request.branch];

  if (
    progress.deleted &&
    progress.unset === undefined &&
    !(await hasBranchConfig(git, request.branch))
  )
    progress.unset = '';

  if (progress.pull) reconcilePull(progress.pull, head);

  await reconcilePruning(git, progress, signal);
}

async function pruneMerged(
  git: Git,
  base: string,
  progress: MergeCleanup,
  policy: () => ReturnType<typeof headRetention>,
  unlisted: string,
  signal?: AbortSignal,
): Promise<void> {
  // with the config locked, branch -d deletes a branch and exits 0 with only a warning that its upstream stayed
  progress.configured ??= [];
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

  let refs = await readBranches().catch(failing(unlisted, signal));

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
      const retention = await policy();

      const name =
        retention && !retention.deletes ? retention.defaultBranch : undefined;

      if (name && refs.some((ref) => retained(ref) && ref.name !== name)) {
        const remote = progress.remote!;

        const checkRemote = async () => {
          if ((await git('remote', 'get-url', remote.name)) !== remote.url)
            throw new Error(`${remote.name}'s URL changed during cleanup`);
        };

        await checkRemote();

        await fetchRemote(git, remote.name).catch(
          failing(`couldn't refresh ${remote.name}`, signal),
        );

        await checkRemote();
        refs = await readBranches();
        keptDefault = name;
      }
    } catch (error) {
      if (error === signal?.reason || isFetchRefConflict(error)) throw error;

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

    await recordPruned(git, progress, name, retaining, signal);
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

  if (!current) return recordPruned(git, progress, name, retained, signal);

  progress.failures!.push(`branch ${name} stayed: its last commit changed`);
  progress.pruned!.push(name);
  delete progress.pruning;
}

async function recordPruned(
  git: Git,
  progress: MergeCleanup,
  name: string,
  retained: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (!progress.deleted!.includes(name)) progress.deleted!.push(name);

  if (retained) await removePrunedConfig(git, name, progress.failures!, signal);
  else if (
    await succeeds(git('config', '--get', `branch.${name}.merge`), signal)
  )
    progress.configured!.push(`branch.${name}`);

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
