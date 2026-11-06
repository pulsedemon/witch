import { promises as files } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { sep } from 'node:path';
import { onTestFinished, vi } from 'vitest';
import type { RegisterCleanup } from './cleanup.js';

const open = files.open;
const directories = new Set<string>();

/** skip disk flushes for opens under unit roots; integration fixtures retain their flushes. */
export function ephemeralFiles(
  directory: string,
  register: RegisterCleanup = onTestFinished,
): void {
  const prefix = `${directory}${sep}`;
  directories.add(prefix);
  const opening = vi
    .spyOn(files, 'open')
    .mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (typeof args[0] === 'string')
        for (const root of directories)
          if (args[0].startsWith(root)) {
            handle.sync = async () => {};
            break;
          }
      return handle;
    });
  syncBuiltinESMExports();
  register(() => {
    directories.delete(prefix);
    if (!directories.size) opening.mockRestore();
    syncBuiltinESMExports();
  });
}
