import { errorMessage } from '../../errors.js';
import {
  changed,
  fastForward,
  gitIn,
  lockCheckout,
  read,
  reconcilePull,
  topLevel,
} from './checkout-git.js';
import type { CheckoutProgress } from './checkout-git.js';
import { runCommand } from './command.js';
import { sharedRebuild } from './shared-rebuild.js';
import type { RebuildResult } from './shared-rebuild.js';
import type { Run } from './repository.js';

export interface InstallProgress {
  result?: string;
  root?: string;
  checkout?: CheckoutProgress;
  installed?: boolean;
  built?: boolean;
  /** the post-abort reconcile of `checkout` failed. */
  unconfirmed?: boolean;
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
        await gitIn(root, AbortSignal.timeout(1000))('rev-parse', 'HEAD')
          .then((head) => reconcilePull(progress.checkout!, head))
          .catch(() => (progress.unconfirmed = true));

      throw error;
    } finally {
      await lock.close().catch((error: unknown) => {
        if (!failed) throw error;
      });
    }
  }
}
