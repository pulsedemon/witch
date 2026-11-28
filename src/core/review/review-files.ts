import { constants } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { openWithoutSymlinks } from '../../persistence/open-file.js';

export class ReviewInputError extends Error {}

export function insideDirectory(root: string, path: string): boolean {
  const child = relative(root, path);

  return (
    !!child &&
    child !== '..' &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

/** canonical roots admit only regular files, even if a link is replaced before open. */
export async function openReviewFile(path: string, roots: readonly string[]) {
  const resolved = await realpath(path);

  if (!roots.some((root) => insideDirectory(root, resolved)))
    throw new ReviewInputError(
      `Review input is outside the allowed directories: ${path}`,
    );

  const file = await openWithoutSymlinks(
    resolved,
    constants.O_RDONLY | constants.O_NONBLOCK,
  );

  try {
    const stat = await file.stat();

    if (!stat.isFile())
      throw new ReviewInputError(`Review input is not a regular file: ${path}`);

    return { file, size: stat.size };
  } catch (error) {
    await file.close();

    throw error;
  }
}

/** each protected open on Linux holds ancestor descriptors until it opens the target. */
export async function snapshotTargets(
  cwd: string,
  files: readonly string[],
  roots: readonly string[],
) {
  const entries: [string, string][] = [];

  for (const name of files) {
    const opened = await openReviewFile(resolve(cwd, name), roots);

    try {
      entries.push([name, await opened.file.readFile('utf8')]);
    } finally {
      await opened.file.close();
    }
  }

  return Object.fromEntries(entries);
}
