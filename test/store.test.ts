import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { StateStore } from '../src/persistence/store.js';
import { applyDisplayUpdate } from '../src/core/state.js';
import type { DisplayItem } from '../src/core/state.js';

await test('the CLI rejects a missing state directory before opening the store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'witch-cli-state-'));
  const cli = fileURLToPath(new URL('../src/cli.tsx', import.meta.url));
  for (const args of [[], [''], ['--state-dir']]) {
    const child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        cli,
        directory,
        '--state-dir',
        ...args,
      ],
      { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let error = '';
    child.stderr.on('data', (chunk: Buffer) => {
      error += chunk.toString();
    });
    const [code] = await once(child, 'close');
    assert.equal(code, 1);
    assert.match(error, /--state-dir requires a directory/);
    assert.deepEqual(await readdir(directory), []);
  }
});

await test('one app owns state until its process exits, including a crash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'witch-lock-'));
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('fixtures/lock.ts', import.meta.url)),
      root,
    ],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  try {
    await once(child.stdout, 'data');
    await assert.rejects(StateStore.open(root), /already running/);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const replacement = await StateStore.open(root);
    await replacement.close();
  } finally {
    child.kill();
  }
});

await test('serialized metadata saves preserve the latest conversation across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'witch-state-'));
  let store = await StateStore.open(root);
  await Promise.all([
    store.save({ version: 1, conversations: [], activeId: 'first' }),
    store.save({ version: 1, conversations: [], activeId: 'second' }),
  ]);
  await store.close();
  store = await StateStore.open(root);
  assert.equal((await store.load()).activeId, 'second');
  await store.close();
});

await test('display history keeps streamed deltas without duplicating final messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'witch-history-'));
  const store = await StateStore.open(root);
  try {
    await store.append('conversation', {
      id: 'message',
      kind: 'assistant',
      cwd: '/project',
      text: 'Hel',
    });
    await store.append('conversation', {
      id: 'message',
      kind: 'assistant',
      cwd: '/project',
      text: 'lo',
    });
    const streamed = (await store.history('conversation')).reduce<
      DisplayItem[]
    >(applyDisplayUpdate, []);
    assert.equal(streamed.length, 1);
    assert.equal(streamed[0]?.text, 'Hello');
    await store.append('conversation', {
      id: 'message',
      kind: 'assistant',
      cwd: '/project',
      text: 'Hello!',
      replace: true,
    });
    const items = (await store.history('conversation')).reduce<DisplayItem[]>(
      applyDisplayUpdate,
      [],
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]?.text, 'Hello!');
  } finally {
    await store.close();
  }
});

await test('a truncated final record cannot corrupt history written after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'witch-partial-'));
  let store = await StateStore.open(root);
  await store.append('c', {
    id: 'first',
    kind: 'notice',
    text: 'before',
    cwd: '/project',
  });
  await store.close();
  await appendFile(join(root, 'history', 'c.jsonl'), '{"id":"unfinished');
  store = await StateStore.open(root);
  try {
    await store.append('c', {
      id: 'next',
      kind: 'notice',
      text: 'after',
      cwd: '/project',
    });
    assert.deepEqual(
      (await store.history('c')).map((entry) => entry.text),
      ['before', 'after'],
    );
  } finally {
    await store.close();
  }
});
