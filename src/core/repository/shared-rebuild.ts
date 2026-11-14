import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { errorMessage } from '../../errors.js';
import { readJson, writeJson } from '../../persistence/json.js';
import { tryOpenLocked } from '../../persistence/lock.js';
import { identifyProcess, runs } from '../../persistence/process.js';
import { processIdentity } from '../state.js';

const attemptSchema = z.object({
  id: z.uuid(),
  owner: processIdentity,
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

/** readers retain this attempt's inode after completion unlinks it and a later attempt starts. */
async function waitForResult(
  receipt: FileHandle,
  attempt: Attempt,
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

    ended = nlink === 0 || !(await runs(attempt.owner));

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

  const lock = await admission(directory, signal).catch((error: unknown) => {
    throw failure(error);
  });

  let receipt: FileHandle | undefined;
  let attempt: Attempt;
  let joined = false;

  try {
    const active = await readJson(state, attemptSchema);

    if (active && (await runs(active.owner))) {
      attempt = active;
      receipt = await open(pathFor(active.id), 'r');
      joined = true;
    } else {
      if (active) {
        await rm(pathFor(active.id), { force: true });

        await rm(state);
      }

      const owner = await identifyProcess(process.pid);

      if (!owner) throw new Error('Could not identify the rebuild process');

      attempt = { id: randomUUID(), owner };
      receipt = await open(pathFor(attempt.id), 'wx+', 0o600);

      await writeJson(state, attempt);
    }
  } catch (error) {
    await receipt?.close();

    throw failure(error);
  } finally {
    await lock.close();
  }

  try {
    if (joined) {
      waiting();

      return await waitForResult(receipt, attempt, signal);
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

    const completion = await admission(directory);

    try {
      try {
        // the final newline publishes a complete receipt; already-open readers survive its unlink.
        await receipt.writeFile(`${JSON.stringify(outcome)}\n`);
      } finally {
        await rm(state);

        await rm(pathFor(attempt.id));
      }
    } finally {
      await completion.close();
    }

    if ('error' in outcome) throw error;

    return outcome.result;
  } finally {
    await receipt.close();
  }
}
