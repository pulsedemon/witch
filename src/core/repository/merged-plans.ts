import { readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { errorMessage } from '../../errors.js';
import { escapeRegExp } from '../../regexp.js';
import { unlessGone } from '../../persistence/json.js';
import { unlessExit1 } from './checkout-git.js';
import type { Git } from './checkout-git.js';

export interface PlanRemoval {
  root?: string;
  /** absolute paths, since two plan directories can hold the same name */
  removed: string[];
  stayed: string[];
  /** ignored plans that stay while mentioning the merged branch */
  mentioned: string[];
  ledgers: string[];
  /** the first reason a plan stayed */
  reason?: string;
  /** the first reason a plan directory couldn't be listed */
  unlisted?: string;
  done?: boolean;
}

/** `git check-ignore` exits 1 for a path no rule ignores, and for a tracked file. any other failure throws. */
const ignored = (git: Git, path: string) =>
  unlessExit1(
    git('check-ignore', '-q', path).then(() => true),
    false,
  );

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
 * the branches a plan declares as its own in prose, such as `**Branch:** \`feat/x\`` or ``Create branch `feat/x` ``, and
 * not the ones it only refers to. separators stay within the line, so a declaration never reaches the next one.
 */
function declaredBranches(text: string): string[] {
  return Array.from(
    text.matchAll(
      /^[ \t>*+-]*(?:\[[ xX]\][ \t]*)?(?:\d+[.)][ \t]*)?\**(?:step \d+:?[ \t]*)?\**(?:create (?:a |the )?(?:new )?)?branch\b[*: \t]*`([^`\s]+)`/gim,
    ),
    (match) => match[1]!,
  );
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
 * removes the gitignored plans that create or declare `branch` and no other branch, each with the gitignored ledgers
 * whose `plan-path` names it. returns those removed, the gitignored ones that stay while mentioning `branch`, those it
 * failed to read, check or remove with the first reason, and the first reason a plan directory couldn't be listed.
 */
export async function removePlans(
  git: Git,
  branch: string,
  progress: PlanRemoval,
  signal?: AbortSignal,
): Promise<PlanRemoval> {
  if (progress.done) return progress;

  const top = await git('rev-parse', '--show-toplevel');
  progress.root = top;
  const ledgers = join(top, planDirectories.ledgers);
  const { removed, stayed, mentioned } = progress;

  // the whole name, so that feat/x-2, feat/x@next, origin/feat/x and feat/x.md don't mention feat/x
  const mention = new RegExp(
    `(?<=^|[\\s\`'"(\\[<:*])${escapeRegExp(branch)}(?=$|[\\s\`'"),;:\\]>!?*]|\\.(?:$|[\\s\`'")\\]>*]))`,
    'm',
  );

  for (const directory of planDirectories.plans) {
    const plans = join(top, directory);
    let names: string[];

    try {
      names = (await unlessGone(readdir(plans))) ?? [];
    } catch (error) {
      progress.unlisted ??= errorMessage(error);

      continue;
    }

    for (const name of names.sort()) {
      const plan = join(plans, name);

      if (
        !name.endsWith('.md') ||
        removed.includes(plan) ||
        stayed.includes(plan) ||
        mentioned.includes(plan)
      )
        continue;

      try {
        // a plan that isn't there, such as a dangling link, names no branch
        const text = (await unlessGone(readFile(plan, 'utf8'))) ?? '';

        const branches = new Set([
          ...createdBranches(text),
          ...declaredBranches(text),
        ]);

        if (
          !(branches.has(branch) || mention.test(text)) ||
          !(await ignored(git, plan))
        )
          continue;

        // a plan for several branches has work left until its last one merges, so only a plan for this branch alone goes
        if (branches.size !== 1 || !branches.has(branch)) {
          mentioned.push(plan);

          continue;
        }

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
