import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test, vi } from 'vitest';
import { runCommand } from '../src/core/command.js';
import { describeMoves, repairMoves } from '../src/core/move-repair.js';
import type { Run } from '../src/core/repository.js';
import type { ConversationRecord } from '../src/core/state.js';
import { projectKey } from '../src/memory/memory.js';
import { readLedger, updateLedger } from '../src/persistence/directories.js';
import type * as Directories from '../src/persistence/directories.js';
import { identifyProcess } from '../src/persistence/process.js';
import { StateStore } from '../src/persistence/store.js';
import { quote } from '../src/shell.js';
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

const execute = promisify(execFile);
const darwin = process.platform === 'darwin';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd },
  );
  return stdout.trim();
}

const status = (cwd: string) => git(cwd, 'status', '--porcelain');

/** a main checkout `w/main` with a worktree `w/main-1`, a state directory, and one repair already run there. */
async function setup({ origin = true }: { origin?: boolean } = {}) {
  const root = await scratch('witch-move-');
  const at = (path: string) => join(root, path);
  await mkdir(at('w/main'), { recursive: true });
  await git(at('w/main'), 'init', '-q', '-b', 'main');
  await git(at('w/main'), 'commit', '-q', '--allow-empty', '-m', 'first');
  if (origin)
    await git(
      at('w/main'),
      'remote',
      'add',
      'origin',
      'https://example.invalid/move.git',
    );
  await git(at('w/main'), 'worktree', 'add', '-q', '--detach', at('w/main-1'));
  const store = await StateStore.open(at('state'));
  const memory = await seededMemory(at('state/memory.git'));
  const runs: string[][] = [];
  const recording: Run = (command, args, options) => {
    runs.push([command, ...args]);
    return runCommand(command, args, options);
  };
  const repair = (
    cwd: string,
    options: Parameters<typeof repairMoves>[3] = {},
  ) => repairMoves(store, memory, at(cwd), { run: recording, ...options });
  let day = 1;
  const save = async (
    id: string,
    cwd: string,
    extra: Partial<ConversationRecord> & Record<string, unknown> = {},
    history = true,
  ) => {
    const files = await store.create({ ...record(id, at(cwd)), ...extra });
    if (history)
      await files.append({
        id: `${id}-line`,
        kind: 'assistant',
        cwd: at(cwd),
        text: `in ${id}`,
      });
    await files.close();
    const directory = at(`state/conversations/${id}`);
    const raw = JSON.parse(
      await readFile(join(directory, 'state.json'), 'utf8'),
    );
    await writeFile(
      join(directory, 'state.json'),
      JSON.stringify({ ...raw, ...extra }, null, 2),
    );
    const date = new Date(`2020-01-${String(day++).padStart(2, '0')}`);
    for (const file of ['state.json', 'history.jsonl'])
      await utimes(join(directory, file), date, date).catch(() => {});
  };
  const saved = async (id: string) => {
    const directory = at(`state/conversations/${id}`);
    return {
      raw: JSON.parse(
        await readFile(join(directory, 'state.json'), 'utf8'),
      ) as Record<string, unknown>,
      history: await readFile(join(directory, 'history.jsonl'), 'utf8').catch(
        () => undefined,
      ),
      mtimes: await Promise.all(
        ['state.json', 'history.jsonl'].map(
          async (file) =>
            (await stat(join(directory, file)).catch(() => undefined))?.mtimeMs,
        ),
      ),
    };
  };
  await repair('w/main');
  return { root, at, store, memory, repair, runs, save, saved };
}

test('a moved main checkout and worktree are repaired from the new location', async () => {
  const f = await setup();
  await f.save('a-old', 'w/main');
  await f.save('b-new', 'w/main', { futureField: 'kept' });
  await f.save('sub', 'w/main/sub');
  await mkdir(f.at('w/main/sub'));
  await f.repair('w/main');
  const before = await Promise.all(['b-new', 'a-old', 'sub'].map(f.saved));
  await mkdir(f.at('w/main-copy'));
  await f.save('copy', 'w/main-copy');
  await rename(f.at('w'), f.at('c'));
  const report = await f.repair('c/main');
  await status(f.at('c/main'));
  await status(f.at('c/main-1'));
  assert.match(
    await git(f.at('c/main'), 'worktree', 'list'),
    new RegExp(`${f.at('c/main-1')} `),
  );
  for (const [index, [id, cwd]] of [
    ['b-new', 'c/main'],
    ['a-old', 'c/main'],
    ['sub', 'c/main/sub'],
  ].entries()) {
    const after = await f.saved(id!);
    assert.equal(after.raw.cwd, f.at(cwd!));
    assert.ok(after.history!.includes(JSON.stringify(f.at(cwd!))));
    assert.deepEqual(after.mtimes, before[index]!.mtimes);
  }
  assert.equal((await f.saved('b-new')).raw.futureField, 'kept');
  assert.deepEqual(
    (await f.store.conversations(f.at('c/main'))).map(({ id }) => id),
    ['b-new', 'a-old'],
  );
  assert.equal((await f.saved('copy')).raw.cwd, f.at('w/main-copy'));
  assert.deepEqual(report.repaired, [
    {
      from: f.at('w/main'),
      to: f.at('c/main'),
      conversations: 3,
      worktrees: 1,
    },
  ]);
  assert.equal(
    describeMoves(report, f.at('state'))!
      .split('\n')
      .filter((line) => line.startsWith('Repaired')).length,
    1,
  );
});

test('a conversation without history is repaired', async () => {
  const f = await setup();
  await f.save('draft', 'w/main', { draft: 'unsent' }, false);
  await rename(f.at('w'), f.at('c'));
  await f.repair('c/main');
  const after = await f.saved('draft');
  assert.equal(after.raw.cwd, f.at('c/main'));
  assert.equal(after.history, undefined);
});

test('a main checkout and worktree moved together are repaired from the worktree', async () => {
  const f = await setup();
  await f.save('in-worktree', 'w/main-1');
  await rename(f.at('w'), f.at('c'));
  await f.repair('c/main-1');
  await status(f.at('c/main'));
  await status(f.at('c/main-1'));
  assert.equal((await f.saved('in-worktree')).raw.cwd, f.at('c/main-1'));
});

test('a moved main checkout alone repairs its worktree', async () => {
  const f = await setup();
  await rename(f.at('w/main'), f.at('w/renamed'));
  await f.repair('w/renamed');
  await status(f.at('w/main-1'));
});

test('a worktree moved alone is repaired from its new location', async () => {
  const f = await setup();
  await rename(f.at('w/main-1'), f.at('w/elsewhere'));
  await f.repair('w/elsewhere');
  assert.match(
    await git(f.at('w/main'), 'worktree', 'list'),
    new RegExp(`${f.at('w/elsewhere')} `),
  );
});

test.skipIf(!darwin)(
  'a main checkout and worktree moved to unrelated places are both repaired',
  async () => {
    const f = await setup();
    await mkdir(f.at('x'));
    await rename(f.at('w/main'), f.at('c'));
    await rename(f.at('w/main-1'), f.at('x/far'));
    const report = await f.repair('c');
    await status(f.at('c'));
    await status(f.at('x/far'));
    assert.equal(report.repaired[0]!.worktrees, 1);
    assert.deepEqual(report.blocked, []);
  },
);

test.skipIf(darwin)(
  'a worktree moved somewhere unrelated is reported where it can not be located',
  async () => {
    const f = await setup();
    await mkdir(f.at('x'));
    await rename(f.at('w/main-1'), f.at('x/far'));
    const report = await f.repair('w/main');
    assert.deepEqual(report.unresolved, [
      { path: f.at('w/main-1'), conversations: 0, worktree: true },
    ]);
    assert.deepEqual(report.blocked, []);
  },
);

test('a deleted, unpruned worktree is reported and does not block', async () => {
  const f = await setup();
  await rm(f.at('w/main-1'), { recursive: true });
  await rename(f.at('w/main'), f.at('w/renamed'));
  const report = await f.repair('w/renamed');
  await status(f.at('w/renamed'));
  assert.deepEqual(report.blocked, []);
  assert.ok(
    report.unresolved.some(
      ({ path, worktree }) => path === f.at('w/main-1') && worktree,
    ),
  );
  assert.match(describeMoves(report, f.at('state'))!, /moved or was deleted/);
});

test('a deleted worktree beside a moved one does not block the repair', async () => {
  const f = await setup();
  await git(
    f.at('w/main'),
    'worktree',
    'add',
    '-q',
    '--detach',
    f.at('w/main-2'),
  );
  await f.repair('w/main');
  await rm(f.at('w/main-1'), { recursive: true });
  await rename(f.at('w'), f.at('c'));
  const report = await f.repair('c/main');
  assert.deepEqual(report.blocked, []);
  await status(f.at('c/main-2'));
});

test('a slot is read only from a name under its main checkout', async () => {
  const f = await setup();
  // as long as `main`, so the part past the main checkout's length reads as `-3`
  await git(
    f.at('w/main'),
    'worktree',
    'add',
    '-q',
    '--detach',
    f.at('w/abcd-3'),
  );
  await f.repair('w/main');
  const { entries } = await readLedger(f.at('state'));
  const slots = Object.fromEntries(
    entries.map(({ path, slot }) => [path, slot]),
  );
  assert.equal(slots[f.at('w/main-1')], 1);
  assert.equal(slots[f.at('w/abcd-3')], undefined);
});

test('an interrupted repair finishes at the next start', async () => {
  const f = await setup();
  await rename(f.at('w'), f.at('c'));
  const interrupted = await repairMoves(f.store, f.memory, f.at('c/main'), {
    run: (command, args, options) =>
      args[0] === 'worktree' && args[1] === 'repair'
        ? Promise.reject(new Error('interrupted'))
        : runCommand(command, args, options),
  });
  assert.ok(
    interrupted.blocked.some(({ reason }) => /interrupted/.test(reason)),
  );
  await assert.rejects(status(f.at('c/main-1')));
  await mkdir(f.at('elsewhere'));
  await f.repair('elsewhere');
  await status(f.at('c/main-1'));
});

test('a failed repair keeps a moved worktree and its slot', async () => {
  const f = await setup();
  await rename(f.at('w/main-1'), f.at('far'));
  await repairMoves(f.store, f.memory, f.at('far'), {
    run: (command, args, options) =>
      args[0] === 'worktree' && args[1] === 'repair'
        ? Promise.reject(new Error('interrupted'))
        : runCommand(command, args, options),
  });
  const { entries } = await readLedger(f.at('state'));
  assert.equal(entries.find(({ path }) => path === f.at('far'))?.slot, 1);
});

for (const [unreadable, mode] of [
  ['.git/worktrees', 0o300],
  ['.git/worktrees/main-1/gitdir', 0],
] as const)
  test(`an unreadable ${unreadable} blocks its repository`, async () => {
    const f = await setup();
    await rename(f.at('w/main'), f.at('w/renamed'));
    const file = f.at(`w/renamed/${unreadable}`);
    await chmod(file, mode);
    try {
      const report = await f.repair('w/renamed');
      assert.ok(
        report.blocked.some(
          ({ repository, reason }) =>
            repository === f.at('w/renamed') && reason.includes(file),
        ),
        JSON.stringify(report),
      );
    } finally {
      await chmod(file, 0o755);
    }
  });

for (const relative of ['.git', 'gitdir'])
  test(`a worktree whose ${relative} link Git wrote relative is checked as its own`, async () => {
    const f = await setup();
    if (relative === '.git')
      await writeFile(
        f.at('w/main-1/.git'),
        'gitdir: ../main/.git/worktrees/main-1\n',
      );
    else
      await writeFile(
        f.at('w/main/.git/worktrees/main-1/gitdir'),
        '../../../../main-1/.git\n',
      );
    await status(f.at('w/main-1'));
    const report = await f.repair('w/main');
    assert.deepEqual(report.blocked, []);
    assert.deepEqual(report.unresolved, []);
  });

test('a worktree named with slot 0 gets no slot and the ledger stays readable', async () => {
  const f = await setup();
  await git(
    f.at('w/main'),
    'worktree',
    'add',
    '-q',
    '--detach',
    f.at('w/main-0'),
  );
  await f.repair('w/main');
  const { entries } = await readLedger(f.at('state'));
  assert.equal(
    entries.find(({ path }) => path === f.at('w/main-0'))?.slot,
    undefined,
  );
});

test('a main checkout that left its worktree behind is reported with its recovery command', async () => {
  const f = await setup();
  await f.save('inside', 'w/main-1');
  await f.repair('w/main');
  await mkdir(f.at('c'));
  await cp(f.at('w/main'), f.at('c/main'), { recursive: true });
  await rm(f.at('w/main'), { recursive: true });
  const report = await f.repair('w/main-1');
  assert.ok(
    report.unresolved.some(({ path }) => path === f.at('w/main')),
    JSON.stringify(report),
  );
  assert.ok(
    describeMoves(report, f.at('state'))!.includes(
      `--recover-directory ${quote(f.at('w/main'))}`,
    ),
  );
});

test('a start with nothing moved runs no repair', async () => {
  const f = await setup();
  f.runs.length = 0;
  await f.repair('w/main');
  assert.ok(
    !f.runs.some(([, ...args]) => args.join(' ') === 'worktree repair'),
  );
});

for (const variant of [
  'foreign worktree',
  'replaced .git',
  'swapped',
  'foreign main',
])
  test(`a foreign .git at a registration's path blocks repair and stays untouched: ${variant}`, async () => {
    const f = await setup();
    await mkdir(f.at('other'));
    await git(f.at('other'), 'init', '-q', '-b', 'main');
    await git(f.at('other'), 'commit', '-q', '--allow-empty', '-m', 'other');
    let main = f.at('w/main');
    const foreign = f.at('w/main-1');
    if (variant === 'foreign worktree') {
      await rename(f.at('w/main'), f.at('c'));
      await rename(f.at('w/main-1'), f.at('away'));
      await git(f.at('other'), 'worktree', 'add', '-q', '--detach', foreign);
      main = f.at('c');
    } else if (variant === 'replaced .git')
      await writeFile(
        join(foreign, '.git'),
        `gitdir: ${f.at('other/.git/worktrees/main-1')}\n`,
      );
    else if (variant === 'swapped') {
      await git(main, 'worktree', 'add', '-q', '--detach', f.at('w/main-2'));
      await rename(foreign, f.at('away'));
      await rename(f.at('w/main-2'), foreign);
    } else {
      await rename(f.at('w/main'), f.at('c'));
      main = f.at('c');
      await rm(f.at('other'), { recursive: true });
      await mkdir(f.at('w/main'));
      await git(f.at('w/main'), 'init', '-q', '-b', 'main');
      await git(f.at('w/main'), 'commit', '-q', '--allow-empty', '-m', 'x');
      await mkdir(f.at('x'));
      await git(
        f.at('w/main'),
        'worktree',
        'add',
        '-q',
        '--detach',
        f.at('x/main-1'),
      );
    }
    const snapshot = async () =>
      Promise.all(
        [join(foreign, '.git'), f.at('x/main-1/.git')].map((file) =>
          readFile(file, 'utf8').catch(() => ''),
        ),
      );
    const before = await snapshot();
    const report = await repairMoves(f.store, f.memory, main);
    assert.deepEqual(await snapshot(), before);
    assert.ok(
      report.blocked.some(({ repository }) => repository === main),
      JSON.stringify(report),
    );
  });

test('history rewriting keeps unmatched lines byte for byte', async () => {
  const f = await setup();
  await f.save('lines', 'w/main');
  const history = f.at('state/conversations/lines/history.jsonl');
  const other = JSON.stringify({
    id: 'other',
    kind: 'notice',
    cwd: f.at('w/main-other'),
    text: 'x',
  });
  const crlf = JSON.stringify({
    id: 'crlf',
    kind: 'notice',
    cwd: f.at('w/main'),
    text: 'y',
  });
  const extra = Buffer.concat([
    Buffer.from(`${other}\n${crlf}\r\n`),
    Buffer.from([0xff, 0xfe, 10]),
    Buffer.from('{"torn":'),
  ]);
  await writeFile(history, Buffer.concat([await readFile(history), extra]));
  await rename(f.at('w'), f.at('c'));
  await f.repair('c/main');
  const after = await readFile(history);
  assert.ok(after.includes(Buffer.from(`${other}\n`)));
  assert.ok(
    after.includes(
      Buffer.from(
        `${JSON.stringify({ id: 'crlf', kind: 'notice', cwd: f.at('c/main'), text: 'y' })}\r\n`,
      ),
    ),
  );
  assert.ok(
    after
      .subarray(-11)
      .equals(Buffer.from([0xff, 0xfe, 10, ...Buffer.from('{"torn":')])),
  );
});

test('prompt history follows a move without rewriting the file', async () => {
  const f = await setup();
  await f.store.addPrompt(f.at('w/main'), 'before the move');
  const prompts = f.at('state/prompts.jsonl');
  const original = await readFile(prompts);
  await rename(f.at('w'), f.at('c'));
  await f.repair('c/main');
  assert.deepEqual(await f.store.prompts(f.at('c/main')), ['before the move']);
  assert.ok((await readFile(prompts)).equals(original));
  await mkdir(f.at('spare'));
  await rename(f.at('spare'), f.at('w'));
  await mkdir(f.at('w/main'));
  await f.store.addPrompt(f.at('w/main'), 'in the new directory');
  assert.deepEqual(await f.store.prompts(f.at('w/main')), [
    'in the new directory',
  ]);
  assert.deepEqual(await f.store.prompts(f.at('c/main')), ['before the move']);
  await writeFile(f.at('state/directories.json'), '{');
  assert.deepEqual(await f.store.prompts(f.at('c/main')), []);
});

test('prompts follow the directory that wrote them when a reused path moves again', async () => {
  const f = await setup();
  await mkdir(f.at('p'));
  await f.save('first', 'p');
  await f.repair('p');
  await f.store.addPrompt(f.at('p'), 'first directory');
  await rename(f.at('p'), f.at('b'));
  await f.repair('b');
  await mkdir(f.at('p'));
  await f.save('second', 'p');
  await f.repair('p');
  await f.store.addPrompt(f.at('p'), 'second directory');
  await rename(f.at('p'), f.at('c'));
  await f.repair('c');
  assert.deepEqual(await f.store.prompts(f.at('b')), ['first directory']);
  assert.deepEqual(await f.store.prompts(f.at('c')), ['second directory']);
});

test("a directory moved onto another's old path doesn't follow that one's move", async () => {
  const f = await setup();
  for (const name of ['a', 'b']) {
    await mkdir(f.at(name));
    await f.save(name, name);
  }
  await f.repair('a');
  await f.store.addPrompt(f.at('a'), 'in a');
  await rename(f.at('b'), f.at('c'));
  await f.repair('c');
  await rename(f.at('a'), f.at('b'));
  await f.repair('b');
  assert.equal((await f.saved('a')).raw.cwd, f.at('b'));
  assert.equal((await f.saved('b')).raw.cwd, f.at('c'));
  assert.deepEqual(await f.store.prompts(f.at('b')), ['in a']);
  assert.deepEqual(await f.store.prompts(f.at('c')), []);
});

test('a conversation held open through two moves follows its own directory, not a later one at the same path', async () => {
  const f = await setup();
  await mkdir(f.at('a'));
  await f.save('held', 'a');
  await f.repair('a');
  const files = await (await StateStore.open(f.at('state'))).claim('held');
  try {
    await rename(f.at('a'), f.at('b'));
    await f.repair('b');
    await rename(f.at('b'), f.at('c'));
    await f.repair('c');
    const { moves } = await readLedger(f.at('state'));
    assert.ok(
      moves.some(({ from, to }) => from === f.at('b') && to === f.at('c')),
      JSON.stringify(moves),
    );
    await mkdir(f.at('b'));
    await f.save('other', 'b');
    await f.repair('b');
    await rename(f.at('b'), f.at('d'));
    await f.repair('d');
  } finally {
    await files.close();
  }
  await f.repair('d');
  assert.equal((await f.saved('held')).raw.cwd, f.at('c'));
  assert.equal((await f.saved('other')).raw.cwd, f.at('d'));
});

test('a conversation waiting at a path follows its own directory, not a later one that moved from there', async () => {
  const f = await setup();
  await mkdir(f.at('a'));
  await f.save('held', 'a');
  await f.repair('a');
  const files = await (await StateStore.open(f.at('state'))).claim('held');
  try {
    await rename(f.at('a'), f.at('b'));
    await f.repair('b');
    await mkdir(f.at('a'));
    await f.save('other', 'a');
    await f.repair('a');
    await rename(f.at('a'), f.at('c'));
    await f.repair('c');
  } finally {
    await files.close();
  }
  await f.repair('c');
  assert.equal((await f.saved('held')).raw.cwd, f.at('b'));
  assert.equal((await f.saved('other')).raw.cwd, f.at('c'));
});

test.skipIf(!darwin)(
  'two renames found by one repair are followed in the order they happened',
  async () => {
    const f = await setup();
    for (const name of ['a', 'b']) {
      await mkdir(f.at(name));
      await f.save(name, name);
    }
    await f.repair('a');
    await rename(f.at('b'), f.at('c'));
    await rename(f.at('a'), f.at('b'));
    const report = await f.repair('b');
    assert.equal((await f.saved('a')).raw.cwd, f.at('b'));
    // b's own conversation waits where another directory now sits
    assert.equal((await f.saved('b')).raw.cwd, f.at('b'));
    assert.deepEqual(report.unresolved, []);
  },
);

test('a repaired conversation follows its directory past an earlier move out of its new path', async () => {
  const f = await setup();
  for (const name of ['a', 'b']) {
    await mkdir(f.at(name));
    await f.save(name, name);
  }
  await f.repair('a');
  await rename(f.at('b'), f.at('c'));
  await f.repair('c');
  await rename(f.at('a'), f.at('b'));
  await f.repair('b');
  assert.equal((await f.saved('a')).raw.cwd, f.at('b'));
  await rename(f.at('b'), f.at('d'));
  await f.repair('d');
  assert.equal((await f.saved('a')).raw.cwd, f.at('d'));
  assert.equal((await f.saved('b')).raw.cwd, f.at('c'));
});

for (const race of ['source', 'parent', 'destination'])
  test(`a ${race} that changes while repair stops a leftover process keeps the conversation where it was`, async () => {
    const f = await setup();
    const cwd = race === 'parent' ? 'w/main/sub' : 'w/main';
    if (race === 'parent') await mkdir(f.at(cwd));
    // changes the paths as it's stopped, the last moment before the rewrite
    const change =
      race === 'destination'
        ? `fs.renameSync(${JSON.stringify(f.at('c/main'))}, ${JSON.stringify(f.at('actual'))}); fs.mkdirSync(${JSON.stringify(f.at('c/main'))});`
        : `fs.mkdirSync(${JSON.stringify(f.at('w/main'))}, { recursive: true });`;
    const child = spawn(process.execPath, [
      '-e',
      `const fs = require('node:fs'); process.on('SIGTERM', () => { ${change} process.exit(0); }); console.log('ready'); setTimeout(() => {}, 60_000);`,
    ]);
    try {
      await new Promise((ready) => child.stdout.once('data', ready));
      await f.save('live', cwd, {
        process: await identifyProcess(child.pid!),
      });
      await rename(f.at('w'), f.at('c'));
      const report = await f.repair('c/main');
      assert.equal((await f.saved('live')).raw.cwd, f.at(cwd));
      assert.ok(
        report.blocked.some(({ path }) => path === f.at(cwd)),
        JSON.stringify(report),
      );
    } finally {
      child.kill('SIGKILL');
    }
  });

test('a destination copied back in place during worktree repair is not taken for the moved one', async () => {
  const f = await setup();
  await f.save('held', 'w/main');
  await rename(f.at('w'), f.at('c'));
  const report = await repairMoves(f.store, f.memory, f.at('c/main'), {
    run: async (command, args, options) => {
      const result = await runCommand(command, args, options);
      if (args[0] === 'worktree' && args[1] === 'repair') {
        await rename(f.at('c/main'), f.at('actual'));
        await cp(f.at('actual'), f.at('c/main'), { recursive: true });
      }
      return result;
    },
  });
  assert.equal((await f.saved('held')).raw.cwd, f.at('w/main'));
  assert.ok(
    report.blocked.some(({ path }) => path === f.at('w/main')),
    JSON.stringify(report),
  );
});

test("a replacement child follows its parent's later move, not the earlier child's own", async () => {
  const f = await setup();
  await mkdir(f.at('a/sub'), { recursive: true });
  await f.save('parent', 'a');
  await f.save('first', 'a/sub');
  await f.repair('a');
  await rename(f.at('a/sub'), f.at('x'));
  await f.repair('x');
  await mkdir(f.at('a/sub'));
  await f.save('second', 'a/sub');
  await f.repair('a');
  await f.store.addPrompt(f.at('a/sub'), 'in the replacement');
  await rename(f.at('a'), f.at('b'));
  await f.repair('b');
  assert.equal((await f.saved('first')).raw.cwd, f.at('x'));
  assert.equal((await f.saved('second')).raw.cwd, f.at('b/sub'));
  assert.deepEqual(await f.store.prompts(f.at('b/sub')), [
    'in the replacement',
  ]);
});

test('a destination replaced between two conversations keeps the later one where it was', async () => {
  const f = await setup();
  // whichever stop comes first swaps the destination; the other conversation is checked against the ledger
  const swap = `if (!fs.existsSync(${JSON.stringify(f.at('actual'))})) { fs.renameSync(${JSON.stringify(f.at('c/main'))}, ${JSON.stringify(f.at('actual'))}); fs.mkdirSync(${JSON.stringify(f.at('c/main'))}); }`;
  const children = ['one', 'two'].map(() =>
    spawn(process.execPath, [
      '-e',
      `const fs = require('node:fs'); process.on('SIGTERM', () => { ${swap} process.exit(0); }); console.log('ready'); setTimeout(() => {}, 60_000);`,
    ]),
  );
  try {
    for (const [index, child] of children.entries()) {
      await new Promise((ready) => child.stdout.once('data', ready));
      await f.save(`live-${index}`, 'w/main', {
        process: await identifyProcess(child.pid!),
      });
    }
    await rename(f.at('w'), f.at('c'));
    await f.repair('c/main');
    for (const index of [0, 1])
      assert.equal((await f.saved(`live-${index}`)).raw.cwd, f.at('w/main'));
  } finally {
    for (const child of children) child.kill('SIGKILL');
  }
});

test('prompts added while repair waits for the ledger lock stay with the moved directory', async () => {
  const f = await setup();
  await f.store.addPrompt(f.at('w/main'), 'first');
  await rename(f.at('w'), f.at('c'));
  let entered!: () => void;
  const inside = new Promise<void>((done) => (entered = done));
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  const held = updateLedger(f.at('state'), async () => {
    entered();
    await gate;
  });
  await inside;
  // a repair asks for the ledger lock only after any boundary read outside it
  const asked = new Promise<void>((done) => (ledgerCalls.before = done));
  const repairing = f.repair('c/main');
  await asked;
  ledgerCalls.before = undefined;
  await f.store.addPrompt(f.at('w/main'), 'while waiting');
  release();
  await held;
  await repairing;
  assert.deepEqual(await f.store.prompts(f.at('c/main')), [
    'while waiting',
    'first',
  ]);
});

test('a directory moved onto a path the ledger knew for a deleted one is repaired on the first start', async () => {
  const f = await setup();
  await mkdir(f.at('q/dest'), { recursive: true });
  await f.save('dest', 'q/dest');
  await f.repair('q/dest');
  await mkdir(f.at('p/old'), { recursive: true });
  await f.save('held', 'p/old');
  await f.repair('p/old');
  await rm(f.at('q/dest'), { recursive: true });
  await rename(f.at('p/old'), f.at('q/dest'));
  const report = await f.repair('q/dest');
  assert.deepEqual(report.blocked, []);
  assert.equal((await f.saved('held')).raw.cwd, f.at('q/dest'));
});

test.skipIf(!darwin)(
  'a stand-in copied over a moved destination is never taken for it on a later start',
  async () => {
    const f = await setup();
    await f.save('held', 'w/main');
    await rename(f.at('w'), f.at('c'));
    await repairMoves(f.store, f.memory, f.at('c/main'), {
      run: async (command, args, options) => {
        const result = await runCommand(command, args, options);
        if (args[0] === 'worktree' && args[1] === 'repair') {
          await rename(f.at('c/main'), f.at('actual'));
          await cp(f.at('actual'), f.at('c/main'), { recursive: true });
        }
        return result;
      },
    });
    // c/main holds another directory now, so the conversation stays listed where it was
    await f.repair('c/main');
    assert.equal((await f.saved('held')).raw.cwd, f.at('w/main'));
  },
);

test('a declared recovery with no ledger entry for it never takes a stand-in for its destination', async () => {
  const f = await setup();
  await f.save('copied', 'w/main');
  await rm(f.at('state/directories.json'));
  await mkdir(f.at('c'));
  await cp(f.at('w/main'), f.at('c/main'), { recursive: true });
  await rm(f.at('w/main'), { recursive: true });
  const report = await repairMoves(f.store, f.memory, f.at('c/main'), {
    declared: { from: f.at('w/main'), to: f.at('c/main') },
    run: async (command, args, options) => {
      const result = await runCommand(command, args, options);
      if (args[0] === 'worktree' && args[1] === 'repair') {
        await rename(f.at('c/main'), f.at('actual'));
        await cp(f.at('actual'), f.at('c/main'), { recursive: true });
      }
      return result;
    },
  });
  assert.equal((await f.saved('copied')).raw.cwd, f.at('w/main'));
  assert.ok(
    report.blocked.some(({ path }) => path === f.at('w/main')),
    JSON.stringify(report),
  );
  // finding the copy that moved away by its identity, so a later start never adopts the stand-in, needs macOS
  if (darwin) {
    await f.repair('c/main');
    assert.equal((await f.saved('copied')).raw.cwd, f.at('w/main'));
  }
});

test.skipIf(!darwin)(
  'a plain directory that moved before anything was saved in it keeps the new one at its path apart',
  async () => {
    const f = await setup();
    await mkdir(f.at('foo'));
    await f.repair('foo');
    await rename(f.at('foo'), f.at('bar'));
    await mkdir(f.at('foo'));
    await f.repair('foo');
    await f.store.addPrompt(f.at('foo'), 'typed in the new foo');
    await f.save('new', 'foo');
    const report = await f.repair('foo');
    assert.deepEqual(await f.store.prompts(f.at('foo')), [
      'typed in the new foo',
    ]);
    assert.deepEqual(await f.store.prompts(f.at('bar')), []);
    assert.equal((await f.saved('new')).raw.cwd, f.at('foo'));
    assert.deepEqual(report.suspended, []);
  },
);

test.skipIf(!darwin)(
  'a clone made where a plain directory moved from is recorded as its own repository',
  async () => {
    const f = await setup();
    await mkdir(f.at('p/plain'), { recursive: true });
    await f.repair('p/plain');
    await rename(f.at('p/plain'), f.at('p/old'));
    await mkdir(f.at('p/plain'));
    await git(f.at('p/plain'), 'init', '-q', '-b', 'main');
    await git(f.at('p/plain'), 'commit', '-q', '--allow-empty', '-m', 'x');
    await f.repair('p/plain');
    await f.repair('p/plain');
    const { entries } = await readLedger(f.at('state'));
    const at = (path: string) => entries.find((entry) => entry.path === path);
    assert.equal(at(f.at('p/plain'))?.main, f.at('p/plain'));
    assert.equal(at(f.at('p/old'))?.main, undefined);
    const elsewhere = await f.repair('w/main');
    assert.deepEqual(elsewhere.blocked, []);
  },
);

test("checking a repaired worktree runs nothing the repository's config names", async () => {
  const f = await setup();
  const marker = f.at('ran');
  const hook = f.at('fsmonitor.sh');
  await writeFile(hook, `#!/bin/sh\ntouch ${quote(marker)}\n`, { mode: 0o755 });
  await git(f.at('w/main'), 'config', 'core.fsmonitor', hook);
  await rename(f.at('w'), f.at('c'));
  const report = await f.repair('c/main');
  assert.deepEqual(report.blocked, []);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('a recreated source suspends its move', async () => {
  const f = await setup();
  await f.save('held', 'w/main');
  await rename(f.at('w/main'), f.at('c'));
  const holder = await StateStore.open(f.at('state'));
  const files = await holder.claim('held');
  const first = await f.repair('c');
  assert.ok(
    first.blocked.some(({ reason }) => /open in another Witch/.test(reason)),
  );
  await mkdir(f.at('spare'));
  await rename(f.at('spare'), f.at('w/main'));
  await files.close();
  const second = await f.repair('c');
  assert.equal((await f.saved('held')).raw.cwd, f.at('w/main'));
  assert.deepEqual(
    second.suspended.map(({ from, conversations }) => [from, conversations]),
    [[f.at('w/main'), 1]],
  );
});

test('an open conversation is reported and repaired after it closes', async () => {
  const f = await setup();
  await f.save('open', 'w/main');
  await rename(f.at('w'), f.at('c'));
  const holder = await StateStore.open(f.at('state'));
  const files = await holder.claim('open');
  const report = await f.repair('c/main');
  assert.ok(
    report.blocked.some(
      ({ path, reason }) =>
        path === f.at('w/main') && /open in another Witch/.test(reason),
    ),
  );
  assert.equal((await f.saved('open')).raw.cwd, f.at('w/main'));
  await files.close();
  await f.repair('c/main');
  assert.equal((await f.saved('open')).raw.cwd, f.at('c/main'));
});

for (const field of ['process', 'usageProcess', 'answerProcess', 'shell'])
  test(`a recorded ${field} left running by a crash is stopped and its conversation repaired`, async () => {
    const f = await setup();
    // a recorded shell leads its own process group, which is what gets killed
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60_000)'],
      { detached: field === 'shell' },
    );
    const exited = new Promise((done) => child.once('exit', done));
    try {
      const identity = await identifyProcess(child.pid!);
      await f.save('live', 'w/main', { [field]: identity });
      const before = (await f.saved('live')).mtimes;
      await rename(f.at('w'), f.at('c'));
      const report = await f.repair('c/main');
      assert.deepEqual(report.blocked, []);
      await exited;
      const after = await f.saved('live');
      assert.equal(after.raw.cwd, f.at('c/main'));
      assert.deepEqual(after.raw[field], identity);
      assert.deepEqual(after.mtimes, before);
    } finally {
      child.kill();
    }
  });

test('a live pid with a different start time is left running', async () => {
  const f = await setup();
  await f.save('reused', 'w/main', {
    process: { pid: process.pid, started: 'Thu Jan  1 00:00:00 1970' },
  });
  await rename(f.at('w'), f.at('c'));
  await f.repair('c/main');
  assert.equal((await f.saved('reused')).raw.cwd, f.at('c/main'));
});

for (const kind of ['origin-less repository', 'plain directory'])
  test(`a ${kind} repairs its conversations`, async () => {
    const f = await setup({ origin: false });
    const base = kind === 'plain directory' ? 'p' : 'w/main';
    if (base === 'p') await mkdir(f.at('p/sub'), { recursive: true });
    else await mkdir(f.at('w/main/sub'));
    await f.save('top', base, {
      sessions: {
        a: {
          id: 'n',
          model: 'm',
          hasHistory: true,
          deliveredProject: projectKey(f.at(base)),
        },
      },
    });
    await f.save('sub', `${base}/sub`, {
      sessions: {
        a: {
          id: 'n',
          model: 'm',
          hasHistory: true,
          deliveredProject: projectKey(
            base === 'p' ? f.at('p/sub') : f.at(base),
          ),
        },
      },
    });
    await f.save('elsewhere', base, {
      sessions: {
        a: {
          id: 'n',
          model: 'm',
          hasHistory: true,
          deliveredProject: 'projects/other-0000',
        },
      },
    });
    await f.repair(base);
    const moved = base === 'p' ? 'q' : 'w/renamed';
    await rename(f.at(base), f.at(moved));
    const report = await f.repair(moved);
    assert.equal((await f.saved('top')).raw.cwd, f.at(moved));
    assert.equal((await f.saved('sub')).raw.cwd, f.at(`${moved}/sub`));
    assert.equal((await f.saved('elsewhere')).raw.cwd, f.at(base));
    assert.ok(report.blocked.some(({ path }) => path === f.at(base)));
  });

test('a detected move into another project blocks its records', async () => {
  const f = await setup();
  await f.save('other', 'w/main', {
    sessions: {
      a: {
        id: 'n',
        model: 'm',
        hasHistory: true,
        deliveredProject: 'projects/other-0000',
      },
    },
  });
  await f.save('same', 'w/main');
  await rename(f.at('w'), f.at('c'));
  const report = await f.repair('c/main');
  assert.equal((await f.saved('other')).raw.cwd, f.at('w/main'));
  assert.equal((await f.saved('same')).raw.cwd, f.at('c/main'));
  assert.ok(report.blocked.some(({ path }) => path === f.at('w/main')));
});

test('a declared move into a different project is refused before anything is written', async () => {
  const f = await setup();
  const key = (await f.memory.scopePaths(f.at('w/main'))).project;
  await f.save('kept', 'w/main', {
    sessions: {
      a: { id: 'n', model: 'm', hasHistory: true, deliveredProject: key },
    },
  });
  await mkdir(f.at('c'));
  await cp(f.at('w/main'), f.at('c/main'), { recursive: true });
  await git(
    f.at('c/main'),
    'remote',
    'set-url',
    'origin',
    'https://example.invalid/else.git',
  );
  await rm(f.at('w/main'), { recursive: true });
  const before = await readLedger(f.at('state'));
  const report = await f.repair('c/main', {
    declared: { from: f.at('w/main'), to: f.at('c/main') },
  });
  assert.ok(report.blocked.length);
  assert.deepEqual(await readLedger(f.at('state')), before);
  assert.equal((await f.saved('kept')).raw.cwd, f.at('w/main'));
});

test('a declared parent move accepts nested repositories', async () => {
  const f = await setup();
  await mkdir(f.at('w/main/nested'));
  await git(f.at('w/main/nested'), 'init', '-q', '-b', 'main');
  await git(
    f.at('w/main/nested'),
    'remote',
    'add',
    'origin',
    'https://example.invalid/nested.git',
  );
  const nested = (await f.memory.scopePaths(f.at('w/main/nested'))).project;
  await f.save('nested', 'w/main/nested', {
    sessions: {
      a: { id: 'n', model: 'm', hasHistory: true, deliveredProject: nested },
    },
  });
  await mkdir(f.at('c'));
  await cp(f.at('w/main'), f.at('c/main'), { recursive: true });
  await rm(f.at('w/main'), { recursive: true });
  const report = await f.repair('c/main', {
    declared: { from: f.at('w/main'), to: f.at('c/main') },
  });
  assert.equal(
    (await f.saved('nested')).raw.cwd,
    f.at('c/main/nested'),
    JSON.stringify(report),
  );
});

test('an unprovable move is reported with its command, and a declared one repairs it', async () => {
  const f = await setup();
  await f.save('copied', 'w/main');
  await mkdir(f.at('c'));
  await cp(f.at('w/main'), f.at('c/main'), { recursive: true });
  await rm(f.at('w/main'), { recursive: true });
  const report = await f.repair('c/main');
  assert.ok(report.unresolved.some(({ path }) => path === f.at('w/main')));
  assert.ok(
    describeMoves(report, f.at('state'))!.includes(
      `--recover-directory ${quote(f.at('w/main'))}`,
    ),
  );
  const declared = { from: f.at('w/main'), to: f.at('c/main') };
  const preview = await f.repair('c/main', { declared, preview: true });
  assert.equal(preview.repaired[0]?.conversations, 1);
  assert.equal((await f.saved('copied')).raw.cwd, f.at('w/main'));
  assert.match(describeMoves(preview, f.at('state'), true)!, /--apply/);
  await f.repair('c/main', { declared });
  assert.equal((await f.saved('copied')).raw.cwd, f.at('c/main'));
  for (const from of ['relative', f.at('c/main')]) {
    const blocked = await f.repair('c/main', {
      declared: { from, to: f.at('c/main') },
    });
    assert.ok(blocked.blocked.length, from);
  }
});

test('an unreadable record is reported only for a declared move', async () => {
  const f = await setup();
  await f.save('good', 'w/main');
  await mkdir(f.at('state/conversations/bad'));
  const bad = f.at('state/conversations/bad/state.json');
  await writeFile(bad, '{');
  await rename(f.at('w'), f.at('c'));
  const report = await f.repair('c/main');
  assert.ok(!report.blocked.some(({ path }) => path.includes('bad')));
  assert.equal((await f.saved('good')).raw.cwd, f.at('c/main'));
  await mkdir(f.at('d'));
  await cp(f.at('c/main'), f.at('d/main'), { recursive: true });
  await rm(f.at('c/main'), { recursive: true });
  const declared = await f.repair('d/main', {
    declared: { from: f.at('c/main'), to: f.at('d/main') },
  });
  assert.ok(
    declared.blocked.some(({ path }) => path === bad),
    JSON.stringify(declared),
  );
});

test('a failure on one path is reported and the rest repair', async () => {
  const f = await setup();
  await mkdir(f.at('locked/inside'), { recursive: true });
  await mkdir(f.at('locked/from'));
  await f.save('locked', 'locked/inside');
  await f.save('earlier', 'locked/from');
  await f.save('fine', 'w/main');
  // the ledger knows both directories under `locked`, and a move out of one of them
  await f.repair('w/main');
  await rename(f.at('locked/from'), f.at('locked/to'));
  await f.repair('locked/to');
  assert.equal((await f.saved('earlier')).raw.cwd, f.at('locked/to'));
  await rename(f.at('w'), f.at('c'));
  await chmod(f.at('locked'), 0);
  try {
    const report = await f.repair('c/main');
    assert.ok(
      report.blocked.some(({ path }) => path === f.at('locked/inside')),
      JSON.stringify(report),
    );
    assert.equal((await f.saved('fine')).raw.cwd, f.at('c/main'));
  } finally {
    await chmod(f.at('locked'), 0o755);
  }
});

for (const held of ['main checkout', 'worktree'])
  test(`an inaccessible ${held} is reported and the rest repair`, async () => {
    const f = await setup();
    const other = f.at('locked/other');
    await mkdir(f.at('locked'));
    // the conversation that still repairs moves to the start directory, which every platform finds
    const [from, to] = held === 'worktree' ? ['w/main', 'w/moved'] : ['p', 'q'];
    if (held === 'worktree')
      await git(f.at('w/main'), 'worktree', 'add', '-q', '--detach', other);
    else {
      await mkdir(other);
      await git(other, 'init', '-q', '-b', 'main');
      await git(other, 'commit', '-q', '--allow-empty', '-m', 'other');
      await mkdir(f.at(from));
    }
    await f.save('fine', from);
    await f.repair(held === 'worktree' ? 'w/main' : 'locked/other');
    await rename(f.at(from), f.at(to));
    await chmod(f.at('locked'), 0);
    try {
      const report = await f.repair(to);
      assert.equal((await f.saved('fine')).raw.cwd, f.at(to));
      assert.ok(
        report.blocked.some(({ repository }) =>
          [other, f.at(to)].includes(repository ?? ''),
        ),
        JSON.stringify(report),
      );
    } finally {
      await chmod(f.at('locked'), 0o755);
    }
  });

test('a missing worktree with conversations in it is one line', async () => {
  const f = await setup();
  await f.save('inside', 'w/main-1');
  await f.repair('w/main');
  await rm(f.at('w/main-1'), { recursive: true });
  const report = await f.repair('w/main');
  assert.deepEqual(report.unresolved, [
    { path: f.at('w/main-1'), conversations: 1, worktree: true },
  ]);
  assert.match(
    describeMoves(report, f.at('state'))!,
    /a worktree that moved or was deleted, with 1 conversation\(s\)/,
  );
});

test('a history that cannot be read blocks its conversation instead of moving it without its history', async () => {
  const f = await setup();
  await f.save('looped', 'w/main');
  const history = f.at('state/conversations/looped/history.jsonl');
  await rm(history);
  await symlink(history, history);
  await rename(f.at('w'), f.at('c'));
  const report = await f.repair('c/main');
  assert.equal((await f.saved('looped')).raw.cwd, f.at('w/main'));
  assert.ok(
    report.blocked.some(({ path }) => path === f.at('w/main')),
    JSON.stringify(report),
  );
});

test('a prompt history that cannot be read stops the repair before any move is recorded', async () => {
  const f = await setup();
  const prompts = f.at('state/prompts.jsonl');
  await symlink(prompts, prompts);
  await rename(f.at('w'), f.at('c'));
  const before = await readLedger(f.at('state'));
  await assert.rejects(f.repair('c/main'), /ELOOP/);
  assert.deepEqual(await readLedger(f.at('state')), before);
});

test('a declared recovery from a copy Witch already started in keeps one ledger entry for it', async () => {
  const f = await setup();
  await f.save('copied', 'w/main');
  await mkdir(f.at('c'));
  await cp(f.at('w/main'), f.at('c/main'), { recursive: true });
  await rm(f.at('w/main'), { recursive: true });
  await f.repair('c/main');
  await f.repair('c/main', {
    declared: { from: f.at('w/main'), to: f.at('c/main') },
  });
  const { entries } = await readLedger(f.at('state'));
  assert.equal(entries.filter(({ path }) => path === f.at('c/main')).length, 1);
  assert.equal((await f.saved('copied')).raw.cwd, f.at('c/main'));
});

test.skipIf(!darwin)(
  'a declared copy where an earlier occupant moved away from is never traded for a stand-in',
  async () => {
    const f = await setup();
    await mkdir(f.at('d'));
    await f.save('occupant', 'd');
    await f.save('copied', 'w/main');
    await f.repair('d');
    // a conversation saved before the ledger knew its directory
    await updateLedger(f.at('state'), async (ledger) => {
      ledger.entries = ledger.entries.filter(({ path }) => path === f.at('d'));
    });
    await rename(f.at('d'), f.at('e'));
    await cp(f.at('w/main'), f.at('d'), { recursive: true });
    await rm(f.at('w/main'), { recursive: true });
    await repairMoves(f.store, f.memory, f.at('d'), {
      declared: { from: f.at('w/main'), to: f.at('d') },
      run: async (command, args, options) => {
        const result = await runCommand(command, args, options);
        if (args[0] === 'worktree' && args[1] === 'repair') {
          await rename(f.at('d'), f.at('actual'));
          await cp(f.at('actual'), f.at('d'), { recursive: true });
        }
        return result;
      },
    });
    await f.repair('d');
    assert.notEqual((await f.saved('copied')).raw.cwd, f.at('d'));
  },
);

test("a declared copy onto a deleted directory's path is repaired, not reported as a race", async () => {
  const f = await setup();
  for (const name of ['d', 's']) {
    await mkdir(f.at(name));
    await f.save(name, name);
  }
  await f.repair('d');
  await rm(f.at('d'), { recursive: true });
  await cp(f.at('s'), f.at('d'), { recursive: true });
  await rm(f.at('s'), { recursive: true });
  const report = await f.repair('d', {
    declared: { from: f.at('s'), to: f.at('d') },
  });
  assert.deepEqual(report.blocked, []);
  assert.equal((await f.saved('s')).raw.cwd, f.at('d'));
});

test("repair's worktree check runs none of the repository's clean filters", async () => {
  const f = await setup();
  const marker = f.at('filtered');
  await git(
    f.at('w/main'),
    'config',
    'filter.mark.clean',
    `sh -c 'touch ${quote(marker)}; cat'`,
  );
  await writeFile(f.at('w/main-1/.gitattributes'), '*.txt filter=mark\n');
  await writeFile(f.at('w/main-1/a.txt'), 'x\n');
  await git(f.at('w/main-1'), 'add', '.');
  await git(f.at('w/main-1'), 'commit', '-q', '-m', 'filtered');
  await rm(marker, { force: true });
  // a changed stat makes status read the file through its clean filter
  const later = new Date(Date.now() + 60_000);
  await utimes(f.at('w/main-1/a.txt'), later, later);
  await rename(f.at('w'), f.at('c'));
  const report = await f.repair('c/main');
  assert.deepEqual(report.blocked, []);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('a worktree registration left without its gitdir blocks its repository', async () => {
  const f = await setup();
  await rm(f.at('w/main/.git/worktrees/main-1/gitdir'));
  await rename(f.at('w/main'), f.at('w/renamed'));
  const report = await f.repair('w/renamed');
  assert.ok(
    report.blocked.some(
      ({ repository, reason }) =>
        repository === f.at('w/renamed') && /git worktree prune/.test(reason),
    ),
    JSON.stringify(report),
  );
});

test.skipIf(!darwin)(
  "a directory that moved where it can't be looked for is reported",
  async () => {
    const f = await setup();
    await mkdir(f.at('p'));
    await f.save('held', 'p');
    await f.repair('p');
    await mkdir(f.at('locked'));
    await rename(f.at('p'), f.at('locked/p'));
    await mkdir(f.at('p'));
    await chmod(f.at('locked'), 0);
    try {
      const report = await f.repair('w/main');
      assert.ok(
        report.blocked.some(({ path }) => path === f.at('p')),
        JSON.stringify(report),
      );
    } finally {
      await chmod(f.at('locked'), 0o755);
    }
  },
);

test("a repaired conversation's ownership counts from the mapping it followed, not the rewrite's end", async () => {
  const f = await setup();
  await f.save('moved', 'w/main');
  await rename(f.at('w'), f.at('c'));
  // the listing record() makes comes after the mapping was taken and before the rewrite
  let lists = 0;
  let during = 0;
  await repairMoves(f.store, f.memory, f.at('c/main'), {
    run: async (command, args, options) => {
      const result = await runCommand(command, args, options);
      if (args[0] === 'worktree' && args[1] === 'list' && ++lists === 2) {
        during = Date.now();
        await new Promise((settled) => setTimeout(settled, 5));
      }
      return result;
    },
  });
  const { raw } = await f.saved('moved');
  assert.equal(raw.cwd, f.at('c/main'));
  assert.ok(Date.parse(String(raw.cwdSince)) <= during, String(raw.cwdSince));
});

test('concurrent repairs leave every record moved and one move in the ledger', async () => {
  const f = await setup();
  for (const id of ['one', 'two', 'three']) await f.save(id, 'w/main');
  const before = await Promise.all(['one', 'two', 'three'].map(f.saved));
  await rename(f.at('w'), f.at('c'));
  await Promise.all([f.repair('c/main'), f.repair('c/main')]);
  await f.repair('c/main');
  for (const [index, id] of ['one', 'two', 'three'].entries()) {
    const after = await f.saved(id);
    assert.equal(after.raw.cwd, f.at('c/main'));
    assert.deepEqual(after.mtimes, before[index]!.mtimes);
  }
  const { moves } = await readLedger(f.at('state'));
  assert.equal(moves.filter(({ from }) => from === f.at('w/main')).length, 1);
});
