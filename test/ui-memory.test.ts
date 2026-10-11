import assert from 'node:assert/strict';
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

await test('a deleted note remains discoverable and can be restored through its history picker', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'harness-ui-memory-')),
  );
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const memory = new Memory(join(root, 'state', 'memory'));
  const coordinator = new Coordinator(
    await StateStore.open(join(root, 'state')),
    memory,
    [{ adapter: new CodexAdapter() }],
  );
  await coordinator.initialize(cwd);
  const scope = await memory.scope(cwd);
  const reference = join(scope.project, 'decisions.md');
  await writeFile(reference, 'Accepted project decision.');
  await memory.commit('save reference');
  const originalRevision = await memory.revision();
  await unlink(reference);
  await memory.commit('delete reference');
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
    assert.notEqual(await memory.revision(), originalRevision);
    assert.equal(await memory.isDirty(), false);
  } finally {
    ui.unmount();
    await coordinator.close();
  }
});
