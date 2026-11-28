import { constants } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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

    return { file, size: stat.size, path: resolved };
  } catch (error) {
    await file.close();

    throw error;
  }
}

export interface TargetSnapshot {
  texts: Readonly<Record<string, string>>;
  canonical: Readonly<Record<string, string>>;
}

export async function snapshotTargets(
  cwd: string,
  files: readonly string[],
  roots: readonly string[],
): Promise<TargetSnapshot> {
  const entries: [string, string][] = [];
  const canonical = new Map<string, string>();

  for (const name of files) {
    const opened = await openReviewFile(resolve(cwd, name), roots);

    try {
      const text =
        canonical.get(opened.path) ?? (await opened.file.readFile('utf8'));

      entries.push([name, text]);
      canonical.set(opened.path, text);
    } finally {
      await opened.file.close();
    }
  }

  return {
    texts: Object.fromEntries(entries),
    canonical: Object.fromEntries(canonical),
  };
}

export async function withTargetSnapshots<T>(
  directory: string,
  texts: TargetSnapshot['texts'],
  run: (files: Readonly<Record<string, string>>) => Promise<T>,
) {
  const staged = await mkdtemp(join(directory, 'targets-'));

  try {
    const files: [string, string][] = [];

    for (const [name, text] of Object.entries(texts)) {
      const path = join(staged, `target-${files.length}.txt`);
      await writeFile(path, text, { mode: 0o600 });
      files.push([name, path]);
    }

    return await run(Object.fromEntries(files));
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}
