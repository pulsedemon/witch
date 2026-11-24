import type { ChildProcess } from 'node:child_process';
import {
  closeSync,
  constants,
  ftruncateSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { launchable, nativeInstallationRoot } from './executable.js';
import {
  holdRuntime,
  nativeUpdateDirectory,
  participantFile,
  participantsDirectory,
} from '../persistence/runtime-updates.js';
import { tryOpenLockedSync } from '../persistence/lock.js';

const participants = new Map<string, () => void>();

export function registerNativeParticipant(
  directory = nativeUpdateDirectory(),
): () => void {
  const existing = participants.get(directory);

  if (existing) return existing;

  mkdirSync(participantsDirectory(directory), { recursive: true, mode: 0o700 });
  const file = participantFile(directory, process.pid);

  const descriptor = tryOpenLockedSync(
    file,
    constants.O_CREAT | constants.O_RDWR,
  );

  if (descriptor === undefined)
    throw new Error('Cannot register native update participation.');

  ftruncateSync(descriptor, 0);

  writeFileSync(
    descriptor,
    JSON.stringify({
      pid: process.pid,
      entry: process.argv[1] ?? '',
      protocol: 1,
    }),
  );

  let held = true;

  const release = () => {
    if (!held) return;

    held = false;
    participants.delete(directory);
    process.removeListener('exit', release);
    closeSync(descriptor);

    try {
      rmSync(file, { force: true });
    } catch {
      /* a stale record is ignored once its kernel lock closes. */
    }
  };

  participants.set(directory, release);
  process.once('exit', release);

  return release;
}

/** launches the executable's real path, resolved now; the lease follows child exit, including failed spawns. */
export function nativeLaunch<T extends ChildProcess>(
  executable: string,
  start: (executable: string) => T,
  directory = nativeUpdateDirectory(),
): T {
  if (!launchable(executable))
    throw new Error(`Native executable not found: ${executable}`);

  const resolved = realpathSync.native(executable);
  const root = nativeInstallationRoot(resolved);

  if (!root) return start(resolved);

  registerNativeParticipant(directory);
  const release = holdRuntime(root, directory);

  try {
    if (realpathSync.native(executable) !== resolved)
      throw new Error('Native installation changed before launch. Try again.');

    const child = start(resolved);
    let held = true;

    const done = () => {
      if (held) {
        held = false;
        release();
      }
    };

    child.once('exit', done);

    child.once('error', () => {
      if (child.pid === undefined) done();
    });

    return child;
  } catch (error) {
    release();

    throw error;
  }
}
