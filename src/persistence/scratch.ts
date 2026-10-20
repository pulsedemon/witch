import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { processIdentity } from '../core/state.js';
import { processRunning, removeDirectory } from './instance.js';
import { writeJson } from './json.js';
import { exclusiveLock } from './lock.js';
import { identifyProcess } from './process.js';

const execute = promisify(execFile);
const metadata = '.witch-scratch.json';
const recordSchema = z.object({
  version: z.literal(1),
  boot: z.uuid(),
  owner: processIdentity.optional(),
});

async function bootSession(): Promise<string> {
  const { stdout } = await execute('/usr/sbin/sysctl', [
    '-n',
    'kern.bootsessionuuid',
  ]);
  return stdout.trim();
}

async function lockDirectory(directory: string): Promise<FileHandle> {
  return open(
    directory,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      exclusiveLock,
  );
}

async function readRecord(directory: string) {
  try {
    return recordSchema.parse(
      JSON.parse(await readFile(join(directory, metadata), 'utf8')),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** a later boot rules out surviving workers, including children forked after their Witch exited. */
async function sweep(parent: string, boot: string): Promise<void> {
  for (const name of await readdir(parent)) {
    const numeric = /^\d+$/.test(name);
    if (!numeric && !z.uuid().safeParse(name).success) continue;
    const directory = join(parent, name);
    let lock: FileHandle | undefined;
    try {
      lock = await lockDirectory(directory);
      const record = await readRecord(directory);
      if (record) {
        if (record.boot !== boot) removeDirectory(directory);
      } else if (!numeric || !processRunning(Number(name))) {
        await writeJson(join(directory, metadata), { version: 1, boot });
      }
    } catch {
      // a busy or unreadable directory stays; missing metadata gets its first boot boundary above
    } finally {
      await lock?.close();
    }
  }
}

/** scratch survives every exit in its boot; a later launch after another boot sweeps unlocked directories. */
export class ScratchSpace {
  private constructor(
    readonly directory: string,
    private lock: FileHandle | undefined,
  ) {}

  static async open(
    parent: string,
    options: { resume?: string; boot?: () => Promise<string> } = {},
  ): Promise<ScratchSpace> {
    parent = resolve(parent);
    const resumed = options.resume !== undefined;
    const directory = resumed
      ? resolve(options.resume!)
      : join(parent, randomUUID());
    if (dirname(directory) !== parent)
      throw new Error('Scratch must be a direct child of its state directory.');
    const boot = z.uuid().parse(await (options.boot ?? bootSession)());
    const owner = await identifyProcess(process.pid);
    if (!owner) throw new Error('Cannot identify the scratch owner.');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (!resumed) await mkdir(directory, { mode: 0o700 });
    const lock = await lockDirectory(directory);
    try {
      if (resumed) {
        const record = await readRecord(directory);
        const legacy = !record && basename(directory) === String(process.pid);
        if (
          !legacy &&
          (record?.boot !== boot ||
            record.owner?.pid !== owner.pid ||
            record.owner.started !== owner.started)
        )
          throw new Error('Scratch does not belong to this restarting Witch.');
      }
      await writeJson(join(directory, metadata), { version: 1, boot, owner });
      await sweep(parent, boot);
      return new ScratchSpace(directory, lock);
    } catch (error) {
      await lock.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const lock = this.lock;
    this.lock = undefined;
    await lock?.close();
  }
}
