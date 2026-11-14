import assert from 'node:assert/strict';
import { promises as files } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { z } from 'zod';
import { readJson, replaceFile } from '../../src/persistence/json.js';
import { scratch } from '../fixtures/scratch.js';

test('a JSON file under a stray file, as under a Finder .DS_Store, reads as missing', async () => {
  const root = await scratch('witch-json-');

  await writeFile(join(root, '.DS_Store'), '');

  assert.equal(
    await readJson(join(root, '.DS_Store', 'state.json'), z.unknown()),
    undefined,
  );
});

/** runs `body` with the temporary file's handle methods replaced by `faults`, and `rm` spied. */
async function withFaults(
  faults: Partial<
    Record<'writeFile' | 'sync' | 'utimes' | 'close', () => Promise<never>>
  >,
  body: (removing: ReturnType<typeof vi.spyOn>) => Promise<void>,
): Promise<void> {
  const opening = files.open;

  vi.spyOn(files, 'open').mockImplementation(
    async (...args: Parameters<typeof files.open>) => {
      const handle: FileHandle = await opening(...args);

      for (const [name, fault] of Object.entries(faults)) {
        if (name === 'close') {
          const close = handle.close.bind(handle);

          vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
            await close();

            return fault();
          });
        } else
          vi.spyOn(handle, name as 'writeFile').mockImplementationOnce(fault);
      }

      return handle;
    },
  );

  const removing = vi.spyOn(files, 'rm');

  syncBuiltinESMExports();

  try {
    await body(removing);
  } finally {
    vi.restoreAllMocks();

    syncBuiltinESMExports();
  }
}

const rejecting = (error: Error) => () => Promise.reject(error);

test('replaceFile leaves no temporary file when rename fails', async () => {
  const root = await scratch('witch-json-');

  await mkdir(join(root, 'target'));

  await assert.rejects(replaceFile(join(root, 'target'), 'new'), {
    code: 'EISDIR',
  });

  assert.deepEqual(await readdir(root), ['target']);
});

test('replaceFile keeps the write error when close also fails', async () => {
  const root = await scratch('witch-json-');
  const sentinel = new Error('write failed');
  const closing = new Error('close failed');
  const closed = vi.fn(() => Promise.reject(closing));

  await withFaults(
    { writeFile: rejecting(sentinel), close: closed },
    async () => {
      await assert.rejects(
        replaceFile(join(root, 'target'), 'new'),
        (error) => error === sentinel,
      );
    },
  );

  assert.equal(closed.mock.calls.length, 1);

  assert.deepEqual(await readdir(root), []);
});

test('replaceFile cleans up when only close fails', async () => {
  const root = await scratch('witch-json-');
  const target = join(root, 'target');

  await writeFile(target, 'old');

  const sentinel = new Error('close failed');

  await withFaults({ close: rejecting(sentinel) }, async () => {
    await assert.rejects(
      replaceFile(target, 'new'),
      (error) => error === sentinel,
    );
  });

  assert.equal(await readFile(target, 'utf8'), 'old');

  assert.deepEqual(await readdir(root), ['target']);
});

for (const step of ['sync', 'utimes'] as const)
  test(`replaceFile cleans up when ${step} fails`, async () => {
    const root = await scratch('witch-json-');
    const target = join(root, 'target');

    await writeFile(target, 'old');

    const sentinel = new Error(`${step} failed`);
    const times = { atime: new Date(0), mtime: new Date(0) };

    await withFaults({ [step]: rejecting(sentinel) }, async () => {
      await assert.rejects(
        replaceFile(target, 'new', times),
        (error) => error === sentinel,
      );
    });

    assert.equal(await readFile(target, 'utf8'), 'old');

    assert.deepEqual(await readdir(root), ['target']);
  });

// this test and the next pass on the old code too; they guard against an unguarded rm or an unlink in finally
test('replaceFile keeps the write error when removal fails', async () => {
  const root = await scratch('witch-json-');
  const sentinel = new Error('write failed');

  await withFaults({ writeFile: rejecting(sentinel) }, async (removing) => {
    removing.mockRejectedValueOnce(new Error('rm failed'));

    await assert.rejects(
      replaceFile(join(root, 'target'), 'new'),
      (error) => error === sentinel,
    );
  });
});

test('replaceFile never removes after a successful rename', async () => {
  const root = await scratch('witch-json-');
  const target = join(root, 'target');

  await withFaults({}, async (removing) => {
    await replaceFile(target, 'new');

    assert.equal(removing.mock.calls.length, 0);
  });

  assert.equal(await readFile(target, 'utf8'), 'new');
});
