import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * this process's directory under `parent`, named after its pid and removed when it exits. those a killed process
 * left, named after one that's gone or after an earlier process with this pid, go first.
 */
export function instanceDirectory(parent: string): string {
  mkdirSync(parent, { recursive: true });
  for (const name of readdirSync(parent))
    if (
      /^\d+$/.test(name) &&
      (Number(name) === process.pid || !running(Number(name)))
    )
      remove(join(parent, name));
  const directory = join(parent, String(process.pid));
  mkdirSync(directory, { recursive: true });
  process.once('exit', () => remove(directory));
  return directory;
}

/** only ESRCH means gone: EPERM is another user's live process. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** what can't be removed stays for a later launch, since a throw here would end launch or skip later exit listeners. */
function remove(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // a read-only directory an agent's command left stops rm until it's made writable
    spawnSync('/bin/chmod', ['-R', 'u+rwx', directory]);
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // a later launch removes it
    }
  }
}
