import { errorMessage } from '../errors.js';
import type { MemoryConflict, Workspace } from '../memory/workspace.js';
import type { Recovery } from './snapshot.js';

/** publish clean memory and retain unfinished writes or conflicting accepted history for recovery. */
export async function settleMemory(
  workspace: Workspace,
): Promise<{ recovery?: Recovery; failure?: string }> {
  let dirty = false;

  let conflict: MemoryConflict | undefined;

  let failure: string | undefined;

  if (await workspace.exists()) {
    const status = await workspace.status();

    dirty = status.dirty;

    // main already holds a clean worktree's commits
    if (!dirty && status.ahead !== 0)
      try {
        const result = await workspace.publish();

        if (result !== 'published') conflict = result;
      } catch (error) {
        failure = errorMessage(error);
      }

    // accept or keep mine would publish the markers a stuck rebase leaves
    if (await workspace.rebaseStopped())
      throw new Error('memory is stuck in a rebase that could not be aborted.');
  }

  const recovery: Recovery | undefined = dirty
    ? {
        kind: 'pending',
        paths: [],
        diff: await workspace.diff(),
        root: workspace.root,
      }
    : conflict
      ? {
          kind: 'conflict',
          ...conflict,
          root: workspace.root,
        }
      : undefined;

  return { recovery, failure };
}
