import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';
import {
  findMoves,
  identify,
  mapper,
  readLedger,
  resolve,
  updateLedger,
} from '../src/persistence/directories.js';
import type {
  DirectoryEntry,
  Ledger,
  LedgerMove,
} from '../src/persistence/directories.js';
import { scratch } from './fixtures/scratch.js';

const execute = promisify(execFile);
const ledgerModule = fileURLToPath(
  new URL('../src/persistence/directories.ts', import.meta.url),
);
const darwin = process.platform === 'darwin';

async function directories(...paths: string[]) {
  const root = await scratch('witch-directories-');
  for (const path of paths) await mkdir(join(root, path), { recursive: true });
  const at = (path: string) => join(root, path);
  const entry = async (path: string, extra: Partial<DirectoryEntry> = {}) => ({
    path: at(path),
    ...(await identify(at(path)))!,
    ...extra,
  });
  const move = async (from: string, to: string): Promise<LedgerMove> => ({
    from: at(from),
    to: at(to),
    ...(await identify(at(to)))!,
    prompts: 0,
    at: 0,
  });
  const moved = (moves: Array<{ from: string; to: string }>) =>
    moves.map(({ from, to }) => [from, to]);
  return { root, at, entry, move, moved };
}

test('mapper maps a path and its descendants at a boundary only', async () => {
  const f = await directories('c/main');
  const { map } = await mapper({
    entries: [],
    moves: [await f.move('w/main', 'c/main')],
  });
  assert.equal(map(f.at('w/main')), f.at('c/main'));
  assert.equal(map(f.at('w/main/src')), f.at('c/main/src'));
  for (const path of ['w/main-1', 'w/main copy', 'w/main.git', 'x/w/main'])
    assert.equal(map(f.at(path)), f.at(path));
});

test('mapper applies the most specific move', async () => {
  const f = await directories('b', 'e', 'c');
  const nested = await mapper({
    entries: [],
    moves: [await f.move('a', 'b'), await f.move('a/sub', 'e')],
  });
  assert.equal(nested.map(f.at('a/sub/x')), f.at('e/x'));
  assert.equal(nested.map(f.at('a/y')), f.at('b/y'));
  const chained = await mapper({
    entries: [],
    moves: [await f.move('a', 'b'), await f.move('b/x', 'c')],
  });
  assert.equal(chained.map(f.at('a/x/f')), f.at('c/f'));
});

test('mapper follows a directory moved back and forth', async () => {
  const f = await directories('a');
  const there = await f.move('a', 'a');
  const ledger: Ledger = {
    entries: [],
    moves: [
      { ...there, from: f.at('a'), to: f.at('b') },
      { ...there, from: f.at('b'), to: f.at('a') },
    ],
  };
  assert.equal((await mapper(ledger)).map(f.at('b/x')), f.at('a/x'));
  await rename(f.at('a'), f.at('b'));
  await resolve(ledger, [{ ...there, from: f.at('a'), to: f.at('b') }], 0);
  assert.equal(ledger.moves.length, 3);
  assert.equal((await mapper(ledger)).map(f.at('a/x')), f.at('b/x'));
});

test('mapper never carries a replaced child', async () => {
  const f = await directories('old/nested', 'x', 'spare');
  const ledger: Ledger = {
    entries: [await f.entry('old'), await f.entry('old/nested')],
    moves: [],
  };
  await rename(f.at('old/nested'), f.at('x/nested'));
  await rename(f.at('spare'), f.at('old/nested'));
  await rename(f.at('old'), f.at('new'));
  await resolve(ledger, await findMoves(ledger.entries, [f.at('new')]), 0);
  const { map } = await mapper(ledger);
  assert.equal(map(f.at('old/g')), f.at('new/g'));
  // macOS finds the child by its identity; elsewhere it stays unresolved
  assert.equal(
    map(f.at('old/nested/f')),
    darwin ? f.at('x/nested/f') : undefined,
  );
});

test('mapper suspends a reused chain', async () => {
  const f = await directories('c', 'spare');
  const ledger: Ledger = {
    entries: [],
    moves: [await f.move('a', 'c'), await f.move('b', 'c')],
  };
  ledger.moves[0] = { ...ledger.moves[0]!, to: f.at('b') };
  await rename(f.at('spare'), f.at('b'));
  const reused = await mapper(ledger);
  assert.equal(reused.map(f.at('a')), undefined);
  assert.deepEqual(f.moved(reused.suspended), [[f.at('b'), f.at('c')]]);
  await rename(f.at('b'), f.at('spare'));
  assert.equal((await mapper(ledger)).map(f.at('a')), f.at('c'));
});

test('mapper maps prompts written before a move even after its path is reused', async () => {
  const f = await directories('c', 'spare');
  const move = { ...(await f.move('a', 'c')), prompts: 100 };
  await rename(f.at('spare'), f.at('a'));
  const { map } = await mapper({ entries: [], moves: [move] });
  const written = (offset: number) => ({
    predates: (known: LedgerMove) => offset < known.prompts,
    throughReused: true,
  });
  assert.equal(map(f.at('a'), written(99)), f.at('c'));
  // written there after the move, it belongs to the directory there now
  assert.equal(map(f.at('a'), written(100)), f.at('a'));
  assert.equal(map(f.at('a')), undefined);
});

test.skipIf(!darwin)(
  'findMoves finds a directory moved anywhere on its volume',
  async () => {
    const f = await directories('w/main', 'w/main-1', 'x/deep');
    const entries = [await f.entry('w/main'), await f.entry('w/main-1')];
    await rename(f.at('w/main'), f.at('c'));
    await rename(f.at('w/main-1'), f.at('x/deep/far'));
    assert.deepEqual(f.moved(await findMoves(entries, [])), [
      [f.at('w/main'), f.at('c')],
      [f.at('w/main-1'), f.at('x/deep/far')],
    ]);
  },
);

test('findMoves resolves a seed by identity and its siblings', async () => {
  const f = await directories('w/main', 'w/main-1');
  const entries = [
    await f.entry('w/main', { main: f.at('w/main') }),
    await f.entry('w/main-1', { main: f.at('w/main') }),
  ];
  await rename(f.at('w'), f.at('c'));
  assert.deepEqual(f.moved(await findMoves(entries, [f.at('c/main')])), [
    [f.at('w/main'), f.at('c/main')],
    [f.at('w/main-1'), f.at('c/main-1')],
  ]);
});

test('findMoves infers siblings of a renamed main checkout', async () => {
  const f = await directories('w/main', 'w/main-1', 'c');
  const entries = [await f.entry('w/main'), await f.entry('w/main-1')];
  await rename(f.at('w/main'), f.at('c/other'));
  await rename(f.at('w/main-1'), f.at('c/other-1'));
  assert.deepEqual(f.moved(await findMoves(entries, [f.at('c/other')])), [
    [f.at('w/main'), f.at('c/other')],
    [f.at('w/main-1'), f.at('c/other-1')],
  ]);
});

test('findMoves never matches a different directory at a candidate path', async () => {
  const f = await directories('w/main', 'w/main-1', 'x', 'c', 'spare');
  const entries = [await f.entry('w/main'), await f.entry('w/main-1')];
  await rename(f.at('w/main'), f.at('c/main'));
  await rename(f.at('w/main-1'), f.at('x/far'));
  await rename(f.at('spare'), f.at('c/main-1'));
  assert.deepEqual(f.moved(await findMoves(entries, [f.at('c/main')])), [
    [f.at('w/main'), f.at('c/main')],
    ...(darwin ? [[f.at('w/main-1'), f.at('x/far')]] : []),
  ]);
});

test('findMoves gives one move per moved root', async () => {
  const f = await directories('w/main/sub', 'w/main-1');
  const entries = [
    await f.entry('w/main'),
    await f.entry('w/main/sub'),
    await f.entry('w/main-1'),
  ];
  await rename(f.at('w'), f.at('c'));
  assert.deepEqual(f.moved(await findMoves(entries, [f.at('c/main')])), [
    [f.at('w/main'), f.at('c/main')],
    [f.at('w/main-1'), f.at('c/main-1')],
  ]);
});

test('resolve updates entries once', async () => {
  const f = await directories('w/main', 'w/main-1');
  const ledger: Ledger = {
    entries: [
      await f.entry('w/main', { main: f.at('w/main') }),
      await f.entry('w/main-1', { main: f.at('w/main'), slot: 1 }),
    ],
    moves: [],
  };
  await rename(f.at('w'), f.at('c'));
  const seeds = [f.at('c/main')];
  await resolve(ledger, await findMoves(ledger.entries, seeds), 7);
  assert.deepEqual(
    ledger.entries.map(({ path, main, slot }) => [path, main, slot]),
    [
      [f.at('c/main'), f.at('c/main'), undefined],
      [f.at('c/main-1'), f.at('c/main'), 1],
    ],
  );
  assert.deepEqual(
    ledger.moves.map(({ prompts }) => prompts),
    [7, 7],
  );
  assert.deepEqual(await findMoves(ledger.entries, seeds), []);
  await resolve(ledger, await findMoves(ledger.entries, seeds), 8);
  assert.equal(ledger.moves.length, 2);
});

test('updateLedger serializes writers across processes', async () => {
  const root = await scratch('witch-ledger-');
  const writer = (name: string) =>
    execute(process.execPath, [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      `import { updateLedger } from ${JSON.stringify(ledgerModule)};
for (let index = 0; index < 20; index++)
  await updateLedger(${JSON.stringify(root)}, async (ledger) => {
    ledger.moves.push({ from: '/${name}', to: '/' + index, device: '1', inode: '1', prompts: 0, at: 0 });
  });`,
    ]);
  await Promise.all([writer('a'), writer('b')]);
  const { moves } = await readLedger(root);
  assert.equal(moves.length, 40);
  await updateLedger(root, async () => {});
  assert.equal((await readLedger(root)).moves.length, 40);
});
