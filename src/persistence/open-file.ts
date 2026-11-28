import { constants, promises as files } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

// macOS O_NOFOLLOW_ANY, which Node doesn't export
export const noFollowAny = 0x20000000;

/** each held directory anchors the next lookup while a parent can be renamed. */
export async function openWithoutSymlinks(
  file: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  if (process.platform !== 'linux')
    return files.open(file, flags | noFollowAny, mode);

  const parts = file.split('/').filter(Boolean);
  const name = parts.pop()!;

  const directories = [
    await files.open('/', constants.O_RDONLY | constants.O_DIRECTORY),
  ];

  const directory = async (handle: FileHandle) => {
    if (!(await handle.stat()).isDirectory())
      throw Object.assign(new Error(`Not a directory: ${file}`), {
        code: 'ENOTDIR',
        path: file,
      });
  };

  try {
    for (const part of parts) {
      const handle = await files.open(
        `/proc/self/fd/${directories.at(-1)!.fd}/${part}`,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );

      directories.push(handle);
      await directory(handle);
    }

    const handle = await files.open(
      `/proc/self/fd/${directories.at(-1)!.fd}/${name}`,
      (flags & ~constants.O_DIRECTORY) | constants.O_NOFOLLOW,
      mode,
    );

    directories.push(handle);

    if (flags & constants.O_DIRECTORY) await directory(handle);

    directories.pop();

    return handle;
  } finally {
    await Promise.all(directories.map((handle) => handle.close()));
  }
}
