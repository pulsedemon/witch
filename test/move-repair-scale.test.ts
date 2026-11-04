import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { repairMoves } from '../src/core/move-repair.js';
import { StateStore } from '../src/persistence/store.js';
import { record } from './fixtures/coordinator.js';
import { scratch } from './fixtures/scratch.js';
import { seededMemory } from './fixtures/seeded-memory.js';

test('repair with many known directories and conversations stays fast', async () => {
  const root = await scratch('witch-scale-');
  const at = (path: string) => join(root, path);
  for (let index = 0; index < 2000; index++) {
    await mkdir(at(`state/conversations/c${index}`), { recursive: true });
    await writeFile(
      at(`state/conversations/c${index}/state.json`),
      JSON.stringify(record(`c${index}`, at(`saved/c${index}`))),
    );
  }
  const entries = Array.from({ length: 2000 }, (_, index) => ({
    path: at(`known/e${index}`),
    device: '1',
    inode: String(index),
  }));
  await writeFile(
    at('state/directories.json'),
    JSON.stringify({ version: 1, entries, moves: [] }),
  );
  await mkdir(at('here'));
  const store = await StateStore.open(at('state'));
  const memory = await seededMemory(at('state/memory.git'));
  // checking every entry against every conversation took seconds
  const started = performance.now();
  const report = await repairMoves(store, memory, at('here'), {
    preview: true,
    run: () => Promise.reject(new Error('not a repository')),
  });
  assert.ok(performance.now() - started < 2000);
  assert.deepEqual(report.blocked, []);
});
