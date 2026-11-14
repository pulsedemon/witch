import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { EmptyMemory } from '../fixtures/empty-memory.js';
import { git } from '../fixtures/git.js';
import { scratch } from '../fixtures/scratch.js';

test('empty memory keeps real project identity while refusing memory repository operations', async () => {
  const root = await scratch('witch-empty-memory-');
  const project = join(root, 'project');

  await mkdir(project);

  const memory = new EmptyMemory(join(root, 'memory.git'));

  await memory.initialize();

  const before = await memory.scopePaths(project);

  await git(project, 'init', '-q');

  await git(project, 'remote', 'add', 'origin', 'https://example.com/a.git');

  const first = await memory.scopePaths(project);

  await git(
    project,
    'remote',
    'set-url',
    'origin',
    'https://example.com/b.git',
  );

  const second = await memory.scopePaths(project);

  assert.notEqual(first.project, before.project);

  assert.notEqual(second.project, first.project);

  assert.equal(first.checkout, before.project);

  assert.equal(second.checkout, before.project);

  await assert.rejects(
    memory.git(memory.root, ['status']),
    /real memory fixture/,
  );
});

test('empty memory refuses note edits instead of reporting successful publication', async () => {
  const root = await scratch('witch-empty-memory-');
  const memory = new EmptyMemory(join(root, 'memory.git'));
  const workspace = memory.workspace(join(root, 'conversation'), 'one');

  assert.equal(await workspace.branchExists(), false);

  await workspace.ensureWorktree();

  assert.equal(
    await memory.workspace(join(root, 'conversation'), 'one').branchExists(),
    true,
  );

  const note = join(workspace.root, 'note.md');

  await writeFile(note, 'A note requiring real Git.');

  await assert.rejects(workspace.status(), /real memory fixture/);

  await assert.rejects(workspace.commit('save'), /real memory fixture/);

  await assert.rejects(workspace.publish(), /real memory fixture/);

  await assert.rejects(
    memory.git(workspace.root, ['status']),
    /real memory fixture/,
  );

  await rm(note);

  assert.equal((await workspace.status()).dirty, false);
});
