import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { WorkTreeChanges } from '../../../src/core/repository/work-tree-changes.js';
import { execute } from '../../../src/core/repository/work-tree-git.js';
import type { GitRun } from '../../../src/core/repository/work-tree-git.js';
import { scratch } from '../../fixtures/scratch.js';

async function repository(
  files: Record<string, string>,
  run: GitRun = execute,
  objectFormat?: 'sha1' | 'sha256',
) {
  const root = await scratch('witch-changes-costs-');
  const work = join(root, 'work');

  await mkdir(work);

  const git = (...args: string[]) =>
    run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: work,
      timeout: 10_000,
    });

  await git(
    'init',
    '-q',
    '-b',
    'main',
    ...(objectFormat ? [`--object-format=${objectFormat}`] : []),
  );

  for (const [name, content] of Object.entries(files))
    await writeFile(join(work, name), content);

  await git('add', '-A');

  await git('commit', '-qm', 'baseline');

  return {
    root,
    work,
    git,
    changes: new WorkTreeChanges(join(root, 'changes'), run),
  };
}

test('absorption uses a fixed number of Git processes for growing reports and retains unreported edits', async () => {
  const counts: number[] = [];
  const writes: number[] = [];

  for (const count of [1, 100, 400]) {
    const calls: string[][] = [];
    const indexes: string[] = [];
    const pathspecs: string[] = [];

    const names = Array.from(
      { length: 400 },
      (_, i) => `n${String(i).padStart(3, '0')}.txt`,
    );

    const run: GitRun = (command, args, options) => {
      calls.push(args);

      if (args.includes('update-index'))
        indexes.push(options.env!.GIT_INDEX_FILE!);

      if (args.includes('--pathspec-from-file=-'))
        pathspecs.push(...options.input!.split('\0').filter(Boolean));

      return execute(command, args, options);
    };

    const { work, changes } = await repository(
      Object.fromEntries(
        [...names, 'pending.txt'].map((name) => [name, 'before\n']),
      ),
      run,
    );

    await changes.watch(work);

    for (const name of names.slice(0, count))
      await writeFile(join(work, name), 'reported\n');

    await writeFile(join(work, 'pending.txt'), 'pending\n');

    calls.length = 0;
    indexes.length = 0;

    await changes.absorb(
      work,
      names.slice(0, count).map((name) => join(work, name)),
    );

    counts.push(calls.length);

    writes.push(indexes.length);

    assert.equal(
      indexes.filter((path) => path.endsWith('/absorb-index')).length,
      1,
    );

    assert.deepEqual(
      (await changes.read(work)).files.map((file) => ({
        path: file.path,
        lines: file.hunks.flatMap((hunk) => hunk.lines),
      })),
      [{ path: join(work, 'pending.txt'), lines: ['-before', '+pending'] }],
    );

    await writeFile(join(work, names[0]!), 'later\n');

    assert.deepEqual(
      (await changes.read(work)).files.map((file) =>
        file.hunks.flatMap((hunk) => hunk.lines),
      ),
      [['-reported', '+later']],
    );

    assert.deepEqual(pathspecs, []);
  }

  assert.equal(new Set(counts).size, 1);

  assert.equal(new Set(writes).size, 1);
});

test('batch absorption keeps literal names and unreported siblings when reports repeat', async () => {
  const names = [
    'has space.txt',
    'has\ttab.txt',
    'has\nnewline.txt',
    ':magic.txt',
  ];

  const { work, changes } = await repository(
    Object.fromEntries(
      [...names, 'pending.txt'].map((name) => [name, 'before\n']),
    ),
  );

  await changes.watch(work);

  for (const name of names) await writeFile(join(work, name), 'reported\n');

  await writeFile(join(work, 'new.txt'), 'new\n');

  await writeFile(join(work, 'pending.txt'), 'pending\n');

  await changes.absorb(
    work,
    [...names, 'new.txt', names[0]!].map((name) => join(work, name)),
  );

  assert.deepEqual(
    (await changes.read(work)).files.map((file) => ({
      path: file.path,
      lines: file.hunks.flatMap((hunk) => hunk.lines),
    })),
    [{ path: join(work, 'pending.txt'), lines: ['-before', '+pending'] }],
  );

  await writeFile(join(work, names[1]!), 'again\n');

  assert.deepEqual(
    (await changes.read(work)).files.map((file) =>
      file.hunks.flatMap((hunk) => hunk.lines),
    ),
    [['-reported', '+again']],
  );
});

async function filtered() {
  const environment = await scratch('witch-changes-filter-');
  const config = join(environment, 'config');
  const marker = join(environment, 'calls');
  const first = join(environment, 'one.sh');
  const second = join(environment, 'two.sh');
  const calls: string[][] = [];

  await writeFile(marker, '');

  await writeFile(first, `printf x >> '${marker}'\nsed 's/^/one:/'\n`);

  await writeFile(second, `printf x >> '${marker}'\nsed 's/^/two:/'\n`);

  await writeFile(config, '');

  await execute(
    'git',
    ['config', '--file', config, 'filter.probe.clean', `sh '${first}'`],
    { cwd: environment, timeout: 10_000 },
  );

  const run: GitRun = (command, args, options) => {
    calls.push(args);

    return execute(command, args, {
      ...options,
      env: {
        ...process.env,
        ...options.env,
        GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
  };

  const fixture = await repository(
    { '.gitattributes': '*.txt filter=probe\n', 'a.txt': 'base\n' },
    run,
  );

  return { ...fixture, marker, config, second, calls, run };
}

test('unchanged unstaged and untracked files reuse canonical blobs without index enumeration', async () => {
  const { work, changes, marker, calls } = await filtered();

  await changes.watch(work);

  await writeFile(join(work, 'a.txt'), 'dirty\n');

  await writeFile(join(work, 'new.txt'), 'fresh\n');

  assert.deepEqual(
    (await changes.read(work)).files.map((file) =>
      file.hunks.flatMap((hunk) => hunk.lines),
    ),
    [['-one:base', '+one:dirty'], ['+one:fresh']],
  );

  const count = (await readFile(marker)).length;
  calls.length = 0;

  assert.deepEqual(await changes.read(work), {
    files: [],
    withHead: 0,
    more: 0,
  });

  assert.equal((await readFile(marker)).length, count);

  assert.equal(
    calls.filter((args) => args.includes('ls-files') && args.includes('-s'))
      .length,
    0,
  );

  assert.equal(
    calls.filter(
      (args) => args.includes('update-index') || args.includes('add'),
    ).length,
    0,
  );

  const old = new Date('2020-01-01T00:00:00Z');

  await utimes(join(work, 'a.txt'), old, old);

  await utimes(join(work, 'new.txt'), old, old);

  assert.deepEqual(await changes.read(work), {
    files: [],
    withHead: 0,
    more: 0,
  });

  const stable = (await readFile(marker)).length;

  assert.deepEqual(await changes.read(work), {
    files: [],
    withHead: 0,
    more: 0,
  });

  assert.equal((await readFile(marker)).length, stable);
});

test('a changed user filter definition refreshes warm canonical blobs', async () => {
  const { work, changes, git, config, second } = await filtered();

  await changes.watch(work);

  await writeFile(join(work, 'a.txt'), 'dirty\n');

  await changes.read(work);

  await git('config', '--file', config, 'filter.probe.clean', `sh '${second}'`);

  assert.deepEqual(
    (await changes.read(work)).files.map((file) =>
      file.hunks.flatMap((hunk) => hunk.lines),
    ),
    [['-one:dirty', '+two:dirty']],
  );
});

test('a repository filter introduced after warming stays disabled while the canonical result refreshes', async () => {
  const { root, work, changes, git } = await filtered();
  const marker = join(root, 'local-filter-ran');

  await changes.watch(work);

  await writeFile(join(work, 'a.txt'), 'dirty\n');

  await changes.read(work);

  await git('config', 'filter.probe.clean', `sh -c 'touch "${marker}"; cat'`);

  assert.deepEqual(
    (await changes.read(work)).files.map((file) =>
      file.hunks.flatMap((hunk) => hunk.lines),
    ),
    [['-one:dirty', '+dirty']],
  );

  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

for (const source of ['working', 'info', 'global'])
  test(`${source} attribute changes refresh a warm canonical blob`, async () => {
    const { work, root, changes, git, config } = await filtered();
    let attributes = join(work, '.gitattributes');

    if (source === 'info')
      attributes = join(work, '.git', 'info', 'attributes');

    if (source === 'global') {
      attributes = join(root, 'attributes');

      await writeFile(join(work, '.gitattributes'), '');

      await writeFile(attributes, '*.txt filter=probe\n');

      await git('config', '--file', config, 'core.attributesFile', attributes);
    }

    await changes.watch(work);

    await writeFile(join(work, 'a.txt'), 'dirty\n');

    await changes.read(work);

    await writeFile(attributes, '*.txt -filter\n');

    assert.deepEqual(
      (await changes.read(work)).files
        .filter((file) => file.path.endsWith('/a.txt'))
        .map((file) => file.hunks.flatMap((hunk) => hunk.lines)),
      [['-one:dirty', '+dirty']],
    );
  });

test('warm snapshots follow index tracking and ignore changes', async () => {
  const { work, git, changes } = await repository({
    '.gitignore': '*.log\n',
    'kept.log': 'kept\n',
    'a.txt': 'a\n',
  });

  await git('add', '-f', 'kept.log');

  await git('commit', '-qm', 'track ignored file');

  await changes.watch(work);

  await rm(join(work, 'kept.log'));

  assert.deepEqual(
    (await changes.read(work)).files.map((file) =>
      file.hunks.flatMap((hunk) => hunk.lines),
    ),
    [['-kept']],
  );

  await writeFile(join(work, 'kept.log'), 'back\n');

  assert.deepEqual(
    (await changes.read(work)).files.map((file) =>
      file.hunks.flatMap((hunk) => hunk.lines),
    ),
    [['+back']],
  );

  await git('rm', '--cached', 'kept.log');

  assert.deepEqual(
    (await changes.read(work)).files.map((file) =>
      file.hunks.flatMap((hunk) => hunk.lines),
    ),
    [['-back']],
  );

  await writeFile(join(work, 'new.txt'), 'new\n');

  await changes.read(work);

  await writeFile(join(work, '.gitignore'), '*.log\nnew.txt\n');

  const read = await changes.read(work);

  assert.deepEqual(
    read.files.map((file) => file.path.slice(work.length + 1)),
    ['.gitignore', 'new.txt'],
  );

  assert.equal(read.files[1]!.kind, 'delete');

  assert.deepEqual(await changes.read(work), {
    files: [],
    withHead: 0,
    more: 0,
  });
});

function binary(version: number): Buffer {
  const data = Buffer.alloc(2 * 1024 * 1024);
  let seed = version;

  for (let offset = 0; offset < data.length; offset += 4) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;

    data.writeUInt32LE(seed >>> 0, offset);
  }

  return data;
}

async function objects(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();

  for (const path of await readdir(join(root, 'changes'), {
    recursive: true,
  })) {
    const parts = /objects\/([0-9a-f]{2})\/([0-9a-f]{38}|[0-9a-f]{62})$/.exec(
      path,
    );

    if (parts) found.set(parts[1]! + parts[2]!, join(root, 'changes', path));
  }

  return found;
}

test('obsolete binary versions do not accumulate while the current blob stays readable', async () => {
  const { root, work, git, changes } = await repository({ 'a.txt': 'base\n' });
  const versions: string[] = [];
  let at8 = 0;

  await changes.watch(work);

  for (let version = 1; version <= 32; version++) {
    await writeFile(join(work, 'data.bin'), binary(version));

    versions.push(
      (await git('hash-object', '--no-filters', 'data.bin')).stdout.trim(),
    );

    const result = await changes.read(work);

    assert.deepEqual(
      result.files.map((file) => ({
        path: file.path,
        unshown: file.unshown,
        hunks: file.hunks,
      })),
      [{ path: join(work, 'data.bin'), unshown: 'binary', hunks: [] }],
    );

    if (version === 8 || version === 32) {
      const retained = await objects(root);
      let bytes = 0;

      for (const path of retained.values()) bytes += (await stat(path)).size;

      assert.ok(retained.has(versions.at(-1)!));

      for (const id of versions.slice(0, -2))
        assert.equal(retained.has(id), false);

      if (version === 8) at8 = bytes;
      else {
        assert.ok(bytes < 6 * 1024 * 1024);

        assert.ok(bytes <= at8 + 65536);
      }
    }
  }

  assert.deepEqual(await changes.read(work), {
    files: [],
    withHead: 0,
    more: 0,
  });

  const retained = await objects(root);
  const current = versions.at(-1)!;
  const path = retained.get(current)!;
  const directory = path.slice(0, -current.length - 1);

  const size = await execute('git', ['cat-file', '-s', current], {
    cwd: work,
    timeout: 10_000,
    env: { ...process.env, GIT_OBJECT_DIRECTORY: directory },
  });

  assert.equal(Number(size.stdout), 2 * 1024 * 1024);

  assert.equal(retained.has(versions.at(-2)!), false);
});

test('failed reads retain private reporting roots through later absorption and reclamation', async () => {
  let fail = false;

  const run: GitRun = (command, args, options) => {
    if (fail && args.includes('--raw')) {
      fail = false;

      return Promise.reject(
        Object.assign(new Error('raw failed'), {
          code: 1,
          stderr: 'fatal: raw\n',
        }),
      );
    }

    return execute(command, args, options);
  };

  const { root, work, changes } = await repository(
    { 'a.txt': 'base\n', 'b.txt': 'b\n' },
    run,
  );

  await changes.watch(work);

  await writeFile(join(work, 'a.txt'), 'private baseline\n');

  await changes.read(work);

  const before = await objects(root);

  await writeFile(join(work, 'a.txt'), 'pending\n');

  fail = true;

  await assert.rejects(changes.read(work), /fatal: raw/);

  await writeFile(join(work, 'b.txt'), 'reported\n');

  await changes.absorb(work, [join(work, 'b.txt')]);

  assert.deepEqual(
    (await changes.read(work)).files.map((file) =>
      file.hunks.flatMap((hunk) => hunk.lines),
    ),
    [['-private baseline', '+pending']],
  );

  assert.deepEqual(await changes.read(work), {
    files: [],
    withHead: 0,
    more: 0,
  });

  const after = await objects(root);

  for (const id of before.keys()) assert.equal(after.has(id), false);
});

test('a failed reachability read does not advance the reporting baseline', async () => {
  let fail = false;

  const run: GitRun = (command, args, options) => {
    if (fail && args.includes('rev-list') && args.includes('--objects')) {
      fail = false;

      return Promise.reject(
        Object.assign(new Error('roots failed'), {
          code: 1,
          stderr: 'fatal: roots\n',
        }),
      );
    }

    return execute(command, args, options);
  };

  const { work, changes } = await repository({ 'a.txt': 'base\n' }, run);

  await changes.watch(work);

  await writeFile(join(work, 'a.txt'), 'pending\n');

  fail = true;

  await assert.rejects(changes.read(work), /fatal: roots/);

  assert.deepEqual(
    (await changes.read(work)).files.map((file) =>
      file.hunks.flatMap((hunk) => hunk.lines),
    ),
    [['-base', '+pending']],
  );
});

test('reclaiming one checkout preserves private baselines in other repositories and linked worktrees', async () => {
  const first = await repository({ 'a.txt': 'base\n' });
  const second = await repository({ 'a.txt': 'base\n' });
  const linked = join(first.root, 'linked');
  const changes = first.changes;

  await first.git('worktree', 'add', '-q', linked, '-b', 'side');

  await writeFile(join(second.work, 'a.txt'), 'second baseline\n');

  await writeFile(join(linked, 'a.txt'), 'linked baseline\n');

  await changes.watch(first.work);

  await changes.watch(second.work);

  await changes.watch(linked);

  await writeFile(join(second.work, 'a.txt'), 'second pending\n');

  await writeFile(join(linked, 'a.txt'), 'linked pending\n');

  for (const text of ['one\n', 'two\n', 'three\n']) {
    await writeFile(join(first.work, 'a.txt'), text);

    await changes.read(first.work);
  }

  assert.deepEqual(
    (await changes.read(second.work)).files.map((file) =>
      file.hunks.flatMap((hunk) => hunk.lines),
    ),
    [['-second baseline', '+second pending']],
  );

  assert.deepEqual(
    (await changes.read(linked)).files.map((file) =>
      file.hunks.flatMap((hunk) => hunk.lines),
    ),
    [['-linked baseline', '+linked pending']],
  );
});

for (const ignored of [false, true])
  test(`a tracked${ignored ? ' ignored' : ''} file replaced by a nested repository reports its entry and later commits`, async () => {
    const { work, changes } = await repository({ a: 'old file\n' });

    if (ignored) await writeFile(join(work, '.gitignore'), 'a\n');

    await changes.watch(work);

    await rm(join(work, 'a'));

    await mkdir(join(work, 'a'));

    const inner = (...args: string[]) =>
      execute('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: join(work, 'a'),
        timeout: 10_000,
      });

    await inner('init', '-q');

    await inner('commit', '--allow-empty', '-qm', 'first');

    const expected = [
      {
        path: join(work, 'a'),
        kind: 'update',
        hunks: [],
        unshown: { added: 1, removed: 1 },
      },
    ];

    assert.deepEqual((await changes.read(work)).files, expected);

    await inner('commit', '--allow-empty', '-qm', 'second');

    assert.deepEqual((await changes.read(work)).files, expected);
  });

test('text auto conversion follows the real index after a snapshot changed from CRLF to LF', async () => {
  const { work, git, changes } = await repository({ 'a.txt': 'one\r\n' });

  await git('config', 'core.autocrlf', 'false');

  await writeFile(join(work, '.gitattributes'), 'a.txt text=auto\n');

  await changes.watch(work);

  await writeFile(join(work, 'a.txt'), 'one\n');

  await changes.read(work);

  await writeFile(join(work, 'a.txt'), 'one\r\n');

  assert.deepEqual(
    (await changes.read(work)).files.map((file) =>
      file.hunks.flatMap((hunk) => hunk.lines),
    ),
    [['-one', '+one\r']],
  );
});

test('removing tracked attributes retains the same CRLF result as a native snapshot', async () => {
  const { work, git, changes } = await repository({
    '.gitattributes': 'a.txt text\n',
    'a.txt': 'one\n',
  });

  await git('config', 'core.autocrlf', 'false');

  await writeFile(join(work, '.gitattributes'), 'a.txt -text\n');

  await writeFile(join(work, 'a.txt'), 'one\r\n');

  await changes.watch(work);

  await rm(join(work, '.gitattributes'));

  assert.deepEqual(
    (await changes.read(work)).files.map((file) => ({
      path: file.path,
      lines: file.hunks.flatMap((hunk) => hunk.lines),
    })),
    [{ path: join(work, '.gitattributes'), lines: ['-a.txt -text'] }],
  );
});

test('packed binary versions are reclaimed and deleting the last private blob leaves no pack behind', async () => {
  let directory = '';

  const run: GitRun = (command, args, options) => {
    directory = options.env?.GIT_OBJECT_DIRECTORY ?? directory;

    return execute(command, args, options);
  };

  const { work, git, changes } = await repository({ 'a.txt': 'base\n' }, run);

  await git('config', 'core.bigFileThreshold', '1k');

  await changes.watch(work);

  const size = async () => {
    let total = 0;

    for (const name of await readdir(directory, { recursive: true })) {
      const info = await stat(join(directory, name));

      if (info.isFile()) total += info.size;
    }

    return total;
  };

  let at8 = 0;

  for (let version = 1; version <= 32; version++) {
    await writeFile(join(work, 'data.bin'), binary(version));

    assert.deepEqual(
      (await changes.read(work)).files.map((file) => [file.path, file.unshown]),
      [[join(work, 'data.bin'), 'binary']],
    );

    if (version === 8) at8 = await size();

    if (version === 32) {
      const bytes = await size();

      assert.ok(bytes < 6 * 1024 * 1024);

      assert.ok(bytes <= at8 + 65536);
    }
  }

  const current = (
    await git('hash-object', '--no-filters', 'data.bin')
  ).stdout.trim();

  const blobSize = await execute('git', ['cat-file', '-s', current], {
    cwd: work,
    timeout: 10_000,
    env: { ...process.env, GIT_OBJECT_DIRECTORY: directory },
  });

  assert.equal(Number(blobSize.stdout), 2 * 1024 * 1024);

  await rm(join(work, 'data.bin'));

  assert.equal((await changes.read(work)).files[0]!.kind, 'delete');

  assert.deepEqual(await changes.read(work), {
    files: [],
    withHead: 0,
    more: 0,
  });

  assert.equal(await size(), 0);
});

test('sparse checkout changes preserve omitted tracked files and still report included edits', async () => {
  const { work, git, changes } = await repository({
    'keep.txt': 'kept\n',
    'omit.txt': 'omitted\n',
  });

  await changes.watch(work);

  await git('sparse-checkout', 'init', '--no-cone');

  await git('sparse-checkout', 'set', '/keep.txt');

  assert.deepEqual(await changes.read(work), {
    files: [],
    withHead: 0,
    more: 0,
  });

  await writeFile(join(work, 'keep.txt'), 'edited\n');

  assert.deepEqual(
    (await changes.read(work)).files.map((file) => ({
      path: file.path,
      lines: file.hunks.flatMap((hunk) => hunk.lines),
    })),
    [{ path: join(work, 'keep.txt'), lines: ['-kept', '+edited'] }],
  );

  await git('sparse-checkout', 'disable');

  assert.deepEqual(await changes.read(work), {
    files: [],
    withHead: 0,
    more: 0,
  });
});

test('text edits retain an unchanged private pack without rewriting its payload', async () => {
  const calls: string[][] = [];
  let directory = '';

  const run: GitRun = (command, args, options) => {
    calls.push(args);

    directory = options.env?.GIT_OBJECT_DIRECTORY ?? directory;

    return execute(command, args, options);
  };

  const { work, git, changes } = await repository({ 'a.txt': 'base\n' }, run);

  await git('config', 'core.bigFileThreshold', '1k');

  await changes.watch(work);

  await writeFile(join(work, 'data.bin'), binary(1));

  await changes.read(work);

  await changes.read(work);

  const names = (await readdir(join(directory, 'pack'))).filter((name) =>
    name.endsWith('.pack'),
  );

  assert.ok(names.length > 0);

  const before = await Promise.all(
    names.map((name) => stat(join(directory, 'pack', name), { bigint: true })),
  );

  calls.length = 0;

  await writeFile(join(work, 'a.txt'), 'edited\n');

  assert.deepEqual(
    (await changes.read(work)).files.map((file) =>
      file.hunks.flatMap((hunk) => hunk.lines),
    ),
    [['-base', '+edited']],
  );

  assert.deepEqual(await changes.read(work), {
    files: [],
    withHead: 0,
    more: 0,
  });

  assert.equal(calls.filter((args) => args.includes('pack-objects')).length, 0);

  for (const [index, name] of names.entries()) {
    const after = await stat(join(directory, 'pack', name), { bigint: true });

    assert.equal(after.ino, before[index]!.ino);

    assert.equal(after.mtimeNs, before[index]!.mtimeNs);
  }
});

test('a file removed during conversion is reported as a deletion', async () => {
  let target: string | undefined;

  const run: GitRun = async (command, args, options) => {
    if (target && args.includes('update-index') && args.includes('--stdin')) {
      await rm(target);

      target = undefined;
    }

    return execute(command, args, options);
  };

  const { work, changes } = await repository({ 'a.txt': 'base\n' }, run);

  await changes.watch(work);

  await writeFile(join(work, 'a.txt'), 'edited\n');

  target = join(work, 'a.txt');

  assert.deepEqual(
    (await changes.read(work)).files.map((file) => ({
      path: file.path,
      kind: file.kind,
      lines: file.hunks.flatMap((hunk) => hunk.lines),
    })),
    [{ path: join(work, 'a.txt'), kind: 'delete', lines: ['-base'] }],
  );

  assert.deepEqual(await changes.read(work), {
    files: [],
    withHead: 0,
    more: 0,
  });
});

for (const kind of ['file', 'repository'])
  test(`an untracked ${kind} replaced by a directory keeps ignored children out and reports visible children immediately`, async () => {
    const { work, changes } = await repository({ '.gitignore': '.env\n' });
    const target = join(work, 'item');

    if (kind === 'file') await writeFile(target, 'old\n');
    else {
      await mkdir(target);

      await execute('git', ['init', '-q'], { cwd: target, timeout: 10_000 });

      await execute(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          'commit',
          '--allow-empty',
          '-qm',
          'inner',
        ],
        { cwd: target, timeout: 10_000 },
      );
    }

    await changes.watch(work);

    await rm(target, { recursive: true });

    await mkdir(target);

    await writeFile(join(target, '.env'), 'excluded\n');

    await writeFile(join(target, 'visible.txt'), 'visible\n');

    assert.deepEqual(
      (await changes.read(work)).files.map((file) => ({
        path: file.path,
        kind: file.kind,
        lines: file.hunks.flatMap((hunk) => hunk.lines),
      })),
      [
        {
          path: target,
          kind: 'delete',
          lines: kind === 'file' ? ['-old'] : [],
        },
        {
          path: join(target, 'visible.txt'),
          kind: 'add',
          lines: ['+visible'],
        },
      ],
    );

    assert.deepEqual(await changes.read(work), {
      files: [],
      withHead: 0,
      more: 0,
    });
  });

test('SHA-256 snapshots absorb exact paths and reclaim obsolete loose and packed objects', async () => {
  let directory = '';

  const run: GitRun = (command, args, options) => {
    directory = options.env?.GIT_OBJECT_DIRECTORY ?? directory;

    return execute(command, args, options);
  };

  const { work, git, changes } = await repository(
    { 'a.txt': 'base\n', 'pending.txt': 'base\n', 'removed.txt': 'base\n' },
    run,
    'sha256',
  );

  await changes.watch(work);

  await writeFile(join(work, 'a.txt'), 'reported\n');

  await writeFile(join(work, 'pending.txt'), 'pending\n');

  await rm(join(work, 'removed.txt'));

  await changes.absorb(work, [join(work, 'a.txt'), join(work, 'removed.txt')]);

  assert.deepEqual(
    (await changes.read(work)).files.map((file) => ({
      path: file.path,
      lines: file.hunks.flatMap((hunk) => hunk.lines),
    })),
    [{ path: join(work, 'pending.txt'), lines: ['-base', '+pending'] }],
  );

  const old = (await git('hash-object', '--no-filters', 'a.txt')).stdout.trim();

  await writeFile(join(work, 'a.txt'), 'next\n');

  await changes.read(work);

  await changes.read(work);

  const local = (...args: string[]) =>
    execute('git', args, {
      cwd: work,
      timeout: 10_000,
      env: { ...process.env, GIT_OBJECT_DIRECTORY: directory },
    });

  await assert.rejects(local('cat-file', '-e', old), { code: 1 });

  const current = (
    await git('hash-object', '--no-filters', 'a.txt')
  ).stdout.trim();

  assert.equal((await local('cat-file', '-p', current)).stdout, 'next\n');

  await git('config', 'core.bigFileThreshold', '1k');

  await writeFile(join(work, 'data.bin'), Buffer.alloc(2048, 1));

  await changes.read(work);

  assert.ok(
    (await readdir(join(directory, 'pack'))).some((name) =>
      name.endsWith('.pack'),
    ),
  );

  const packed = (
    await git('hash-object', '--no-filters', 'data.bin')
  ).stdout.trim();

  await writeFile(join(work, 'data.bin'), Buffer.alloc(2048, 2));

  await changes.read(work);

  await changes.read(work);

  await assert.rejects(local('cat-file', '-e', packed), { code: 1 });

  const live = (
    await git('hash-object', '--no-filters', 'data.bin')
  ).stdout.trim();

  assert.equal((await local('cat-file', '-s', live)).stdout.trim(), '2048');
});

test('an untracked repository first commit is discovered with unchanged directory metadata', async () => {
  const { work, changes } = await repository({ 'a.txt': 'base\n' });
  const nested = join(work, 'nested');

  await mkdir(nested);

  const inner = (...args: string[]) =>
    execute('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: nested,
      timeout: 10_000,
    });

  await inner('init', '-q');

  await changes.watch(work);

  assert.deepEqual((await changes.read(work)).files, []);

  const before = await lstat(nested, { bigint: true });

  await inner('commit', '--allow-empty', '-qm', 'first');

  const after = await lstat(nested, { bigint: true });

  assert.equal(after.mtimeNs, before.mtimeNs);

  assert.equal(after.ctimeNs, before.ctimeNs);

  assert.deepEqual((await changes.read(work)).files, [
    {
      path: nested,
      kind: 'add',
      hunks: [],
      unshown: { added: 1, removed: 0 },
    },
  ]);
});

for (const ignored of [false, true])
  test(`a directory replaced by ${ignored ? 'an ignored' : 'a visible'} symlink reports only checkout entries`, async () => {
    const { root, work, git, changes } = await repository({
      '.gitignore': ignored ? 'folder\n' : '',
    });

    await mkdir(join(work, 'folder'));

    await writeFile(join(work, 'folder', 'a.txt'), 'base\n');

    await git('add', '-f', 'folder/a.txt');

    await git('commit', '-qm', 'tracked child');

    await changes.watch(work);

    await mkdir(join(root, 'copy'));

    await writeFile(join(root, 'copy', 'a.txt'), 'outside\n');

    await rm(join(work, 'folder'), { recursive: true });

    await symlink('../copy', join(work, 'folder'));

    assert.deepEqual(
      (await changes.read(work)).files.map((file) => ({
        path: file.path,
        kind: file.kind,
        lines: file.hunks.flatMap((hunk) => hunk.lines),
      })),
      [
        ...(ignored
          ? []
          : [{ path: join(work, 'folder'), kind: 'add', lines: ['+../copy'] }]),
        {
          path: join(work, 'folder', 'a.txt'),
          kind: 'delete',
          lines: ['-base'],
        },
      ],
    );

    assert.deepEqual(await changes.read(work), {
      files: [],
      withHead: 0,
      more: 0,
    });
  });

test('a failed snapshot cannot reintroduce a newly ignored untracked file on reset', async () => {
  let fail = false;

  const run: GitRun = (command, args, options) => {
    if (fail && args.includes('write-tree')) {
      fail = false;

      return Promise.reject(
        Object.assign(new Error('injected'), {
          code: 128,
          stderr: 'fatal: injected write-tree failure',
        }),
      );
    }

    return execute(command, args, options);
  };

  const { work, changes } = await repository(
    { '.gitignore': '', 'a.txt': 'base\n' },
    run,
  );

  await writeFile(join(work, 'x.txt'), 'visible\n');

  await changes.watch(work);

  await writeFile(join(work, '.gitignore'), 'x.txt\n');

  await writeFile(join(work, 'a.txt'), 'changed\n');

  fail = true;

  await assert.rejects(changes.read(work), /injected/);

  await writeFile(join(work, 'x.txt'), 'excluded secret\n');

  assert.deepEqual(
    (await changes.read(work)).files.map((file) => ({
      path: file.path,
      kind: file.kind,
      lines: file.hunks.flatMap((hunk) => hunk.lines),
    })),
    [
      { path: join(work, '.gitignore'), kind: 'update', lines: ['+x.txt'] },
      {
        path: join(work, 'a.txt'),
        kind: 'update',
        lines: ['-base', '+changed'],
      },
      { path: join(work, 'x.txt'), kind: 'delete', lines: ['-visible'] },
    ],
  );

  assert.deepEqual(await changes.read(work), {
    files: [],
    withHead: 0,
    more: 0,
  });
});

test('an invalid nested Git directory in a tracked file replacement keeps ignored contents out', async () => {
  const { work, changes } = await repository({
    '.gitignore': '.env\n',
    a: 'old\n',
  });

  await changes.watch(work);

  await rm(join(work, 'a'));

  await mkdir(join(work, 'a'));

  await execute('git', ['init', '-q'], {
    cwd: join(work, 'a'),
    timeout: 10_000,
  });

  await rm(join(work, 'a', '.git', 'HEAD'));

  await writeFile(join(work, 'a', '.env'), 'excluded\n');

  await writeFile(join(work, 'a', 'visible.txt'), 'visible\n');

  assert.deepEqual(
    (await changes.read(work)).files.map((file) => ({
      path: file.path,
      kind: file.kind,
      lines: file.hunks.flatMap((hunk) => hunk.lines),
    })),
    [
      { path: join(work, 'a'), kind: 'delete', lines: ['-old'] },
      {
        path: join(work, 'a', 'visible.txt'),
        kind: 'add',
        lines: ['+visible'],
      },
    ],
  );

  assert.deepEqual(await changes.read(work), {
    files: [],
    withHead: 0,
    more: 0,
  });
});

for (const ours of ['lf', 'crlf', 'absent'])
  test(`unmerged index conversion uses ${ours} from our side and preserves native mode and no-op filtering`, async () => {
    const fixture = await filtered();
    const { root, work, git, marker } = fixture;
    let privateEnv: NodeJS.ProcessEnv | undefined;
    let tree = '';

    const changes = new WorkTreeChanges(
      join(root, 'merge-changes'),
      async (command, args, options) => {
        const result = await fixture.run(command, args, options);

        if (args.includes('write-tree')) {
          privateEnv = options.env;
          tree = result.stdout.trim();
        }

        return result;
      },
    );

    await git('config', 'core.autocrlf', 'false');

    await git('config', 'core.filemode', 'false');

    await writeFile(
      join(work, '.gitattributes'),
      '*.txt filter=probe text=auto\n',
    );

    await writeFile(join(root, 'lf'), 'one:one\n');

    await writeFile(join(root, 'crlf'), 'one:one\r\n');

    const lf = (
      await git('hash-object', '-w', '--no-filters', join(root, 'lf'))
    ).stdout.trim();

    const crlf = (
      await git('hash-object', '-w', '--no-filters', join(root, 'crlf'))
    ).stdout.trim();

    const records = [
      `0 ${'0'.repeat(lf.length)}\ta.txt`,
      `100755 ${lf} 1\ta.txt`,
      ...(ours === 'absent'
        ? []
        : [`100755 ${ours === 'lf' ? lf : crlf} 2\ta.txt`]),
      `100644 ${ours === 'crlf' ? lf : crlf} 3\ta.txt`,
    ];

    await fixture.run('git', ['update-index', '-z', '--index-info'], {
      cwd: work,
      timeout: 10_000,
      input: `${records.join('\0')}\0`,
    });

    await git('init', '-q', join(work, 'unborn'));

    const original = await readFile(join(work, '.git', 'index'));

    await writeFile(join(work, 'a.txt'), 'one\r\n');

    await changes.watch(work);

    const count = (await readFile(marker)).length;

    assert.deepEqual((await changes.read(work)).files, []);

    assert.equal((await readFile(marker)).length, count);

    const indexed = await execute('git', ['ls-tree', tree, '--', 'a.txt'], {
      cwd: work,
      timeout: 10_000,
      env: privateEnv,
    });

    assert.match(indexed.stdout, /^100755 blob [0-9a-f]+\ta\.txt\n$/);

    await writeFile(join(work, 'a.txt'), 'one\n');

    assert.deepEqual(
      (await changes.read(work)).files.map((file) =>
        file.hunks.flatMap((hunk) => hunk.lines),
      ),
      ours === 'crlf' ? [['-one:one\r', '+one:one']] : [],
    );

    const stable = (await readFile(marker)).length;

    assert.deepEqual((await changes.read(work)).files, []);

    assert.equal((await readFile(marker)).length, stable);

    changes.close();

    await changes.settled();

    assert.deepEqual(await readFile(join(work, '.git', 'index')), original);
  });
