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

/** a password prompt would draw over the TUI, and nothing could answer it. */
const git = async (cwd: string, ...args: string[]) =>
  (
    await execute('git', args, {
      cwd,
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
  ).stdout.trim();

/**
 * ssh's passphrase and host key prompts would too, so a fetch runs ssh in batch mode, unless the user set their own
 * ssh command, which this would replace.
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
  await fetchRemote(cwd, '--prune');
  // after the fetch, which can take a while: the watch's status is seconds old, and a commit made meanwhile would
  // go with the branch
  const status = await read(cwd);
  if (status.branch !== branch || changed(status)) return undefined;
  if ((await git(cwd, 'rev-parse', 'HEAD')) !== commit)
    return {
      text: `#${number} merged, but ${branch}'s last commit isn't the one it merged, so it stays.`,
      cleaned: false,
    };
  // GitHub deletes a merged pull request's branch, and a long-lived head branch such as develop keeps its own
  const [upstream, tracking] = (
    await git(
      cwd,
      'for-each-ref',
      '--format=%(upstream)%09%(upstream:track)',
      `refs/heads/${branch}`,
    )
  ).split('\t');
  if (!upstream)
    return {
      text: `#${number} merged, but ${branch} tracks no remote branch, so it stays.`,
      cleaned: false,
    };
  if (tracking !== '[gone]')
    return {
      text: `#${number} merged, but ${branch} is still on its remote, so it stays.`,
      cleaned: false,
    };
  // a plain switch overwrites an ignored file the base tracks, and that file was never committed
  await git(cwd, 'switch', '--no-overwrite-ignore', base);
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
  await succeeds(git(cwd, 'config', '--remove-section', `branch.${branch}`));
  const { removed: plans, stayed, reason } = await removePlans(cwd, branch);
  const removed = plans.length
    ? `, and ${plans.length > 1 ? 'plans' : 'plan'} ${list(plans)}`
    : '';
  const kept = stayed.length
    ? `${stayed.length > 1 ? 'plans' : 'plan'} ${list(stayed)} stayed: ${reason}`
    : '';
  // after the deletions, so a base that can't fast-forward still leaves the merged branch and its plans gone
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
    text: `#${number} merged: switched to ${base} and pulled, deleted ${branches}${removed}${kept && `, but ${kept}`}.`,
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

/**
 * removes the gitignored plans that create `branch` and no other branch, each with the ledgers whose `plan-path`
 * names it. returns those removed, and those that stayed with the first reason.
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
  for (const name of await readdir(plans).catch(() => [])) {
    const plan = join(plans, name);
    if (!name.endsWith('.md')) continue;
    // a plan that can't be read creates no branch, so it stays
    const created = createdBranches(
      await readFile(plan, 'utf8').catch(() => ''),
    );
    // a plan for several branches has work left until its last one merges, so only a plan for this branch alone goes
    if (
      created.size !== 1 ||
      !created.has(branch) ||
      !(await ignored(top, plan))
    )
      continue;
    try {
      // the ledgers first, since only the plan leads to them
      for (const ledger of await readdir(ledgers).catch(() => [])) {
        const folder = join(ledgers, ledger);
        const link = (
          await readFile(join(folder, 'plan-path'), 'utf8').catch(() => '')
        ).trim();
        if (link && resolve(top, link) === plan && (await ignored(top, folder)))
          await rm(folder, { recursive: true, force: true });
      }
      await rm(plan);
      removed.push(name);
    } catch (error) {
      stayed.push(name);
      reason ??= errorMessage(error);
    }
  }
  return { removed, stayed, reason };
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
  await fetchRemote(root);
  // after the fetch, so a switch or an edit made during it isn't pulled and built
  const status = await read(root);
  if (status.branch !== base || changed(status))
    return `Witch's checkout at ${root} isn't clean on ${base}, so it wasn't rebuilt.`;
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
 * kept the branch or failed isn't tried again; one that found the checkout changed, or another Witch's turn in its
 * directory, waits for the next status change.
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
