import assert from 'node:assert/strict';

import { mkdir, open, readFile, writeFile } from 'node:fs/promises';

import type { FileHandle } from 'node:fs/promises';

import { join } from 'node:path';

import { test, vi } from 'vitest';

import { writeJson } from '../src/persistence/json.js';

import type { RegisterCleanup } from './fixtures/cleanup.js';

import { ephemeralFiles } from './fixtures/ephemeral-files.js';

import { scratch } from './fixtures/scratch.js';

import { settled, within } from './fixtures/within.js';

test('unit files remain readable while sibling files and restored files retain their durability barrier', async () => {
  const root = await scratch('witch-ephemeral-files-');

  const unit = join(root, 'unit');

  const sibling = join(root, 'unit-sibling');

  await mkdir(unit);

  await mkdir(sibling);

  const probe = await open(join(root, 'probe'), 'w');

  const prototype = Object.getPrototypeOf(probe) as FileHandle;

  await probe.close();

  const sync = prototype.sync;

  let entered = Promise.withResolvers<void>();

  let release = Promise.withResolvers<void>();

  const syncing = vi
    .spyOn(prototype, 'sync')
    .mockImplementation(async function (this: FileHandle) {
      entered.resolve();

      await release.promise;

      await sync.call(this);
    });

  let restore: Parameters<RegisterCleanup>[0] = () => {};

  ephemeralFiles(unit, (cleanup) => {
    restore = cleanup;
  });

  const pending: Promise<void>[] = [];

  try {
    const file = join(unit, 'state.json');

    await within(writeJson(file, { value: 17 }), 3000, 'visible unit write');

    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { value: 17 });

    for (const destination of [join(sibling, 'state.json'), file]) {
      await writeFile(destination, '{"value":29}\n');

      const writing = writeJson(destination, { value: 43 });

      pending.push(writing);

      const done = settled(writing);

      await within(entered.promise, 3000, 'durability barrier');

      assert.equal(done(), false);

      assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), {
        value: 29,
      });

      release.resolve();

      await writing;

      assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), {
        value: 43,
      });

      await restore();

      restore = () => {};

      entered = Promise.withResolvers<void>();

      release = Promise.withResolvers<void>();
    }
  } finally {
    release.resolve();

    await Promise.allSettled(pending);

    await restore();

    syncing.mockRestore();
  }
});
