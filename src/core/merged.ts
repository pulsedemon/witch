import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { errorMessage } from '../agents/stderr.js';
import { exclusiveLock } from '../persistence/lock.js';
import { runCommand } from './command.js';
import type { Coordinator } from './coordinator.js';
import { parseStatus } from './repository.js';
import type {
  PullRequest,
  Repository,
  RepositoryWatch,
  Run,
} from './repository.js';

/** a password prompt would draw over the TUI, and nothing could answer it. */
const git = async (cwd: string, ...args: string[]) =>
  (
    await runCommand('git', args, {
      cwd,
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
  ).stdout.trim();

/**
 * uses ssh batch mode to avoid passphrase and host key prompts unless the user configured an ssh command.
 */
const fetchRemote = async (cwd: string, ...args: string[]) => {
  const own =
    process.env.GIT_SSH ||
    (await git(cwd, 'config', 'core.sshCommand').catch(() => ''));
  await git(
    cwd,
    ...(own ? [] : ['-c', 'core.sshCommand=ssh -o BatchMode=yes']),
    'fetch',
    ...args,
  );
};

const succeeds = (promise: Promise<unknown>) =>
  promise.then(
    () => true,
    () => false,
  );

const read = async (cwd: string) =>
  parseStatus(
    await git(
      cwd,
      '--no-optional-locks',
      'status',
      '--porcelain=v2',
      '--branch',
    ),
  );

/** `git check-ignore` exits 1 for a path no rule ignores, and for a tracked file. any other failure throws. */
const ignored = (cwd: string, path: string) =>
  git(cwd, 'check-ignore', '-q', path).then(
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

const list = (items: string[]) =>
  items.length > 1
    ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
    : items[0]!;

/** skips a checkout another Witch is updating; locking the git directory leaves no file behind. */
async function lockCheckout(cwd: string): Promise<FileHandle | undefined> {
  return open(
    await git(cwd, 'rev-parse', '--absolute-git-dir'),
    constants.O_RDONLY | constants.O_NONBLOCK | exclusiveLock,
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
    return undefined;
  });
}

/**
 * what a merged pull request leaves in the checkout at `cwd`: switches to the base, deletes the branch and its
 * gitignored plans with their gitignored ledgers, brings the base up to date, and deletes the other merged branches
 * whose remote branch is gone. returns a sentence saying what it did, and whether it moved the checkout, or nothing
 * when the checkout left the branch or changed, or another Witch is updating it.
 */
export async function cleanUpMerge(
  cwd: string,
  pullRequest: PullRequest,
): Promise<{ text: string; cleaned: boolean } | undefined> {
  const lock = await lockCheckout(cwd).catch((error: unknown) => {
    throw new Error(
      `#${pullRequest.number} merged, but its cleanup failed while locking ${pullRequest.branch}: ${errorMessage(error).trim()}`,
      { cause: error },
    );
  });
  if (!lock) return undefined;
  try {
    return await clean(cwd, pullRequest);
  } finally {
    await lock.close();
  }
}

async function clean(
  cwd: string,
  pullRequest: PullRequest,
): Promise<{ text: string; cleaned: boolean } | undefined> {
  const { number, branch, commit, base } = pullRequest;
  const stopped = (error: unknown): never => {
    throw new Error(
      `#${number} merged, but its cleanup failed before deleting ${branch}: ${errorMessage(error).trim()}`,
      { cause: error },
    );
  };
  await fetchRemote(cwd, '--prune').catch(stopped);
  // after the fetch, which can take a while: the watch's status is seconds old, and a commit made meanwhile would
  // go with the branch
  const status = await read(cwd).catch(stopped);
  if (status.branch !== branch || changed(status)) return undefined;
  if ((await git(cwd, 'rev-parse', 'HEAD').catch(stopped)) !== commit)
    return {
      text: `#${number} merged, but ${branch}'s last commit isn't the one it merged, so it stays.`,
      cleaned: false,
    };
  // GitHub deletes a merged pull request's branch, and a long-lived head branch such as develop keeps its own
  const [upstream, tracking, merges] = (
    await git(
      cwd,
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
  // a plain switch overwrites an ignored file the base tracks, and that file was never committed
  await git(
    cwd,
    'switch',
    '--no-overwrite-ignore',
    '--end-of-options',
    base,
  ).catch(async (error: unknown) => {
    // a failing post-checkout hook fails the switch after it has moved the checkout
    if ((await read(cwd).catch(() => undefined))?.branch !== base)
      stopped(error);
  });
  // deleted only while still at the merged commit, since another terminal can commit to it after the tip check. -d
  // would compare against the base before it's brought up to date
  try {
    await git(cwd, 'update-ref', '-d', `refs/heads/${branch}`, commit);
  } catch (error) {
    throw new Error(
      `#${number} merged: switched to ${base}, but ${branch} wasn't deleted: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  // branch -D would drop it too, and a later branch of the same name would inherit its upstream
  const unset = await git(
    cwd,
    'config',
    '--remove-section',
    `branch.${branch}`,
  ).then(
    () => '',
    (error: unknown) =>
      `config section branch.${branch} stayed: ${errorMessage(error).trim()}`,
  );
  const {
    removed: plans,
    stayed,
    reason,
  } = await removePlans(cwd, branch).catch((error: unknown) => {
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
    // the first fetch reached only the merged branch's remote, and the base can track another
    await fetchRemote(cwd);
    // another terminal can switch or edit meanwhile, and the merge would pull whatever branch it left
    const fetched = await read(cwd);
    if (fetched.branch !== base || changed(fetched))
      throw new Error(`the checkout left ${base} or changed during the fetch`);
    await git(
      cwd,
      'merge',
      '--ff-only',
      '--no-overwrite-ignore',
      '@{upstream}',
    );
  } catch (error) {
    throw new Error(
      `#${number} merged: switched to ${base} and deleted branch ${branch}${removed}${kept && ` (${kept})`}, but ${base} didn't fast-forward: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const deleted = [branch];
  // with the config locked, branch -d deletes a branch and exits 0 with only a warning that its upstream stayed
  const configured: string[] = [];
  const failures: string[] = [];
  const refs = await git(
    cwd,
    'for-each-ref',
    '--merged',
    'HEAD',
    // :short would print heads/<name> for a branch a tag shares a name with
    '--format=%(refname:lstrip=2)%09%(upstream:track)%09%(worktreepath)',
    'refs/heads',
  ).catch((error: unknown) => {
    throw new Error(
      `#${number} merged: switched to ${base} and pulled, deleted branch ${branch}${removed}${kept && ` (${kept})`}, but could not list other merged branches: ${errorMessage(error)}`,
      { cause: error },
    );
  });
  for (const line of refs.split('\n')) {
    const [name, track, worktree] = line.split('\t');
    // a merged pull request's remote branch is gone and a long-lived branch's isn't
    if (!name || track !== '[gone]' || worktree) continue;
    try {
      await git(cwd, 'branch', '-d', '--end-of-options', name);
    } catch (error) {
      failures.push(`branch ${name} stayed: ${errorMessage(error).trim()}`);
      continue;
    }
    deleted.push(name);
    if (await succeeds(git(cwd, 'config', '--get', `branch.${name}.merge`)))
      configured.push(`branch.${name}`);
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
  return {
    text: `#${number} merged: switched to ${base} and pulled, deleted ${branches}${removed}${left && `, but ${left}`}.`,
    cleaned: true,
  };
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
  cwd: string,
  branch: string,
): Promise<{ removed: string[]; stayed: string[]; reason?: string }> {
  const top = await git(cwd, 'rev-parse', '--show-toplevel');
  const plans = join(top, 'docs/superpowers/plans');
  const ledgers = join(top, '.superpowers/sdd');
  const removed: string[] = [];
  const stayed: string[] = [];
  let reason: string | undefined;
  let names: string[];
  try {
    names = await readdir(plans).catch(absent([]));
  } catch (error) {
    return { removed, stayed, reason: errorMessage(error) };
  }
  for (const name of names) {
    const plan = join(plans, name);
    if (!name.endsWith('.md')) continue;
    try {
      // a plan that isn't there, such as a dangling link, creates no branch
      const created = createdBranches(
        await readFile(plan, 'utf8').catch(absent('')),
      );
      // a plan for several branches has work left until its last one merges, so only a plan for this branch alone goes
      if (
        created.size !== 1 ||
        !created.has(branch) ||
        !(await ignored(top, plan))
      )
        continue;
      // the ledgers first, since only the plan leads to them
      for (const ledger of await readdir(ledgers).catch(absent([]))) {
        const folder = join(ledgers, ledger);
        const link = (
          await readFile(join(folder, 'plan-path'), 'utf8').catch(absent(''))
        ).trim();
        if (link && resolve(top, link) === plan && (await ignored(top, folder)))
          await rm(folder, { recursive: true, force: true });
      }
      await rm(plan);
      removed.push(name);
    } catch (error) {
      stayed.push(name);
      reason ??= errorMessage(error).trim();
    }
  }
  return { removed, stayed, reason };
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
): Promise<string> {
  const failed = (error: unknown): never => {
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
  const lock = await lockCheckout(root).catch(failed);
  if (!lock)
    return `Witch's checkout at ${root} is busy, so it wasn't rebuilt.`;
  try {
    await fetchRemote(root);
    // after the fetch, so a switch or an edit made during it isn't pulled and built
    const status = await read(root);
    if (status.branch !== base || changed(status))
      return `Witch's checkout at ${root} isn't clean on ${base}, so it wasn't rebuilt.`;
    // a pull would overwrite an ignored file the incoming commits start tracking
    await git(
      root,
      'merge',
      '--ff-only',
      '--no-overwrite-ignore',
      '@{upstream}',
    );
    await run('pnpm', ['install', '--frozen-lockfile'], {
      cwd: root,
      timeout: 300_000,
    });
    await run('pnpm', ['build'], { cwd: root, timeout: 300_000 });
    return `Rebuilt Witch at ${await git(root, 'rev-parse', '--short', 'HEAD')}, for its next start.`;
  } catch (error) {
    return failed(error);
  } finally {
    await lock.close();
  }
}

/**
 * cleans up after the merged pull request whose branch the checkout sits on, once nothing staged, modified or
 * conflicted would block it and the conversation is idle with no error or queue on screen. a cleanup that acted,
 * kept the branch or failed isn't tried again; one that did nothing, as when the checkout changed or another Witch
 * was busy in it, waits for the next status change.
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
