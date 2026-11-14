import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readJson, writeJson } from './json.js';
import { tryOpenLocked } from './lock.js';
import { bootSession } from './process.js';

const recordSchema = z.object({
  boot: z.uuid(),
  sentAt: z.number().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

/** spaces actual writes across processes without persisting alerts that can become stale. */
export class NotificationSchedule {
  private constructor(
    private readonly directory: string,
    private readonly boot: string,
  ) {}

  static async open(directory: string): Promise<NotificationSchedule> {
    const boot = z.uuid().parse(await bootSession());

    await mkdir(directory, { recursive: true, mode: 0o700 });

    return new NotificationSchedule(directory, boot);
  }

  async attempt(
    message: () => string | undefined,
    write: (data: string) => void,
  ): Promise<number | undefined> {
    const lock = await tryOpenLocked(
      join(this.directory, 'lock'),
      constants.O_RDWR | constants.O_CREAT,
      { mode: 0o600 },
    );

    if (!lock) return 25;

    try {
      const file = join(this.directory, 'schedule.json');

      const previous = await readJson(file, recordSchema);

      const data = message();

      if (data === undefined) return;

      const digest = createHash('sha256').update(data).digest('hex');

      if (previous?.boot === this.boot) {
        const interval = previous.digest === digest ? 6_200 : 1_200;

        const remaining =
          previous.sentAt + interval - Number(process.hrtime.bigint()) / 1e6;

        if (remaining > 0) return remaining;
      }

      write(data);

      await writeJson(file, {
        boot: this.boot,
        sentAt: Number(process.hrtime.bigint()) / 1e6,
        digest,
      });
    } finally {
      await lock.close();
    }
  }
}
