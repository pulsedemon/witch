import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { errorMessage } from '../agents/stderr.js';
import type { Memory } from '../memory/memory.js';
import { tryOpenLocked } from '../persistence/lock.js';
import { runs } from '../persistence/process.js';
import type { StateStore } from '../persistence/store.js';
import { runCommand } from './command.js';
import type { Coordinator } from './coordinator.js';
import type { Conversation } from './state.js';
import { parseStatus, statusArgs } from './repository.js';
import type {
  PullRequest,
  Repository,
  RepositoryWatch,
  Run,
} from './repository.js';

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
  removed: string[];
  stayed: string[];
  ledgers: string[];
  reason?: string;
  done?: boolean;
}

export interface MergeCleanup {
  cwd?: string;
  switchHead?: string;
  moved?: boolean;
  unset?: string;
  plans?: PlanRemoval;
  pull?: CheckoutProgress;
  deleted?: string[];
  configured?: string[];
  failures?: string[];
  pruned?: string[];
  pruning?: { name: string; head: string };
  result?: { text: string; cleaned: boolean };
  install?: InstallProgress;
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
    return 'interrupted';
  }
}

interface InstallProgress {
  root?: string;
  checkout?: CheckoutProgress;
  installed?: boolean;
  built?: boolean;
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
      (record.cwd === top || record.cwd.startsWith(`${top}/`)) &&
      record.activity &&
      record.process &&
      (await runs(record.process))
    )
      return true;
  return false;
}

/**
 * uses ssh batch mode to avoid passphrase and host key prompts unless the user configured an ssh command.
 */
const fetchRemote = async (git: Git, ...args: string[]) => {
  const own =
    process.env.GIT_SSH ||
    (await git('config', 'core.sshCommand').catch(() => ''));
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
 * what a switch would carry along or stop at. untracked files don't count, since `git switch` refuses to overwrite
 * one.
 */
const changed = ({ staged, modified, conflicts }: Repository) =>
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

/**
 * what a merged pull request leaves in the checkout at `cwd`: switches to the base, deletes the branch and its
 * gitignored plans with their gitignored ledgers, brings the base up to date, and deletes the other merged branches
 * whose remote branch is gone. returns a sentence saying what it did, and whether it moved the checkout, `'changed'`
 * when the checkout left the branch or changed, or nothing when another Witch is updating it or `blocked` says one is
 * working in it.
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
    return await clean(git, pullRequest, blocked, progress, signal);
  } catch (error) {
    if (error === signal?.reason && progress.switchHead) {
      const reconcile = AbortSignal.timeout(1000);
      await reconcileCleanup(
        gitIn(cwd, reconcile),
        pullRequest,
        progress,
        reconcile,
      );
    }
    throw error;
  } finally {
    await lock.close();
  }
}

async function clean(
  git: Git,
  pullRequest: PullRequest,
  blocked: () => Promise<boolean>,
  progress: MergeCleanup,
  signal?: AbortSignal,
): Promise<{ text: string; cleaned: boolean } | 'changed' | undefined> {
  const { number, branch, commit, base } = pullRequest;
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
    if (status.branch === base) {
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
    await fetchRemote(git, '--prune').catch(stopped);
    // after the fetch, which can take a while: the watch's status is seconds old, and a commit made meanwhile would
    // go with the branch
    const status = await read(git).catch(stopped);
    if (status.branch !== branch || changed(status)) return 'changed';
    if ((await git('rev-parse', 'HEAD').catch(stopped)) !== commit)
      return {
        text: `#${number} merged, but ${branch}'s last commit isn't the one it merged, so it stays.`,
        cleaned: false,
      };
    // GitHub deletes a merged pull request's branch, and a long-lived head branch such as develop keeps its own
    const [upstream, tracking, merges] = (
      await git(
        'for-each-ref',
        '--format=%(upstream:short)%09%(upstream:track)%09%(upstream:remoteref)',
        `refs/heads/${branch}`,
      ).catch(stopped)
    ).split('\t');
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
    if (tracking !== '[gone]')
      return {
        text: `#${number} merged, but ${branch} is still on its remote, so it stays.`,
        cleaned: false,
      };
    // again: a turn that started during the fetch changes nothing the status shows
    if (await blocked()) return undefined;
    progress.switchHead = await git('rev-parse', `refs/heads/${base}`);
    // a plain switch overwrites an ignored file the base tracks, and that file was never committed
    await git(
      'switch',
      '--no-overwrite-ignore',
      '--end-of-options',
      base,
    ).catch(async (error: unknown) => {
      if (error === signal?.reason) throw error;
      // a failing post-checkout hook fails the switch after it has moved the checkout
      if ((await read(git).catch(() => undefined))?.branch !== base)
        stopped(error);
    });
    progress.moved = true;
  }
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
        `#${number} merged: switched to ${base}, but ${branch} wasn't deleted: ${errorMessage(error)}`,
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
  } = await removePlans(
    git,
    branch,
    (progress.plans ??= { removed: [], stayed: [], ledgers: [] }),
    signal,
  ).catch((error: unknown) => {
    if (error === signal?.reason) throw error;
    throw new Error(
      `#${number} merged: switched to ${base} and deleted branch ${branch}${unset && ` (${unset})`}, but could not locate its plans: ${errorMessage(error)}`,
      { cause: error },
    );
  });
  // none is named when the plans couldn't be listed
  const named = (names: string[]) =>
    names.length
      ? `${names.length > 1 ? 'plans' : 'plan'} ${list(names)}`
      : 'plans';
  const removed = plans.length ? `, and ${named(plans)}` : '';
  const kept = [unset, reason && `${named(stayed)} stayed: ${reason}`]
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
      `#${number} merged: switched to ${base} and deleted branch ${branch}${removed}${kept && ` (${kept})`}, but ${base} didn't fast-forward: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const deleted = progress.deleted;
  // with the config locked, branch -d deletes a branch and exits 0 with only a warning that its upstream stayed
  const configured = (progress.configured ??= []);
  const failures = (progress.failures ??= []);
  const pruned = (progress.pruned ??= []);
  await reconcilePruning(git, progress, signal);
  const refs = await git(
    'for-each-ref',
    '--merged',
    'HEAD',
    // :short would print heads/<name> for a branch a tag shares a name with
    '--format=%(refname:lstrip=2)%09%(upstream:track)%09%(worktreepath)%09%(objectname)',
    'refs/heads',
  ).catch((error: unknown) => {
    if (error === signal?.reason) throw error;
    throw new Error(
      `#${number} merged: switched to ${base} and pulled, deleted branch ${branch}${removed}${kept && ` (${kept})`}, but could not list other merged branches: ${errorMessage(error)}`,
      { cause: error },
    );
  });
  for (const line of refs.split('\n')) {
    const [name, track, worktree, head] = line.split('\t');
    // a merged pull request's remote branch is gone and a long-lived branch's isn't
    if (
      !name ||
      !head ||
      track !== '[gone]' ||
      worktree ||
      pruned.includes(name)
    )
      continue;
    progress.pruning = { name, head };
    try {
      await git('branch', '-d', '--end-of-options', name);
    } catch (error) {
      if (error === signal?.reason) throw error;
      failures.push(`branch ${name} stayed: ${errorMessage(error).trim()}`);
      pruned.push(name);
      delete progress.pruning;
      continue;
    }
    deleted.push(name);
    if (await succeeds(git('config', '--get', `branch.${name}.merge`), signal))
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
    text: `#${number} merged: switched to ${base} and pulled, deleted ${branches}${removed}${left && `, but ${left}`}.`,
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
  const status = await read(git);
  if (status.branch === request.base) progress.moved = true;
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
  const { name, head } = progress.pruning;
  const current = await refHead(git, name);
  if (current === head) return;
  if (!current) {
    if (!progress.deleted!.includes(name)) progress.deleted!.push(name);
    if (await succeeds(git('config', '--get', `branch.${name}.merge`), signal))
      progress.configured!.push(`branch.${name}`);
  } else
    progress.failures!.push(`branch ${name} stayed: its last commit changed`);
  progress.pruned!.push(name);
  delete progress.pruning;
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

/** `fallback` for a path that isn't there, ENOTDIR included for one under a stray file such as Finder's .DS_Store. */
const absent =
  <T>(fallback: T) =>
  (error: unknown): T => {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    return fallback;
  };

/**
 * removes the gitignored plans that create `branch` and no other branch, each with the gitignored ledgers whose
 * `plan-path` names it. returns those removed, and those it failed to read, check or remove with the first reason,
 * or only a reason when it couldn't list the plans.
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
  const plans = join(top, 'docs/superpowers/plans');
  const ledgers = join(top, '.superpowers/sdd');
  const { removed, stayed } = progress;
  let names: string[];
  try {
    names = await readdir(plans).catch(absent([]));
  } catch (error) {
    progress.reason = errorMessage(error);
    progress.done = true;
    return progress;
  }
  for (const name of names) {
    const plan = join(plans, name);
    if (
      !name.endsWith('.md') ||
      removed.includes(name) ||
      stayed.includes(name)
    )
      continue;
    try {
      // a plan that isn't there, such as a dangling link, creates no branch
      const created = createdBranches(
        await readFile(plan, 'utf8').catch(absent('')),
      );
      // a plan for several branches has work left until its last one merges, so only a plan for this branch alone goes
      if (
        created.size !== 1 ||
        !created.has(branch) ||
        !(await ignored(git, plan))
      )
        continue;
      // the ledgers first, since only the plan leads to them
      for (const ledger of await readdir(ledgers).catch(absent([]))) {
        const folder = join(ledgers, ledger);
        if (progress.ledgers.includes(folder)) continue;
        const link = (
          await readFile(join(folder, 'plan-path'), 'utf8').catch(absent(''))
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
      removed.push(name);
    } catch (error) {
      if (error === signal?.reason) throw error;
      stayed.push(name);
      progress.reason ??= errorMessage(error).trim();
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
      );
    return failed(error);
  } finally {
    await lock.close();
  }
}

/**
 * cleans up a merged branch while its checkout is clean and the conversation is idle without errors or queued prompts.
 * a cleanup that found the checkout changed waits for a repository change, other deferred cleanups retry after five
 * seconds or a repository change. interrupted work survives checkout changes; completed work and ordinary failures
 * aren't retried.
 */
export function watchMerges(
  repository: Pick<RepositoryWatch, 'snapshot' | 'subscribe'>,
  coordinator: Pick<Coordinator, 'snapshot' | 'subscribe' | 'cleanUpMerge'>,
  install?: string,
): () => void {
  const settled = new Set<string>();
  let attempted: string | undefined;
  let pending: NodeJS.Immediate | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let continuation:
    | { request: PullRequest; progress: MergeCleanup; owner?: string }
    | undefined;
  const check = () => {
    pending = undefined;
    const status = repository.snapshot;
    const owner = coordinator.snapshot.conversation?.id;
    if (continuation && continuation.owner !== owner) continuation = undefined;
    const pullRequest = continuation?.request ?? status?.pullRequest;
    const { phase, error, queue } = coordinator.snapshot;
    if (
      pullRequest?.state !== 'MERGED' ||
      (!continuation && status!.branch !== pullRequest.branch) ||
      (status && changed(status)) ||
      phase !== 'idle' ||
      error ||
      queue.length ||
      settled.has(pullRequest.commit) ||
      attempted === pullRequest.commit
    )
      return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    attempted = pullRequest.commit;
    const work = continuation ?? { request: pullRequest, progress: {}, owner };
    void coordinator.cleanUpMerge(pullRequest, install, work.progress).then(
      (acted) => {
        if (acted === 'interrupted') {
          continuation = work;
          attempted = undefined;
          schedule();
          return;
        }
        // the status line's next change retries it; a timer would fetch every 5 s while the two reads disagree
        if (acted === 'changed') return;
        if (acted) {
          continuation = undefined;
          settled.add(pullRequest.commit);
        } else if (!stopped) {
          retryTimer = setTimeout(retry, 5000);
          retryTimer.unref();
        }
      },
      // a failed cleanup shows its error; operate can't refuse, since the phase was checked this tick
      () => {
        continuation = undefined;
        settled.add(pullRequest.commit);
      },
    );
  };
  // after the publish that called it: a turn's end settles its queue and error after publishing idle
  const schedule = () => {
    if (!stopped) pending ??= setImmediate(check);
  };
  const retry = () => {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    attempted = undefined;
    schedule();
  };
  const stops = [repository.subscribe(retry), coordinator.subscribe(schedule)];
  schedule();
  return () => {
    stopped = true;
    clearImmediate(pending);
    clearTimeout(retryTimer);
    stops.forEach((stop) => stop());
  };
}
