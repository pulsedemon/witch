import { randomUUID } from 'node:crypto';
import { constants, promises as files } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { errorMessage } from '../agents/stderr.js';
import {
  coordinationActionSchema,
  coordinationSnapshotSchema,
  conversationSummarySchema,
  taskClaimSchema,
} from '../core/coordination-state.js';
import type { CoordinationAction } from '../core/coordination-state.js';
import { ClaimConflict, checkDeadline } from './coordination.js';
import { writeJson } from './json.js';

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
    action: coordinationActionSchema,
  });

const controlOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('peers'), snapshot: coordinationSnapshotSchema }),
  z.object({ kind: z.literal('claimed'), claim: taskClaimSchema }),
  z.object({ kind: z.literal('released') }),
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

async function read(
  file: string,
  flag = constants.O_RDONLY,
): Promise<string | undefined> {
  return files
    .readFile(file, { encoding: 'utf8', flag })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
}

async function remove(file: string): Promise<void> {
  await files.unlink(file).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

export async function callControl(
  binding: ControlBinding,
  action: CoordinationAction,
): Promise<ControlResult> {
  const request = controlRequestSchema.parse({
    version: 1,
    id: randomUUID(),
    conversation: binding.conversation,
    activation: binding.activation,
    deadline: Date.now() + 10_000,
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
      if (answered) continue;
      const text = await read(
        join(this.directory, 'inbox', name),
        constants.O_RDONLY | constants.O_NONBLOCK | noFollowAny,
      );
      if (text === undefined) continue;
      let outcome: ControlOutcome;
      try {
        const request = controlRequestSchema.parse(JSON.parse(text));
        if (request.id !== id)
          throw new Error('Request id does not match its file.');
        checkDeadline(request.deadline);
        outcome = await this.handle(request);
      } catch (error) {
        outcome =
          error instanceof ClaimConflict
            ? { kind: 'conflict', claim: error.claim, message: error.message }
            : { kind: 'error', message: errorMessage(error) };
      }
      // a fresh descriptor cannot follow a redirected parent or overwrite an existing file.
      const file = await files.open(
        reply,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowAny,
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
