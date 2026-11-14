import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { processIdentity } from '../core/state.js';
import type { ProcessIdentity } from '../core/state.js';
import { processRunning } from './instance.js';
import { readJson, writeJson } from './json.js';
import { openLocked } from './lock.js';
import {
  bootSession,
  identifyProcess,
  identifyProcesses,
  sameProcess,
} from './process.js';
import {
  inspectScratch,
  scratchProbeTimeout,
  scratchRequiresBoot,
} from './scratch-usage.js';
import type { ScratchCandidate } from './scratch-usage.js';

const execute = promisify(execFile);
const metadata = '.witch-scratch.json';
// twelve digits is a short name, never a legacy pid.
const legacyName = /^\d{1,11}$/;
// short so a unix socket under TMPDIR fits macOS's 104-byte path limit.
const shortName = /^[0-9a-f]{12}$/;

const legacyRecord = z.object({
  version: z.literal(1),
  boot: z.uuid(),
  owner: processIdentity.optional(),
});

const recordSchema = z.discriminatedUnion('version', [
  legacyRecord,
  legacyRecord.extend({
    version: z.literal(2),
    owner: processIdentity,
    requiresBoot: z.boolean(),
  }),
]);

async function lockDirectory(
  directory: string,
  nonblocking = true,
): Promise<FileHandle> {
  return openLocked(
    directory,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      (nonblocking ? constants.O_NONBLOCK : 0),
  );
}

async function readRecord(directory: string) {
  return readJson(join(directory, metadata), recordSchema);
}

/** a version 1 record predates the tmux check, so one that names its owner goes on usage evidence alone. */
function waitsForBoot(record: z.infer<typeof recordSchema>): boolean {
  return record.version === 2 ? record.requiresBoot : !record.owner;
}

async function removeScratch(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    // an agent's read-only directory can prevent removal after its users have ended.
    await execute('/bin/chmod', ['-R', 'u+rwx', directory], {
      timeout: 10_000,
      killSignal: 'SIGKILL',
    }).catch(() => {});

    await rm(directory, { recursive: true, force: true });
  }
}

async function sweep(
  parent: string,
  boot: string,
  owner: ProcessIdentity,
  inspect: typeof inspectScratch,
): Promise<void> {
  let parentLock: FileHandle | undefined;

  const held: {
    candidate: ScratchCandidate;
    record: z.infer<typeof recordSchema>;
    lock: FileHandle;
  }[] = [];

  try {
    parentLock = await lockDirectory(parent);

    const observed = new Map<
      string,
      z.infer<typeof recordSchema> | undefined
    >();

    for (const name of await readdir(parent)) {
      if (
        !legacyName.test(name) &&
        !shortName.test(name) &&
        !z.uuid().safeParse(name).success
      )
        continue;

      const directory = join(parent, name);

      try {
        if (!(await lstat(directory)).isDirectory()) continue;

        const record = await readRecord(directory);

        if (
          record?.boot === boot &&
          (waitsForBoot(record) || sameProcess(record.owner, owner))
        )
          continue;

        observed.set(directory, record);
      } catch {
        // unreadable and invalid roots cannot establish ownership.
      }
    }

    const owners = await identifyProcesses(
      [...observed.values()].flatMap((record) =>
        record?.boot === boot && record.owner ? [record.owner.pid] : [],
      ),
      { timeout: scratchProbeTimeout },
    );

    for (const [directory, previous] of observed) {
      const name = basename(directory);
      const numeric = legacyName.test(name);

      // a restarting owner must never compete with a sweep for its directory lock.
      if (
        (previous?.boot === boot &&
          previous.owner &&
          sameProcess(owners.get(previous.owner.pid), previous.owner)) ||
        (!previous && numeric && processRunning(Number(name)))
      )
        continue;

      let lock: FileHandle | undefined;

      try {
        lock = await lockDirectory(directory);

        const record = await readRecord(directory);

        if (JSON.stringify(record) !== JSON.stringify(previous)) continue;

        if (!record) {
          // a legacy pid can be reused while the directory lock is acquired.
          if (!numeric || !processRunning(Number(name)))
            await writeJson(join(directory, metadata), { version: 1, boot });

          continue;
        }

        const previousBoot = record.boot !== boot;

        held.push({
          candidate: {
            directory,
            owner: record.owner,
            previousBoot,
            requiresBoot: waitsForBoot(record),
            lockFd: lock.fd,
          },
          record,
          lock,
        });

        lock = undefined;
      } catch {
        // busy, unreadable and invalid roots remain for a later pass.
      } finally {
        await lock?.close();
      }
    }

    if (!held.length) return;

    const decisions = await inspect(held.map(({ candidate }) => candidate));

    const live = await identifyProcesses(
      held.flatMap(({ candidate }) =>
        !candidate.previousBoot && candidate.owner ? [candidate.owner.pid] : [],
      ),
      { timeout: scratchProbeTimeout },
    );

    for (const { candidate, record, lock } of held) {
      const { directory, owner, previousBoot } = candidate;

      if (
        decisions.get(directory) !== 'unused' ||
        (!previousBoot && owner && sameProcess(live.get(owner.pid), owner))
      )
        continue;

      try {
        const original = await lock.stat();
        const current = await lstat(directory);

        if (
          original.dev !== current.dev ||
          original.ino !== current.ino ||
          JSON.stringify(record) !== JSON.stringify(await readRecord(directory))
        )
          continue;

        await removeScratch(directory);
      } catch {
        // a changed root or failed removal stays for the next pass.
      }
    }
  } catch {
    // another cleaner or an incomplete observation cannot authorize removal.
  } finally {
    try {
      await Promise.all(held.map(({ lock }) => lock.close()));
    } finally {
      await parentLock?.close();
    }
  }
}

/** active roots survive restart; closed roots are reclaimed once no process shows use of them. */
export class ScratchSpace {
  private readonly timer: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;

  private constructor(
    readonly directory: string,
    private lock: FileHandle | undefined,
    private readonly parent: string,
    private readonly boot: string,
    private readonly owner: ProcessIdentity,
    private readonly inspect: typeof inspectScratch,
    interval: number,
  ) {
    this.timer = setInterval(() => void this.maintain(), interval);

    this.timer.unref();
  }

  static async open(
    parent: string,
    options: {
      resume?: string;
      boot?: () => Promise<string>;
      interval?: number;
      inspect?: typeof inspectScratch;
    } = {},
  ): Promise<ScratchSpace> {
    parent = resolve(parent);

    const resumed = options.resume !== undefined;

    const directory = resumed
      ? resolve(options.resume!)
      : join(parent, randomBytes(6).toString('hex'));

    if (dirname(directory) !== parent)
      throw new Error('Scratch must be a direct child of its state directory.');

    const boot = z.uuid().parse(await (options.boot ?? bootSession)());
    const owner = await identifyProcess(process.pid);

    if (!owner) throw new Error('Cannot identify the scratch owner.');

    let requiresBoot = resumed ? true : await scratchRequiresBoot();

    await mkdir(parent, { recursive: true, mode: 0o700 });

    if (!resumed) await mkdir(directory, { mode: 0o700 });

    // wait out a sweep that found the new directory before its owner locked it.
    const lock = await lockDirectory(directory, resumed);

    try {
      if (resumed) {
        const record = await readRecord(directory);
        const legacy = !record && basename(directory) === String(process.pid);

        if (
          !legacy &&
          (record?.boot !== boot || !sameProcess(record.owner, owner))
        )
          throw new Error('Scratch does not belong to this restarting Witch.');

        requiresBoot = record?.version === 2 ? record.requiresBoot : true;
      }

      await writeJson(join(directory, metadata), {
        version: 2,
        boot,
        owner,
        requiresBoot,
      });

      const space = new ScratchSpace(
        directory,
        lock,
        parent,
        boot,
        owner,
        options.inspect ?? inspectScratch,
        options.interval ?? 60_000,
      );

      await space.maintain();

      return space;
    } catch (error) {
      await lock.close();

      throw error;
    }
  }

  private maintain(): Promise<void> {
    if (!this.lock) return Promise.resolve();

    this.polling ??= sweep(this.parent, this.boot, this.owner, this.inspect)
      .catch(() => {})
      .finally(() => {
        this.polling = undefined;
      });

    return this.polling;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);

    const lock = this.lock;

    this.lock = undefined;

    await this.polling;

    await lock?.close();
  }
}
