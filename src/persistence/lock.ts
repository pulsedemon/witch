import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

// macOS O_EXLOCK, which Node doesn't export
export const exclusiveLock = 0x20;

/** observes a held lock without creating a path or changing the owner's file. */
export async function isLocked(file: string): Promise<boolean> {
  try {
    const lock = await open(
      file,
      constants.O_RDONLY | constants.O_NONBLOCK | exclusiveLock,
    );
    await lock.close();
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EAGAIN') return true;
    if (code === 'ENOENT') return false;
    throw error;
  }
}
