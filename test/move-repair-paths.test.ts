import assert from 'node:assert/strict';

import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';

import { test } from 'vitest';

import { runCommand } from '../src/core/command.js';

import { repairMoves } from '../src/core/move-repair.js';

import { readLedger } from '../src/persistence/directories.js';

import { StateStore } from '../src/persistence/store.js';

import { quote } from '../src/shell.js';

import { git } from './fixtures/git.js';

import { setup } from './fixtures/move-repair.js';

import { darwin } from './fixtures/move-repair.js';

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
