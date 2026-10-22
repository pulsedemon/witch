import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, chmod, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { exclusiveLock, lockedFiles } from '../src/persistence/lock.js';
import { LockedElsewhere, StateStore } from '../src/persistence/store.js';
import { record } from './fixtures/coordinator.js';
import { scratch } from './fixtures/scratch.js';
import { within } from './fixtures/within.js';

async function observer(t: TestContext, root: string, limit: number) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('fixtures/lock.ts', import.meta.url)),
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
  t.after(async () => {
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

await test('concurrent probes never report a free file as held', async (t) => {
  const root = await scratch('witch-lock-observers-');
  const store = await StateStore.open(root);
  await (await store.create(record('observed', root))).close();
  const observers = await Promise.all([
    observer(t, root, 200),
    observer(t, root, 200),
  ]);
  await Promise.all(observers.map((child) => child.start()));
  const results = await Promise.all(observers.map((child) => child.finish()));
  assert.deepEqual(results, [
    { attempts: 200, held: 0 },
    { attempts: 200, held: 0 },
  ]);
});

await test('observation never prevents a free conversation from opening', async (t) => {
  const root = await scratch('witch-lock-acquisition-');
  const store = await StateStore.open(root);
  await (await store.create(record('observed', root))).close();
  const child = await observer(t, root, 0);
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

await test('batch observation preserves path identity and filesystem failures', async (t) => {
  const root = await scratch('witch-lock-batch-');
  const heldPath = join(root, 'présence λ[]\nlock');
  const free = join(root, 'free');
  const missing = join(root, 'missing');
  await Promise.all([writeFile(heldPath, ''), writeFile(free, '')]);
  const held = await open(
    heldPath,
    constants.O_RDONLY | constants.O_NONBLOCK | exclusiveLock,
  );
  t.after(() => held.close());
  assert.deepEqual(
    await lockedFiles([free, heldPath, missing]),
    new Set([heldPath]),
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

await test('query failure never reports an unlocked file', async () => {
  const root = await scratch('witch-lock-query-failure-');
  const file = join(root, 'free');
  await writeFile(file, '');
  await writeFile(
    join(root, 'FailLockQuery.pm'),
    'die "injected lock query failure\\n";\n',
  );
  const previous = {
    PERL5LIB: process.env.PERL5LIB,
    PERL5OPT: process.env.PERL5OPT,
  };
  try {
    process.env.PERL5LIB = root;
    process.env.PERL5OPT = '-MFailLockQuery';
    await assert.rejects(lockedFiles([file]), /injected lock query failure/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.deepEqual(await lockedFiles([file]), new Set());
});
