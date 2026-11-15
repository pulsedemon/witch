import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { errorMessage } from '../../errors.js';
import {
  gone,
  readJson,
  unlessGone,
  writeJson,
} from '../../persistence/json.js';
import { openLocked, tryOpenLocked } from '../../persistence/lock.js';

const attemptSchema = z.object({
  id: z.uuid(),
});

const resultSchema = z.object({ text: z.string(), built: z.boolean() });

const receiptSchema = z.union([
  z.object({ result: resultSchema }),
  z.object({ error: z.string() }),
]);

export type RebuildResult = z.infer<typeof resultSchema>;

type Attempt = z.infer<typeof attemptSchema>;

async function pause(signal?: AbortSignal): Promise<void> {
  await delay(100, undefined, { signal }).catch((error: unknown) => {
    throw signal?.aborted ? signal.reason : error;
  });
}

async function admission(directory: string, signal?: AbortSignal) {
  for (;;) {
    signal?.throwIfAborted();

    const lock = await tryOpenLocked(
      join(directory, 'witch-rebuild.lock'),
      constants.O_RDWR | constants.O_CREAT,
    );

    if (lock) return lock;

    await pause(signal);
  }
}

/** shared probes cannot mistake one another for the builder's exclusive lifetime lock. */
async function rebuilding(path: string): Promise<boolean> {
  try {
    const probe = await tryOpenLocked(path, constants.O_RDONLY, {
      shared: true,
    });

    if (!probe) return true;

    await probe.close();

    return false;
  } catch (error) {
    if (gone(error)) return false;

    throw error;
  }
}

/** readers retain this attempt's inode after completion unlinks it and a later attempt starts. */
async function waitForResult(
  receipt: FileHandle,
  path: string,
  signal?: AbortSignal,
): Promise<RebuildResult> {
  let ended = false;

  for (;;) {
    signal?.throwIfAborted();
    const { size, nlink } = await receipt.stat();

    const { buffer, bytesRead } = await receipt.read(
      Buffer.alloc(size),
      0,
      size,
      0,
    );

    const text = buffer.toString('utf8', 0, bytesRead);

    if (text.endsWith('\n')) {
      const outcome = receiptSchema.parse(JSON.parse(text));

      if ('error' in outcome) throw new Error(outcome.error);

      return outcome.result;
    }

    if (ended)
      throw new Error(
        'Another Witch stopped rebuilding without reporting a result; the rebuild outcome is unconfirmed.',
      );

    ended = nlink === 0 || !(await rebuilding(path));

    if (!ended) await pause(signal);
  }
}

export async function sharedRebuild(
  directory: string,
  rebuild: () => Promise<RebuildResult>,
  {
    signal,
    waiting,
    failure,
  }: {
    signal?: AbortSignal;
    waiting(): void;

    failure(error: unknown): Error;
  },
): Promise<RebuildResult> {
  const state = join(directory, 'witch-rebuild.json');
  const pathFor = (id: string) => join(directory, `witch-rebuild-${id}.json`);
  let lock: FileHandle | undefined;
  let receipt: FileHandle | undefined;
  let lifetime: FileHandle | undefined;
  let created: string | undefined;

  const completion = await perform().then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );

  const errors: unknown[] = [];

  if (created)
    for (const path of [state, created])
      await rm(path, { force: true }).catch((error: unknown) => {
        errors.push(error);
      });

  for (const handle of [receipt, lifetime, lock])
    await handle?.close().catch((error: unknown) => {
      errors.push(error);
    });

  if ('error' in completion) throw completion.error;

  if (errors.length) throw errors[0];

  return completion.result;

  async function perform(): Promise<RebuildResult> {
    let attempt: Attempt;
    let joined = false;

    lock = await admission(directory, signal).catch((error: unknown) => {
      throw failure(error);
    });

    try {
      const active = await readJson(state, attemptSchema);

      if (active) receipt = await unlessGone(open(pathFor(active.id), 'r'));

      if (active && receipt && (await rebuilding(pathFor(active.id)))) {
        attempt = active;
        joined = true;
      } else {
        await receipt?.close();
        receipt = undefined;

        if (active) {
          await rm(pathFor(active.id), { force: true });
          await rm(state, { force: true });
        }

        attempt = { id: randomUUID() };
        const path = pathFor(attempt.id);
        receipt = await open(path, 'wx+', 0o600);
        created = path;
        lifetime = await openLocked(path, constants.O_RDWR);
        await writeJson(state, attempt);
      }
    } catch (error) {
      throw failure(error);
    }

    await lock.close();
    lock = undefined;

    if (joined) {
      waiting();

      return await waitForResult(receipt, pathFor(attempt.id), signal);
    }

    let outcome: z.infer<typeof receiptSchema>;
    let error: unknown;

    try {
      outcome = { result: await rebuild() };
    } catch (cause) {
      error = cause === signal?.reason ? cause : failure(cause);

      outcome = {
        error:
          cause === signal?.reason
            ? "Another Witch's rebuild was interrupted."
            : errorMessage(error),
      };
    }

    try {
      lock = await admission(directory);
      // the final newline publishes a complete receipt; already-open readers survive its unlink.
      await receipt.writeFile(`${JSON.stringify(outcome)}\n`);
    } catch (cause) {
      throw 'error' in outcome ? error : cause;
    }

    if ('error' in outcome) throw error;

    return outcome.result;
  }
}
