import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { identifyProcess } from '../src/persistence/process.js';
import { LockedElsewhere, StateStore } from '../src/persistence/store.js';
import { foldDisplayUpdates } from '../src/core/state.js';
import type { Conversation } from '../src/core/state.js';

function conversation(id: string, cwd = '/project'): Conversation {
  return {
    id,
    title: id,
    cwd,
    agent: 'codex',
    sessions: {},
    createdAt: new Date().toISOString(),
  };
}

await test('one app owns a conversation until its process exits, including a crash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'witch-lock-'));
  const store = await StateStore.open(root);
  await (await store.create(conversation('held'))).close();
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('fixtures/lock.ts', import.meta.url)),
      root,
      'held',
    ],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  try {
    await once(child.stdout, 'data');
    await assert.rejects(store.claim('held'), /open in another Witch instance/);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await (await store.claim('held')).close();
  } finally {
    child.kill();
  }
});

await test('a second claim of a conversation is refused while another conversation claims fine', async () => {
  const store = await StateStore.open(
    await mkdtemp(join(tmpdir(), 'witch-claims-')),
  );
  const first = await store.create(conversation('first'));
  await (await store.create(conversation('second'))).close();
  try {
    await assert.rejects(
      store.claim('first'),
      (error) =>
        error instanceof LockedElsewhere &&
        /open in another Witch instance/.test(error.message),
    );
    await (await store.claim('second')).close();
  } finally {
    await first.close();
  }
});

await test('a closed conversation store rejects writes and leaves its files unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'witch-closed-'));
  const store = await StateStore.open(root);
  const files = await store.create(conversation('closed'));
  await files.append({ id: 'n', kind: 'notice', text: 'kept', cwd: '/p' });
  await files.close();
  const directory = join(root, 'conversations', 'closed');
  const before = await Promise.all(
    ['state.json', 'history.jsonl'].map((name) =>
      readFile(join(directory, name), 'utf8'),
    ),
  );
  await assert.rejects(
    files.save({ ...conversation('closed'), title: 'changed' }),
    /no longer open/,
  );
  await assert.rejects(
    files.append({ id: 'm', kind: 'notice', text: 'lost', cwd: '/p' }),
    /no longer open/,
  );
  assert.deepEqual(
    await Promise.all(
      ['state.json', 'history.jsonl'].map((name) =>
        readFile(join(directory, name), 'utf8'),
      ),
    ),
    before,
  );
});

await test('a failed write fails every later write and the close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'witch-failed-write-'));
  const store = await StateStore.open(root);
  const files = await store.create(conversation('failed'));
  const directory = join(root, 'conversations', 'failed');
  await chmod(directory, 0o500);
  try {
    await assert.rejects(
      files.append({ id: 'n', kind: 'notice', text: 'lost', cwd: '/p' }),
      /EACCES/,
    );
  } finally {
    await chmod(directory, 0o700);
  }
  await assert.rejects(
    files.append({ id: 'm', kind: 'notice', text: 'after', cwd: '/p' }),
    /EACCES/,
  );
  await assert.rejects(files.close(), /EACCES/);
});

await test('a claim that cannot stop the recorded process releases its lock', async () => {
  const store = await StateStore.open(
    await mkdtemp(join(tmpdir(), 'witch-failed-claim-')),
  );
  const child = spawn(
    '/bin/sh',
    ['-c', "trap '' TERM; echo ready; exec /bin/sleep 20"],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  try {
    await once(child.stdout, 'data');
    const files = await store.create(conversation('orphan'));
    await files.save({
      ...files.record,
      process: await identifyProcess(child.pid!),
    });
    await files.close();
    await assert.rejects(store.claim('orphan'), /has not stopped/);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await (await store.claim('orphan')).close();
  } finally {
    child.kill('SIGKILL');
  }
});

await test('a claim leaves running a process that reuses the recorded pid', async () => {
  const store = await StateStore.open(
    await mkdtemp(join(tmpdir(), 'witch-reused-pid-')),
  );
  const child = spawn('/bin/sleep', ['20'], { stdio: 'ignore' });
  try {
    const files = await store.create(conversation('reused'));
    await files.save({
      ...files.record,
      process: { pid: child.pid!, started: 'Thu Jan  1 00:00:00 1970' },
    });
    await files.close();
    await (await store.claim('reused')).close();
    assert.equal((await identifyProcess(child.pid!))?.pid, child.pid);
  } finally {
    child.kill('SIGKILL');
  }
});

await test('serialized saves of one record keep the latest after restart', async () => {
  const store = await StateStore.open(
    await mkdtemp(join(tmpdir(), 'witch-state-')),
  );
  const files = await store.create(conversation('saved'));
  await Promise.all([
    files.save({ ...files.record, title: 'first' }),
    files.save({ ...files.record, title: 'second' }),
  ]);
  await files.close();
  const reopened = await store.claim('saved');
  assert.equal(reopened.record.title, 'second');
  await reopened.close();
});

await test('display history keeps streamed deltas without duplicating final messages', async () => {
  const store = await StateStore.open(
    await mkdtemp(join(tmpdir(), 'witch-history-')),
  );
  const files = await store.create(conversation('streamed'));
  try {
    await files.append({
      id: 'message',
      kind: 'assistant',
      cwd: '/project',
      text: 'Hel',
    });
    await files.append({
      id: 'message',
      kind: 'assistant',
      cwd: '/project',
      text: 'lo',
    });
    const streamed = await files.items();
    assert.equal(streamed.length, 1);
    assert.equal(streamed[0]?.text, 'Hello');
    await files.append({
      id: 'message',
      kind: 'assistant',
      cwd: '/project',
      text: 'Hello!',
      replace: true,
    });
    const items = await files.items();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.text, 'Hello!');
  } finally {
    await files.close();
  }
});

await test('a truncated final record cannot corrupt history written after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'witch-partial-'));
  const store = await StateStore.open(root);
  let files = await store.create(conversation('c'));
  await files.append({
    id: 'first',
    kind: 'notice',
    text: 'before',
    cwd: '/project',
  });
  await files.close();
  await appendFile(
    join(root, 'conversations', 'c', 'history.jsonl'),
    '{"id":"unfinished',
  );
  files = await store.claim('c');
  try {
    assert.deepEqual(
      (await files.history()).map((entry) => entry.text),
      ['before'],
    );
    await files.append({
      id: 'next',
      kind: 'notice',
      text: 'after',
      cwd: '/project',
    });
    assert.deepEqual(
      (await files.history()).map((entry) => entry.text),
      ['before', 'after'],
    );
  } finally {
    await files.close();
  }
});

await test('replay folds appends, replacements and new ids, keeping a title an empty replacement omits', () => {
  assert.deepEqual(
    foldDisplayUpdates([
      { id: 'm', kind: 'assistant', text: 'Hel', cwd: '/p', title: 'codex' },
      {
        id: 't',
        kind: 'tool',
        text: 'partial',
        cwd: '/p',
        title: 'npm test',
        done: false,
      },
      { id: 'm', kind: 'assistant', text: 'lo', cwd: '/p' },
      {
        id: 't',
        kind: 'tool',
        text: 'final',
        cwd: '/p',
        title: '',
        done: true,
        replace: true,
      },
      { id: 'n', kind: 'notice', text: 'new', cwd: '/p' },
    ]),
    [
      { id: 'm', kind: 'assistant', text: 'Hello', cwd: '/p', title: 'codex' },
      {
        id: 't',
        kind: 'tool',
        text: 'final',
        cwd: '/p',
        title: 'npm test',
        done: true,
      },
      { id: 'n', kind: 'notice', text: 'new', cwd: '/p' },
    ],
  );
});

await test('an append keeps the cwd its item has, and a replacement takes its own', () => {
  const tool = { id: 't', kind: 'tool', title: '', done: false } as const;
  assert.equal(
    foldDisplayUpdates([
      { ...tool, text: '', cwd: '/p/sub', replace: true },
      { ...tool, text: 'a.md', cwd: '/p' },
    ])[0]?.cwd,
    '/p/sub',
  );
  assert.equal(
    foldDisplayUpdates([
      { ...tool, text: '', cwd: '/p' },
      { ...tool, text: 'a.md', cwd: '/p/sub', replace: true },
    ])[0]?.cwd,
    '/p/sub',
  );
});

await test("listing keeps this directory's conversations with history, newest history first, and a stray file is no unreadable record", async () => {
  const root = await mkdtemp(join(tmpdir(), 'witch-listing-'));
  const store = await StateStore.open(root);
  for (const [id, cwd, history] of [
    ['a', '/project', true],
    ['b', '/project', true],
    ['c', '/project', true],
    ['elsewhere', '/other', true],
    ['empty', '/project', false],
  ] as const) {
    const files = await store.create(conversation(id, cwd));
    if (history) await files.append({ id: 'n', kind: 'notice', text: id, cwd });
    await files.close();
  }
  await mkdir(join(root, 'conversations', 'stray'));
  await writeFile(join(root, 'conversations', '.DS_Store'), '');
  assert.deepEqual((await store.records()).unreadable, []);
  for (const [id, seconds] of [
    ['a', 1000],
    ['b', 3000],
    ['c', 2000],
  ] as const)
    await utimes(
      join(root, 'conversations', id, 'history.jsonl'),
      seconds,
      seconds,
    );
  assert.deepEqual(
    (await store.conversations('/project')).map(({ id }) => id),
    ['b', 'c', 'a'],
  );
});
