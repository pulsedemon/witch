import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { chmod, mkdir, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';
import {
  adoptIdentity,
  findMoves,
  formerPaths,
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

test('a move recorded while the clock reads behind the last one is dated after it', async () => {
  const f = await directories('a');
  const ahead = Date.now() + 60_000;
  const ledger: Ledger = {
    entries: [],
    moves: [{ ...(await f.move('a', 'b')), at: ahead }],
  };
  await resolve(ledger, [await f.move('b', 'c')], 0);
  assert.equal(ledger.moves[1]?.at, ahead + 1);
});

test('rechecking a mapping looks only at the known directories holding its path', async () => {
  const f = await directories('a');
  const ledger: Ledger = {
    entries: Array.from({ length: 50_000 }, (_, index) => ({
      path: f.at(`known/e${index}`),
      device: '1',
      inode: String(index),
    })),
    moves: [],
  };
  const mapping = await mapper(ledger);
  // scanning every entry for each recheck takes seconds here
  const started = performance.now();
  for (let index = 0; index < 2000; index++)
    assert.equal(await mapping.unchanged(f.at(`a/c${index}`)), true);
  assert.ok(performance.now() - started < 500);
});

test('resolving a move beside many known directories looks only at the ones it carries', async () => {
  const f = await directories('b');
  const ledger: Ledger = {
    entries: Array.from({ length: 100_000 }, (_, index) => ({
      path: f.at(`known/e${index}`),
      device: '1',
      inode: String(index),
    })),
    moves: [],
  };
  // checking every entry's membership before its path takes a second here
  const started = performance.now();
  await resolve(ledger, [await f.move('a', 'b')], 0);
  assert.ok(performance.now() - started < 300);
  assert.equal(ledger.entries.length, 100_000);
});

test('resolving a move relocates the directories it carries in one pass over the ledger', async () => {
  const f = await directories();
  const entries: DirectoryEntry[] = [];
  for (let index = 0; index < 200; index++) {
    await mkdir(f.at(`b/c${index}`), { recursive: true });
    entries.push({
      ...(await f.entry(`b/c${index}`)),
      path: f.at(`a/c${index}`),
    });
  }
  let reads = 0;
  const ledger = new Proxy<Ledger>(
    { entries, moves: [] },
    {
      get(target, key, receiver) {
        if (key === 'entries') reads++;
        return Reflect.get(target, key, receiver) as unknown;
      },
    },
  );
  await resolve(ledger, [await f.move('a', 'b')], 0);
  assert.equal(ledger.entries[199]?.path, f.at('b/c199'));
  // reading every entry again for each carried directory made large moves quadratic
  assert.ok(reads < 20, String(reads));
});

test('resolving many moves at once reads the ledger a fixed number of times', async () => {
  const f = await directories();
  const entries: DirectoryEntry[] = [];
  for (let index = 0; index < 300; index++) {
    await mkdir(f.at(`b/c${index}`), { recursive: true });
    entries.push({
      ...(await f.entry(`b/c${index}`, { main: f.at(`a/c${index}`) })),
      path: f.at(`a/c${index}`),
    });
  }
  const moves = entries.map(({ path, device, inode }) => ({
    from: path,
    to: path.replace(f.at('a'), f.at('b')),
    device,
    inode,
  }));
  let reads = 0;
  const counted = <T extends object>(items: T[]) =>
    new Proxy(items, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
  const ledger: Ledger = { entries: counted(entries), moves: counted([]) };
  await resolve(ledger, moves, 0);
  // scanning the entries and the moves for each move made a parent holding thousands of known directories take seconds
  assert.ok(reads < 4 * moves.length, String(reads));
  assert.deepEqual(
    ledger.entries.map(({ path, main }) => [path, main]),
    moves.map(({ to }) => [to, to]),
  );
  assert.deepEqual(
    ledger.moves.map(({ from, to }) => [from, to]),
    moves.map(({ from, to }) => [from, to]),
  );
});

test("formerPaths follows a directory back through its own and its parents' moves, but not past a path another directory took", async () => {
  const f = await directories('v/p');
  const ledger: Ledger = {
    entries: [],
    moves: [
      { ...(await f.move('p', 'v/p')), to: f.at('w/p') },
      await f.move('w', 'v'),
    ],
  };
  assert.deepEqual(await formerPaths(ledger, f.at('v/p')), [
    f.at('w/p'),
    f.at('p'),
  ]);
  await mkdir(f.at('p'));
  assert.deepEqual(await formerPaths(ledger, f.at('v/p')), [f.at('w/p')]);
});

test('formerPaths gives one path per move a directory took when a parent was renamed before it', async () => {
  const f = await directories('b/d');
  const ledger: Ledger = {
    entries: [],
    moves: [await f.move('a', 'b'), await f.move('b/c', 'b/d')],
  };
  assert.deepEqual(await formerPaths(ledger, f.at('b/d')), [
    f.at('b/c'),
    f.at('a/c'),
  ]);
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

test('findMoves follows a renamed parent of many known directories with one lookup by identity', async () => {
  const names = Array.from(
    { length: 300 },
    (_, index) => `r${String(index).padStart(3, '0')}`,
  );
  const f = await directories(...names.map((name) => `w/${name}`));
  const entries = await Promise.all(names.map((name) => f.entry(`w/${name}`)));
  await rename(f.at('w'), f.at('c'));
  let spawns = 0;
  const spawned = () => spawns++;
  subscribe('child_process', spawned);
  try {
    assert.deepEqual(
      f.moved(await findMoves(entries, [])),
      names.map((name) => [f.at(`w/${name}`), f.at(`c/${name}`)]),
    );
  } finally {
    unsubscribe('child_process', spawned);
  }
  // a shell for each entry made a renamed folder of thousands of checkouts take most of a minute
  assert.ok(spawns <= 1, String(spawns));
});

test('findMoves records where a sibling really is, not a link or a differently cased name to it', async () => {
  const f = await directories('w/main', 'w/linked', 'w/cased', 'far');
  const entries = [
    await f.entry('w/main'),
    await f.entry('w/linked'),
    await f.entry('w/cased'),
  ];
  await rename(f.at('w'), f.at('c'));
  await rename(f.at('c/linked'), f.at('far/linked'));
  await symlink(f.at('far/linked'), f.at('c/linked'));
  await rename(f.at('c/cased'), f.at('c/Cased'));
  assert.deepEqual(f.moved(await findMoves(entries, [f.at('c/main')])), [
    [f.at('w/main'), f.at('c/main')],
    ...(darwin ? [[f.at('w/cased'), f.at('c/Cased')]] : []),
    [f.at('w/linked'), f.at('far/linked')],
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

test.skipIf(!darwin)(
  'adoptIdentity keeps a recorded directory that still exists elsewhere and takes in one that is gone',
  async () => {
    const f = await directories('a', 'gone');
    const moved = { path: f.at('a'), ...(await identify(f.at('a')))! };
    const deleted = { path: f.at('gone'), ...(await identify(f.at('gone')))! };
    await rename(f.at('a'), f.at('b'));
    await mkdir(f.at('a'));
    await mkdir(f.at('replacement'));
    await rm(f.at('gone'), { recursive: true });
    await rename(f.at('replacement'), f.at('gone'));
    const before = { ...moved };
    assert.equal(
      await adoptIdentity(moved, (await identify(f.at('a')))!),
      false,
    );
    assert.deepEqual(moved, before);
    const now = (await identify(f.at('gone')))!;
    assert.equal(await adoptIdentity(deleted, now), true);
    assert.equal(deleted.inode, now.inode);
  },
);

test("a moved entry that takes a stale entry's path keeps its own repository and no slot", async () => {
  const f = await directories('one', 'two', 'two-1');
  const ledger: Ledger = {
    entries: [
      await f.entry('one', { main: f.at('one') }),
      await f.entry('two', { main: f.at('two') }),
      await f.entry('two-1', { main: f.at('two'), slot: 1 }),
    ],
    moves: [],
  };
  await rm(f.at('two-1'), { recursive: true });
  const move = await f.move('one', 'two-1');
  await rename(f.at('one'), f.at('two-1'));
  await resolve(ledger, [{ ...move, ...(await identify(f.at('two-1')))! }], 0);
  const at = ledger.entries.filter(({ path }) => path === f.at('two-1'));
  assert.deepEqual(
    at.map(({ main, slot }) => ({ main, slot })),
    [{ main: f.at('two-1'), slot: undefined }],
  );
});

test.skipIf(!darwin)(
  'adoptIdentity keeps a recorded directory it cannot reach',
  async () => {
    const f = await directories('a', 'locked');
    const recorded = { path: f.at('a'), ...(await identify(f.at('a')))! };
    await rename(f.at('a'), f.at('locked/a'));
    await mkdir(f.at('a'));
    await chmod(f.at('locked'), 0);
    try {
      const before = { ...recorded };
      assert.equal(
        await adoptIdentity(recorded, (await identify(f.at('a')))!),
        false,
      );
      assert.deepEqual(recorded, before);
    } finally {
      await chmod(f.at('locked'), 0o755);
    }
  },
);

test('adoptIdentity drops the repository and slot that described the directory gone from a path', async () => {
  const f = await directories('w-2');
  const recorded = await f.entry('w-2', { main: f.at('w'), slot: 2 });
  // made before the old one goes, so Linux can't give it the same inode
  await mkdir(f.at('replacement'));
  await rm(f.at('w-2'), { recursive: true });
  await rename(f.at('replacement'), f.at('w-2'));
  const now = (await identify(f.at('w-2')))!;
  assert.equal(await adoptIdentity(recorded, now), true);
  assert.deepEqual(recorded, { path: f.at('w-2'), ...now });
});
