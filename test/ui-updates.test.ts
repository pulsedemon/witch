import assert from 'node:assert/strict';
import { createElement } from 'react';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import { App } from '../src/ui/app.js';
import { updatesText } from '../src/ui/updates.js';
import { Coordinator } from '../src/core/coordinator.js';
import { StateStore } from '../src/persistence/store.js';
import { runtimeUpdateFixture } from './fixtures/runtime-updates.js';
import { unitFixture } from './fixtures/coordinator.js';
import { EmptyMemory } from './fixtures/empty-memory.js';
import { FixtureAgent, TurnGate } from './fixtures/agent.js';
import { scratch } from './fixtures/scratch.js';
import { show, ENTER, DOWN } from './fixtures/ui.js';
import { until } from './fixtures/within.js';

async function submit(ui: ReturnType<typeof show>, text: string) {
  ui.stdin.write(text);
  await delay(30);
  ui.stdin.write(ENTER);
}

test('native updates require explicit confirmation and show the selected verified version', async () => {
  const f = await unitFixture();
  const update = await runtimeUpdateFixture({
    maintain: (runtime, run) => f.coordinator.maintainNative(runtime, run),
    notice: () => {},
  });
  const ui = show(
    createElement(App, {
      coordinator: f.coordinator,
      updates: update.updates,
      onExit: () => {},
    }),
    80,
    24,
  );
  try {
    await delay(70);
    await submit(ui, '/updates codex');
    await until('confirmation', () =>
      ui.text().includes('2.0.0 + paid checks'),
    );
    assert.deepEqual(update.installs, []);
    assert.match(ui.text(), /Update Codex 1\.0\.0/);
    assert.ok(ui.text().includes('codex'));
    ui.stdin.write(ENTER);
    await until('cancelled confirmation', () =>
      ui.text().includes('Native runtime updates'),
    );
    assert.deepEqual(update.installs, []);
    ui.stdin.write('\u001b[27u');
    await delay(30);
    await submit(ui, '/updates codex');
    await until('second confirmation', () =>
      ui.text().includes('2.0.0 + paid checks'),
    );
    ui.stdin.write(DOWN);
    ui.stdin.write(ENTER);
    await until('updated version', () =>
      ui.text().includes('Installed: 2.0.0'),
    );
    assert.equal((await update.inspect()).version, '2.0.0');
    assert.match(ui.text(), /Verified with this Witch build/);
  } finally {
    ui.unmount();
    update.updates.close();
    await f.coordinator.close();
  }
});

test('the narrow confirmation retains both its version and paid-check disclosure', async () => {
  const f = await unitFixture();
  const update = await runtimeUpdateFixture();
  const ui = show(
    createElement(App, {
      coordinator: f.coordinator,
      updates: update.updates,
      onExit: () => {},
    }),
    30,
    12,
  );
  try {
    await delay(70);
    await submit(ui, '/updates codex');
    await until('narrow confirmation', () =>
      ui.text().includes('2.0.0 + paid checks'),
    );
    assert.deepEqual(update.installs, []);
  } finally {
    ui.unmount();
    update.updates.close();
    await f.coordinator.close();
  }
});

test('busy work refuses installation without interrupting the active turn', async () => {
  const f = await unitFixture();
  const gate = new TurnGate();
  f.a.gate = gate;
  const running = f.coordinator.send('current work');
  await gate.entered;
  const update = await runtimeUpdateFixture({
    maintain: (runtime, run) => f.coordinator.maintainNative(runtime, run),
    notice: () => {},
  });
  try {
    await assert.rejects(
      update.updates.apply(update.check, { accountUsage: true }),
      /Finish current work/,
    );
    assert.deepEqual(update.installs, []);
    assert.equal(f.coordinator.snapshot.phase, 'running');
    assert.equal(f.a.stops.length, 0);
  } finally {
    gate.open();
    await running;
    update.updates.close();
    await f.coordinator.close();
  }
});

test('queued prompts refuse installation and remain queued', async () => {
  const f = await unitFixture();
  const release = f.coordinator.holdPromptDelivery();
  await f.coordinator.send('queued work');
  const update = await runtimeUpdateFixture({
    maintain: (runtime, run) => f.coordinator.maintainNative(runtime, run),
    notice: () => {},
  });
  try {
    await assert.rejects(
      update.updates.apply(update.check, { accountUsage: true }),
      /queued prompts/,
    );
    assert.deepEqual(f.coordinator.snapshot.queue, ['queued work']);
    assert.deepEqual(update.installs, []);
  } finally {
    release();
    update.updates.close();
    await f.coordinator.close();
  }
});

test('maintenance reconnects an active native conversation using its saved session', async () => {
  const root = await scratch('witch-update-reconnect-');
  const project = join(root, 'project');
  await mkdir(project);
  const store = await StateStore.open(join(root, 'state'));
  const agent = new FixtureAgent('codex');
  const c = new Coordinator(store, new EmptyMemory(join(root, 'memory.git')), [
    { adapter: agent, executable: 'codex' },
  ]);
  await c.initialize(project);
  await c.send('preserved conversation');
  const before = c.snapshot.native!.id;
  const update = await runtimeUpdateFixture({
    maintain: (runtime, run) => c.maintainNative(runtime, run),
    notice: () => {},
  });
  try {
    await update.updates.apply(update.check, { accountUsage: true });
    assert.equal(c.snapshot.native!.id, before);
    assert.equal(agent.sessions.at(-1)!.options.resume, before);
    assert.equal(c.snapshot.phase, 'idle');
  } finally {
    update.updates.close();
    await c.close();
  }
});

test('recovery works without a loaded conversation and retries the original initialization', async () => {
  const root = await scratch('witch-update-startup-');
  const project = join(root, 'project');
  const store = await StateStore.open(join(root, 'state'));
  const registration = {
    adapter: new FixtureAgent('codex'),
    executable: undefined as string | undefined,
  };
  const c = new Coordinator(store, new EmptyMemory(join(root, 'memory.git')), [
    registration,
  ]);
  await assert.rejects(c.initialize(project));
  const initial = c.snapshot;
  assert.equal(initial.conversation, undefined);
  c.notice('Codex update available', undefined, false);
  assert.equal(c.snapshot.items.at(-1)?.text, 'Codex update available');
  const update = await runtimeUpdateFixture({
    maintain: (runtime, run) =>
      c.maintainNative(runtime, async (signal) => {
        await run(signal);
        registration.executable = 'codex';
      }),
    notice: () => {},
  });
  const install = update.native.install;
  update.native.verify = async () => {
    throw new Error('Candidate failed');
  };
  update.native.install = async (...args) => {
    if (args[1] === '1.0.0') throw new Error('Recovery unavailable');
    await install(...args);
  };
  try {
    await assert.rejects(
      update.updates.apply(update.check, { accountUsage: true }),
      /Recovery unavailable/,
    );
    assert.equal((await update.store.journal(update.root))?.phase, 'failed');
    update.native.install = install;
    await mkdir(project);
    const ui = show(
      createElement(App, {
        coordinator: c,
        updates: update.updates,
        onExit: () => {},
      }),
      80,
      24,
    );
    try {
      await delay(70);
      ui.stdin.write('\u0010');
      await delay(30);
      await submit(ui, 'updates');
      await until('runtime recovery picker', () =>
        ui.text().includes('recovery required'),
      );
      ui.stdin.write(DOWN);
      ui.stdin.write(ENTER);
      await until('recovery confirmation', () =>
        ui.text().includes('Restore 1.0.0'),
      );
      ui.stdin.write(DOWN);
      ui.stdin.write(ENTER);
      await until(
        'recovered initialization',
        () => c.snapshot.phase === 'idle',
      );
    } finally {
      ui.unmount();
    }
    assert.equal((await update.inspect()).version, '1.0.0');
    assert.equal(c.snapshot.phase, 'idle');
    assert.equal(c.snapshot.conversation?.agent, 'codex');
  } finally {
    update.updates.close();
    await c.close();
  }
});

test('failed reconnect keeps qualified candidate recovery available and restores the previous session', async () => {
  const root = await scratch('witch-update-reconnect-failed-');
  const project = join(root, 'project');
  await mkdir(project);
  const agent = new FixtureAgent('codex');
  const c = new Coordinator(
    await StateStore.open(join(root, 'state')),
    new EmptyMemory(join(root, 'memory.git')),
    [{ adapter: agent, executable: 'codex' }],
  );
  await c.initialize(project);
  await c.send('saved history');
  const originalSession = c.snapshot.native!.id;
  const update = await runtimeUpdateFixture({
    maintain: (runtime, run) => c.maintainNative(runtime, run),
    notice: () => {},
  });
  agent.beforeConnect = async () => {
    throw new Error('Candidate reconnect failed');
  };
  try {
    await assert.rejects(
      update.updates.apply(update.check, { accountUsage: true }),
      /Candidate reconnect failed/,
    );
    const journal = (await update.store.journal(update.root))!;
    assert.equal(journal.phase, 'failed');
    assert.match(updatesText(update.updates.snapshot), /recover/);
    agent.beforeConnect = undefined;
    await update.updates.recover(journal);
    assert.equal((await update.inspect()).version, '1.0.0');
    assert.equal(c.snapshot.native!.id, originalSession);
  } finally {
    update.updates.close();
    await c.close();
  }
});

test('unknown check state and recovered failures are not labeled verified', async () => {
  const f = await runtimeUpdateFixture();
  f.native.verify = async () => {
    throw new Error('Account usage exhausted');
  };
  await assert.rejects(f.updates.apply(f.check, { accountUsage: true }));
  const text = updatesText(f.updates.snapshot);
  assert.match(text, /Installed: 1.0.0/);
  assert.match(text, /Account usage exhausted/);
  assert.match(text, /Not yet verified/);
  assert.doesNotMatch(text, /Installed: 2.0.0/);
  f.updates.close();
});
