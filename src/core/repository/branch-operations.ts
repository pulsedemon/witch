import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { unlessGone } from '../../persistence/json.js';

/** whether the Git directory `admin`, a checkout's own, holds a rebase or bisect of `name`. */
export async function operationIn(
  admin: string,
  name: string,
): Promise<boolean> {
  const [merge, apply, bisect, updates] = await Promise.all(
    [
      'rebase-merge/head-name',
      'rebase-apply/head-name',
      'BISECT_START',
      'rebase-merge/update-refs',
    ].map((file) => unlessGone(readFile(join(admin, file), 'utf8'))),
  );

  return (
    [merge, apply, bisect].some(
      (branch) =>
        branch?.replace(/\n+$/, '').replace(/^refs\/heads\//, '') === name,
    ) ||
    !!updates
      ?.split('\n')
      .some((ref, index) => index % 3 === 0 && ref === `refs/heads/${name}`)
  );
}

/** keep branches owned by rebase or bisect; their detached HEADs are absent from %(worktreepath). */
export async function branchInOperation(
  common: string,
  name: string,
): Promise<boolean> {
  const worktrees = join(common, 'worktrees');

  const admins = [
    common,
    ...((await unlessGone(readdir(worktrees))) ?? []).map((entry) =>
      join(worktrees, entry),
    ),
  ];

  for (const admin of admins) if (await operationIn(admin, name)) return true;

  return false;
}
