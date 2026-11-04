import assert from 'node:assert/strict';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { repairMoves } from '../src/core/move-repair.js';
import type * as Json from '../src/persistence/json.js';
import { StateStore } from '../src/persistence/store.js';
import { record } from './fixtures/coordinator.js';
import { scratch } from './fixtures/scratch.js';
import { seededMemory } from './fixtures/seeded-memory.js';

const fileWrites = vi.hoisted(() => ({
  before: undefined as ((file: string) => void) | undefined,
}));
vi.mock('../src/persistence/json.js', async (importOriginal) => {
  const original = await importOriginal<typeof Json>();
  return {
    ...original,
    replaceFile: (async (file, ...rest) => {
      fileWrites.before?.(file);
      return original.replaceFile(file, ...rest);
    }) satisfies typeof original.replaceFile,
  };
});

for (const stop of ['before', 'after'] as const)
  for (const again of [true, false])
    test(`a repair stopped ${stop} its history write finishes at the next start${again ? ' after another move' : ''}`, async () => {
      const root = await scratch('witch-interrupted-');
      const at = (path: string) => join(root, path);
      for (const path of ['a', 'tools']) await mkdir(at(path));
      const store = await StateStore.open(at('state'));
      const memory = await seededMemory(at('state/memory.git'));
      const repair = (cwd: string) => repairMoves(store, memory, at(cwd));
      const files = await store.create(record('a', at('a')));
      await files.append({ id: 'own', kind: 'user', cwd: at('a'), text: 'hi' });
      await files.append({
        id: 'ran',
        kind: 'tool',
        cwd: at('tools'),
        text: '',
      });
      await files.close();
      await repair('a');

      await rename(at('a'), at('b'));
      let written = false;
      fileWrites.before = (file) => {
        if (file.endsWith('history.jsonl')) {
          if (stop === 'before') throw new Error('stopped');
          written = true;
        } else if (written && file.endsWith('state.json'))
          throw new Error('stopped');
      };
      try {
        const stopped = await repair('b');
        assert.ok(stopped.blocked.some(({ reason }) => /stopped/.test(reason)));
      } finally {
        fileWrites.before = undefined;
      }
      const final = again ? 'c' : 'b';
      if (again) await rename(at('b'), at('c'));
      await repair(final);

      const directory = at('state/conversations/a');
      const saved = JSON.parse(
        await readFile(join(directory, 'state.json'), 'utf8'),
      ) as Record<string, unknown>;
      assert.equal(saved.cwd, at(final));
      assert.equal(saved.historyCwd, undefined);
      const rows = (await readFile(join(directory, 'history.jsonl'), 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as { id: string; cwd: string });
      assert.deepEqual(
        rows.map(({ id, cwd }) => [id, cwd]),
        [
          ['own', at(final)],
          ['ran', at('tools')],
        ],
      );
    });
