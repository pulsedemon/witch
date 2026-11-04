import assert from 'node:assert/strict';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { repairMoves } from '../src/core/move-repair.js';
import { projectKey } from '../src/memory/memory.js';
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

/**
 * a conversation in `a`, with its project delivered there and a tool row at `tool`, whose repair of the move from `a` to
 * `b` stopped `stop` its history write.
 */
async function stopped(stop: 'before' | 'after', tool: string) {
  const root = await scratch('witch-interrupted-');
  const at = (path: string) => join(root, path);
  await mkdir(at('a'));
  const store = await StateStore.open(at('state'));
  const memory = await seededMemory(at('state/memory.git'));
  const repair = (cwd: string) => repairMoves(store, memory, at(cwd));
  const files = await store.create({
    ...record('a', at('a')),
    sessions: {
      a: {
        id: 'n',
        model: 'm',
        hasHistory: true,
        deliveredProject: projectKey(at('a')),
      },
    },
  });
  await files.append({ id: 'own', kind: 'user', cwd: at('a'), text: 'hi' });
  await files.append({ id: 'ran', kind: 'tool', cwd: at(tool), text: '' });
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
    const report = await repair('b');
    assert.ok(report.blocked.some(({ reason }) => /stopped/.test(reason)));
  } finally {
    fileWrites.before = undefined;
  }

  const directory = at('state/conversations/a');
  const saved = async () => ({
    record: JSON.parse(
      await readFile(join(directory, 'state.json'), 'utf8'),
    ) as Record<string, unknown>,
    rows: (await readFile(join(directory, 'history.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => {
        const { id, cwd } = JSON.parse(line) as { id: string; cwd: string };
        return [id, cwd];
      }),
  });
  return { at, repair, saved };
}

for (const stop of ['before', 'after'] as const)
  for (const again of [true, false])
    test(`a repair stopped ${stop} its history write finishes at the next start${again ? ' after another move' : ''}`, async () => {
      const { at, repair, saved } = await stopped(stop, 'tools');
      const final = again ? 'c' : 'b';
      if (again) await rename(at('b'), at('c'));
      await repair(final);
      const { record, rows } = await saved();
      assert.equal(record.cwd, at(final));
      assert.equal(record.historyCwd, undefined);
      assert.deepEqual(rows, [
        ['own', at(final)],
        ['ran', at('tools')],
      ]);
    });

test('a repair stopped before its history write leaves a tool row at its destination when the directory moves back', async () => {
  const { at, repair, saved } = await stopped('before', 'b');
  await rename(at('b'), at('a'));
  await repair('a');
  const { record, rows } = await saved();
  assert.equal(record.cwd, at('a'));
  assert.equal(record.historyCwd, undefined);
  assert.deepEqual(rows, [
    ['own', at('a')],
    ['ran', at('b')],
  ]);
});
