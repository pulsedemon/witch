import { randomUUID } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';
import type { ZodType } from 'zod';

/** readers see the complete old or new value, and private files never inherit permissive defaults. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await replaceFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** replaces a file whole, keeping `times` when given, so a reader ordering files by mtime sees no change. */
export async function replaceFile(
  file: string,
  content: string | Buffer,
  times?: { atime: Date; mtime: Date },
): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
    if (times) await handle.utimes(times.atime, times.mtime);
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

/** undefined when the file is missing; unreadable, malformed or schema-invalid content throws. */
export async function readJson<T>(
  file: string,
  schema: ZodType<T>,
): Promise<T | undefined> {
  const text = await readFile(file, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  return text === undefined ? undefined : schema.parse(JSON.parse(text));
}

/** undefined for a file that's gone; one that can't be read throws, so its caller reports it rather than skipping it. */
export const unlessGone = <T>(read: Promise<T>): Promise<T | undefined> =>
  read.catch((error: unknown) => {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  });
