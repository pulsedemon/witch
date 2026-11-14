import assert from 'node:assert/strict';

import { mkdir, readFile, rename, rm } from 'node:fs/promises';

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
 * a conversation in `home`, with a row there and `rows` elsewhere and its project delivered there, whose repair of `move`
 * to `away` stopped `stop` its history write.
 */
async function stopped(
  stop: 'before' | 'after',
  rows: Array<[id: string, path: string]>,
  {
    home = 'a',
    away = 'b',
    move = (at: (path: string) => string) => rename(at(home), at(away)),
  } = {},
) {
  const root = await scratch('witch-interrupted-');

  const at = (path: string) => join(root, path);

  await mkdir(at(home), { recursive: true });

  const store = await StateStore.open(at('state'));

  const memory = await seededMemory(at('state/memory.git'));

  const repair = (cwd: string) => repairMoves(store, memory, at(cwd));

  const files = await store.create({
    ...record('a', at(home)),
    sessions: {
      a: {
        id: 'n',
        model: 'm',
        hasHistory: true,
        deliveredProject: projectKey(at(home)),
      },
    },
  });

  await files.append({ id: 'own', kind: 'user', cwd: at(home), text: 'hi' });

  for (const [id, path] of rows)
    await files.append({ id, kind: 'tool', cwd: at(path), text: '' });

  await files.close();

  await repair(home);

  await move(at);

  let written = false;

  fileWrites.before = (file) => {
    if (file.endsWith('history.jsonl')) {
      if (stop === 'before') throw new Error('stopped');

      written = true;
    } else if (written && file.endsWith('state.json'))
      throw new Error('stopped');
  };

  try {
    const report = await repair(away);

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

  return { at, store, repair, saved };
}

for (const stop of ['before', 'after'] as const)
  for (const again of [true, false])
    test(`a repair stopped ${stop} its history write finishes at the next start${again ? ' after another move' : ''}`, async () => {
      const { at, repair, saved } = await stopped(stop, [['ran', 'tools']]);

      const final = again ? 'c' : 'b';

      if (again) await rename(at('b'), at('c'));

      await repair(final);

      const { record, rows } = await saved();

      assert.equal(record.cwd, at(final));

      assert.equal(record.historyMove, undefined);

      assert.deepEqual(rows, [
        ['own', at(final)],
        ['ran', at('tools')],
      ]);
    });

test('a repair stopped before its history write leaves a tool row at the path it moved to when the directory moves back', async () => {
  const { at, repair, saved } = await stopped('before', [['ran', 'b']]);

  await rename(at('b'), at('a'));

  await repair('a');

  const { record, rows } = await saved();

  assert.equal(record.cwd, at('a'));

  assert.equal(record.historyMove, undefined);

  assert.deepEqual(rows, [
    ['own', at('a')],
    ['ran', at('b')],
  ]);
});

test('a conversation opened before its stopped repair finishes keeps its new rows with its own', async () => {
  const { at, store, repair, saved } = await stopped('before', [
    ['ran', 'tools'],
  ]);

  const files = await store.claim('a');

  await files.append({ id: 'later', kind: 'user', cwd: at('b'), text: 'hi' });

  await files.close();

  await rename(at('b'), at('c'));

  await repair('c');

  const { record, rows } = await saved();

  assert.equal(record.cwd, at('c'));

  assert.equal(record.historyMove, undefined);

  assert.deepEqual(rows, [
    ['own', at('c')],
    ['ran', at('tools')],
    ['later', at('c')],
  ]);
});

for (const finish of ['the next repair', 'opening the conversation'])
  test(`a repair stopped after its history write into an ancestor moves each row once when ${finish} finishes it`, async () => {
    const { at, store, repair, saved } = await stopped(
      'after',
      [['sub', 'p/child/child']],
      {
        home: 'p/child',
        away: 'p',
        move: async (at) => {
          await rename(at('p/child'), at('x'));

          await rm(at('p'), { recursive: true });

          await rename(at('x'), at('p'));
        },
      },
    );

    if (finish === 'the next repair') await repair('p');
    else await (await store.claim('a')).close();

    const { record, rows } = await saved();

    assert.equal(record.cwd, at('p'));

    assert.equal(record.historyMove, undefined);

    assert.deepEqual(rows, [
      ['own', at('p')],
      ['sub', at('p/child')],
    ]);
  });
