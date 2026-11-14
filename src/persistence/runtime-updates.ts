import { createHash } from 'node:crypto';
import { closeSync, constants, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  installationSchema,
  runtimeCheckSchema,
  versionSchema,
} from '../agents/runtime-updates.js';
import type { RuntimeInstallation } from '../agents/runtime-updates.js';
import { gone, readJson, unlessGone, writeJson } from './json.js';
import { openLocked, tryOpenLocked, tryOpenLockedSync } from './lock.js';

const cachedCheckSchema = runtimeCheckSchema.extend({
  notified: z.string().optional(),
});

const updateJournalSchema = z.object({
  id: z.string().uuid(),
  previous: installationSchema,
  target: versionSchema,
  build: z.string(),
  selected: installationSchema.optional(),
  phase: z.enum([
    'preparing',
    'installing',
    'verifying',
    'recovering',
    'failed',
    'verified',
    'recovered',
    'aborted',
  ]),
  startedAt: z.number(),
  error: z.string().optional(),
});

export type UpdateJournal = z.infer<typeof updateJournalSchema>;

export const nativeUpdateDirectory = () =>
  join(homedir(), '.witch', 'native-updates');

/** where each Witch taking part in native updates keeps a locked `<pid>.json`. */
export const participantsDirectory = (directory: string) =>
  join(directory, 'participants');

export const participantFile = (directory: string, pid: number) =>
  join(participantsDirectory(directory), `${pid}.json`);

/** the participant records under `directory`; a participant is one whose record is still locked. */
export async function listParticipants(directory: string): Promise<string[]> {
  const folder = participantsDirectory(directory);
  const files = (await unlessGone(readdir(folder))) ?? [];

  return files
    .filter((file) => /^\d+\.json$/.test(file))
    .map((file) => join(folder, file));
}

export const pendingUpdate = (journal: UpdateJournal) =>
  !['verified', 'recovered', 'aborted'].includes(journal.phase);

/** whether `journal` records a passed qualification of exactly this artifact by this Witch build. */
export const qualifiedBy = (
  journal: UpdateJournal | undefined,
  installation: RuntimeInstallation | undefined,
  build: string | undefined,
) =>
  journal?.phase === 'verified' &&
  !!installation &&
  installation.digest === journal.selected?.digest &&
  journal.build === build;

const key = (root: string) => createHash('sha256').update(root).digest('hex');

const journalFile = (directory: string, root: string) =>
  join(directory, `${key(root)}.json`);

export class NativeUpdatePending extends Error {
  constructor(
    message = 'A native runtime update needs attention. Press Ctrl+P and choose Native runtime updates and recovery.',
  ) {
    super(message);
  }
}

export function holdRuntime(
  root: string,
  directory = nativeUpdateDirectory(),
): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const descriptor = tryOpenLockedSync(
    join(directory, `${key(root)}.use`),
    constants.O_CREAT | constants.O_RDWR,
    true,
  );

  if (descriptor === undefined) throw new NativeUpdatePending();

  try {
    let journal: UpdateJournal | undefined;

    try {
      journal = updateJournalSchema.parse(
        JSON.parse(readFileSync(journalFile(directory, root), 'utf8')),
      );
    } catch (error) {
      if (!gone(error)) throw error;
    }

    if (journal && pendingUpdate(journal)) throw new NativeUpdatePending();

    return () => closeSync(descriptor);
  } catch (error) {
    closeSync(descriptor);

    throw error;
  }
}

export class RuntimeUpdateStore {
  constructor(readonly directory = nativeUpdateDirectory()) {}

  async transaction(root: string): Promise<FileHandle> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });

    const file = await tryOpenLocked(
      join(this.directory, `${key(root)}.transaction`),
      constants.O_CREAT | constants.O_RDWR,
    );

    if (!file)
      throw new NativeUpdatePending(
        'Another native update, recovery or qualification holds this installation. Try again when it finishes.',
      );

    return file;
  }

  async exclusive(root: string, signal: AbortSignal): Promise<FileHandle> {
    const deadline = Date.now() + 5000;

    do {
      signal.throwIfAborted();

      const file = await tryOpenLocked(
        join(this.directory, `${key(root)}.use`),
        constants.O_CREAT | constants.O_RDWR,
      );

      if (file) return file;

      await delay(50, undefined, { signal });
    } while (Date.now() < deadline);

    throw new Error(
      'Another process is using this native installation. Close it before updating.',
    );
  }

  journal(root: string): Promise<UpdateJournal | undefined> {
    return readJson(journalFile(this.directory, root), updateJournalSchema);
  }

  operation(journal: UpdateJournal): string {
    return join(this.directory, 'operations', journal.id);
  }

  async journals(): Promise<UpdateJournal[]> {
    const files = (await unlessGone(readdir(this.directory))) ?? [];

    const values = await Promise.all(
      files
        .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
        .map((file) =>
          readJson(join(this.directory, file), updateJournalSchema),
        ),
    );

    return values.filter((value) => value !== undefined);
  }

  write(journal: UpdateJournal): Promise<void> {
    return writeJson(
      journalFile(this.directory, journal.previous.root),
      journal,
    );
  }

  cached(root: string, channel: string) {
    return readJson(
      join(this.directory, `${key(root)}-${channel}.check.json`),
      cachedCheckSchema,
    );
  }

  async cache(check: z.infer<typeof runtimeCheckSchema>): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });

    const file = join(
      this.directory,
      `${key(check.installation.root)}-${check.installation.channel}.check.json`,
    );

    const lock = await openLocked(
      `${file}.lock`,
      constants.O_CREAT | constants.O_RDWR,
    );

    try {
      const previous = await readJson(file, cachedCheckSchema);

      const notify =
        check.available &&
        !check.blocked &&
        previous?.notified !== check.target;

      await writeJson(file, {
        ...check,
        notified: notify ? check.target : previous?.notified,
      });

      return notify;
    } finally {
      await lock.close();
    }
  }
}
