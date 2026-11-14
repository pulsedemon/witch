import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as files } from 'node:fs';
import {
  access,
  appendFile,
  chmod,
  mkdir,
  readFile,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { StateStore } from '../src/persistence/store.js';
import {
  applyDisplayUpdate,
  displayUpdateSchema,
  foldDisplayUpdates,
} from '../src/core/state.js';
import type {
  ConversationRecord,
  DisplayItem,
  DisplayUpdate,
} from '../src/core/state.js';
import { scratch } from './fixtures/scratch.js';
import { within } from './fixtures/within.js';
import { conversation } from './fixtures/store.js';

async function recordedHistory(directory: string): Promise<DisplayUpdate[]> {
  const content = await readFile(join(directory, 'history.jsonl'), 'utf8');

  return content
    .trim()
    .split('\n')
    .map((line) => displayUpdateSchema.parse(JSON.parse(line)));
}

test('display history keeps streamed deltas without duplicating final messages', async () => {
  const store = await StateStore.open(await scratch('witch-history-'));
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

test('a history burst writes one replacement and settles its appends', async (t) => {
  const store = await StateStore.open(await scratch('witch-history-burst-'));
  const held = await store.create(conversation('burst'));

  t.onTestFinished(() => held.close());

  const update = { id: 'm', kind: 'assistant', cwd: '/project' } as const;

  const writes = Array.from({ length: 1000 }, (_, index) =>
    held.append({ ...update, text: `chunk ${index}\n` }),
  );

  writes.push(held.append({ ...update, text: 'finished', replace: true }));

  await Promise.all(writes);

  const records = await recordedHistory(held.directory);

  assert.equal(records.length, 1);

  assert.equal(records[0]?.text, 'finished');

  assert.equal((await held.items())[0]?.text, 'finished');
});

test(
  'history streams keep the first deadline and append only new text after it',
  { timeout: 5000 },
  async (t) => {
    const store = await StateStore.open(await scratch('witch-history-timer-'));
    const held = await store.create(conversation('timer'));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    t.onTestFinished(async () => {
      try {
        await held.close();
      } finally {
        vi.useRealTimers();
      }
    });

    const update = { id: 'm', kind: 'assistant', cwd: '/project' } as const;
    const first = held.append({ ...update, text: 'first' });

    vi.advanceTimersByTime(99);

    const second = held.append({ ...update, text: 'second' });

    await assert.rejects(access(join(held.directory, 'history.jsonl')), {
      code: 'ENOENT',
    });

    vi.advanceTimersByTime(1);

    await Promise.all([first, second]);

    assert.deepEqual(
      (await recordedHistory(held.directory)).map(({ text }) => text),
      ['firstsecond'],
    );

    const third = held.append({ ...update, text: 'third' });

    vi.advanceTimersByTime(100);

    await third;

    assert.deepEqual(
      (await recordedHistory(held.directory)).map(({ text }) => text),
      ['firstsecond', 'third'],
    );

    await held.append({ ...update, text: 'replacement', replace: true });

    assert.equal((await held.items())[0]?.text, 'replacement');
  },
);

test('history batches preserve first appearance order across returning ids', async (t) => {
  const store = await StateStore.open(await scratch('witch-history-order-'));
  const held = await store.create(conversation('order'));

  t.onTestFinished(() => held.close());

  const update = { kind: 'assistant', cwd: '/project' } as const;

  const writes = [
    held.append({ ...update, id: 'A', text: 'first' }),
    held.append({ ...update, id: 'B', text: 'middle' }),
    held.append({ ...update, id: 'A', text: 'last' }),
  ];

  await held.flush();

  await Promise.all(writes);

  assert.deepEqual(
    (await recordedHistory(held.directory)).map(({ id }) => id),
    ['A', 'B', 'A'],
  );

  assert.deepEqual(
    (await held.items()).map(({ id, text }) => [id, text]),
    [
      ['A', 'firstlast'],
      ['B', 'middle'],
    ],
  );
});

test('history batches snapshot metadata and retain it across appends and replacements', async (t) => {
  const store = await StateStore.open(await scratch('witch-history-metadata-'));
  const held = await store.create(conversation('metadata'));

  t.onTestFinished(() => held.close());

  const images = ['first.png'];

  const diff: NonNullable<DisplayUpdate['diff']> = [
    {
      path: 'before.ts',
      kind: 'add',
      hunks: [{ oldStart: 0, newStart: 1, lines: ['+before'] }],
    },
  ];

  const update = { id: 'tool', kind: 'tool', done: false } as const;

  const first = held.append({
    ...update,
    text: 'head',
    cwd: '/sub',
    title: 'command',
    shell: true,
    images,
    diff,
    at: '2026-10-23T10:00:00.000Z',
  });

  images[0] = 'changed.png';

  diff[0]!.hunks[0]!.lines[0] = '+changed';

  const second = held.append({
    ...update,
    text: 'tail',
    cwd: '/root',
    title: '',
    at: '2026-10-23T10:00:01.000Z',
  });

  await held.flush();

  await Promise.all([first, second]);

  assert.equal((await held.items())[0]?.cwd, '/sub');

  assert.equal((await held.items())[0]?.text, 'headtail');

  await held.append({
    ...update,
    text: 'done',
    cwd: '/new',
    title: '',
    done: true,
    replace: true,
    at: '2026-10-23T10:00:02.000Z',
  });

  assert.deepEqual(await held.items(), [
    {
      id: 'tool',
      kind: 'tool',
      done: true,
      text: 'done',
      cwd: '/new',
      title: 'command',
      shell: true,
      images: ['first.png'],
      diff: [
        {
          path: 'before.ts',
          kind: 'add',
          hunks: [{ oldStart: 0, newStart: 1, lines: ['+before'] }],
        },
      ],
      at: '2026-10-23T10:00:02.000Z',
    },
  ]);
});

for (const boundary of [
  'save',
  'flush',
  'history',
  'items',
  'close',
] as const) {
  test(
    `pending history drains before ${boundary} completes`,
    { timeout: 5000 },
    async (t) => {
      const store = await StateStore.open(
        await scratch('witch-history-boundary-'),
      );

      const held = await store.create(conversation('boundary'));

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      t.onTestFinished(async () => {
        try {
          await held.close();
        } finally {
          vi.useRealTimers();
        }
      });

      const update = {
        id: 'm',
        kind: 'assistant',
        text: 'pending',
        cwd: '/project',
      } as const;

      const writing = held.append(update);

      if (boundary === 'save')
        await held.save({ ...held.record, title: 'saved' });
      else await held[boundary]();

      await writing;

      assert.equal((await recordedHistory(held.directory))[0]?.text, 'pending');

      if (boundary === 'close') {
        await assert.rejects(held.append(update), /no longer open/);

        const reopened = await store.claim('boundary');

        try {
          vi.advanceTimersByTime(1000);

          assert.equal((await recordedHistory(held.directory)).length, 1);

          assert.equal((await reopened.items())[0]?.text, 'pending');
        } finally {
          await reopened.close();
        }
      }
    },
  );
}

test('close waits for in-flight history and drains the next batch once', async () => {
  const store = await StateStore.open(await scratch('witch-history-flight-'));
  const held = await store.create(conversation('flight'));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const opening = files.open;

  vi.spyOn(files, 'open').mockImplementation(
    async (...args: Parameters<typeof files.open>) => {
      const file = await opening(...args);

      if (String(args[0]).endsWith('/history.jsonl')) {
        const write = file.writeFile.bind(file);

        vi.spyOn(file, 'writeFile').mockImplementation(
          async (...args: Parameters<typeof write>) => {
            entered.resolve();

            await release.promise;

            return write(...args);
          },
        );
      }

      return file;
    },
  );

  syncBuiltinESMExports();

  let closing: Promise<void> | undefined;

  try {
    let appended = false;
    let closed = false;
    const update = { id: 'm', kind: 'assistant', cwd: '/project' } as const;

    const first = held.append({ ...update, text: 'before' }).then(() => {
      appended = true;
    });

    const flushing = held.flush();

    await within(entered.promise, 5000, 'history write entered');

    const second = held.append({ ...update, text: 'after' });

    closing = held.close().then(() => {
      closed = true;
    });

    await Promise.resolve();

    assert.equal(appended, false);

    assert.equal(closed, false);

    release.resolve();

    await Promise.all([first, second, flushing, closing]);

    assert.deepEqual(
      (await recordedHistory(held.directory)).map(({ text }) => text),
      ['before', 'after'],
    );

    const reclaimed = await store.claim('flight');

    await reclaimed.close();
  } finally {
    release.resolve();

    await closing;

    await held.close();

    vi.restoreAllMocks();

    syncBuiltinESMExports();
  }
});

test('a timer write rejects its batch and later operations while releasing locks', async () => {
  const store = await StateStore.open(await scratch('witch-history-failure-'));
  const held = await store.create(conversation('failure'));

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const update = { id: 'm', kind: 'assistant', cwd: '/project' } as const;

  await chmod(held.directory, 0o500);

  try {
    const first = assert.rejects(
      held.append({ ...update, text: 'first' }),
      /EACCES/,
    );

    const second = assert.rejects(
      held.append({ ...update, text: 'second' }),
      /EACCES/,
    );

    vi.advanceTimersByTime(100);

    await Promise.all([first, second]);

    await chmod(held.directory, 0o700);

    await assert.rejects(held.append({ ...update, text: 'later' }), /EACCES/);

    await assert.rejects(held.flush(), /EACCES/);

    await assert.rejects(held.close(), /EACCES/);

    await (await store.claim('failure')).close();
  } finally {
    await chmod(held.directory, 0o700);

    await held.close().catch(() => {});

    vi.useRealTimers();
  }
});

for (const kind of ['assistant', 'tool'] as const) {
  test(`a crashed writer retains timer-written ${kind} text`, async (t) => {
    const store = await StateStore.open(await scratch('witch-history-crash-'));

    await (await store.create(conversation('crash'))).close();

    const child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('fixtures/history-stream.ts', import.meta.url)),
        store.root,
        'crash',
        kind,
      ],
      { cwd: store.root, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const ended = new Promise<void>((resolve) =>
      child.once('close', () => resolve()),
    );

    t.onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');

      await ended;
    });

    const [ready] = await within(
      once(child.stdout, 'data'),
      5000,
      'timer-written history',
    );

    assert.equal(String(ready), 'written\n');

    child.kill('SIGKILL');

    await within(ended, 5000, 'history writer exit');

    const reopened = await store.claim('crash');

    try {
      assert.deepEqual(
        (await reopened.items()).map(({ kind, text }) => ({ kind, text })),
        [{ kind, text: 'firstsecond' }],
      );

      assert.equal((await recordedHistory(reopened.directory)).length, 1);
    } finally {
      await reopened.close();
    }
  });
}

test('a truncated final record cannot corrupt history written after restart', async () => {
  const root = await scratch('witch-partial-');
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

for (const [name, complete, partial, expectedRead] of [
  ['empty', false, '', 0],
  ['complete', true, '', 1],
  ['multiple windows', true, 'x'.repeat(8193), 12289],
  ['window boundary', true, 'x'.repeat(4096), 4097],
  ['only unfinished', false, '{"unfinished":', 14],
] as const) {
  test(`history append inspects only the required tail: ${name}`, async () => {
    const store = await StateStore.open(await scratch('witch-history-tail-'));

    await (await store.create(conversation('tail'))).close();

    const path = join(store.root, 'conversations', 'tail', 'history.jsonl');

    const prefix = complete
      ? `${JSON.stringify({ id: 'old', kind: 'notice', text: 'x'.repeat(65536), cwd: '/before' })}\n`
      : '';

    await writeFile(path, prefix + partial);

    const opening = files.open;
    let fullReads = 0;
    let bytesRead = 0;

    vi.spyOn(files, 'open').mockImplementation(
      async (...args: Parameters<typeof files.open>) => {
        const file = await opening(...args);

        if (args[0] === path) {
          const read = file.read.bind(file);
          const readAll = file.readFile.bind(file);

          vi.spyOn(file, 'read').mockImplementation(
            async (...args: Parameters<typeof read>) => {
              const result = await read(...args);

              bytesRead += result.bytesRead;

              return result;
            },
          );

          vi.spyOn(file, 'readFile').mockImplementation(
            (...args: Parameters<typeof readAll>) => {
              fullReads++;

              return readAll(...args);
            },
          );
        }

        return file;
      },
    );

    syncBuiltinESMExports();

    const held = await store.claim('tail');

    try {
      await held.append({
        id: 'new',
        kind: 'notice',
        text: 'after',
        cwd: '/after',
      });

      await held.close();

      assert.equal(
        await readFile(path, 'utf8'),
        prefix + '{"id":"new","kind":"notice","text":"after","cwd":"/after"}\n',
      );

      assert.equal(fullReads, 0);

      assert.equal(bytesRead, expectedRead);
    } finally {
      vi.restoreAllMocks();

      syncBuiltinESMExports();

      await held.close();
    }
  });
}

for (const [path, reduce] of [
  ['replay', foldDisplayUpdates],
  [
    'live',
    (updates: readonly DisplayUpdate[]) =>
      updates.reduce<DisplayItem[]>(applyDisplayUpdate, []),
  ],
] as const) {
  test(`${path} folds appends, replacements and new ids, keeping a title an empty replacement omits`, () => {
    assert.deepEqual(
      reduce([
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
        {
          id: 'm',
          kind: 'assistant',
          text: 'Hello',
          cwd: '/p',
          title: 'codex',
        },
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

  test(`${path}: an append keeps the cwd its item has, and a replacement takes its own`, () => {
    const tool = { id: 't', kind: 'tool', title: '', done: false } as const;

    assert.equal(
      reduce([
        { ...tool, text: '', cwd: '/p/sub', replace: true },
        { ...tool, text: 'a.md', cwd: '/p' },
      ])[0]?.cwd,
      '/p/sub',
    );

    assert.equal(
      reduce([
        { ...tool, text: '', cwd: '/p' },
        { ...tool, text: 'a.md', cwd: '/p/sub', replace: true },
      ])[0]?.cwd,
      '/p/sub',
    );
  });
}

test("listing keeps this directory's conversations with history, newest history first, and a stray file is no unreadable record", async () => {
  const root = await scratch('witch-listing-');
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

test("listing keeps a conversation with a saved draft or queue but no history, placed by and carrying its record's time", async () => {
  const root = await scratch('witch-listing-');
  const store = await StateStore.open(root);

  const conversations: [
    string,
    Pick<ConversationRecord, 'draft' | 'queue'>?,
  ][] = [
    ['a'],
    ['b'],
    ['drafted', { draft: 'unsent' }],
    ['queued', { queue: ['waiting'] }],
    ['empty', {}],
  ];

  for (const [id, saved] of conversations) {
    const files = await store.create(conversation(id, '/project'));

    if (saved) await files.save({ ...files.record, ...saved });
    else
      await files.append({
        id: 'n',
        kind: 'notice',
        text: id,
        cwd: '/project',
      });

    await files.close();
  }

  for (const [id, file, seconds] of [
    ['a', 'history.jsonl', 1000],
    ['b', 'history.jsonl', 3000],
    ['drafted', 'state.json', 2000],
    ['queued', 'state.json', 500],
  ] as const)
    await utimes(join(root, 'conversations', id, file), seconds, seconds);

  assert.deepEqual(
    (await store.conversations('/project')).map(({ id, modified }) => [
      id,
      modified,
    ]),
    [
      ['b', 3_000_000],
      ['drafted', 2_000_000],
      ['a', 1_000_000],
      ['queued', 500_000],
    ],
  );
});

test("prompts list this directory's newest first after a restart, keep line breaks, and skip a line a crash cut short without losing the next", async () => {
  const root = await scratch('witch-prompts-');
  const store = await StateStore.open(root);

  assert.deepEqual(await store.prompts('/a'), []);

  await store.addPrompt('/a', 'one');

  await store.addPrompt('/b', 'other');

  await store.addPrompt('/a', 'two\nlines');

  // a cut append still wrote the line break it starts with
  await appendFile(join(root, 'prompts.jsonl'), '\n{"cwd":"/a","text":"cut');

  await (await StateStore.open(root)).addPrompt('/a', 'three');

  const reopened = await StateStore.open(root);

  assert.deepEqual(await reopened.prompts('/a'), [
    'three',
    'two\nlines',
    'one',
  ]);

  assert.deepEqual(await reopened.prompts('/b'), ['other']);
});

test("a prompt's image markers are stored without their numbers, which name images only in the process that pasted them", async () => {
  const root = await scratch('witch-prompts-');

  await (
    await StateStore.open(root)
  ).addPrompt('/a', 'see [Image #1] and [Image #12], not [Image #3');

  await (
    await StateStore.open(root)
  ).addPrompt('/a', "!printf '%s' '[Image #12]'");

  assert.deepEqual(await (await StateStore.open(root)).prompts('/a'), [
    "!printf '%s' '[Image #12]'",
    'see [Image] and [Image], not [Image #3',
  ]);
});

test('prompts one instance adds at once are stored newest first', async () => {
  const root = await scratch('witch-prompts-');
  const store = await StateStore.open(root);
  // long prompts take long enough to write that unordered appends land out of order in most runs
  const texts = [...'abcdefgh'].map((letter) => letter.repeat(2 ** 20));

  await Promise.all(texts.map((text) => store.addPrompt('/a', text)));

  assert.deepEqual(await store.prompts('/a'), texts.toReversed());
});

test('prompts longer than a write chunk, stored by several instances at once, each read back whole', async () => {
  const root = await scratch('witch-prompts-');

  const stores = await Promise.all(
    [1, 2, 3, 4].map(() => StateStore.open(root)),
  );

  // appendFile writes 512 KiB at a time, and appends running at once split each other's longer records
  const texts = [...'abcd'].map((letter) => letter.repeat(2 ** 20));

  await Promise.all(
    texts.map((text, index) => stores[index]!.addPrompt('/a', text)),
  );

  assert.deepEqual((await stores[0]!.prompts('/a')).sort(), texts);
});
