import { runGit } from '../../src/memory/memory.js';
import type {
  GitOptions,
  GitResult,
  GitRunner,
} from '../../src/memory/memory.js';

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
