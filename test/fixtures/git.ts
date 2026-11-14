import { execFile } from 'node:child_process';

import { promisify } from 'node:util';

import { runGit } from '../../src/memory/memory.js';

import type {
  GitOptions,
  GitResult,
  GitRunner,
} from '../../src/memory/memory.js';

const execute = promisify(execFile);

/** git with a test identity, `main` for a new repository's branch, and its trimmed output. */
export const git = async (cwd: string, ...args: string[]) =>
  (
    await execute(
      'git',
      [
        '-c',
        'init.defaultBranch=main',
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        ...args,
      ],
      { cwd },
    )
  ).stdout.trim();

export type GitHook = (
  command: readonly string[],
  run: () => Promise<GitResult>,
  options: GitOptions,
) => Promise<GitResult>;

/** a git runner a test can act through between two commands; `command` omits the `-c` overrides. */
export function hookedGit(hook: { current: GitHook }): GitRunner {
  return (args, options) => {
    let start = 0;

    while (args[start] === '-c') start += 2;

    return hook.current(
      args.slice(start),
      () => runGit(args, options),
      options,
    );
  };
}

export const passThrough: GitHook = (_, run) => run();
