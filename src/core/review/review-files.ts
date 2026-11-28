import { constants } from 'node:fs';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
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

async function reviewPath(path: string, roots: readonly string[]) {
  const resolved = await realpath(path);

  if (!roots.some((root) => insideDirectory(root, resolved)))
    throw new ReviewInputError(
      `Review input is outside the allowed directories: ${path}`,
    );

  return resolved;
}

/** canonical roots admit only regular files, even if a link is replaced before open. */
export async function openReviewFile(path: string, roots: readonly string[]) {
  const resolved = await reviewPath(path, roots);

  if (!(await stat(resolved)).isFile())
    throw new ReviewInputError(`Review input is not a regular file: ${path}`);

  const file = await openWithoutSymlinks(
    resolved,
    constants.O_RDONLY | constants.O_NONBLOCK,
  );

  try {
    const opened = await file.stat();

    if (!opened.isFile())
      throw new ReviewInputError(`Review input is not a regular file: ${path}`);

    return { file, size: opened.size, path: resolved };
  } catch (error) {
    await file.close();

    throw error;
  }
}

export async function readBytes(file: FileHandle, capacity: number) {
  const buffer = Buffer.allocUnsafe(capacity);
  let offset = 0;

  while (offset < capacity) {
    const { bytesRead } = await file.read(buffer, offset, capacity - offset);

    if (!bytesRead) break;

    offset += bytesRead;
  }

  return buffer.subarray(0, offset);
}

export const reviewReceiptFileSchema = z.object({
  path: z.string().min(1),
  device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/),
});

export type ReviewReceiptFile = z.infer<typeof reviewReceiptFileSchema>;

export async function receiptFile(
  path: string,
  file: FileHandle,
): Promise<ReviewReceiptFile> {
  const { dev, ino } = await file.stat({ bigint: true });

  return { path: resolve(path), device: String(dev), inode: String(ino) };
}

export async function verifyReviewReceipt(
  receipt: ReviewReceiptFile,
  expected: string,
  scratch: string,
): Promise<void> {
  const { file } = await openReviewFile(receipt.path, [scratch]);

  try {
    const original = await file.stat({ bigint: true });

    if (
      String(original.dev) !== receipt.device ||
      String(original.ino) !== receipt.inode
    )
      throw new ReviewInputError('The plan review receipt was replaced.');

    const bytes = Buffer.from(expected);

    if (!(await readBytes(file, bytes.length + 1)).equals(bytes))
      throw new ReviewInputError('The plan review receipt contents changed.');

    const { file: namedFile } = await openReviewFile(receipt.path, [scratch]);

    try {
      const named = await namedFile.stat({ bigint: true });

      if (named.dev !== original.dev || named.ino !== original.ino)
        throw new ReviewInputError('The plan review receipt was replaced.');

      if (named.ctimeNs !== original.ctimeNs)
        throw new ReviewInputError(
          'The plan review receipt changed while being read.',
        );
    } finally {
      await namedFile.close();
    }
  } finally {
    await file.close();
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
  signal?: AbortSignal,
): Promise<TargetSnapshot> {
  const entries: [string, string][] = [];
  const canonical = new Map<string, string>();

  for (const name of files) {
    signal?.throwIfAborted();
    const opened = await openReviewFile(resolve(cwd, name), roots);

    try {
      const text =
        canonical.get(opened.path) ??
        (await opened.file.readFile({ encoding: 'utf8', signal }));

      entries.push([name, text]);
      canonical.set(opened.path, text);
    } finally {
      await opened.file.close();
    }
  }

  signal?.throwIfAborted();

  return {
    texts: Object.fromEntries(entries),
    canonical: Object.fromEntries(canonical),
  };
}

export async function withTargetSnapshots<T>(
  directory: string,
  texts: TargetSnapshot['texts'],
  run: (files: Readonly<Record<string, string>>) => Promise<T>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const staged = await mkdtemp(join(directory, 'targets-'));

  try {
    const files: [string, string][] = [];
    const copies = new Map<string, string>();

    for (const [name, text] of Object.entries(texts)) {
      signal?.throwIfAborted();
      let path = copies.get(text);

      if (!path) {
        path = join(staged, `target-${copies.size}.txt`);
        await writeFile(path, text, { mode: 0o600, signal });
        copies.set(text, path);
      }

      files.push([name, path]);
    }

    signal?.throwIfAborted();

    return await run(Object.fromEntries(files));
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}
