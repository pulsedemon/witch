import assert from 'node:assert/strict';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { repairMoves } from '../../../src/core/repository/move-repair.js';
import { projectKey } from '../../../src/memory/memory.js';
import { identify } from '../../../src/persistence/directories.js';
import { StateStore } from '../../../src/persistence/store.js';
import { record } from '../../fixtures/coordinator.js';
import { scratch } from '../../fixtures/scratch.js';
import { seededMemory } from '../../fixtures/seeded-memory.js';

/**
 * runs the repair `prepare` sets up at a quarter of the input and then at all of it, and fails when the full input
 * costs more than 8 times the CPU: linear work costs about 4 times as much, quadratic work about 16. CPU time, unlike
 * the wall clock, barely grows on a loaded machine.
 */
async function linear<T>(
  prepare: (share: number) => Promise<() => Promise<T>>,
): Promise<T> {
  const measure = async (share: number) => {
    const repair = await prepare(share);
    const before = process.cpuUsage();
    const result = await repair();
    const { user, system } = process.cpuUsage(before);

    return { result, ms: (user + system) / 1000 };
  };

  const quarter = await measure(0.25);
  const full = await measure(1);

  assert.ok(
    full.ms < 8 * quarter.ms,
    `${full.ms} ms of CPU for the full input, ${quarter.ms} ms for a quarter`,
  );

  return full.result;
}

test('repair with many known directories and conversations stays linear', async () => {
  // checking every entry against every conversation is quadratic
  const report = await linear(async (share) => {
    const root = await scratch('witch-scale-');
    const at = (path: string) => join(root, path);

    for (let index = 0; index < 2000 * share; index++) {
      await mkdir(at(`state/conversations/c${index}`), { recursive: true });

      await writeFile(
        at(`state/conversations/c${index}/state.json`),
        JSON.stringify(record(`c${index}`, at(`saved/c${index}`))),
      );
    }

    const entries = Array.from({ length: 2000 * share }, (_, index) => ({
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

    return () =>
      repairMoves(store, memory, at('here'), {
        preview: true,
        run: () => Promise.reject(new Error('not a repository')),
      });
  });

  assert.deepEqual(report.blocked, []);
});

test('repairing many conversations past many unrelated moves stays linear', async () => {
  // each rewrite rechecks only the moves its own mapping followed
  const { report, store, at } = await linear(async (share) => {
    const root = await scratch('witch-scale-');
    const at = (path: string) => join(root, path);

    for (let index = 0; index < 100 * share; index++) {
      await mkdir(at(`old/c${index}`), { recursive: true });
      await mkdir(at(`state/conversations/c${index}`), { recursive: true });

      await writeFile(
        at(`state/conversations/c${index}/state.json`),
        JSON.stringify(record(`c${index}`, at(`old/c${index}`))),
      );
    }

    const moves = Array.from({ length: 10_000 * share }, (_, index) => ({
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

    return async () => ({
      report: await repairMoves(store, memory, at('new'), {
        run: () => Promise.reject(new Error('not a repository')),
      }),
      store,
      at,
    });
  });

  assert.deepEqual(report.blocked, []);
  const { records } = await store.records();
  assert.ok(records.every(({ cwd }) => cwd.startsWith(at('new/'))));
});

test('conversations moving to the same place look up its project scope once', async () => {
  const root = await scratch('witch-scale-');
  const at = (path: string) => join(root, path);
  await mkdir(at('old'));

  const session = {
    id: 'session',
    model: 'model',
    hasHistory: true,
    deliveredProject: projectKey(at('old')),
  };

  for (let index = 0; index < 3; index++) {
    await mkdir(at(`state/conversations/c${index}`), { recursive: true });

    await writeFile(
      at(`state/conversations/c${index}/state.json`),
      JSON.stringify({
        ...record(`c${index}`, at('old')),
        sessions: { codex: session },
      }),
    );
  }

  const entries = [{ path: at('old'), ...(await identify(at('old')))! }];

  await writeFile(
    at('state/directories.json'),
    JSON.stringify({ version: 1, entries, moves: [] }),
  );

  await rename(at('old'), at('new'));
  const store = await StateStore.open(at('state'));
  const memory = await seededMemory(at('state/memory.git'));
  const looked = vi.spyOn(memory, 'scopePaths');

  await repairMoves(store, memory, at('new'), {
    run: () => Promise.reject(new Error('not a repository')),
  });

  assert.equal(
    looked.mock.calls.filter(([path]) => path === at('new')).length,
    1,
  );
});

test('previewing many moved conversations beside many known directories stays linear', async () => {
  // a preview skips the rewrites, so the per-conversation destination lookup dominates
  const report = await linear(async (share) => {
    const root = await scratch('witch-scale-');
    const at = (path: string) => join(root, path);

    for (let index = 0; index < 4000 * share; index++) {
      await mkdir(at(`old/c${index}`), { recursive: true });
      await mkdir(at(`state/conversations/c${index}`), { recursive: true });

      await writeFile(
        at(`state/conversations/c${index}/state.json`),
        JSON.stringify(record(`c${index}`, at(`old/c${index}`))),
      );
    }

    const unrelated = Array.from({ length: 50_000 * share }, (_, index) => ({
      path: at(`known/e${index}`),
      device: '1',
      inode: String(index),
    }));

    const entries = [
      { path: at('old'), ...(await identify(at('old')))! },
      ...unrelated,
    ];

    await writeFile(
      at('state/directories.json'),
      JSON.stringify({ version: 1, entries, moves: [] }),
    );

    await rename(at('old'), at('new'));
    const store = await StateStore.open(at('state'));
    const memory = await seededMemory(at('state/memory.git'));

    return () =>
      repairMoves(store, memory, at('new'), {
        preview: true,
        run: () => Promise.reject(new Error('not a repository')),
      });
  });

  assert.equal(report.repaired[0]?.conversations, 4000);
});
