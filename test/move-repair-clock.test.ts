import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { repairMoves } from '../src/core/move-repair.js';
import { createConversation } from '../src/core/state.js';
import { identify } from '../src/persistence/directories.js';
import type * as Directories from '../src/persistence/directories.js';
import type { LedgerMove } from '../src/persistence/directories.js';
import { StateStore } from '../src/persistence/store.js';
import { record } from './fixtures/coordinator.js';
import { scratch } from './fixtures/scratch.js';
import { seededMemory } from './fixtures/seeded-memory.js';

const ledgerCalls = vi.hoisted(() => ({
  before: undefined as (() => void) | undefined,
}));

vi.mock('../src/persistence/directories.js', async (importOriginal) => {
  const original = await importOriginal<typeof Directories>();

  return {
    ...original,
    updateLedger: ((...args) => {
      ledgerCalls.before?.();

      return original.updateLedger(...args);
    }) satisfies typeof original.updateLedger,
  };
});

/** a conversation saved in `old`, which the ledger knows beside `moves`, and a repair that returns its record. */
async function held(moves: LedgerMove[] = []) {
  const root = await scratch('witch-clock-');
  const at = (path: string) => join(root, path);

  await mkdir(at('old'));

  await mkdir(at('state/conversations/held'), { recursive: true });

  await writeFile(
    at('state/conversations/held/state.json'),
    JSON.stringify(record('held', at('old'))),
  );

  const entries = [{ path: at('old'), ...(await identify(at('old')))! }];

  await writeFile(
    at('state/directories.json'),
    JSON.stringify({ version: 1, entries, moves }),
  );

  const store = await StateStore.open(at('state'));
  const memory = await seededMemory(at('state/memory.git'));

  const repair = async (cwd: string) => {
    await repairMoves(store, memory, at(cwd), {
      run: () => Promise.reject(new Error('not a repository')),
    });

    return JSON.parse(
      await readFile(at('state/conversations/held/state.json'), 'utf8'),
    ) as { cwd: string; cwdSince: string };
  };

  return { at, repair };
}

test('a conversation repaired while the clock reads behind a recorded move still follows its next move', async () => {
  const ahead = Date.now() + 60_000;

  const f = await held([
    {
      from: '/gone',
      to: '/away',
      device: '1',
      inode: '1',
      prompts: 0,
      at: ahead,
    },
  ]);

  await rename(f.at('old'), f.at('new'));

  const repaired = await f.repair('new');

  assert.equal(repaired.cwd, f.at('new'));

  assert.ok(Date.parse(repaired.cwdSince) >= ahead, repaired.cwdSince);

  await rename(f.at('new'), f.at('newer'));

  assert.equal((await f.repair('newer')).cwd, f.at('newer'));
});

test('a conversation repaired before the clock stepped back still follows its next move', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });

  try {
    vi.setSystemTime(1_000_000);

    const f = await held();

    await rename(f.at('old'), f.at('new'));

    vi.setSystemTime(1_100_000);

    // the clock reads later when repair dates the conversation than when it recorded the move
    let calls = 0;

    ledgerCalls.before = () => {
      if (++calls === 2) vi.setSystemTime(2_000_000);
    };

    await f.repair('new').finally(() => (ledgerCalls.before = undefined));

    vi.setSystemTime(1_500_000);

    await rename(f.at('new'), f.at('newer'));

    assert.equal((await f.repair('newer')).cwd, f.at('newer'));
  } finally {
    vi.useRealTimers();
  }
});

/** a conversation Witch creates in `old` once the ledger holds `moves`, and a repair that returns its cwd. */
async function created(
  moves: (at: (path: string) => string) => Promise<LedgerMove[]>,
) {
  const root = await scratch('witch-clock-');
  const at = (path: string) => join(root, path);

  await mkdir(at('old'));

  await mkdir(at('state'));

  await writeFile(
    at('state/directories.json'),
    JSON.stringify({
      version: 1,
      entries: [{ path: at('old'), ...(await identify(at('old')))! }],
      moves: await moves(at),
    }),
  );

  const store = await StateStore.open(at('state'));
  const files = await store.create(createConversation(at('old'), 'a'));
  const { id } = files.record;

  await files.close();

  const memory = await seededMemory(at('state/memory.git'));

  const repair = async (cwd: string) => {
    await repairMoves(store, memory, at(cwd), {
      run: () => Promise.reject(new Error('not a repository')),
    });

    const { records } = await store.records();

    return records.find((saved) => saved.id === id)?.cwd;
  };

  return { at, repair };
}

test("a conversation created at a reused path after the clock stepped back follows its own directory, not the earlier occupant's", async () => {
  const f = await created(async (at) => {
    await mkdir(at('elsewhere'));

    return [
      {
        from: at('old'),
        to: at('elsewhere'),
        ...(await identify(at('elsewhere')))!,
        prompts: 0,
        at: Date.now() + 60_000,
      },
    ];
  });

  await rename(f.at('old'), f.at('new'));

  assert.equal(await f.repair('new'), f.at('new'));
});

test('a conversation created before any move was recorded follows its directory after the clock stepped back', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });

  try {
    vi.setSystemTime(2_000_000);

    const f = await created(async () => []);

    vi.setSystemTime(1_000_000);

    await rename(f.at('old'), f.at('new'));

    assert.equal(await f.repair('new'), f.at('new'));
  } finally {
    vi.useRealTimers();
  }
});
