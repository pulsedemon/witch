import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants, promises as files } from 'node:fs';
import {
  appendFile,
  access,
  chmod,
  mkdir,
  open,
  readFile,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { exclusiveLock } from '../src/persistence/lock.js';
import { identifyProcess } from '../src/persistence/process.js';
import { LockedElsewhere, StateStore } from '../src/persistence/store.js';
import { foldDisplayUpdates } from '../src/core/state.js';
import type { Conversation } from '../src/core/state.js';
import { scratch } from './fixtures/scratch.js';
import { until, within } from './fixtures/within.js';

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

/** a detached shell like a `!` command's, and the pid of the sleep it runs in the background. both ignore SIGTERM, as a command can. */
async function detachedShell(seconds: string) {
  const child = spawn(
    '/bin/sh',
    ['-c', `trap "" TERM; sleep ${seconds} & echo $!; wait`],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const [data] = (await once(child.stdout, 'data')) as [Buffer];
  return { child, background: Number(String(data).trim()) };
}

await test('a real holder stays exclusive until close or crash', async (t) => {
  const root = await scratch('witch-lock-');
  const store = await StateStore.open(root);
  await (await store.create(conversation('held'))).close();
  for (const exit of ['close', 'crash']) {
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
    const ended = new Promise<void>((resolve) =>
      child.once('close', () => resolve()),
    );
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await ended;
    });
    await within(once(child.stdout, 'data'), 5000, 'holder ready');
    assert.equal(await store.isOpen('held'), true);
    await assert.rejects(store.claim('held'), /open in another Witch instance/);
    if (exit === 'close') child.stdin.end('close');
    else child.kill('SIGKILL');
    await within(ended, 5000, 'holder stopped');
    assert.equal(await store.isOpen('held'), false);
    await (await store.claim('held')).close();
  }
});

await test('conversation locks carry a registration lock that a lost race releases', async () => {
  const store = await StateStore.open(
    await scratch('witch-conversation-batch-'),
  );
  const held = await store.create(conversation('current'));
  await (await store.create(conversation('closed'))).close();
  await writeFile(join(store.root, 'conversations', '.DS_Store'), 'finder');
  await (await store.create(conversation('older'))).close();
  // an older Witch takes only `lock`
  const older = await open(
    join(store.root, 'conversations', 'older', 'lock'),
    constants.O_RDWR | constants.O_NONBLOCK | exclusiveLock,
  );
  assert.deepEqual(
    await store.openConversations(),
    new Map([
      ['current', { coordinated: true }],
      ['older', { coordinated: false }],
    ]),
  );
  await assert.rejects(store.claim('older'), LockedElsewhere);
  await older.close();
  const reclaimed = await store.claim('older');
  assert.deepEqual(
    await store.openConversations(['older']),
    new Map([['older', { coordinated: true }]]),
  );
  await reclaimed.close();
  await held.close();
  assert.deepEqual(
    await store.openConversations(['current', 'older']),
    new Map(),
  );
  await (await store.claim('current')).close();
});

await test('selected records exclude unreadable conversations and an empty selection reads nothing', async (t) => {
  const store = await StateStore.open(await scratch('witch-selected-records-'));
  const selected = conversation('selected', '/selected');
  await (await store.create(selected)).close();
  await (await store.create(conversation('damaged', '/damaged'))).close();
  const damaged = join(store.root, 'conversations', 'damaged', 'state.json');
  await writeFile(damaged, '{broken');
  const reading = t.mock.method(files, 'readFile');
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await store.records(['selected']), {
      records: [selected],
      unreadable: [],
    });
    assert.deepEqual(await store.records([]), { records: [], unreadable: [] });
    assert.deepEqual(
      reading.mock.calls.map(({ arguments: [file] }) => file),
      [join(store.root, 'conversations', 'selected', 'state.json')],
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  const all = await store.records();
  assert.deepEqual(all.records, [selected]);
  assert.deepEqual(
    all.unreadable.map(({ file }) => file),
    [damaged],
  );
});

await test("a legacy holder stays unregistered during a current owner's failed claim", async (t) => {
  const store = await StateStore.open(await scratch('witch-legacy-race-'));
  await (await store.create(conversation('older'))).close();
  const path = join(store.root, 'conversations', 'older', 'lock');
  const legacy = await open(
    path,
    constants.O_RDWR | constants.O_NONBLOCK | exclusiveLock,
  );
  t.after(() => legacy.close());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const opening = files.open;
  t.mock.method(
    files,
    'open',
    async (...args: Parameters<typeof files.open>) => {
      if (args[0] === path) {
        entered.resolve();
        await release.promise;
      }
      return opening(...args);
    },
  );
  syncBuiltinESMExports();
  const claiming = assert.rejects(store.claim('older'), LockedElsewhere);
  try {
    await within(entered.promise, 5000, 'claim holding coordinated');
    assert.deepEqual(
      await store.openConversations(['older']),
      new Map([['older', { coordinated: false }]]),
    );
  } finally {
    release.resolve();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await claiming;
  }
});

await test('closing after a lock observation never turns a current owner into a legacy owner', async () => {
  const root = await scratch('witch-close-probe-');
  const store = await StateStore.open(root);
  const held = await store.create(conversation('current'));
  await writeFile(
    join(root, 'PauseLock.pm'),
    `package PauseLock;
BEGIN {
  *CORE::GLOBAL::fcntl = sub (*$$) {
    my $result = CORE::fcntl($_[0], $_[1], $_[2]);
    open(my $ready, '>', "$ENV{WITCH_LOCK_PROBE}/ready") or die $!;
    close($ready) or die $!;
    while (!-e "$ENV{WITCH_LOCK_PROBE}/continue") { select(undef, undef, undef, 0.001); }
    return $result;
  };
}
1;
`,
  );
  const previous = {
    PERL5LIB: process.env.PERL5LIB,
    PERL5OPT: process.env.PERL5OPT,
    WITCH_LOCK_PROBE: process.env.WITCH_LOCK_PROBE,
  };
  process.env.PERL5LIB = root;
  process.env.PERL5OPT = '-MPauseLock';
  process.env.WITCH_LOCK_PROBE = root;
  const observing = store.openConversations(['current']);
  try {
    await until('lock observation', () =>
      access(join(root, 'ready')).then(
        () => true,
        () => false,
      ),
    );
    await held.close();
    await writeFile(join(root, 'continue'), '');
    assert.deepEqual(
      await observing,
      new Map([['current', { coordinated: true }]]),
    );
  } finally {
    try {
      await writeFile(join(root, 'continue'), '');
      await observing;
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await held.close();
    }
  }
});

await test('a second claim of a conversation is refused while another conversation claims fine', async () => {
  const store = await StateStore.open(await scratch('witch-claims-'));
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

await test('observing conversation ownership leaves its native process and stored data untouched', async () => {
  const root = await scratch('witch-observation-');
  const store = await StateStore.open(root);
  const files = await store.create(conversation('observed'));
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  const ended = once(child, 'exit');
  try {
    const identity = await identifyProcess(child.pid!);
    assert.ok(identity);
    await files.save({ ...files.record, process: identity });
    await files.append({
      id: 'n',
      kind: 'notice',
      text: 'kept',
      cwd: '/project',
    });
    const contents = () =>
      Promise.all(
        ['state.json', 'history.jsonl'].map((name) =>
          readFile(join(root, 'conversations', 'observed', name), 'utf8'),
        ),
      );
    const before = await contents();
    assert.equal(await store.isOpen('observed'), true);
    await assert.rejects(store.claim('observed'), LockedElsewhere);
    await files.close();
    assert.equal(await store.isOpen('observed'), false);
    assert.deepEqual(await contents(), before);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.equal(await store.isOpen('absent'), false);
    await assert.rejects(access(join(root, 'conversations', 'absent')), {
      code: 'ENOENT',
    });
    const lock = join(root, 'conversations', 'observed', 'lock');
    await chmod(lock, 0o000);
    try {
      await assert.rejects(store.isOpen('observed'), { code: 'EACCES' });
    } finally {
      await chmod(lock, 0o600);
    }
  } finally {
    await files.close();
    child.kill();
    await ended;
  }
});

await test('a closed conversation store rejects writes and leaves its files unchanged', async () => {
  const root = await scratch('witch-closed-');
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
  const root = await scratch('witch-failed-write-');
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

await test('a failed history close still releases both ownership locks', async (t) => {
  const store = await StateStore.open(await scratch('witch-history-close-'));
  const held = await store.create(conversation('current'));
  const failure = new Error('history close failed');
  const opening = files.open;
  t.mock.method(
    files,
    'open',
    async (...args: Parameters<typeof files.open>) => {
      const file = await opening(...args);
      if (String(args[0]).endsWith('/history.jsonl')) {
        const close = file.close.bind(file);
        t.mock.method(file, 'close', async () => {
          await close();
          throw failure;
        });
      }
      return file;
    },
  );
  syncBuiltinESMExports();
  try {
    await held.append({ id: 'n', kind: 'notice', text: 'kept', cwd: '/p' });
    await assert.rejects(held.close(), failure);
    assert.equal(await store.isOpen('current'), false);
    await (await store.claim('current')).close();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await held.close();
  }
});

await test('a claim that cannot stop the recorded process still kills the recorded shell, and releases its lock', async () => {
  const store = await StateStore.open(await scratch('witch-failed-claim-'));
  const agent = spawn(
    '/bin/sh',
    ['-c', "trap '' TERM; echo ready; exec /bin/sleep 20"],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const { child: shell } = await detachedShell('20.313');
  try {
    await once(agent.stdout, 'data');
    const files = await store.create(conversation('orphan'));
    await files.save({
      ...files.record,
      process: await identifyProcess(agent.pid!),
      shell: await identifyProcess(shell.pid!),
    });
    await files.close();
    await assert.rejects(store.claim('orphan'), /has not stopped/);
    assert.equal(shell.signalCode, 'SIGKILL');
    const agentExited = once(agent, 'exit');
    agent.kill('SIGKILL');
    await agentExited;
    await (await store.claim('orphan')).close();
  } finally {
    agent.kill('SIGKILL');
    try {
      process.kill(-shell.pid!, 'SIGKILL');
    } catch {
      // stopped by the claim
    }
  }
});

await test('a claim succeeds when the recorded process exits before its signal', async (t) => {
  const store = await StateStore.open(await scratch('witch-exited-claim-'));
  const child = spawn('/bin/sleep', ['20'], { stdio: 'ignore' });
  try {
    const files = await store.create(conversation('exited'));
    await files.save({
      ...files.record,
      process: await identifyProcess(child.pid!),
    });
    await files.close();
    t.mock.method(process, 'kill', () => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });
    const claimed = await store.claim('exited');
    assert.equal(claimed.record.process, undefined);
    await claimed.close();
  } finally {
    child.kill('SIGKILL');
  }
});

await test('a claim stops the recorded process after a time zone and locale change', async () => {
  const store = await StateStore.open(await scratch('witch-moved-zone-'));
  const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
  const child = spawn('/bin/sleep', ['20'], { stdio: 'ignore' });
  try {
    process.env.TZ = 'Asia/Tokyo';
    process.env.LC_ALL = 'de_DE.UTF-8';
    const files = await store.create(conversation('moved'));
    await files.save({
      ...files.record,
      process: await identifyProcess(child.pid!),
    });
    await files.close();
    process.env.TZ = 'America/New_York';
    delete process.env.LC_ALL;
    const exited = once(child, 'exit');
    const claimed = await store.claim('moved');
    await within(exited, 2000, 'the recorded process to stop');
    assert.equal(claimed.record.process, undefined);
    await claimed.close();
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    child.kill('SIGKILL');
  }
});

await test("a claim leaves running a process that reuses the recorded process's pid, and a group that reuses the recorded shell's", async () => {
  const store = await StateStore.open(await scratch('witch-reused-pid-'));
  const child = spawn('/bin/sleep', ['20'], { stdio: 'ignore' });
  const { child: shell } = await detachedShell('20.312');
  try {
    const files = await store.create(conversation('reused'));
    await files.save({
      ...files.record,
      process: { pid: child.pid!, started: 'Thu Jan  1 00:00:00 1970' },
      shell: { pid: shell.pid!, started: 'Thu Jan  1 00:00:00 1970' },
    });
    await files.close();
    await (await store.claim('reused')).close();
    assert.equal((await identifyProcess(child.pid!))?.pid, child.pid);
    assert.equal(shell.exitCode ?? shell.signalCode, null);
  } finally {
    child.kill('SIGKILL');
    try {
      process.kill(-shell.pid!, 'SIGKILL');
    } catch {
      // a wrong claim already stopped it
    }
  }
});

await test("a claim kills a recorded shell's whole group, a member its first signal missed included, and clears the record", async (t) => {
  const store = await StateStore.open(await scratch('witch-shell-claim-'));
  const { child, background } = await detachedShell('20.311');
  const kill = process.kill.bind(process);
  try {
    const files = await store.create(conversation('shell'));
    await files.save({
      ...files.record,
      shell: await identifyProcess(child.pid!),
    });
    await files.close();
    let missed = false;
    t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
      // the first group kill lands as the shell forks, so it reaches only the shell, which ps lists until it's reaped
      if (!missed && pid === -child.pid! && signal === 'SIGKILL') {
        missed = true;
        setTimeout(() => kill(child.pid!, 'SIGKILL'), 50);
        return true;
      }
      return kill(pid, signal);
    });
    const claimed = await store.claim('shell');
    await until(
      'the background sleep to exit',
      async () => !(await identifyProcess(background)),
    );
    assert.equal(claimed.record.shell, undefined);
    await claimed.close();
    const saved = JSON.parse(
      await readFile(join(claimed.directory, 'state.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(saved.shell, undefined);
  } finally {
    try {
      kill(-child.pid!, 'SIGKILL');
    } catch {
      // stopped by the claim
    }
  }
});

await test('serialized saves of one record keep the latest after restart', async () => {
  const store = await StateStore.open(await scratch('witch-state-'));
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

await test('a truncated final record cannot corrupt history written after restart', async () => {
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

await test("prompts list this directory's newest first after a restart, keep line breaks, and skip a line a crash cut short without losing the next", async () => {
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

await test('prompts one instance adds at once are stored newest first', async () => {
  const root = await scratch('witch-prompts-');
  const store = await StateStore.open(root);
  // long prompts take long enough to write that unordered appends land out of order in most runs
  const texts = [...'abcdefgh'].map((letter) => letter.repeat(2 ** 20));
  await Promise.all(texts.map((text) => store.addPrompt('/a', text)));
  assert.deepEqual(await store.prompts('/a'), texts.toReversed());
});

await test('prompts longer than a write chunk, stored by several instances at once, each read back whole', async () => {
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
