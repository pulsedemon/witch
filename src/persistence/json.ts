import { randomUUID } from 'node:crypto';
import { open, rename } from 'node:fs/promises';

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
