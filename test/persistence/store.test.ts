import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants, promises as files } from 'node:fs';
import { access, chmod, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { openLocked } from '../../src/persistence/lock.js';
import { identifyProcess } from '../../src/persistence/process.js';
import { LockedElsewhere, StateStore } from '../../src/persistence/store.js';
import { scratch } from '../fixtures/scratch.js';
import { appears, settled, until, within } from '../fixtures/within.js';
import { conversation } from '../fixtures/store.js';

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

test('a real holder stays exclusive until close or crash', async (t) => {
  const root = await scratch('witch-lock-');
  const store = await StateStore.open(root);
  await (await store.create(conversation('held'))).close();

  for (const exit of ['close', 'crash']) {
    const child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('../fixtures/lock.ts', import.meta.url)),
        root,
        'held',
      ],
      { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const ended = new Promise<void>((resolve) =>
      child.once('close', () => resolve()),
    );

    t.onTestFinished(async () => {
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

test('conversation locks carry a registration lock that a lost race releases', async () => {
  const store = await StateStore.open(
    await scratch('witch-conversation-batch-'),
  );

  const held = await store.create(conversation('current'));
  await (await store.create(conversation('closed'))).close();
  await writeFile(join(store.root, 'conversations', '.DS_Store'), 'finder');
  await (await store.create(conversation('older'))).close();

  // an older Witch takes only `lock`
  const older = await openLocked(
    join(store.root, 'conversations', 'older', 'lock'),
    constants.O_RDWR | constants.O_NONBLOCK,
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

test('selected records exclude unreadable conversations and an empty selection reads nothing', async () => {
  const store = await StateStore.open(await scratch('witch-selected-records-'));
  const created = await store.create(conversation('selected', '/selected'));
  const selected = created.record;
  await created.close();
  await (await store.create(conversation('damaged', '/damaged'))).close();
  const damaged = join(store.root, 'conversations', 'damaged', 'state.json');
  await writeFile(damaged, '{broken');
  const reading = vi.spyOn(files, 'readFile');
  syncBuiltinESMExports();

  try {
    assert.deepEqual(await store.records(['selected']), {
      records: [selected],
      unreadable: [],
    });

    assert.deepEqual(await store.records([]), { records: [], unreadable: [] });

    assert.deepEqual(
      reading.mock.calls.map(([file]) => file),
      [join(store.root, 'conversations', 'selected', 'state.json')],
    );
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  }

  const all = await store.records();
  assert.deepEqual(all.records, [selected]);

  assert.deepEqual(
    all.unreadable.map(({ file }) => file),
    [damaged],
  );
});

test("a legacy holder stays unregistered during a current owner's failed claim", async (t) => {
  const store = await StateStore.open(await scratch('witch-legacy-race-'));
  await (await store.create(conversation('older'))).close();
  const path = join(store.root, 'conversations', 'older', 'lock');

  const legacy = await openLocked(
    path,
    constants.O_RDWR | constants.O_NONBLOCK,
  );

  t.onTestFinished(() => legacy.close());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const opening = files.open;

  vi.spyOn(files, 'open').mockImplementation(
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
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await claiming;
  }
});

test('closing after a lock observation never turns a current owner into a legacy owner', async () => {
  const root = await scratch('witch-close-probe-');
  const store = await StateStore.open(root);
  const held = await store.create(conversation('current'));

  await writeFile(
    join(root, 'PauseLock.pm'),
    `package PauseLock;
BEGIN {
  my $pause = sub {
    open(my $ready, '>', "$ENV{WITCH_LOCK_PROBE}/ready") or die $!;
    close($ready) or die $!;
    while (!-e "$ENV{WITCH_LOCK_PROBE}/continue") { select(undef, undef, undef, 0.001); }
  };
  if ($^O eq 'linux') {
    *CORE::GLOBAL::close = sub (*) {
      my $target = readlink('/proc/self/fd/' . fileno($_[0]));
      my $result = CORE::close($_[0]);
      $pause->() if defined($target) && $target eq '/proc/locks';
      return $result;
    };
  } else {
    *CORE::GLOBAL::fcntl = sub (*$$) {
      my $result = CORE::fcntl($_[0], $_[1], $_[2]);
      $pause->();
      return $result;
    };
  }
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
    await appears(join(root, 'ready'), 'lock observation');
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

test('a second claim of a conversation is refused while another conversation claims fine', async () => {
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

test('observing conversation ownership leaves its native process and stored data untouched', async () => {
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

test('a closed conversation store rejects writes and leaves its files unchanged', async () => {
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

test("a saved image is a new private file in the conversation's images directory", async () => {
  const root = await scratch('witch-images-');
  const store = await StateStore.open(root);
  const pictures = await store.create(conversation('pictures'));

  try {
    const first = await pictures.saveImage(Buffer.from('first'), 'png');
    const second = await pictures.saveImage(Buffer.from('second'), 'jpg');
    const directory = join(root, 'conversations', 'pictures', 'images');
    assert.deepEqual([dirname(first), dirname(second)], [directory, directory]);
    assert.match(first, /\/[0-9a-f-]{36}\.png$/);
    assert.match(second, /\/[0-9a-f-]{36}\.jpg$/);

    assert.deepEqual(
      await Promise.all([first, second].map((path) => readFile(path, 'utf8'))),
      ['first', 'second'],
    );

    assert.equal((await files.stat(directory)).mode & 0o777, 0o700);

    for (const path of [first, second])
      assert.equal((await files.stat(path)).mode & 0o777, 0o600);
  } finally {
    await pictures.close();
  }
});

test('closing a conversation waits for an image save it accepted and refuses saves after it', async (t) => {
  const root = await scratch('witch-image-close-');
  const store = await StateStore.open(root);
  const pictures = await store.create(conversation('pictures'));
  const held = Promise.withResolvers<void>();
  const write = files.writeFile;

  t.onTestFinished(() => {
    held.resolve();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  vi.spyOn(files, 'writeFile').mockImplementation(async (...args) => {
    await held.promise;

    return write(...args);
  });

  syncBuiltinESMExports();
  const saving = pictures.saveImage(Buffer.from('late'), 'png');
  let closed = false;
  const closing = pictures.close().then(() => (closed = true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closed, false);
  held.resolve();
  const path = await saving;
  await closing;
  assert.equal(await readFile(path, 'utf8'), 'late');

  await assert.rejects(
    pictures.saveImage(Buffer.from('after'), 'png'),
    /no longer open/,
  );
});

test('a failed write fails every later write and the close', async () => {
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

test('a failed history close still releases both ownership locks', async () => {
  const store = await StateStore.open(await scratch('witch-history-close-'));
  const held = await store.create(conversation('current'));
  const failure = new Error('history close failed');
  const opening = files.open;

  vi.spyOn(files, 'open').mockImplementation(
    async (...args: Parameters<typeof files.open>) => {
      const file = await opening(...args);

      if (String(args[0]).endsWith('/history.jsonl')) {
        const close = file.close.bind(file);

        vi.spyOn(file, 'close').mockImplementation(async () => {
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
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await held.close();
  }
});

test('a claim that cannot stop the recorded process still kills the recorded shell, and releases its lock', async () => {
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

for (const field of ['usageProcess', 'answerProcess'] as const) {
  for (const main of [false, true]) {
    test(`a claim stops the recorded ${field}${main ? ' and main process' : ' without a main process'}`, async () => {
      const store = await StateStore.open(await scratch('witch-usage-claim-'));

      const children = Array.from({ length: main ? 2 : 1 }, () =>
        spawn('/bin/sleep', ['30'], { stdio: 'ignore' }),
      );

      try {
        const files = await store.create(conversation('usage'));

        await files.save({
          ...files.record,
          [field]: await identifyProcess(children[0]!.pid!),
          ...(main
            ? { process: await identifyProcess(children[1]!.pid!) }
            : {}),
        });

        await files.close();
        const closed = children.map((child) => once(child, 'close'));
        const recovered = await store.claim('usage');
        await Promise.all(closed);
        assert.equal(recovered.record.process, undefined);
        assert.equal(recovered.record[field], undefined);
        await recovered.close();

        const saved = JSON.parse(
          await readFile(
            join(store.root, 'conversations', 'usage', 'state.json'),
            'utf8',
          ),
        ) as Partial<Record<typeof field | 'process', unknown>>;

        assert.equal(saved.process, undefined);
        assert.equal(saved[field], undefined);
      } finally {
        for (const child of children) child.kill('SIGKILL');
      }
    });
  }

  test(`a claim does not signal a process that reused the ${field} pid`, async () => {
    const store = await StateStore.open(await scratch('witch-usage-reused-'));
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });

    try {
      const files = await store.create(conversation('reused-usage'));

      await files.save({
        ...files.record,
        [field]: { pid: child.pid!, started: 'Thu Jan  1 00:00:00 1970' },
      });

      await files.close();
      const recovered = await store.claim('reused-usage');
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      assert.equal(recovered.record[field], undefined);
      await recovered.close();
    } finally {
      child.kill('SIGKILL');
    }
  });
}

test('a failed main stop retains the recovery lock until the usage helper stop settles', async () => {
  const store = await StateStore.open(await scratch('witch-usage-stop-'));
  const main = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });

  const helper = spawn(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM',()=>process.stdout.write('stopping\\n'));process.stdin.on('data',()=>process.exit());console.log('ready')",
    ],
    { stdio: 'pipe' },
  );

  const kill = process.kill.bind(process);
  let recovering: Promise<unknown> | undefined;

  try {
    await once(helper.stdout, 'data');
    const files = await store.create(conversation('usage-stop'));

    await files.save({
      ...files.record,
      process: await identifyProcess(main.pid!),
      usageProcess: await identifyProcess(helper.pid!),
    });

    await files.close();
    const signalled = once(helper.stdout, 'data');

    vi.spyOn(process, 'kill').mockImplementation(
      (pid: number, signal?: string | number) => {
        if (pid === main.pid && signal === 'SIGTERM')
          throw new Error('Main stop failed');

        return kill(pid, signal);
      },
    );

    recovering = assert.rejects(store.claim('usage-stop'), /Main stop failed/);
    const isSettled = settled(recovering);
    await signalled;
    assert.equal(await store.isOpen('usage-stop'), true);
    assert.equal(isSettled(), false);
    const closed = once(helper, 'close');
    helper.stdin.write('finish');
    await recovering;
    await closed;
    assert.equal(await store.isOpen('usage-stop'), false);
  } finally {
    vi.restoreAllMocks();
    main.kill('SIGKILL');
    helper.kill('SIGKILL');
    await recovering;
  }
});

test('a claim succeeds when the recorded process exits before its signal', async () => {
  const store = await StateStore.open(await scratch('witch-exited-claim-'));
  const child = spawn('/bin/sleep', ['20'], { stdio: 'ignore' });

  try {
    const files = await store.create(conversation('exited'));

    await files.save({
      ...files.record,
      process: await identifyProcess(child.pid!),
    });

    await files.close();

    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });

    const claimed = await store.claim('exited');
    assert.equal(claimed.record.process, undefined);
    await claimed.close();
  } finally {
    child.kill('SIGKILL');
  }
});

test('a claim stops the recorded process after a time zone and locale change', async () => {
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

test("a claim leaves running a process that reuses the recorded process's pid, and a group that reuses the recorded shell's", async () => {
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

test("a claim kills a recorded shell's whole group, a member its first signal missed included, and clears the record", async () => {
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

    vi.spyOn(process, 'kill').mockImplementation(
      (pid: number, signal?: string | number) => {
        // the first group kill lands as the shell forks, so it reaches only the shell, which ps lists until it's reaped
        if (!missed && pid === -child.pid! && signal === 'SIGKILL') {
          missed = true;
          setTimeout(() => kill(child.pid!, 'SIGKILL'), 50);

          return true;
        }

        return kill(pid, signal);
      },
    );

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

test('serialized saves of one record keep the latest after restart', async () => {
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

test('a save writes the record as it was when called', async () => {
  const store = await StateStore.open(await scratch('witch-state-'));
  const files = await store.create(conversation('snapshot'));
  const record = { ...files.record, title: 'saved' };
  const saving = files.save(record);
  record.title = 'changed';
  await saving;
  await files.close();
  const reopened = await store.claim('snapshot');
  assert.equal(reopened.record.title, 'saved');
  await reopened.close();
});
