import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import { main, Memory } from '../../src/memory/memory.js';
import { passThrough } from '../fixtures/git.js';
import { fixture, git, save } from '../fixtures/memory.js';
import { scratch } from '../fixtures/scratch.js';
import { seededMemory } from '../fixtures/seeded-memory.js';
import { unreadable } from '../fixtures/unreadable.js';

const lines = (changes: Record<number, string> = {}) =>
  [1, 2, 3, 4, 5].map((line) => changes[line] ?? `line ${line}`).join('\n') +
  '\n';

test('two workspaces publish different notes, each with its own attribution', async () => {
  const { memory, open } = await fixture();
  const { workspace: first } = await open('first');
  const { workspace: second } = await open('second');

  await save(
    first,
    { 'global/first.md': 'First.' },
    'save\n\nconversation: first',
  );

  await save(
    second,
    { 'global/second.md': 'Second.' },
    'save\n\nconversation: second',
  );

  assert.equal(await first.publish(), 'published');

  assert.equal(await second.publish(), 'published');

  assert.equal(await memory.read(main, 'global/first.md'), 'First.');

  assert.equal(await memory.read(main, 'global/second.md'), 'Second.');

  const bodies = await git(memory.root, 'log', '--format=%b', main);

  assert.match(bodies, /conversation: first/);

  assert.match(bodies, /conversation: second/);
});

test('publication reports the conflicting commit even when a later commit reverted it', async () => {
  const { memory, open } = await fixture();
  const { workspace: theirs } = await open('theirs');

  await save(theirs, { 'global/n.md': 'one\n' });

  await theirs.publish();

  const { workspace: mine } = await open('mine');

  await save(mine, { 'global/n.md': 'a-change\n' });

  await save(mine, { 'global/n.md': 'one\n' });

  await save(theirs, { 'global/n.md': 'b-change\n' });

  await theirs.publish();

  const head = await mine.revision();
  const accepted = await memory.resolve(main);
  const index = await git(mine.root, 'write-tree');
  const result = await mine.publish();

  assert.ok(result !== 'published');

  assert.deepEqual(result.paths, ['global/n.md']);

  assert.match(result.diff, /^-one$/m);

  assert.match(result.diff, /^\+a-change$/m);

  assert.equal(await mine.revision(), head);

  assert.equal(await memory.resolve(main), accepted);

  assert.equal(await git(mine.root, 'write-tree'), index);

  assert.equal(await readFile(join(mine.root, 'global/n.md'), 'utf8'), 'one\n');

  assert.equal(await mine.isDirty(), false);

  assert.equal(await mine.rebaseStopped(), false);
});

test('publication previews a later conflict against the already replayed commits', async () => {
  const { open } = await fixture();
  const { workspace: theirs } = await open('theirs');

  await save(theirs, { 'global/a.md': 'zero\n', 'global/n.md': 'one\n' });

  await theirs.publish();

  const { workspace: mine } = await open('mine');

  await save(mine, { 'global/a.md': 'first\n' });

  await save(mine, { 'global/a.md': 'second\n', 'global/n.md': 'a-change\n' });

  await save(theirs, { 'global/n.md': 'b-change\n' });

  await theirs.publish();

  const result = await mine.publish();

  assert.ok(result !== 'published');

  assert.deepEqual(result.paths, ['global/n.md']);

  assert.match(result.diff, /^-first$/m);

  assert.match(result.diff, /^\+second$/m);

  assert.match(result.diff, /^\+a-change$/m);

  assert.doesNotMatch(result.diff, /^-zero$/m);
});

test('publication retains its conflict preview when main advances during abort', async () => {
  const { memory, open, hook } = await fixture();
  const { workspace: theirs } = await open('theirs');

  await save(theirs, { 'global/n.md': 'one\n' });

  await theirs.publish();

  const { workspace: mine } = await open('mine');

  await save(mine, { 'global/n.md': 'a-change\n' });

  await save(theirs, { 'global/n.md': 'b-change\n' });

  await theirs.publish();

  hook.current = async (command, run) => {
    const result = await run();

    if (command.join(' ') === 'rebase --abort') {
      hook.current = passThrough;

      await save(theirs, { 'global/n.md': 'one\n' });

      await theirs.publish();
    }

    return result;
  };

  const result = await mine.publish();

  assert.ok(result !== 'published');

  assert.deepEqual(result.paths, ['global/n.md']);

  assert.match(result.diff, /^\+a-change$/m);

  assert.equal(await memory.read(main, 'global/n.md'), 'one\n');
});

test('a failed conflict preview aborts the rebase without changing either branch', async () => {
  const { memory, open, hook } = await fixture();
  const { workspace: theirs } = await open('theirs');

  await save(theirs, { 'global/n.md': 'one\n' });

  await theirs.publish();

  const { workspace: mine } = await open('mine');

  await save(mine, { 'global/n.md': 'a-change\n' });

  await save(theirs, { 'global/n.md': 'b-change\n' });

  await theirs.publish();

  const head = await mine.revision();
  const accepted = await memory.resolve(main);
  const index = await git(mine.root, 'write-tree');

  hook.current = (command, run) => {
    if (command[0] === 'merge-tree') throw new Error('preview failed');

    return run();
  };

  await assert.rejects(mine.publish(), /preview failed/);

  assert.equal(await mine.revision(), head);

  assert.equal(await memory.resolve(main), accepted);

  assert.equal(await git(mine.root, 'write-tree'), index);

  assert.equal(
    await readFile(join(mine.root, 'global/n.md'), 'utf8'),
    'a-change\n',
  );

  assert.equal(await mine.isDirty(), false);

  assert.equal(await mine.rebaseStopped(), false);
});

test('keep mine wins conflicting lines and merges every other change, and discard mine takes main', async () => {
  for (const decision of ['keep', 'discard'] as const) {
    const { memory, open, project, begin } = await fixture();
    const { workspace: theirs } = await open('theirs');
    const { workspace: mine } = await open('mine');

    const base = {
      'global/one.md': lines(),
      'global/two.md': lines(),
    };

    await save(theirs, base);

    await theirs.publish();

    await begin(mine, project);

    await save(theirs, {
      'global/one.md': lines({ 1: 'theirs 1', 3: 'theirs 3' }),
      'global/two.md': lines({ 1: 'theirs 1' }),
    });

    await theirs.publish();

    await save(mine, {
      'global/one.md': lines({ 1: 'mine 1' }),
      'global/two.md': lines({ 3: 'mine 3' }),
      'global/three.md': 'Mine only.',
    });

    const conflict = await mine.publish();

    assert.ok(conflict !== 'published');

    assert.deepEqual(conflict.paths, ['global/one.md']);

    assert.match(conflict.diff, /^--- global\/one\.md$/m);

    assert.match(conflict.diff, /^\+mine 1$/m);

    assert.doesNotMatch(conflict.diff, /theirs/);

    if (decision === 'keep') {
      await mine.keepMine();

      assert.equal(await mine.publish(), 'published');

      assert.equal(
        await memory.read(main, 'global/one.md'),
        lines({ 1: 'mine 1', 3: 'theirs 3' }),
      );

      assert.equal(
        await memory.read(main, 'global/two.md'),
        lines({ 1: 'theirs 1', 3: 'mine 3' }),
      );

      assert.equal(await memory.read(main, 'global/three.md'), 'Mine only.');
    } else {
      await mine.discardMine();

      assert.equal(await mine.revision(), await memory.resolve(main));

      assert.equal(
        await readFile(join(mine.root, 'global/one.md'), 'utf8'),
        lines({ 1: 'theirs 1', 3: 'theirs 3' }),
      );

      assert.equal(await mine.publish(), 'published');
    }
  }
});

for (const [name, conflictingPath, myFiles, theirFiles, keptFiles] of [
  [
    'keep mine keeps its directory at a file/directory conflict',
    'global/x',
    { 'global/x/y.md': 'mine\n' },
    { 'global/x': 'theirs\n' },
    { 'global/x/y.md': 'mine\n' },
  ],
  [
    'keep mine keeps its file at a file/directory conflict',
    'global/x',
    { 'global/x': 'mine\n' },
    { 'global/x/y.md': 'theirs\n' },
    { 'global/x': 'mine\n' },
  ],
  [
    'keep mine preserves literal paths and existing tilde names',
    'global/x[1]',
    {
      'global/x[1]': 'mine\n',
      'global/x[1]~HEAD': 'user-named\n',
    },
    {
      'global/x[1]/y.md': 'theirs\n',
      'global/x1': 'literal-neighbor\n',
    },
    {
      'global/x[1]': 'mine\n',
      'global/x[1]~HEAD': 'user-named\n',
      'global/x1': 'literal-neighbor\n',
    },
  ],
] as const) {
  test(name, async () => {
    const { memory, open } = await fixture();
    const { workspace: theirs } = await open('theirs');
    const { workspace: mine } = await open('mine');

    await save(mine, { ...myFiles, 'global/mine.md': 'mine-only\n' });

    await save(theirs, { ...theirFiles, 'global/theirs.md': 'theirs-only\n' });

    await theirs.publish();

    const conflict = await mine.publish();

    assert.ok(conflict !== 'published');

    assert.deepEqual(conflict.paths, [conflictingPath]);

    await mine.keepMine();

    assert.equal(await mine.publish(), 'published');

    const expectedFiles = {
      ...keptFiles,
      'global/mine.md': 'mine-only\n',
      'global/theirs.md': 'theirs-only\n',
    };

    for (const [path, text] of Object.entries(expectedFiles)) {
      assert.equal(await readFile(join(mine.root, path), 'utf8'), text);

      assert.equal(await memory.read(main, path), text);
    }

    assert.deepEqual(
      (await git(memory.root, 'ls-tree', '-r', '--name-only', '-z', main))
        .split('\0')
        .filter(Boolean)
        .sort(),
      ['global/MEMORY.md', ...Object.keys(expectedFiles)].sort(),
    );
  });
}

test('keep mine carries no markers through a rename on either side', async () => {
  for (const renamer of ['theirs', 'mine'] as const) {
    const { memory, open, project, begin } = await fixture();
    const { workspace: theirs } = await open('theirs');
    const { workspace: mine } = await open('mine');

    await save(theirs, { 'global/one.md': lines() });

    await theirs.publish();

    await begin(mine, project);

    if (renamer === 'theirs') {
      await save(theirs, {
        'global/one.md': null,
        'global/renamed.md': lines({ 2: 'theirs 2' }),
      });

      await save(mine, { 'global/one.md': lines({ 2: 'mine 2' }) });
    } else {
      await save(theirs, {
        'global/one.md': lines({ 2: 'theirs 2', 4: 'theirs 4' }),
      });

      await save(mine, {
        'global/one.md': null,
        'global/renamed.md': lines({ 2: 'mine 2' }),
      });
    }

    await theirs.publish();

    assert.notEqual(await mine.publish(), 'published');

    await mine.keepMine();

    assert.equal(await mine.publish(), 'published');

    await memory.run(memory.root, ['grep', '-q', '<<<<<<<', main], {
      codes: [1],
    });

    await assert.rejects(memory.read(main, 'global/one.md'));

    assert.equal(
      await memory.read(main, 'global/renamed.md'),
      renamer === 'theirs'
        ? lines({ 2: 'mine 2' })
        : lines({ 2: 'mine 2', 4: 'theirs 4' }),
    );
  }
});

test('a publish that loses the race to update main retries onto the new main', async () => {
  const { memory, open, hook } = await fixture();
  const { workspace: first } = await open('first');
  const { workspace: second } = await open('second');

  await save(first, { 'global/first.md': 'First.' });

  await save(second, { 'global/second.md': 'Second.' });

  let armed = true;

  hook.current = async (command, run, options) => {
    const result = await run();

    if (
      armed &&
      options.cwd === first.root &&
      command.join(' ') === `rev-parse ${main}`
    ) {
      armed = false;

      await second.publish();
    }

    return result;
  };

  assert.equal(await first.publish(), 'published');

  assert.equal(await memory.read(main, 'global/first.md'), 'First.');

  assert.equal(await memory.read(main, 'global/second.md'), 'Second.');
});

test('keep mine merges against the main it read even when main moves', async () => {
  const { memory, open, hook } = await fixture();
  const { workspace: theirs } = await open('theirs');
  const { workspace: mine } = await open('mine');
  const { workspace: other } = await open('other');

  await save(theirs, { 'global/one.md': 'Theirs.\n' });

  await save(mine, { 'global/one.md': 'Mine.\n' });

  await save(other, { 'global/other.md': 'Other.' });

  await theirs.publish();

  assert.notEqual(await mine.publish(), 'published');

  hook.current = async (command, run) => {
    const result = await run();

    if (command[0] === 'merge-tree') {
      hook.current = passThrough;

      await other.publish();
    }

    return result;
  };

  await mine.keepMine();

  assert.equal(await mine.publish(), 'published');

  assert.equal(await memory.read(main, 'global/one.md'), 'Mine.\n');

  assert.equal(await memory.read(main, 'global/other.md'), 'Other.');
});

test('a crash inside keep mine before its reset leaves the worktree clean and the conflict standing', async () => {
  for (const theirPath of ['global/one.md', 'global/one.md/child.md']) {
    const { memory, open, hook } = await fixture();
    const { workspace: theirs } = await open('theirs');
    const { workspace: mine } = await open('mine');

    // their extra note puts the merged tree ahead of my HEAD, which a real index would stage
    await save(theirs, {
      [theirPath]: 'Theirs.\n',
      'global/theirs.md': 'Theirs only.',
    });

    await save(mine, { 'global/one.md': 'Mine.\n' });

    await theirs.publish();

    assert.notEqual(await mine.publish(), 'published');

    const head = await mine.revision();
    const accepted = await memory.resolve(main);

    const index = (
      await git(mine.root, 'rev-parse', '--git-path', 'index')
    ).trim();

    const indexBefore = await readFile(index);

    hook.current = async (command, run) => {
      const result = await run();

      if (command[0] === 'commit-tree') throw new Error('crashed');

      return result;
    };

    await assert.rejects(mine.keepMine(), /crashed/);

    hook.current = passThrough;

    assert.equal(await mine.revision(), head);

    assert.equal(await memory.resolve(main), accepted);

    assert.deepEqual(await readFile(index), indexBefore);

    assert.equal(
      await readFile(join(mine.root, 'global/one.md'), 'utf8'),
      'Mine.\n',
    );

    assert.equal(await mine.isDirty(), false);

    assert.notEqual(await mine.publish(), 'published');
  }
});

test('a deleted worktree directory comes back on its branch with its unpublished commit', async () => {
  const { memory, open } = await fixture();
  const { workspace } = await open('a');

  await save(workspace, { 'global/kept.md': 'Kept.' });

  const commit = await workspace.revision();

  await rm(workspace.root, { recursive: true });

  await workspace.ensureWorktree();

  assert.equal(
    (await git(workspace.root, 'symbolic-ref', 'HEAD')).trim(),
    'refs/heads/conversations/a',
  );

  assert.equal(await workspace.revision(), commit);

  await workspace.publish();

  assert.equal(await memory.read(main, 'global/kept.md'), 'Kept.');
});

test('a stopped rebase is found under a state directory with a line break', async () => {
  const root = join(await scratch('witch-memory-'), 'state\nbreak');
  const memory = await seededMemory(join(root, 'memory.git'));
  const workspace = memory.workspace(join(root, 'conversations', 'a'), 'a');

  await workspace.ensureWorktree();

  assert.equal(await workspace.rebaseStopped(), false);

  const gitdir = await git(workspace.root, 'rev-parse', '--absolute-git-dir');

  await mkdir(join(gitdir.slice(0, -1), 'rebase-merge'));

  assert.equal(await workspace.rebaseStopped(), true);
});

test('initialization fails on a root it cannot look at and builds nothing beside it', async (t) => {
  const parent = await scratch('witch-memory-');
  const root = join(parent, 'memory.git');

  unreadable(t, root);

  await assert.rejects(new Memory(root).initialize(), { code: 'EACCES' });

  assert.deepEqual(await readdir(parent), []);
});

test('a worktree whose .git cannot be looked at is not read as missing', async (t) => {
  const root = await scratch('witch-memory-');
  const memory = await seededMemory(join(root, 'memory.git'));
  const workspace = memory.workspace(join(root, 'conversations', 'a'), 'a');

  await workspace.ensureWorktree();

  unreadable(t, join(workspace.root, '.git'));

  await assert.rejects(workspace.exists(), { code: 'EACCES' });
});

test('a rebase directory that cannot be looked at is not read as no rebase', async (t) => {
  const root = await scratch('witch-memory-');
  const memory = await seededMemory(join(root, 'memory.git'));
  const workspace = memory.workspace(join(root, 'conversations', 'a'), 'a');

  await workspace.ensureWorktree();

  const gitdir = /^gitdir: (.+)\n$/.exec(
    await readFile(join(workspace.root, '.git'), 'utf8'),
  )![1]!;

  unreadable(t, join(resolve(workspace.root, gitdir), 'rebase-merge'));

  await assert.rejects(workspace.rebaseStopped(), { code: 'EACCES' });
});

for (const [name, mineChange, theirChange, expected] of [
  ['I delete, they edit', null, lines({ 2: 'theirs 2' }), undefined],
  ['I edit, they delete', lines({ 2: 'mine 2' }), null, lines({ 2: 'mine 2' })],
] as const) {
  test(`keep mine when ${name}`, async () => {
    const { memory, open, project, begin } = await fixture();
    const { workspace: theirs } = await open('theirs');
    const { workspace: mine } = await open('mine');

    await save(theirs, { 'global/one.md': lines(), 'global/keep.md': 'Keep.' });

    await theirs.publish();

    await begin(mine, project);

    await save(theirs, { 'global/one.md': theirChange });

    await save(mine, { 'global/one.md': mineChange });

    await theirs.publish();

    assert.notEqual(await mine.publish(), 'published');

    await mine.keepMine();

    await mine.publish();

    if (expected === undefined)
      await assert.rejects(memory.read(main, 'global/one.md'));
    else assert.equal(await memory.read(main, 'global/one.md'), expected);

    assert.equal(await memory.read(main, 'global/keep.md'), 'Keep.');
  });
}

test('keep mine keeps their renamed copy of a note I deleted', async () => {
  const { memory, open, project, begin } = await fixture();
  const { workspace: theirs } = await open('theirs');
  const { workspace: mine } = await open('mine');

  await save(theirs, { 'global/one.md': lines(), 'global/keep.md': 'Keep.' });

  await theirs.publish();

  await begin(mine, project);

  await save(theirs, { 'global/one.md': null, 'global/renamed.md': lines() });

  await save(mine, { 'global/one.md': null });

  await theirs.publish();

  assert.notEqual(await mine.publish(), 'published');

  await mine.keepMine();

  await mine.publish();

  assert.equal(await memory.read(main, 'global/renamed.md'), lines());
});
