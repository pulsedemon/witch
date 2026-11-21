import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, chmod, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { openLocked, lockedFiles } from '../../src/persistence/lock.js';
import { LockedElsewhere, StateStore } from '../../src/persistence/store.js';
import { record } from '../fixtures/store.js';
import { scratch } from '../fixtures/scratch.js';
import { within } from '../fixtures/within.js';
import { orderedCleanup } from '../fixtures/cleanup.js';
import type { RegisterCleanup } from '../fixtures/cleanup.js';

async function observer(
  register: RegisterCleanup,
  root: string,
  limit: number,
) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('../fixtures/lock.ts', import.meta.url)),
      root,
      'observed',
      'observe',
      String(limit),
    ],
    { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] },
  );

  let output = '';

  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });

  const ended = new Promise<void>((resolve) =>
    child.once('close', () => resolve()),
  );

  register(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');

    await ended;
  });

  await within(once(child.stdout, 'data'), 5000, 'observer ready');

  return {
    start: async () => {
      const started = within(
        once(child.stdout, 'data'),
        5000,
        'observer started',
      );

      child.stdin.write('start');
      await started;
    },
    finish: async () => {
      if (!limit) child.stdin.end();

      await within(ended, 30_000, 'observer finished');
      assert.equal(child.exitCode, 0, output);

      return JSON.parse(output.trim().split('\n').at(-1)!) as {
        attempts: number;
        held: number;
      };
    },
  };
}

test('concurrent probes never report a free file as held', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const root = await scratch('witch-lock-observers-');
  const store = await StateStore.open(root);
  await (await store.create(record('observed', root))).close();

  const observers = await Promise.all([
    observer(cleanup, root, 200),
    observer(cleanup, root, 200),
  ]);

  await Promise.all(observers.map((child) => child.start()));
  const results = await Promise.all(observers.map((child) => child.finish()));

  assert.deepEqual(results, [
    { attempts: 200, held: 0 },
    { attempts: 200, held: 0 },
  ]);
});

test('observation never prevents a free conversation from opening', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const root = await scratch('witch-lock-acquisition-');
  const store = await StateStore.open(root);
  await (await store.create(record('observed', root))).close();
  const child = await observer(cleanup, root, 0);
  await child.start();
  let failures = 0;

  for (let attempt = 0; attempt < 1000; attempt++) {
    try {
      await (await store.claim('observed')).close();
    } catch (error) {
      if (!(error instanceof LockedElsewhere)) throw error;

      failures++;
    }
  }

  const result = await child.finish();
  assert.ok(result.attempts > 1);
  assert.equal(failures, 0);
});

test('batch observation preserves path identity and filesystem failures', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const root = await scratch('witch-lock-batch-');
  const heldPath = join(root, 'présence λ[]\nlock');
  const sharedPath = join(root, 'shared');
  const free = join(root, 'free');
  const missing = join(root, 'missing');
  await Promise.all([writeFile(heldPath, ''), writeFile(free, '')]);

  const held = await openLocked(
    heldPath,
    constants.O_RDONLY | constants.O_NONBLOCK,
  );

  cleanup(() => held.close());

  const shared = await openLocked(
    sharedPath,
    constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK,
    { mode: 0o600, shared: true },
  );

  cleanup(() => shared.close());

  assert.deepEqual(
    await lockedFiles([
      free,
      heldPath,
      missing,
      sharedPath,
      join(free, 'lock'),
    ]),
    new Map([
      [heldPath, 'exclusive'],
      [sharedPath, 'shared'],
    ]),
  );

  await assert.rejects(access(missing), { code: 'ENOENT' });
  await chmod(free, 0o000);

  try {
    await assert.rejects(lockedFiles([heldPath, free]), {
      code: 'EACCES',
      path: free,
    });
  } finally {
    await chmod(free, 0o600);
  }
});

/** runs `run` with the lock query's perl loading `module` from `directory` first. */
async function preloaded(
  directory: string,
  module: string,
  run: () => Promise<void>,
): Promise<void> {
  const previous = {
    PERL5LIB: process.env.PERL5LIB,
    PERL5OPT: process.env.PERL5OPT,
  };

  try {
    process.env.PERL5LIB = directory;
    process.env.PERL5OPT = `-M${module}`;
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('query failure never reports an unlocked file', async () => {
  const root = await scratch('witch-lock-query-failure-');
  const file = join(root, 'free');
  await writeFile(file, '');

  await writeFile(
    join(root, 'FailLockQuery.pm'),
    'die "injected lock query failure\\n";\n',
  );

  await preloaded(root, 'FailLockQuery', () =>
    assert.rejects(lockedFiles([file]), /injected lock query failure/),
  );

  assert.deepEqual(await lockedFiles([file]), new Map());
});

test.skipIf(process.platform !== 'linux')(
  "a lock listed by any of the table's reads is reported, with the latest mode",
  async () => {
    const root = await scratch('witch-lock-tables-');

    const cases = [
      ['third', [undefined, undefined, 'WRITE'], 'exclusive'],
      ['second', [undefined, 'WRITE', undefined], 'exclusive'],
      ['first', ['READ', undefined, undefined], 'shared'],
      ['downgraded', ['WRITE', 'WRITE', 'READ'], 'shared'],
      ['upgraded', ['READ', 'READ', 'WRITE'], 'exclusive'],
    ] as const;

    const tables = ['', '', ''];

    for (const [name, modes] of cases) {
      const file = join(root, name);
      await writeFile(file, '');
      // a device number passes 32 bits, where a number's shift wraps
      const { dev, ino } = await stat(file, { bigint: true });
      const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
      const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);

      for (const [pass, mode] of modes.entries())
        if (mode)
          tables[pass] +=
            `1: FLOCK  ADVISORY  ${mode} 1 ${major.toString(16)}:${minor.toString(16)}:${ino} 0 EOF\n`;
    }

    await writeFile(
      join(root, 'LockTables.pm'),
      `my @tables = (${tables.map((table) => `'${table}'`).join(', ')});
my $read = 0;
*CORE::GLOBAL::open = sub (*;$@) {
  return CORE::open($_[0], '<', \\$tables[$read++])
    if @_ == 3 && $_[2] eq '/proc/locks';
  return @_ == 3 ? CORE::open($_[0], $_[1], $_[2]) : CORE::open($_[0], $_[1]);
};
1;
`,
    );

    await preloaded(root, 'LockTables', async () => {
      assert.deepEqual(
        await lockedFiles(cases.map(([name]) => join(root, name))),
        new Map(cases.map(([name, , mode]) => [join(root, name), mode])),
      );
    });
  },
);
