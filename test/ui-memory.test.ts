import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  writeFile,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { CodexAdapter } from '../src/agents/codex.js';
import { Coordinator } from '../src/core/coordinator.js';
import { Memory } from '../src/memory/memory.js';
import { StateStore } from '../src/persistence/store.js';
import { App } from '../src/ui/app.js';

async function until(predicate: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail('The expected UI operation did not complete');
}

/** a stored conversation whose memory worktree is ready for notes, before it opens. */
async function conversation() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'witch-ui-memory-')),
  );
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const store = await StateStore.open(join(root, 'state'));
  const memory = new Memory(join(root, 'state', 'memory.git'));
  const coordinator = new Coordinator(store, memory, [
    { adapter: new CodexAdapter() },
  ]);
  await coordinator.initialize(cwd);
  const id = randomUUID();
  const files = await store.create({
    id,
    title: 'Notes',
    cwd,
    agent: 'codex',
    sessions: {},
    createdAt: new Date().toISOString(),
  });
  const workspace = memory.workspace(files.directory, id);
  await workspace.ensureWorktree();
  const scope = await workspace.scope(cwd);
  return { coordinator, id, files, workspace, scope };
}

await test('a deleted note remains discoverable and can be restored through its history picker', async () => {
  const { coordinator, id, files, workspace, scope } = await conversation();
  const reference = join(workspace.root, scope.project, 'decisions.md');
  await writeFile(reference, 'Accepted project decision.');
  await workspace.commit('save reference');
  const originalRevision = await workspace.revision();
  await unlink(reference);
  await workspace.commit('delete reference');
  await files.close();
  // the conversation opens even though its agent can't connect
  await assert.rejects(
    coordinator.selectConversation(id),
    /Codex is not installed/,
  );
  const ui = render(createElement(App, { coordinator, onExit: () => {} }));
  try {
    await delay(40);
    ui.stdin.write('/memory');
    await delay(30);
    ui.stdin.write('\r');
    await until(() => !!ui.lastFrame()?.includes('(deleted)'));
    assert.match(stripAnsi(ui.lastFrame()!), /decisions.md \(deleted\)/);
    assert.ok(ui.lastFrame()!.includes(`vscode://file${reference}`));
    await delay(30);
    ui.stdin.write('decisions.md');
    await delay(30);
    ui.stdin.write('\r');
    await until(() => !!ui.lastFrame()?.includes('Restore a memory version'));
    assert.ok(!ui.lastFrame()!.includes('delete reference'));
    await delay(30);
    ui.stdin.write('\r');
    await until(
      async () =>
        coordinator.snapshot.phase === 'idle' &&
        (await readFile(reference, 'utf8').catch(() => '')) ===
          'Accepted project decision.',
    );
    assert.notEqual(await workspace.revision(), originalRevision);
    assert.equal(await workspace.isDirty(), false);
  } finally {
    ui.unmount();
    await coordinator.close();
  }
});
