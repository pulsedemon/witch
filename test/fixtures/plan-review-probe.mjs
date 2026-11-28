import process from 'node:process';
import { existsSync, writeFileSync } from 'node:fs';
import { appendFile, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers';

const { fault, root, draftFile } = JSON.parse(
  process.env.WITCH_TEST_PLAN_REVIEW,
);

if (fault === 'stop-at-check' || fault === 'stop-at-publication') {
  process.on('SIGTERM', () =>
    setImmediate(() => writeFileSync(join(root, 'stop-observed'), 'yes')),
  );
} else if (
  fault === 'lost-report' ||
  fault === 'lost-after-stage' ||
  fault === 'missing-draft-and-reply' ||
  fault === 'receipt-conflict-and-reply'
) {
  const now = Date.now;
  const timeout = join(root, 'mail-timeout');
  Date.now = () => now() + (existsSync(timeout) ? 31000 : 0);
} else {
  const handle = await open(draftFile);
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();

  if (fault === 'grow-on-read') {
    const read = prototype.read;

    prototype.read = async function (...args) {
      prototype.read = read;
      await appendFile(draftFile, 'X');

      return read.apply(this, args);
    };
  } else if (
    fault === 'draft-after-save' ||
    fault === 'missing-draft-and-write'
  ) {
    const sync = prototype.sync;
    const receiptFile = join(root, 'attempt.json');

    prototype.sync = async function () {
      const receipt = await readFile(receiptFile, 'utf8').catch(() => '');

      if (
        fault === 'missing-draft-and-write' &&
        receipt.includes('Could not reread the plan draft')
      )
        throw new Error('Fixture receipt sync failed');

      await sync.call(this);

      if (receipt.includes('"status":"completed"')) {
        prototype.sync = sync;
        await writeFile(draftFile, 'Edited during receipt sync');
      }
    };
  }
}
