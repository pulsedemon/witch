import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { promisify } from 'node:util';
import { listFiles } from '../src/core/files.js';
import { scratch } from './fixtures/scratch.js';

const execute = promisify(execFile);

async function files(root: string, paths: Record<string, string>) {
  for (const [path, content] of Object.entries(paths)) {
    await mkdir(join(root, path, '..'), { recursive: true });

    await writeFile(join(root, path), content);
  }
}

test('a work tree lists tracked and untracked files under the cwd, without ignored or deleted ones', async () => {
  const root = await scratch('witch-files-');

  const git = (...args: string[]) => execute('git', ['-C', root, ...args]);

  await git('init', '-q');

  await files(root, {
    '.gitignore': '*.log\n',
    'tracked.txt': '',
    'gone.txt': '',
    'sub/inner.txt': '',
    'two words.txt': '',
  });

  await git('add', '.');

  await git(
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-qm',
    'start',
  );

  await rm(join(root, 'gone.txt'));

  await files(root, { 'new.txt': '', 'debug.log': '' });

  assert.deepEqual((await listFiles(root)).sort(), [
    '.gitignore',
    'new.txt',
    'sub/inner.txt',
    'tracked.txt',
    'two words.txt',
  ]);

  assert.deepEqual(await listFiles(join(root, 'sub')), ['inner.txt']);

  assert.equal((await listFiles(root, 2)).length, 2);
});

test('a path in a merge conflict is listed once', async () => {
  const root = await scratch('witch-files-');

  const git = (...args: string[]) =>
    execute('git', [
      '-C',
      root,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      ...args,
    ]);

  await git('init', '-q', '-b', 'main');

  await files(root, { 'tracked.txt': 'base\n' });

  await git('add', '.');

  await git('commit', '-qm', 'base');

  await git('checkout', '-qb', 'other');

  await files(root, { 'tracked.txt': 'theirs\n' });

  await git('commit', '-qam', 'theirs');

  await git('checkout', '-q', 'main');

  await files(root, { 'tracked.txt': 'mine\n' });

  await git('commit', '-qam', 'mine');

  await assert.rejects(git('merge', '-q', 'other'));

  assert.deepEqual(await listFiles(root), ['tracked.txt']);
});

test("the listing never runs the repository's fsmonitor command", async () => {
  const root = await scratch('witch-files-');

  const work = join(root, 'work');

  const marker = join(root, 'ran');

  const monitor = join(root, 'monitor.sh');

  await execute('git', ['init', '-q', work]);

  await writeFile(monitor, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });

  await execute('git', ['-C', work, 'config', 'core.fsmonitor', monitor]);

  await files(work, { '.gitignore': '' });

  // the walk fallback skips dot entries, so this listing came from Git
  assert.deepEqual(await listFiles(work), ['.gitignore']);

  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('outside a work tree a walk lists files breadth first and skips dot entries and unreadable directories', async () => {
  const root = await scratch('witch-files-');

  await files(root, {
    'top.txt': '',
    'deep/inner.txt': '',
    '.hidden/secret.txt': '',
    '.dotfile': '',
  });

  assert.deepEqual(await listFiles(root), ['top.txt', 'deep/inner.txt']);

  assert.deepEqual(await listFiles(root, 1), ['top.txt']);

  await chmod(join(root, 'deep'), 0o000);

  try {
    assert.deepEqual(await listFiles(root), ['top.txt']);
  } finally {
    await chmod(join(root, 'deep'), 0o700);
  }
});
