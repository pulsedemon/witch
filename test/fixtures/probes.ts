import type { ChildProcess } from 'node:child_process';

import { subscribe, unsubscribe } from 'node:diagnostics_channel';

export async function countProbes<T>(run: () => Promise<T>) {
  const probes = { ps: 0, perl: 0, git: 0, sh: 0 };

  const observe = (message: unknown) => {
    const { process: child } = message as { process: ChildProcess };

    child.once('spawn', () => {
      if (child.spawnfile === '/bin/ps') probes.ps++;

      if (child.spawnfile === '/usr/bin/perl') probes.perl++;

      if (child.spawnfile === 'git') probes.git++;

      if (child.spawnfile === '/bin/sh') probes.sh++;
    });
  };

  subscribe('child_process', observe);

  try {
    return { value: await run(), ...probes };
  } finally {
    unsubscribe('child_process', observe);
  }
}
