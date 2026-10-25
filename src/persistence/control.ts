import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, promises as files } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { errorMessage } from '../agents/stderr.js';
import {
  familiarActionSchema,
  familiarOutcomeSchema,
} from '../agents/familiar-report.js';
import type { FamiliarAction } from '../agents/familiar-report.js';
import {
  coordinationActionSchema,
  coordinationSnapshotSchema,
  conversationSummarySchema,
  taskClaimSchema,
  selectionStateSchema,
} from '../core/coordination-state.js';
import type { CoordinationAction } from '../core/coordination-state.js';
import { ClaimConflict, checkDeadline } from './coordination.js';
import { writeJson } from './json.js';

const execute = promisify(execFile);
const cleanup = `
my ($directory, $name, $flags) = @ARGV;
my @directories;
for my $part ('replies', 'inbox') {
  sysopen(my $handle, "$directory/$part", $flags)
    or die "Cannot open $part: $!";
  push @directories, $handle;
}
for my $handle (@directories) {
  chdir($handle) or die "Cannot enter mailbox directory: $!";
  unlink($name) or $!{ENOENT} or die "Cannot remove expired control file: $!";
  close($handle) or die "Cannot close mailbox directory: $!";
}
`;
const idSchema = z.string().uuid();
// macOS O_NOFOLLOW_ANY, which Node doesn't export
const noFollowAny = 0x20000000;
export const controlBindingSchema = z.object({
  directory: z.string().min(1),
  conversation: z.string().min(1),
  activation: idSchema,
});

export const controlRequestSchema = controlBindingSchema
  .omit({ directory: true })
  .extend({
    version: z.literal(1),
    id: idSchema,
    deadline: z.number(),
    action: z.union([coordinationActionSchema, familiarActionSchema]),
  });

const controlOutcomeSchema = z.discriminatedUnion('kind', [
  familiarOutcomeSchema,
  z.object({ kind: z.literal('peers'), snapshot: coordinationSnapshotSchema }),
  z.object({
    kind: z.literal('claimed'),
    claim: taskClaimSchema,
    warning: z.string().optional(),
  }),
  z.object({ kind: z.literal('released') }),
  z.object({
    kind: z.literal('selection'),
    selection: selectionStateSchema,
    snapshot: coordinationSnapshotSchema,
  }),
  z.object({ kind: z.literal('selection-cancelled'), selection: idSchema }),
  z.object({
    kind: z.literal('conflict'),
    claim: taskClaimSchema,
    owner: conversationSummarySchema.optional(),
    message: z.string(),
  }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);
const controlResultSchema = controlOutcomeSchema.and(
  z.object({ id: idSchema }),
);
export type ControlBinding = z.infer<typeof controlBindingSchema>;
export type ControlRequest = z.infer<typeof controlRequestSchema>;
export type ControlOutcome = z.infer<typeof controlOutcomeSchema>;
export type ControlResult = z.infer<typeof controlResultSchema>;

/** each held directory anchors the next lookup while a parent can be renamed. */
async function openControlFile(
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

async function read(
  file: string,
  protectedRead = false,
): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    if (protectedRead)
      handle = await openControlFile(
        file,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
    return await files.readFile(handle ?? file, { encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function remove(file: string): Promise<void> {
  await files.unlink(file).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

export async function callControl(
  binding: ControlBinding,
  action: CoordinationAction | FamiliarAction,
  deadline = Date.now() + 10_000,
): Promise<ControlResult> {
  const request = controlRequestSchema.parse({
    version: 1,
    id: randomUUID(),
    conversation: binding.conversation,
    activation: binding.activation,
    deadline,
    action,
  });
  const inbox = join(binding.directory, 'inbox', `${request.id}.json`);
  const reply = join(binding.directory, 'replies', `${request.id}.json`);
  await writeJson(inbox, request).catch((error: unknown) => {
    throw new Error(`Coordination host unavailable: ${errorMessage(error)}`, {
      cause: error,
    });
  });
  try {
    while (Date.now() < request.deadline) {
      const text = await read(reply);
      if (text?.endsWith('\n')) {
        const result = controlResultSchema.parse(JSON.parse(text));
        if (result.id !== request.id)
          throw new Error('Reply id does not match.');
        await remove(inbox);
        await remove(reply);
        return result;
      }
      await delay(25);
    }
    throw new Error('The host did not reply before the deadline.');
  } catch (error) {
    throw new Error(
      `Coordination result unknown. Query peers before doing work. ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export class ControlHost {
  private timer: ReturnType<typeof setInterval>;
  private reading?: Promise<void>;
  private closed = false;

  private constructor(
    readonly directory: string,
    private readonly handle: (
      request: ControlRequest,
    ) => Promise<ControlOutcome>,
    private readonly failed: (error: unknown) => void,
  ) {
    this.timer = setInterval(() => this.poll(), 250);
    this.timer.unref();
    this.poll();
  }

  static async open(
    directory: string,
    handle: (request: ControlRequest) => Promise<ControlOutcome>,
    failed: (error: unknown) => void,
  ): Promise<ControlHost> {
    for (const name of ['inbox', 'replies'])
      await files.mkdir(join(directory, name), {
        recursive: true,
        mode: 0o700,
      });
    return new ControlHost(await files.realpath(directory), handle, failed);
  }

  async drain(): Promise<void> {
    await this.reading;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.drain();
  }

  private poll(): void {
    if (this.closed || this.reading) return;
    this.reading = this.read()
      .catch(this.failed)
      .finally(() => {
        this.reading = undefined;
      });
  }

  /** directory handles keep deletion inside the mailbox if a parent path is replaced. */
  private async expire(id: string): Promise<void> {
    if (process.platform === 'linux') {
      const directories: FileHandle[] = [];
      try {
        for (const part of ['replies', 'inbox'])
          directories.push(
            await openControlFile(
              join(this.directory, part),
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK,
            ),
          );
        for (const handle of directories)
          await remove(`/proc/self/fd/${handle.fd}/${id}.json`);
      } finally {
        await Promise.all(directories.map((handle) => handle.close()));
      }
      return;
    }
    await execute('/usr/bin/perl', [
      '-e',
      cleanup,
      this.directory,
      `${id}.json`,
      String(
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NONBLOCK |
          noFollowAny,
      ),
    ]);
  }

  private async read(): Promise<void> {
    for (const name of await files.readdir(join(this.directory, 'inbox'))) {
      if (this.closed) return;
      if (!name.endsWith('.json')) continue;
      const parsed = idSchema.safeParse(name.slice(0, -5));
      if (!parsed.success) continue;
      const id = parsed.data;
      const reply = join(this.directory, 'replies', name);
      const answered = await files.access(reply).then(
        () => true,
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        },
      );
      const text = await read(join(this.directory, 'inbox', name), true);
      if (text === undefined) continue;
      let request: ControlRequest | undefined;
      let outcome: ControlOutcome | undefined;
      try {
        const envelope = controlRequestSchema.parse(JSON.parse(text));
        if (envelope.id !== id)
          throw new Error('Request id does not match its file.');
        request = envelope;
        if (!answered) {
          checkDeadline(request.deadline);
          outcome = await this.handle(request);
        }
      } catch (error) {
        outcome =
          error instanceof ClaimConflict
            ? { kind: 'conflict', claim: error.claim, message: error.message }
            : { kind: 'error', message: errorMessage(error) };
      }
      if (request && Date.now() >= request.deadline) {
        await this.expire(id);
        continue;
      }
      if (answered) continue;
      // a fresh descriptor cannot follow a redirected parent or overwrite an existing file.
      const file = await openControlFile(
        reply,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        // the final newline marks a complete reply while clients can observe a partial write.
        await file.writeFile(`${JSON.stringify({ ...outcome, id })}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
    }
  }
}
