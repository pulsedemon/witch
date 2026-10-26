import { randomUUID } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';
import type { ZodType } from 'zod';

/** readers see the complete old or new value, and private files never inherit permissive defaults. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
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
