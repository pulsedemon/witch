import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'vitest';
import type { Run } from '../src/core/repository.js';
import { WorkTreeChanges } from '../src/core/work-tree-changes.js';
import type { Changes } from '../src/core/work-tree-changes.js';
import { scratch } from './fixtures/scratch.js';

const execute = promisify(execFile);
const past = '2020-01-01T00:00:00Z';

/** a repository with one commit of `files`, and the watcher that keeps its storage beside it. */
async function repository(files: Record<string, string> = { 'a.txt': 'a\n' }) {
  const root = await scratch('witch-changes-');
  const work = join(root, 'work');
  await mkdir(work);
  const git = async (...args: string[]) =>
    (
      await execute(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
        { cwd: work },
      )
    ).stdout;
  /** a commit dated before any baseline, as a branch someone else made would be. */
  const old = (...args: string[]) =>
    execute(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', ...args],
      { cwd: work, env: { ...process.env, GIT_COMMITTER_DATE: past } },
    );
  await git('init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries(files))
    await writeFile(join(work, name), text);
  await git('add', '-f', '-A');
  await old('-m', 'first');
  return {
    root,
    work,
    git,
    old,
    changes: new WorkTreeChanges(join(root, 'changes')),
  };
}

/** each file's path under `work`, kind, changed lines and what was left out. */
const changed = (work: string, { files }: Changes) =>
  files.map(({ path, kind, hunks, unshown }) => ({
    path: path.slice(work.length + 1),
    kind,
    lines: hunks.flatMap(({ lines }) =>
      lines.filter((line) => line[0] !== ' '),
    ),
    ...(unshown ? { unshown } : {}),
  }));

const none: Changes = { files: [], withHead: 0, more: 0 };

async function contents(directory: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    found[path] = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  }
  return found;
}

test('an update, an add and a delete come back with their hunks and absolute paths, and an ignored file does not', async () => {
  const { work, git, changes } = await repository({
    'a.txt': 'one\n\nthree\n',
    'gone.txt': 'bye\n',
    '.gitignore': '*.log\n',
  });
  // the user's setting would strip the space from the blank context line
  await git('config', 'diff.suppressBlankEmpty', 'true');
  await changes.watch(work);
  await appendFile(join(work, 'a.txt'), 'four\n');
  await writeFile(join(work, 'new file.txt'), 'hello\n');
  await writeFile(join(work, 'debug.log'), 'noise\n');
  await rm(join(work, 'gone.txt'));
  assert.deepEqual(await changes.read(work), {
    files: [
      {
        path: join(work, 'a.txt'),
        kind: 'update',
        hunks: [
          { oldStart: 1, newStart: 1, lines: [' one', ' ', ' three', '+four'] },
        ],
      },
      {
        path: join(work, 'gone.txt'),
        kind: 'delete',
        hunks: [{ oldStart: 1, newStart: 0, lines: ['-bye'] }],
      },
      {
        path: join(work, 'new file.txt'),
        kind: 'add',
        hunks: [{ oldStart: 0, newStart: 1, lines: ['+hello'] }],
      },
    ],
    withHead: 0,
    more: 0,
  });
});

test('consecutive reads each show only what changed since the one before', async () => {
  const { work, changes } = await repository();
  await changes.watch(work);
  await appendFile(join(work, 'a.txt'), 'b\n');
  assert.deepEqual(changed(work, await changes.read(work)), [
    { path: 'a.txt', kind: 'update', lines: ['+b'] },
  ]);
  await appendFile(join(work, 'a.txt'), 'c\n');
  assert.deepEqual(changed(work, await changes.read(work)), [
    { path: 'a.txt', kind: 'update', lines: ['+c'] },
  ]);
  assert.deepEqual(await changes.read(work), none);
});

test('a tracked file that an ignore rule matches stays covered, also when only staged or deleted and recreated', async () => {
  const { work, git, changes } = await repository({
    'kept.log': 'one\n',
    '.gitignore': '*.log\n',
  });
  await writeFile(join(work, 'staged.log'), 'staged\n');
  await git('add', '-f', 'staged.log');
  await changes.watch(work);
  await appendFile(join(work, 'kept.log'), 'two\n');
  await appendFile(join(work, 'staged.log'), 'more\n');
  assert.deepEqual(changed(work, await changes.read(work)), [
    { path: 'kept.log', kind: 'update', lines: ['+two'] },
    { path: 'staged.log', kind: 'update', lines: ['+more'] },
  ]);
  await rm(join(work, 'kept.log'));
  assert.deepEqual(changed(work, await changes.read(work)), [
    { path: 'kept.log', kind: 'delete', lines: ['-one', '-two'] },
  ]);
  await writeFile(join(work, 'kept.log'), 'back\n');
  assert.deepEqual(changed(work, await changes.read(work)), [
    { path: 'kept.log', kind: 'add', lines: ['+back'] },
  ]);
});

test("the repository's Git directory keeps its contents through a watch, a read and an absorb", async () => {
  const { work, git, changes } = await repository({
    'a.txt': 'a\n',
    'b.txt': 'b\n',
  });
  await git('config', 'core.splitIndex', 'true');
  const hook = join(work, '.git', 'hooks', 'post-index-change');
  await mkdir(join(work, '.git', 'hooks'), { recursive: true });
  await writeFile(hook, '#!/bin/sh\ntouch "$(git rev-parse --git-dir)/RAN"\n');
  await chmod(hook, 0o755);
  await appendFile(join(work, 'a.txt'), 'staged\n');
  await git('add', 'a.txt');
  await rm(join(work, '.git', 'RAN'), { force: true });
  const before = await contents(join(work, '.git'));
  await changes.watch(work);
  await appendFile(join(work, 'a.txt'), 'edited\n');
  await appendFile(join(work, 'b.txt'), 'edited\n');
  await changes.absorb(work, [join(work, 'a.txt')]);
  assert.deepEqual(changed(work, await changes.read(work)), [
    { path: 'b.txt', kind: 'update', lines: ['+edited'] },
  ]);
  assert.deepEqual(await contents(join(work, '.git')), before);
});

test('a read from a subdirectory of a linked worktree covers the whole worktree', async () => {
  const { root, work, git, changes } = await repository();
  const linked = join(root, 'linked');
  await git('worktree', 'add', '-q', linked, '-b', 'side');
  // the user's setting would limit a diff to the directory it runs in
  await git('config', 'diff.relative', 'true');
  await mkdir(join(linked, 'deep'));
  await changes.watch(join(linked, 'deep'));
  await appendFile(join(linked, 'a.txt'), 'top\n');
  await writeFile(join(linked, 'deep', 'in.txt'), 'in\n');
  assert.deepEqual(changed(linked, await changes.read(join(linked, 'deep'))), [
    { path: 'a.txt', kind: 'update', lines: ['+top'] },
    { path: 'deep/in.txt', kind: 'add', lines: ['+in'] },
  ]);
  assert.deepEqual(await changes.read(work), none);
});

for (const name of ['ends in a space ', 'a:b"c\\d', 'line\nbreak'])
  test(`a checkout in a directory named ${JSON.stringify(name)} is read as itself`, async () => {
    const root = await scratch('witch-changes-');
    const work = join(root, name);
    await mkdir(work);
    const git = (...args: string[]) =>
      execute('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: work,
      });
    await git('init', '-q', '-b', 'main');
    // tracked though ignored, so a snapshot has it only from the repository's index
    await writeFile(join(work, '.gitignore'), '*.log\n');
    await writeFile(join(work, 'tracked.log'), 'a\n');
    await writeFile(join(work, 'kept.txt'), 'kept\n');
    // older than the index, so a snapshot takes this file's content from the repository's objects
    await utimes(join(work, 'kept.txt'), new Date(past), new Date(past));
    await git('add', '-A', '-f');
    await git('commit', '-qm', 'first');
    const changes = new WorkTreeChanges(join(root, 'changes'));
    await changes.watch(work);
    await appendFile(join(work, 'tracked.log'), 'more\n');
    assert.deepEqual(changed(work, await changes.read(work)), [
      { path: 'tracked.log', kind: 'update', lines: ['+more'] },
    ]);
  });

test('a read with no baseline takes one and shows nothing, and an absorb with none does nothing', async () => {
  const { work, changes } = await repository({
    'a.txt': 'a\n',
    'b.txt': 'b\n',
  });
  await appendFile(join(work, 'a.txt'), 'native\n');
  await changes.absorb(work, [join(work, 'a.txt')]);
  await appendFile(join(work, 'b.txt'), 'before\n');
  assert.deepEqual(await changes.read(work), none);
  await appendFile(join(work, 'b.txt'), 'after\n');
  assert.deepEqual(changed(work, await changes.read(work)), [
    { path: 'b.txt', kind: 'update', lines: ['+after'] },
  ]);
});

test('a checkout keeps its baseline through a second watch and a watch of another checkout', async () => {
  const first = await repository();
  const second = await repository();
  const changes = first.changes;
  await changes.watch(first.work);
  await appendFile(join(first.work, 'a.txt'), 'between\n');
  await changes.watch(first.work);
  await changes.watch(second.work);
  await appendFile(join(first.work, 'a.txt'), 'meanwhile\n');
  await appendFile(join(second.work, 'a.txt'), 'own\n');
  assert.deepEqual(changed(second.work, await changes.read(second.work)), [
    { path: 'a.txt', kind: 'update', lines: ['+own'] },
  ]);
  assert.deepEqual(changed(first.work, await changes.read(first.work)), [
    { path: 'a.txt', kind: 'update', lines: ['+between', '+meanwhile'] },
  ]);
});

test('storage inside the checkout stays out of its own snapshots', async () => {
  const { work } = await repository();
  const changes = new WorkTreeChanges(join(work, 'state', 'changes'));
  await changes.watch(work);
  assert.deepEqual(await changes.read(work), none);
  assert.deepEqual(await changes.read(work), none);
});

test('concurrent operations run one at a time', async () => {
  const { work, changes } = await repository();
  await changes.watch(work);
  await appendFile(join(work, 'a.txt'), 'b\n');
  const [first, second] = await Promise.all([
    changes.read(work),
    changes.read(work),
  ]);
  assert.deepEqual(changed(work, first), [
    { path: 'a.txt', kind: 'update', lines: ['+b'] },
  ]);
  assert.deepEqual(second, none);
});

test('absorb takes only the reported paths into the baseline', async () => {
  const { root, work, changes } = await repository({
    'a.txt': 'a\n',
    'b.txt': 'b\n',
    'gone.txt': 'bye\n',
    '.gitignore': '*.log\n',
  });
  await changes.watch(work);
  await appendFile(join(work, 'a.txt'), 'native\n');
  await appendFile(join(work, 'b.txt'), 'shell\n');
  await rm(join(work, 'gone.txt'));
  await writeFile(join(work, 'native.log'), 'ignored\n');
  await changes.absorb(work, [
    join(work, 'a.txt'),
    join(work, 'gone.txt'),
    join(work, 'never.txt'),
    join(work, 'native.log'),
    join(root, 'outside.txt'),
  ]);
  assert.deepEqual(changed(work, await changes.read(work)), [
    { path: 'b.txt', kind: 'update', lines: ['+shell'] },
  ]);
  await appendFile(join(work, 'a.txt'), 'later\n');
  // only outside paths, so nothing is taken in
  await changes.absorb(work, [join(root, 'outside.txt')]);
  assert.deepEqual(changed(work, await changes.read(work)), [
    { path: 'a.txt', kind: 'update', lines: ['+later'] },
  ]);
});

test('absorb takes a file that became a directory, and a directory that became a file', async () => {
  const { work, git, changes } = await repository({ file: 'file\n' });
  await mkdir(join(work, 'directory'));
  await writeFile(join(work, 'directory', 'inside.txt'), 'inside\n');
  await git('add', '-A');
  await git('commit', '-qm', 'directory');
  await changes.watch(work);
  await rm(join(work, 'file'));
  await mkdir(join(work, 'file'));
  await writeFile(join(work, 'file', 'new.txt'), 'new\n');
  await rm(join(work, 'directory'), { recursive: true });
  await writeFile(join(work, 'directory'), 'now a file\n');
  await changes.absorb(work, [
    join(work, 'file', 'new.txt'),
    join(work, 'directory'),
  ]);
  assert.deepEqual(await changes.read(work), none);
});

test('an edit committed since the baseline shows, as does the first commit of an unborn branch', async () => {
  const { work, git, changes } = await repository();
  await changes.watch(work);
  // lands in the baseline's own second
  await appendFile(join(work, 'a.txt'), 'committed\n');
  await git('commit', '-qam', 'local');
  assert.deepEqual(
    await changes.read(work).then((read) => changed(work, read)),
    [{ path: 'a.txt', kind: 'update', lines: ['+committed'] }],
  );

  const root = await scratch('witch-changes-');
  const unborn = join(root, 'work');
  await mkdir(unborn);
  await execute('git', ['init', '-q', '-b', 'main'], { cwd: unborn });
  const fresh = new WorkTreeChanges(join(root, 'changes'));
  await fresh.watch(unborn);
  await writeFile(join(unborn, 'first.txt'), 'first\n');
  await execute(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'],
    { cwd: unborn },
  );
  await execute(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first'],
    { cwd: unborn },
  );
  assert.deepEqual(changed(unborn, await fresh.read(unborn)), [
    { path: 'first.txt', kind: 'add', lines: ['+first'] },
  ]);
});

test('files that only follow a moved HEAD are counted, and one the command left dirty shows', async () => {
  const { work, git, old, changes } = await repository({
    'a.txt': 'a\n',
    'b.txt': 'b\n',
  });
  await git('branch', 'older');
  await appendFile(join(work, 'a.txt'), 'newer\n');
  await appendFile(join(work, 'b.txt'), 'newer\n');
  await old('-am', 'second');
  await changes.watch(work);

  await git('switch', '-q', 'older');
  assert.deepEqual(await changes.read(work), { ...none, withHead: 2 });

  // a fast-forward to commits that existed before the baseline
  await git('merge', '-q', '--ff-only', 'main');
  assert.deepEqual(await changes.read(work), { ...none, withHead: 2 });

  await git('switch', '-q', '-c', 'side', 'HEAD~1');
  await appendFile(join(work, 'b.txt'), 'dirty\n');
  const moved = await changes.read(work);
  assert.equal(moved.withHead, 1);
  assert.deepEqual(changed(work, moved), [
    { path: 'b.txt', kind: 'update', lines: ['-newer', '+dirty'] },
  ]);

  // an edit committed and then merged with older commits is inside the count
  await git('restore', 'b.txt');
  await changes.read(work);
  await writeFile(join(work, 'c.txt'), 'c\n');
  await git('add', 'c.txt');
  await git('commit', '-qm', 'local');
  await git('merge', '-q', '--no-edit', 'main');
  assert.deepEqual(await changes.read(work), { ...none, withHead: 3 });

  await git('checkout', '-q', '--orphan', 'fresh');
  await appendFile(join(work, 'a.txt'), 'orphan\n');
  assert.deepEqual(changed(work, await changes.read(work)), [
    { path: 'a.txt', kind: 'update', lines: ['+orphan'] },
  ]);
});

test('a revert with HEAD unchanged shows, and an edit Git stores identically does not', async () => {
  const { work, git, changes } = await repository({
    'a.txt': 'a\n',
    'crlf.txt': 'one\ntwo\n',
    '.gitattributes': 'crlf.txt text\n',
  });
  await appendFile(join(work, 'a.txt'), 'pending\n');
  await changes.watch(work);
  await git('restore', 'a.txt');
  assert.deepEqual(changed(work, await changes.read(work)), [
    { path: 'a.txt', kind: 'update', lines: ['-pending'] },
  ]);
  await writeFile(join(work, 'crlf.txt'), 'one\r\ntwo\r\n');
  assert.deepEqual(await changes.read(work), none);
});

test('an equal-length edit made in the second the index was written shows', async () => {
  const { work, git, changes } = await repository({ 'a.txt': 'aaaa\n' });
  await git('config', 'core.checkStat', 'minimal');
  const second = new Date('2024-01-01T00:00:00Z');
  await utimes(join(work, 'a.txt'), second, second);
  await git('add', 'a.txt');
  await utimes(join(work, '.git', 'index'), second, second);
  await changes.watch(work);
  await writeFile(join(work, 'a.txt'), 'bbbb\n');
  await utimes(join(work, 'a.txt'), second, second);
  assert.deepEqual(changed(work, await changes.read(work)), [
    { path: 'a.txt', kind: 'update', lines: ['-aaaa', '+bbbb'] },
  ]);
});

test('a file past the line budget, a binary file and a type change keep their header without lines', async () => {
  const { work, changes } = await repository({
    'forced.bin': 'a\u0000b\n',
    'link.txt': 'file\n',
    'small.txt': 'small\n',
    '.gitattributes': 'forced.bin diff\n',
  });
  await changes.watch(work);
  await writeFile(
    join(work, 'big.txt'),
    Array.from({ length: 401 }, (_, line) => `${line}\n`).join(''),
  );
  await writeFile(join(work, 'data.bin'), Buffer.from([0, 1, 2, 0]));
  await writeFile(join(work, 'forced.bin'), 'a\u0000c\n');
  await rm(join(work, 'link.txt'));
  await symlink('small.txt', join(work, 'link.txt'));
  await appendFile(join(work, 'small.txt'), 'more\n');
  assert.deepEqual(changed(work, await changes.read(work)), [
    {
      path: 'big.txt',
      kind: 'add',
      lines: [],
      unshown: { added: 401, removed: 0 },
    },
    { path: 'data.bin', kind: 'add', lines: [], unshown: 'binary' },
    {
      path: 'forced.bin',
      kind: 'update',
      lines: [],
      unshown: { added: 1, removed: 1 },
    },
    {
      path: 'link.txt',
      kind: 'update',
      lines: [],
      unshown: { added: 1, removed: 1 },
    },
    { path: 'small.txt', kind: 'update', lines: ['+more'] },
  ]);
});

test("a row's files share the line budget, and a name Git could read as pathspec magic keeps its count", async () => {
  const { work, changes } = await repository();
  await changes.watch(work);
  const lines = (count: number) =>
    Array.from({ length: count }, (_, line) => `${line}\n`).join('');
  await writeFile(join(work, ':a.txt'), lines(401));
  await writeFile(join(work, 'first.txt'), lines(250));
  await writeFile(join(work, 'second.txt'), lines(250));
  assert.deepEqual(
    changed(work, await changes.read(work)).map(({ path, lines, unshown }) => [
      path,
      lines.length,
      unshown,
    ]),
    [
      [':a.txt', 0, { added: 401, removed: 0 }],
      ['first.txt', 250, undefined],
      ['second.txt', 0, { added: 250, removed: 0 }],
    ],
  );
});

test("the user's setting to join nearby hunks leaves the lines between them out", async () => {
  const lines = Array.from({ length: 40 }, (_, line) => `${line}`);
  const { work, git, changes } = await repository({
    'a.txt': `${lines.join('\n')}\n`,
  });
  await git('config', 'diff.interHunkContext', '100');
  await changes.watch(work);
  await writeFile(
    join(work, 'a.txt'),
    `first\n${lines.slice(1, -1).join('\n')}\nlast\n`,
  );
  const [file] = (await changes.read(work)).files;
  assert.deepEqual(
    file!.hunks.map(({ lines }) => lines),
    [
      ['-0', '+first', ' 1', ' 2', ' 3'],
      [' 36', ' 37', ' 38', '-39', '+last'],
    ],
  );
});

test('a long line takes more of the line budget, as a changed line or as context', async () => {
  const { work, changes } = await repository({
    'context.txt': `${'x'.repeat(90_000)}\nsmall\n`,
  });
  const sizes = async () =>
    changed(work, await changes.read(work)).map(({ path, lines, unshown }) => [
      path,
      lines.length,
      unshown,
    ]);
  await changes.watch(work);
  await writeFile(join(work, 'long.json'), `${'x'.repeat(100_000)}\n`);
  assert.deepEqual(await sizes(), [['long.json', 0, { added: 1, removed: 0 }]]);
  await writeFile(join(work, 'context.txt'), `${'x'.repeat(90_000)}\nedited\n`);
  assert.deepEqual(await sizes(), [
    ['context.txt', 0, { added: 1, removed: 1 }],
  ]);
  // 199 characters cost one line each, so 400 of them take the whole budget and no more
  await writeFile(join(work, 'fits.txt'), `${'x'.repeat(199)}\n`.repeat(400));
  assert.deepEqual(await sizes(), [['fits.txt', 400, undefined]]);
});

test('files past the hundredth are counted, and only the listed files have their lines counted', async () => {
  const { root, work } = await repository();
  const counted: string[][] = [];
  const run: Run = (command, args, options) => {
    if (args.includes('--numstat'))
      counted.push(args.slice(args.indexOf('--') + 1));
    return execute(command, args, options);
  };
  const changes = new WorkTreeChanges(join(root, 'changes'), run);
  await changes.watch(work);
  const names = Array.from(
    { length: 101 },
    (_, file) => `n${String(file).padStart(3, '0')}.txt`,
  );
  for (const name of names) await writeFile(join(work, name), 'n\n');
  const read = await changes.read(work);
  assert.equal(read.files.length, 100);
  assert.equal(read.more, 1);
  assert.equal(read.files.at(-1)!.path, join(work, 'n099.txt'));
  assert.deepEqual(counted, [names.slice(0, 100)]);
});

test('a file whose content Git fails to hand over keeps its header, and the rest of the row shows', async () => {
  const { root, work } = await repository();
  const run: Run = (command, args, options) =>
    args.includes('cat-file')
      ? Promise.reject(Object.assign(new Error('failed'), { code: 128 }))
      : execute(command, args, options);
  const changes = new WorkTreeChanges(join(root, 'changes'), run);
  await changes.watch(work);
  await appendFile(join(work, 'a.txt'), 'more\n');
  await writeFile(join(work, 'new.txt'), 'new\n');
  assert.deepEqual(changed(work, await changes.read(work)), [
    { path: 'a.txt', kind: 'update', lines: ['+more'] },
    {
      path: 'new.txt',
      kind: 'add',
      lines: [],
      unshown: { added: 1, removed: 0 },
    },
  ]);
  assert.deepEqual(await changes.read(work), none);
});

test("a file replaced by a directory, and a nested repository's new commit, leave the next file its own lines", async () => {
  const { work, git, changes } = await repository({
    a: 'was a file\n',
    'z.txt': 'z\n',
  });
  const nested = join(work, 'nested');
  await mkdir(nested);
  const inner = (...args: string[]) =>
    execute('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: nested,
    });
  await inner('init', '-q', '-b', 'main');
  await inner('commit', '-q', '--allow-empty', '-m', 'one');
  // the user's setting would print a nested repository's change without a file header
  await git('config', 'diff.submodule', 'log');
  await changes.watch(work);
  await rm(join(work, 'a'));
  await mkdir(join(work, 'a'));
  await writeFile(
    join(work, 'a', 'big'),
    Array.from({ length: 401 }, (_, line) => `${line}\n`).join(''),
  );
  await inner('commit', '-q', '--allow-empty', '-m', 'two');
  await appendFile(join(work, 'z.txt'), 'edited\n');
  assert.deepEqual(changed(work, await changes.read(work)), [
    { path: 'a', kind: 'delete', lines: ['-was a file'] },
    {
      path: 'a/big',
      kind: 'add',
      lines: [],
      unshown: { added: 401, removed: 0 },
    },
    {
      path: 'nested',
      kind: 'update',
      lines: [],
      unshown: { added: 1, removed: 1 },
    },
    { path: 'z.txt', kind: 'update', lines: ['+edited'] },
  ]);
});

test('a nested repository the index tracks never runs its own filter, and shows once the index takes its commit', async () => {
  const { root, work, git, changes } = await repository();
  const nested = join(work, 'nested');
  const marker = join(root, 'ran');
  await mkdir(nested);
  const inner = (...args: string[]) =>
    execute('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: nested,
    });
  await inner('init', '-q', '-b', 'main');
  await writeFile(join(nested, '.gitattributes'), 'in.txt filter=probe\n');
  await writeFile(join(nested, 'in.txt'), 'a\n');
  await inner('add', '-A');
  await inner('commit', '-qm', 'one');
  await inner('config', 'filter.probe.clean', `sh -c 'touch "${marker}"; cat'`);
  await git('add', 'nested');
  await git('commit', '-qm', 'nested');
  await changes.watch(work);
  // the same size at another time, which Git settles only by reading the content through the filter
  await writeFile(join(nested, 'in.txt'), 'b\n');
  await utimes(join(nested, 'in.txt'), new Date(past), new Date(past));
  assert.deepEqual(await changes.read(work), none);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });

  await inner('commit', '-qam', 'two');
  assert.deepEqual(await changes.read(work), none);
  await git('add', 'nested');
  assert.deepEqual(changed(work, await changes.read(work)), [
    {
      path: 'nested',
      kind: 'update',
      lines: [],
      unshown: { added: 1, removed: 1 },
    },
  ]);
});

test('settled waits for the operations already asked for', async () => {
  const { root, work } = await repository();
  const held = Promise.withResolvers<void>();
  const order: string[] = [];
  const run: Run = async (command, args, options) => {
    if (args.includes('write-tree')) {
      await held.promise;
      order.push('snapshot');
    }
    return execute(command, args, options);
  };
  const changes = new WorkTreeChanges(join(root, 'changes'), run);
  const watching = changes.watch(work);
  const settled = changes.settled().then(() => order.push('settled'));
  held.resolve();
  await settled;
  await watching;
  assert.deepEqual(order, ['snapshot', 'settled']);
});

test('a directory outside a repository reads nothing, and another failure of the lookup rejects', async () => {
  const root = await scratch('witch-changes-');
  const calls: string[][] = [];
  const outside: Run = (_command, args) => {
    calls.push(args);
    return Promise.reject(
      Object.assign(new Error('failed'), {
        code: 128,
        stderr:
          'fatal: not a git repository (or any of the parent directories): .git\n',
      }),
    );
  };
  const changes = new WorkTreeChanges(join(root, 'changes'), outside);
  await changes.watch(root);
  assert.deepEqual(await changes.read(root), none);
  assert.equal(calls.length, 2);

  const refused: Run = () =>
    Promise.reject(
      Object.assign(new Error('failed'), {
        code: 128,
        stderr:
          "fatal: detected dubious ownership in repository at '/x'\nmore\n",
      }),
    );
  await assert.rejects(
    new WorkTreeChanges(join(root, 'other'), refused).read(root),
    {
      message:
        "Couldn't read file changes: fatal: detected dubious ownership in repository at '/x'",
    },
  );
});

test("a failure names Git's error past its warnings, and a command stopped at its time limit", async () => {
  const root = await scratch('witch-changes-');
  const failing = (failure: object): Run => {
    return () => Promise.reject(Object.assign(new Error('failed'), failure));
  };
  await assert.rejects(
    new WorkTreeChanges(
      join(root, 'warned'),
      failing({
        code: 128,
        stderr:
          'warning: adding embedded git repository: nested\nerror: open("locked"): Permission denied\nfatal: adding files failed\n',
      }),
    ).read(root),
    {
      message:
        'Couldn\'t read file changes: error: open("locked"): Permission denied',
    },
  );
  await assert.rejects(
    new WorkTreeChanges(
      join(root, 'slow'),
      failing({ code: null, killed: true, signal: 'SIGTERM', stderr: '' }),
    ).read(root),
    { message: "Couldn't read file changes: Git timed out" },
  );
});

test('a failed read keeps its baseline, so the next read still shows the change', async () => {
  const { root, work } = await repository({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  let fail = true;
  const run: Run = (command, args, options) => {
    if (fail && args.includes('--raw')) {
      fail = false;
      return Promise.reject(
        Object.assign(new Error('failed'), { code: 1, stderr: 'fatal: raw\n' }),
      );
    }
    return execute(command, args, options);
  };
  const changes = new WorkTreeChanges(join(root, 'changes'), run);
  await changes.watch(work);
  await appendFile(join(work, 'a.txt'), 'before\n');
  await assert.rejects(changes.read(work), {
    message: "Couldn't read file changes: fatal: raw",
  });
  await appendFile(join(work, 'b.txt'), 'native\n');
  await changes.absorb(work, [join(work, 'b.txt')]);
  assert.deepEqual(changed(work, await changes.read(work)), [
    { path: 'a.txt', kind: 'update', lines: ['+before'] },
  ]);
});
