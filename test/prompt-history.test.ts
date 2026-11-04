import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { StateStore } from '../src/persistence/store.js';
import { scratch } from './fixtures/scratch.js';

/** a state directory whose prompt history and ledger each test writes whole. */
async function state() {
  const root = await scratch('witch-prompts-');
  const at = (path: string) => join(root, path);
  return { at, store: await StateStore.open(at('state')) };
}

test('prompt history maps a long move chain once per directory, not once per prompt', async () => {
  const f = await state();
  const paths = Array.from({ length: 201 }, (_, index) =>
    f.at(`chain/${index}`),
  );
  const lines = `${JSON.stringify({ cwd: paths[0], text: 'p' })}\n`.repeat(
    10_000,
  );
  await writeFile(f.at('state/prompts.jsonl'), lines);
  await writeFile(
    f.at('state/directories.json'),
    JSON.stringify({
      version: 1,
      entries: [],
      moves: paths.slice(1).map((to, index) => ({
        from: paths[index],
        to,
        device: '1',
        inode: String(index),
        prompts: lines.length,
        at: index,
      })),
    }),
  );
  // linear work takes milliseconds here; replaying the chain for every prompt took seconds
  const started = performance.now();
  assert.equal((await f.store.prompts(paths[200]!)).length, 10_000);
  assert.ok(performance.now() - started < 1000);
});

test('prompt history from every stop of a long move chain maps each stop once', async () => {
  const f = await state();
  const paths = Array.from({ length: 1201 }, (_, index) =>
    f.at(`chain/${index}`),
  );
  let content = '';
  const moves = [];
  for (const [index, path] of paths.entries()) {
    content += `${JSON.stringify({ cwd: path, text: String(index) })}\n`;
    const to = paths[index + 1];
    if (to)
      moves.push({
        from: path,
        to,
        device: '1',
        inode: String(index),
        prompts: Buffer.byteLength(content),
        at: index,
      });
  }
  await writeFile(f.at('state/prompts.jsonl'), content);
  await writeFile(
    f.at('state/directories.json'),
    JSON.stringify({ version: 1, entries: [], moves }),
  );
  // each stop's chain is followed once; replaying the rest of the chain for every prompt took seconds
  const started = performance.now();
  assert.equal((await f.store.prompts(paths[1200]!)).length, 1201);
  assert.ok(performance.now() - started < 1000);
});

test('prompt history from many directories under a long-moved parent stays fast', async () => {
  const f = await state();
  const parents = Array.from({ length: 401 }, (_, index) =>
    f.at(`moved/${index}`),
  );
  let content = '';
  for (let index = 0; index < 400; index++)
    content += `${JSON.stringify({ cwd: `${parents[0]}/sub-${index}`, text: String(index) })}\n`;
  await writeFile(f.at('state/prompts.jsonl'), content);
  await writeFile(
    f.at('state/directories.json'),
    JSON.stringify({
      version: 1,
      entries: [],
      moves: parents.slice(1).map((to, index) => ({
        from: parents[index],
        to,
        device: '1',
        inode: String(index),
        prompts: Buffer.byteLength(content),
        at: index,
      })),
    }),
  );
  // each hop looks up its own path and parents; scanning every move at every hop took many seconds
  const started = performance.now();
  assert.deepEqual(await f.store.prompts(`${parents[400]}/sub-7`), ['7']);
  assert.ok(performance.now() - started < 1000);
});

test('prompt history under a parent moved back and forth many times stays fast', async () => {
  const f = await state();
  const [x, y, z] = ['x', 'y', 'z'].map((name) => f.at(`swing/${name}`)) as [
    string,
    string,
    string,
  ];
  let content = '';
  for (let index = 0; index < 200; index++)
    content += `${JSON.stringify({ cwd: `${x}/sub-${index}`, text: String(index) })}\n`;
  const size = Buffer.byteLength(content);
  const moves = Array.from({ length: 2000 }, (_, index) => ({
    from: index % 2 ? y : x,
    to: index % 2 ? x : y,
    device: '1',
    inode: '1',
    prompts: size,
    at: index,
  }));
  moves.push({
    from: x,
    to: z,
    device: '1',
    inode: '1',
    prompts: size,
    at: 2000,
  });
  await writeFile(f.at('state/prompts.jsonl'), content);
  await writeFile(
    f.at('state/directories.json'),
    JSON.stringify({ version: 1, entries: [], moves }),
  );
  // each hop finds its next move by binary search; filtering every move from the same path took seconds
  const started = performance.now();
  assert.deepEqual(await f.store.prompts(`${z}/sub-7`), ['7']);
  assert.ok(performance.now() - started < 1000);
});
