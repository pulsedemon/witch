import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import type * as Directories from '../../src/persistence/directories.js';
import { StateStore } from '../../src/persistence/store.js';
import { scratch } from '../fixtures/scratch.js';

// counts what mapping prompts costs once the mapper is built: map calls, moves read and elements filtered
const counts = vi.hoisted(() => ({ maps: 0, reads: 0, filtered: 0 }));

vi.mock('../../src/persistence/directories.js', async (importOriginal) => {
  const original = await importOriginal<typeof Directories>();

  return {
    ...original,
    mapper: (async (ledger) => {
      const mapping = await original.mapper({
        ...ledger,
        moves: new Proxy(ledger.moves, {
          get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) counts.reads++;

            return Reflect.get(target, key, receiver) as unknown;
          },
        }),
      });

      counts.reads = 0;
      counts.filtered = 0;

      return {
        ...mapping,
        map: (...args: Parameters<typeof mapping.map>) => {
          counts.maps++;

          return mapping.map(...args);
        },
      };
    }) satisfies typeof original.mapper,
  };
});

/** runs `run` while adding to `counts.filtered` the length of every array filtered. */
async function filtering<T>(run: () => Promise<T>): Promise<T> {
  const filter = Array.prototype.filter;

  const spy = vi.spyOn(Array.prototype, 'filter').mockImplementation(function (
    this: unknown[],
    ...args
  ) {
    counts.filtered += this.length;

    return filter.apply(this, args);
  });

  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}

/** a state directory whose prompt history and ledger each test writes whole. */
async function state() {
  const root = await scratch('witch-prompts-');
  const at = (path: string) => join(root, path);

  return { at, store: await StateStore.open(at('state')) };
}

test('prompt history maps a long move chain once per directory, not once per prompt', async () => {
  const f = await state();

  const paths = Array.from({ length: 51 }, (_, index) =>
    f.at(`chain/${index}`),
  );

  const lines = `${JSON.stringify({ cwd: paths[0], text: 'p' })}\n`.repeat(
    1000,
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

  counts.maps = 0;
  assert.equal((await f.store.prompts(paths[50]!)).length, 1000);
  // every prompt was sent from one directory before every move, so one mapping serves them all
  assert.equal(counts.maps, 1);
});

test('prompt history from every stop of a long move chain maps each stop once', async () => {
  const f = await state();

  const paths = Array.from({ length: 801 }, (_, index) =>
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

  assert.equal((await f.store.prompts(paths[800]!)).length, 801);
  // replaying the rest of the chain for every stop reads moves quadratically
  assert.ok(counts.reads < 24_000, String(counts.reads));
});

test("prompt history from many directories under a long-moved parent looks up each hop's move by its source", async () => {
  const f = await state();

  const parents = Array.from({ length: 201 }, (_, index) =>
    f.at(`moved/${index}`),
  );

  let content = '';

  for (let index = 0; index < 50; index++)
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

  assert.deepEqual(await f.store.prompts(`${parents[200]}/sub-7`), ['7']);
  // scanning every move at every hop multiplies each hop by the ledger's length
  assert.ok(counts.reads < 101_000, String(counts.reads));
});

test("prompt history under a parent moved back and forth finds each hop's move without filtering its source's moves", async () => {
  const f = await state();

  const [x, y, z] = ['x', 'y', 'z'].map((name) => f.at(`swing/${name}`)) as [
    string,
    string,
    string,
  ];

  let content = '';

  for (let index = 0; index < 10; index++)
    content += `${JSON.stringify({ cwd: `${x}/sub-${index}`, text: String(index) })}\n`;

  const size = Buffer.byteLength(content);

  const moves = Array.from({ length: 200 }, (_, index) => ({
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
    at: 200,
  });

  await writeFile(f.at('state/prompts.jsonl'), content);

  await writeFile(
    f.at('state/directories.json'),
    JSON.stringify({ version: 1, entries: [], moves }),
  );

  assert.deepEqual(await filtering(() => f.store.prompts(`${z}/sub-7`)), ['7']);
  // filtering a source's every move at every hop multiplies each hop by the swings
  assert.ok(counts.filtered < 1000, String(counts.filtered));
});

test('prompt history past many unrelated moves never refilters the move boundaries per line', async () => {
  const f = await state();
  const line = `${JSON.stringify({ cwd: f.at('here'), text: 'p' })}\n`;
  const content = line.repeat(20_000);
  await writeFile(f.at('state/prompts.jsonl'), content);

  await writeFile(
    f.at('state/directories.json'),
    JSON.stringify({
      version: 1,
      entries: [],
      moves: Array.from({ length: 800 }, (_, index) => ({
        from: f.at(`elsewhere/${index}`),
        to: f.at(`moved/${index}`),
        device: '1',
        inode: String(index),
        prompts: (index + 1) * line.length * 20,
        at: index,
      })),
    }),
  );

  assert.equal(
    (await filtering(() => f.store.prompts(f.at('here')))).length,
    20_000,
  );

  // counting the boundaries a line has passed by filtering them all multiplies each line by the moves
  assert.ok(counts.filtered < 1000, String(counts.filtered));
});
