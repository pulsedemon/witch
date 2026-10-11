import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Memory } from '../src/memory/memory.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'harness-memory-'));
  const project = join(root, 'project');
  await mkdir(project);
  const memory = new Memory(join(root, 'memory'));
  await memory.initialize();
  const scope = await memory.scope(project);
  return { memory, scope, root, project };
}

await test('accepted snapshots exclude dirty tracked and newly created notes', async () => {
  const { memory, scope } = await fixture();
  await writeFile(join(scope.project, 'MEMORY.md'), 'Accepted project fact.');
  await memory.commit('seed');
  await writeFile(join(scope.project, 'MEMORY.md'), 'Unfinished project fact.');
  await writeFile(join(scope.project, 'pending.md'), 'Unfinished new note.');
  assert.equal(await memory.isDirty(), true);
  const snapshot = await memory.snapshot(scope);
  assert.match(snapshot.text, /Accepted project fact/);
  assert.doesNotMatch(snapshot.text, /Unfinished/);
  await memory.discard();
  assert.equal(await memory.isDirty(), false);
  assert.equal(
    await readFile(join(scope.project, 'MEMORY.md'), 'utf8'),
    'Accepted project fact.',
  );
  await assert.rejects(readFile(join(scope.project, 'pending.md')));
});

await test('global memory crosses projects while project notes remain scoped', async () => {
  const { memory, scope, root } = await fixture();
  await writeFile(join(scope.global, 'MEMORY.md'), 'Use concise replies.');
  await writeFile(
    join(scope.project, 'MEMORY.md'),
    'Project A uses port 4567.',
  );
  await memory.commit('preferences');
  const other = join(root, 'other');
  await mkdir(other);
  const otherScope = await memory.scope(other);
  const snapshot = await memory.snapshot(otherScope);
  assert.match(snapshot.text, /Use concise replies/);
  assert.doesNotMatch(snapshot.text, /4567/);
});

await test('restore produces a new accepted revision and deletion remains visible', async () => {
  const { memory, scope } = await fixture();
  const path = join(scope.project, 'MEMORY.md');
  await writeFile(path, 'Use value A.');
  await memory.commit('first preference');
  const first = await memory.revision();
  await writeFile(path, 'Use value B.');
  await memory.commit('second preference');
  const second = await memory.revision();
  await memory.restore(path, first);
  const restored = await memory.snapshot(scope);
  assert.notEqual(restored.revision, first);
  assert.notEqual(restored.revision, second);
  assert.match(restored.text, /Use value A/);
  assert.equal((await memory.history(path)).length, 3);
  await unlink(path);
  await memory.commit('remove preference');
  assert.doesNotMatch((await memory.snapshot(scope)).text, /Use value A/);
});

await test('a clean turn does not add an empty memory commit', async () => {
  const { memory } = await fixture();
  const before = await memory.revision();
  await memory.commit('no changes');
  assert.equal(await memory.revision(), before);
});
