import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Memory } from '../src/memory/memory.js';

const execute = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'harness-memory-'));
  const project = join(root, 'project');
  await mkdir(project);
  const memory = new Memory(join(root, 'memory'));
  await memory.initialize();
  const scope = await memory.scope(project);
  return { memory, scope, root, project };
}

await test('initialization resumes an unborn repository without replacing existing notes', async () => {
  for (const seeded of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'harness-incomplete-memory-'));
    await execute('git', ['init', '-b', 'main'], { cwd: root });
    const note = join(root, 'global', 'MEMORY.md');
    if (seeded) {
      await mkdir(join(root, 'global'));
      await writeFile(note, 'Preserve this preference.');
    }
    const memory = new Memory(root);
    await memory.initialize();
    assert.equal(
      await readFile(note, 'utf8'),
      seeded ? 'Preserve this preference.' : '# Global memory\n',
    );
    const revision = await memory.revision();
    await writeFile(note, 'Pending change.');
    await memory.initialize();
    assert.equal(await memory.revision(), revision);
    assert.equal(await readFile(note, 'utf8'), 'Pending change.');
    assert.equal(await memory.isDirty(), true);
  }
});

await test('memory commits use their own identity without global Git configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-memory-identity-'));
  const module = new URL('../src/memory/memory.ts', import.meta.url).href;
  const { stdout } = await execute(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { Memory } from ${JSON.stringify(module)};
       import { writeFile } from 'node:fs/promises';
       const memory = new Memory(${JSON.stringify(root)});
       await memory.initialize();
       await writeFile(${JSON.stringify(join(root, 'global', 'MEMORY.md'))}, 'New preference.');
       await memory.commit('save preference');
       console.log(await memory.read('global/MEMORY.md'));`,
    ],
    {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'user.useConfigOnly',
        GIT_CONFIG_VALUE_0: 'true',
        GIT_AUTHOR_NAME: undefined,
        GIT_AUTHOR_EMAIL: undefined,
        GIT_COMMITTER_NAME: undefined,
        GIT_COMMITTER_EMAIL: undefined,
      },
    },
  );
  assert.equal(stdout.trim(), 'New preference.');
  const log = await execute('git', ['log', '--format=%an <%ae> | %cn <%ce>'], {
    cwd: root,
  });
  assert.deepEqual(log.stdout.trim().split('\n'), [
    'Agent Harness <agent-harness@localhost> | Agent Harness <agent-harness@localhost>',
    'Agent Harness <agent-harness@localhost> | Agent Harness <agent-harness@localhost>',
  ]);
});

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
