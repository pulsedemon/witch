import assert from 'node:assert/strict';

import { readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';

import { join } from 'node:path';

import { test } from 'vitest';

import { fixture, save } from './fixtures/memory.js';

import { passThrough } from './fixtures/git.js';

async function context() {
  const { memory, open, project, hook } = await fixture();

  const { workspace } = await open('context');

  const scope = await memory.scopePaths(project);

  const projectIndex = `${scope.project}/MEMORY.md`;

  await save(workspace, {
    'global/MEMORY.md': 'Global preference 17.\n',
    [projectIndex]: 'Project preference 29.\n',
    'global/kept.md': 'Reference detail 53.\n',
  });

  return {
    hook,
    memory,
    workspace,
    scope,
    projectIndex,
    before: await workspace.revision(),
    snapshot: async (previous?: string) =>
      memory.snapshot(
        await workspace.revision(),
        workspace.root,
        scope,
        previous,
      ),
  };
}

test('a snapshot reads its captured commit when the branch advances after enumeration', async () => {
  const f = await context();

  f.hook.current = async (command, run) => {
    const result = await run();

    if (command[0] === 'ls-tree' && command[1] === '-r') {
      f.hook.current = passThrough;

      await save(f.workspace, {
        'global/MEMORY.md': 'Later global preference 71.\n',
        [f.projectIndex]: 'Later project preference 73.\n',
      });
    }

    return result;
  };

  const snapshot = await f.memory.snapshot(f.before, f.workspace.root, f.scope);

  assert.notEqual(await f.workspace.revision(), f.before);

  assert.ok(snapshot.includes('Global preference 17.\n'));

  assert.ok(snapshot.includes('Project preference 29.\n'));

  assert.doesNotMatch(snapshot, /Later global|Later project/);
});

test('snapshots and standalone text and byte reads reject a committed symlink index', async () => {
  const f = await context();

  const index = 'global/MEMORY.md';

  await rm(join(f.workspace.root, index));

  await symlink('kept.md', join(f.workspace.root, index));

  await f.memory.git(f.workspace.root, ['add', '--all']);

  await f.memory.git(f.workspace.root, ['commit', '-m', 'legacy symlink']);

  const revision = await f.workspace.revision();

  await assert.rejects(
    f.memory.snapshot(revision, f.workspace.root, f.scope),
    /regular files/,
  );

  await assert.rejects(f.memory.read(revision, index), /regular files/);

  await assert.rejects(f.memory.readBytes(revision, index), /regular files/);
});

test('an unrelated project commit produces no memory update', async () => {
  const f = await context();

  await save(f.workspace, { 'projects/other/note.md': 'Other project 71.' });

  assert.equal(await f.snapshot(f.before), '');
});

for (const changed of ['global', 'project'] as const) {
  test(`a ${changed} index update replaces only its own accepted scope`, async () => {
    const f = await context();

    const file = changed === 'global' ? 'global/MEMORY.md' : f.projectIndex;

    const replacement = `${changed} replacement 41.\n`;

    await save(f.workspace, { [file]: replacement });

    await writeFile(join(f.workspace.root, file), 'Uncommitted value 67.');

    const update = await f.snapshot(f.before);

    assert.ok(
      update.includes(`${join(f.workspace.root, file)}\n${replacement}`),
    );

    assert.doesNotMatch(update, /Uncommitted value 67/);

    assert.doesNotMatch(update, /Global preference 17|Project preference 29/);

    assert.match(update, /replace only their named scopes/);

    assert.match(update, /Other current scopes are unchanged/);

    assert.doesNotMatch(update, /supersedes all earlier/);
  });
}

test('reference updates carry paths and statuses without unchanged indexes or note bodies', async () => {
  const f = await context();

  await save(f.workspace, {
    'global/moved.md': 'Move source.',
    'global/deleted.md': 'Delete source.',
  });

  const before = await f.workspace.revision();

  await rename(
    join(f.workspace.root, 'global/moved.md'),
    join(f.workspace.root, 'global/renamed.md'),
  );

  await save(f.workspace, {
    'global/added.md': 'New reference 73.',
    'global/kept.md': 'Changed reference 83.',
    'global/deleted.md': null,
  });

  const update = await f.snapshot(before);

  for (const [status, file] of [
    ['A', 'added'],
    ['M', 'kept'],
    ['D', 'deleted'],
    ['D', 'moved'],
    ['A', 'renamed'],
  ]) {
    assert.ok(
      update.includes(
        `${status}\t${JSON.stringify(join(f.workspace.root, 'global', `${file}.md`))}`,
      ),
    );
  }

  assert.doesNotMatch(update, /Global preference 17|Project preference 29/);

  assert.doesNotMatch(
    update,
    /New reference 73|Changed reference 83|Move source/,
  );

  assert.match(update, /deleted notes are no longer active/);

  assert.match(
    update,
    /Re-read changed reference notes before relying on them/,
  );
});

test('reversed changes still invalidate delivered intermediate memory', async () => {
  const f = await context();

  await save(f.workspace, {
    [f.projectIndex]: 'Intermediate preference 89.',
    'global/temporary.md': 'Temporary reference.',
    'global/kept.md': null,
  });

  await save(f.workspace, {
    [f.projectIndex]: 'Project preference 29.\n',
    'global/temporary.md': null,
    'global/kept.md': 'Reference detail 53.\n',
  });

  const update = await f.snapshot(f.before);

  assert.ok(update.includes('Project preference 29.\n'));

  assert.ok(
    update.includes(
      `D\t${JSON.stringify(join(f.workspace.root, 'global/temporary.md'))}`,
    ),
  );

  assert.ok(
    update.includes(
      `M\t${JSON.stringify(join(f.workspace.root, 'global/kept.md'))}`,
    ),
  );

  assert.doesNotMatch(update, /Intermediate preference 89/);
});

test('deleting an index withdraws its previous essentials while reference notes remain', async () => {
  const f = await context();

  await save(f.workspace, { [f.projectIndex]: null });

  const update = await f.snapshot(f.before);

  assert.ok(
    update.includes(
      `${join(f.workspace.root, f.projectIndex)}\n(No saved essentials.)`,
    ),
  );

  assert.ok(
    update.includes(
      `D\t${JSON.stringify(join(f.workspace.root, f.projectIndex))}`,
    ),
  );

  assert.doesNotMatch(update, /Project preference 29|Global preference 17/);

  assert.match(
    update,
    /Removed index facts and deleted notes are no longer active/,
  );

  assert.equal(
    await readFile(join(f.workspace.root, 'global/kept.md'), 'utf8'),
    'Reference detail 53.\n',
  );
});

test('index limits count UTF-8 bytes and preserve complete inline or referenced contents', async () => {
  const f = await context();

  for (const { body, bytes, inline } of [
    { body: 'a'.repeat(6000), bytes: 6000, inline: true },
    { body: 'b'.repeat(6001), bytes: 6001, inline: false },
    { body: 'é'.repeat(3000), bytes: 6000, inline: true },
    { body: 'é'.repeat(3001), bytes: 6002, inline: false },
  ]) {
    await save(f.workspace, { [f.projectIndex]: body });

    const snapshot = await f.snapshot();

    const file = join(f.workspace.root, f.projectIndex);

    if (inline) assert.ok(snapshot.includes(`${file}\n${body}`));
    else {
      assert.ok(snapshot.includes(`${file}\n(${bytes} bytes)`));

      assert.ok(!snapshot.includes(body.slice(0, 100)));

      assert.match(
        snapshot,
        /Read the complete file at the path above before acting/,
      );

      assert.match(snapshot, /It replaces the previous index for this scope/);
    }

    assert.equal(await readFile(file, 'utf8'), body);
  }
});

test('many notes produce bounded baselines and complete reference invalidation on update', async () => {
  const f = await context();

  const notes = Object.fromEntries(
    Array.from({ length: 150 }, (_, i) => [
      `global/note-${i}.md`,
      'Reference body 97.',
    ]),
  );

  await save(f.workspace, { ...notes, 'global/kept.md': null });

  const baseline = await f.snapshot();

  assert.match(baseline, /Global preference 17/);

  assert.match(baseline, /Project preference 29/);

  assert.doesNotMatch(
    baseline,
    /Available reference notes|note-149\.md|Reference body 97/,
  );

  for (const snapshot of [baseline, await f.snapshot(f.before)]) {
    assert.match(
      snapshot,
      /Treat all previously read reference notes as stale/,
    );

    assert.match(snapshot, /missing notes no longer apply/);

    assert.doesNotMatch(snapshot, /note-0\.md|Changed or deleted notes/);

    assert.ok(Buffer.byteLength(snapshot, 'utf8') < 2000);
  }

  const files = await f.memory.files(await f.workspace.revision(), f.scope);

  assert.deepEqual(
    files.filter((file) => /note-\d+\.md$/.test(file)).sort(),
    Object.keys(notes).sort(),
  );
});

test('a filename with Unicode and control characters remains identifiable in a change notice', async () => {
  const f = await context();

  const file = 'global/café\tline\nquote".md';

  await save(f.workspace, { [file]: 'Reference body 101.' });

  const update = await f.snapshot(f.before);

  assert.ok(
    update.includes(`A\t${JSON.stringify(join(f.workspace.root, file))}`),
  );

  assert.doesNotMatch(update, /Reference body 101/);
});
