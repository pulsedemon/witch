import type { ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { launchable } from './executable.js';

/** launches the executable's real path, resolved now, so a pinned path names the version installed at launch. */
export function nativeLaunch<T extends ChildProcess>(
  executable: string,
  start: (executable: string) => T,
): T {
  if (!launchable(executable))
    throw new Error(`Native executable not found: ${executable}`);

  return start(realpathSync.native(executable));
}
