import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import {
  nativeLaunch,
  registerNativeParticipant,
} from '../src/agents/native-launch.js';
import {
  holdRuntime,
  NativeUpdatePending,
} from '../src/persistence/runtime-updates.js';
import { runtimeUpdateFixture } from './fixtures/runtime-updates.js';
import { until } from './fixtures/within.js';

test('a native lease in another process excludes the updater until that process releases it', async () => {
  const f = await runtimeUpdateFixture();

  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      new URL('./fixtures/native-update-lease.mjs', import.meta.url).pathname,
      f.root,
      f.store.directory,
    ],
    { stdio: 'pipe' },
  );

  let output = '';

  child.stdout.on('data', (chunk) => (output += String(chunk)));

  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);

    child.once('close', resolve);
  });

  try {
    await until('remote native lease', () => output.includes('held'));

    await assert.rejects(
      f.store.exclusive(f.root, AbortSignal.timeout(30)),
      /aborted|timeout/i,
    );

    child.stdin.end();

    assert.equal(await closed, 0);

    const writer = await f.store.exclusive(
      f.root,
      new AbortController().signal,
    );

    try {
      assert.throws(
        () => holdRuntime(f.root, f.store.directory),
        NativeUpdatePending,
      );
    } finally {
      await writer.close();
    }
  } finally {
    child.kill('SIGKILL');

    await closed.catch(() => {});

    f.updates.close();
  }
});

test('native launch executes the checked artifact even if the launcher changes immediately before spawn', async () => {
  const f = await runtimeUpdateFixture();

  const unregister = registerNativeParticipant(f.store.directory);

  let output = '';

  const child = nativeLaunch(
    f.launcher,
    process.env,
    (executable) => {
      unlinkSync(f.launcher);

      symlinkSync(f.artifacts.get('2.0.0')!.executable, f.launcher);

      return spawn(executable, ['--version'], { stdio: 'pipe' });
    },
    f.store.directory,
  );

  child.stdout.on('data', (chunk) => (output += String(chunk)));

  try {
    assert.equal(
      await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);

        child.once('close', resolve);
      }),
      0,
    );

    assert.equal(output.trim(), 'codex-cli 1.0.0');

    assert.equal((await f.inspect()).version, '2.0.0');

    const writer = await f.store.exclusive(
      f.root,
      new AbortController().signal,
    );

    await writer.close();
  } finally {
    unregister();

    f.updates.close();
  }
});

test('a pending update prevents a native launch before a subprocess is created', async () => {
  const f = await runtimeUpdateFixture();

  const unregister = registerNativeParticipant(f.store.directory);

  f.native.prepare = async () => {
    let spawned = false;

    assert.throws(
      () =>
        nativeLaunch(
          f.launcher,
          process.env,
          (executable) => {
            spawned = true;

            return spawn(executable, ['--version'], { stdio: 'pipe' });
          },
          f.store.directory,
        ),
      NativeUpdatePending,
    );

    assert.equal(spawned, false);

    throw new Error('Preparation ended before mutation');
  };

  try {
    await assert.rejects(
      f.updates.apply(f.check, { accountUsage: true }),
      /Preparation ended/,
    );

    assert.deepEqual(f.installs, []);
  } finally {
    unregister();

    f.updates.close();
  }
});

test('an error from a still-running native child retains its lease until exit', async () => {
  const f = await runtimeUpdateFixture();

  const unregister = registerNativeParticipant(f.store.directory);

  writeFileSync(
    f.artifacts.get('1.0.0')!.executable,
    '#!/bin/sh\nexec sleep 30\n',
  );

  const child = nativeLaunch(
    f.launcher,
    process.env,
    (executable) => spawn(executable, [], { stdio: 'pipe' }),
    f.store.directory,
  );

  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );

  try {
    child.emit(
      'error',
      new DOMException('The operation was aborted', 'AbortError'),
    );

    await assert.rejects(
      f.store.exclusive(f.root, AbortSignal.timeout(30)),
      /aborted|timeout/i,
    );

    child.kill('SIGKILL');

    await exited;

    const exclusive = await f.store.exclusive(
      f.root,
      new AbortController().signal,
    );

    await exclusive.close();
  } finally {
    child.kill('SIGKILL');

    await exited;

    unregister();

    f.updates.close();
  }
});
