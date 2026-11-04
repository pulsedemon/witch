import assert from 'node:assert/strict';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { repairMoves } from '../src/core/move-repair.js';
import { identify } from '../src/persistence/directories.js';
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
  // checking every entry against every conversation takes seconds here
  const started = performance.now();
  const report = await repairMoves(store, memory, at('here'), {
    preview: true,
    run: () => Promise.reject(new Error('not a repository')),
  });
  assert.ok(performance.now() - started < 2000);
  assert.deepEqual(report.blocked, []);
});

test('repairing many conversations past many unrelated moves stays fast', async () => {
  const root = await scratch('witch-scale-');
  const at = (path: string) => join(root, path);
  for (let index = 0; index < 100; index++) {
    await mkdir(at(`old/c${index}`), { recursive: true });
    await mkdir(at(`state/conversations/c${index}`), { recursive: true });
    await writeFile(
      at(`state/conversations/c${index}/state.json`),
      JSON.stringify(record(`c${index}`, at(`old/c${index}`))),
    );
  }
  const moves = Array.from({ length: 10_000 }, (_, index) => ({
    from: at(`gone/m${index}`),
    to: at(`gone/n${index}`),
    device: '1',
    inode: String(index),
    prompts: 0,
    at: index,
  }));
  const entries = [{ path: at('old'), ...(await identify(at('old')))! }];
  await writeFile(
    at('state/directories.json'),
    JSON.stringify({ version: 1, entries, moves }),
  );
  await rename(at('old'), at('new'));
  const store = await StateStore.open(at('state'));
  const memory = await seededMemory(at('state/memory.git'));
  // each rewrite rechecks only the moves its own mapping followed
  const started = performance.now();
  const report = await repairMoves(store, memory, at('new'), {
    run: () => Promise.reject(new Error('not a repository')),
  });
  assert.ok(performance.now() - started < 3500);
  assert.deepEqual(report.blocked, []);
  const { records } = await store.records();
  assert.ok(records.every(({ cwd }) => cwd.startsWith(at('new/'))));
});
