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

/** a Git config value, or '' when it's unset, which Git reports with exit 1. any other failure throws. */
export const configValue = (git: Git, key: string) =>
  git('config', key).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === 1) return '';

    throw error;
  });

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
