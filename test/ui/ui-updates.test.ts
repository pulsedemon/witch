import assert from 'node:assert/strict';
import { createElement } from 'react';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import { App } from '../../src/ui/App.js';
import { updateChoice, updatesText } from '../../src/ui/commands/updates.js';
import {
  holdRuntime,
  NativeUpdatePending,
} from '../../src/persistence/runtime-updates.js';
import type { UpdateJournal } from '../../src/persistence/runtime-updates.js';
import { RuntimeUpdates } from '../../src/core/runtime/runtime-updates.js';
import type { RuntimeUpdateSnapshot } from '../../src/core/runtime/runtime-updates.js';
import { Coordinator } from '../../src/core/coordinator.js';
import { StateStore } from '../../src/persistence/store.js';
import { runtimeUpdateFixture } from '../fixtures/runtime-updates.js';
import { unitFixture } from '../fixtures/coordinator.js';
import { EmptyMemory } from '../fixtures/empty-memory.js';
import { FixtureAgent, TurnGate } from '../fixtures/agent.js';
import { scratch } from '../fixtures/scratch.js';
import { show, ENTER, DOWN } from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';

const agents = [{ id: 'codex', label: 'Fixture Codex', installed: true }];

/** an open conversation on `a` whose agent list also holds the update fixture's runtime, as the app's must to label it. */
async function session() {
  const root = await scratch('witch-update-ui-');
  const project = join(root, 'project');
  await mkdir(project);

  const coordinator = new Coordinator(
    await StateStore.open(join(root, 'state')),
    new EmptyMemory(join(root, 'memory.git')),
    [new FixtureAgent('a'), new FixtureAgent('codex', 'Fixture Codex')].map(
      (adapter) => ({ adapter, executable: adapter.id }),
    ),
  );

  await coordinator.initialize(project);

  return coordinator;
}

async function submit(ui: ReturnType<typeof show>, text: string) {
  ui.stdin.write(text);
  await delay(30);
  ui.stdin.write(ENTER);
}

test('native updates require explicit confirmation and show the selected verified version', async () => {
  const coordinator = await session();

  const update = await runtimeUpdateFixture({
    maintain: (runtime, run) => coordinator.maintainNative(runtime, run),
    notice: () => {},
  });

  const ui = show(
    createElement(App, {
      coordinator,
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
    assert.match(ui.text(), /Update Fixture Codex 1\.0\.0/);
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
    await coordinator.close();
  }
});

test('the narrow confirmation retains both its version and paid-check disclosure', async () => {
  const coordinator = await session();
  const update = await runtimeUpdateFixture();

  const ui = show(
    createElement(App, {
      coordinator,
      updates: update.updates,
      onExit: () => {},
    }),
    30,
    24,
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
    await coordinator.close();
  }
});

test('the confirmation shows a choice at every height and its launcher where one fits beside it', async () => {
  const coordinator = await session();
  const update = await runtimeUpdateFixture();

  const ui = show(
    createElement(App, {
      coordinator,
      updates: update.updates,
      onExit: () => {},
    }),
    80,
    12,
  );

  try {
    await delay(70);
    await submit(ui, '/updates codex');
    await until('confirmation', () => ui.text().includes('Cancel'));

    for (let rows = 12; rows >= 3; rows--) {
      ui.resize(80, rows);

      await until(`a choice at ${rows} rows`, () => {
        const frame = ui.text().split('\n');

        return (
          frame.length === rows && frame.some((row) => row.trim() === 'Cancel')
        );
      });

      // the lowest terminal that fits the launcher, which the title's `Fixture Codex` can't match
      if (rows === 7) assert.ok(ui.text().includes('/codex'));
    }
  } finally {
    ui.unmount();
    update.updates.close();
    await coordinator.close();
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

    assert.match(
      updatesText(update.updates.snapshot, agents),
      /Run \/updates codex to recover/,
    );

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
  const text = updatesText(f.updates.snapshot, agents);
  assert.match(text, /^Fixture Codex\nInstalled: 1\.0\.0$/m);
  assert.match(text, /Account usage exhausted/);
  assert.match(text, /Not yet verified/);
  assert.doesNotMatch(text, /Installed: 2.0.0/);
  f.updates.close();
});

test('an unrelated startup failure leaves a qualified update usable', async () => {
  const root = await scratch('witch-update-startup-unrelated-');
  const project = join(root, 'missing-project');

  const c = new Coordinator(
    await StateStore.open(join(root, 'state')),
    new EmptyMemory(join(root, 'memory.git')),
    [{ adapter: new FixtureAgent('codex'), executable: 'codex' }],
  );

  await assert.rejects(c.initialize(project), /ENOENT/);
  assert.equal(c.snapshot.conversation, undefined);

  const update = await runtimeUpdateFixture({
    maintain: (runtime, run) => c.maintainNative(runtime, run),
    notice: () => {},
  });

  try {
    await update.updates.apply(update.check, { accountUsage: true });
    assert.equal((await update.store.journal(update.root))?.phase, 'verified');
    assert.equal((await update.inspect()).version, '2.0.0');
    assert.deepEqual(update.installs, ['2.0.0']);
    holdRuntime(update.root, update.store.directory)();
    assert.equal(c.snapshot.phase, 'error');
    assert.match(c.snapshot.error!, /ENOENT.*missing-project/);
  } finally {
    update.updates.close();
    await c.close();
  }
});

test('a current unverified installation is offered qualification even when updates are blocked', async () => {
  const coordinator = await session();

  const update = await runtimeUpdateFixture(
    {
      maintain: (runtime, run) => coordinator.maintainNative(runtime, run),
      notice: () => {},
    },
    '2.0.0',
  );

  update.policy.automatic = true;
  update.policy.blocked = 'Native Codex automatic updates are enabled.';

  const ui = show(
    createElement(App, {
      coordinator,
      updates: update.updates,
      onExit: () => {},
    }),
    80,
    24,
  );

  try {
    await delay(70);
    await submit(ui, '/updates codex');

    await until('qualify confirmation', () =>
      ui.text().includes('Paid checks on 2.0.0'),
    );

    assert.match(ui.text(), /Qualify Fixture Codex 2\.0\.0\?/);
    assert.ok(ui.text().includes('codex'));
    ui.stdin.write(ENTER);

    await until('cancelled confirmation', () =>
      ui.text().includes('Run /updates codex to qualify it.'),
    );

    assert.equal(await update.store.journal(update.root), undefined);
    ui.stdin.write('\u001b[27u');
    await delay(30);
    await submit(ui, '/updates codex');

    await until('second confirmation', () =>
      ui.text().includes('Paid checks on 2.0.0'),
    );

    ui.stdin.write(DOWN);
    ui.stdin.write(ENTER);

    await until('verified version', () =>
      ui.text().includes('Verified with this Witch build'),
    );

    assert.deepEqual(update.installs, []);
    assert.equal((await update.store.journal(update.root))?.phase, 'verified');
  } finally {
    ui.unmount();
    update.updates.close();
    await coordinator.close();
  }
});

test('the picker label and the status text offer qualification by one rule', async () => {
  const f = await runtimeUpdateFixture(undefined, '2.0.0');
  const snapshot = f.updates.snapshot;
  const entry = snapshot.entries[0]!;

  const offered = (state: RuntimeUpdateSnapshot) => ({
    label: /not verified/.test(updateChoice(state.entries[0]!, state, agents)),
    hint: /Run \/updates codex to qualify it\./.test(
      updatesText(state, agents),
    ),
  });

  const journal: UpdateJournal = {
    id: '4b4c6f0e-6f58-4a55-9a0c-3c2a5a4f7d10',
    previous: f.artifacts.get('1.0.0')!,
    target: '2.0.0',
    build: snapshot.build!,
    selected: entry.installation,
    phase: 'verified',
    startedAt: 1,
  };

  assert.deepEqual(offered(snapshot), { label: true, hint: true });

  assert.deepEqual(
    offered({
      ...snapshot,
      entries: [{ ...entry, check: { ...entry.check!, blocked: 'Blocked' } }],
    }),
    { label: true, hint: true },
  );

  for (const [reason, changed] of [
    ['a newer release', { check: { ...entry.check!, available: true } }],
    ['no earlier version', { earlier: undefined }],
    ['a verified record', { journal }],
    ['a pending journal', { journal: { ...journal, phase: 'failed' } }],
  ] as const)
    assert.deepEqual(
      offered({ ...snapshot, entries: [{ ...entry, ...changed }] }),
      { label: false, hint: false },
      reason,
    );

  assert.deepEqual(
    offered({ ...snapshot, progress: 'Qualifying codex 2.0.0' }),
    { label: false, hint: false },
  );

  const unidentified: RuntimeUpdateSnapshot = {
    ...snapshot,
    build: undefined,
    buildError: 'Build tree unreadable',
  };

  assert.deepEqual(offered(unidentified), { label: false, hint: false });

  assert.match(
    updatesText(unidentified, agents),
    /Witch build identity failed: Build tree unreadable/,
  );

  const pending: RuntimeUpdateSnapshot = {
    ...snapshot,
    entries: [{ ...entry, journal: { ...journal, phase: 'failed' } }],
  };

  assert.match(
    updateChoice(pending.entries[0]!, pending, agents),
    /recovery required/,
  );

  assert.match(updatesText(pending, agents), /Run \/updates codex to recover/);
  f.updates.close();
});

test('a refused qualification leaves the offer in place', async () => {
  const f = await runtimeUpdateFixture(undefined, '2.0.0');
  const transaction = await f.store.transaction(f.root);

  try {
    await assert.rejects(
      f.updates.apply(f.check, { accountUsage: true }),
      NativeUpdatePending,
    );
  } finally {
    await transaction.close();
  }

  assert.equal(f.updates.snapshot.progress, undefined);

  assert.match(
    updateChoice(f.updates.snapshot.entries[0]!, f.updates.snapshot, agents),
    /not verified/,
  );

  f.updates.close();
});

test('inventory waits for the build identity before reporting verification', async () => {
  const f = await runtimeUpdateFixture(undefined, '2.0.0');
  await f.updates.apply(f.check, { accountUsage: true });
  f.updates.close();

  const slow = new RuntimeUpdates(
    {
      maintain: async (_runtime, run) => run(new AbortController().signal),
      notice: () => {},
    },
    f.store,
    f.native,
    async () => [f.registration],
    async () => {
      await delay(200);

      return 'fixture-build';
    },
  );

  await slow.check();
  assert.equal(slow.snapshot.build, 'fixture-build');

  assert.match(
    updatesText(slow.snapshot, agents),
    /Verified with this Witch build\./,
  );

  slow.close();
});

/** rechecks while the releases directory cannot be listed and the selected artifact stays reachable. */
async function recheckUnlistable(
  f: Awaited<ReturnType<typeof runtimeUpdateFixture>>,
) {
  const releases = join(f.root, 'releases');
  await chmod(releases, 0o300);

  try {
    await f.updates.check(true);
  } finally {
    await chmod(releases, 0o755);
  }

  return f.updates.snapshot.entries[0]!;
}

test('an unreadable release directory is reported without hiding the available update', async () => {
  const f = await runtimeUpdateFixture();
  const entry = await recheckUnlistable(f);
  assert.equal(entry.error, undefined);
  assert.equal(entry.check?.available, true);

  assert.match(
    updateChoice(entry, f.updates.snapshot, agents),
    /^Fixture Codex · 1\.0\.0 → 2\.0\.0$/,
  );

  const text = updatesText(f.updates.snapshot, agents);
  assert.match(text, /Earlier version lookup failed: EACCES/);
  assert.doesNotMatch(text, /Check failed/);
  f.updates.close();
});

test('an unreadable release directory withholds the qualification offer', async () => {
  const f = await runtimeUpdateFixture(undefined, '2.0.0');
  assert.equal(f.updates.snapshot.entries[0]!.earlier, '1.0.0');
  const entry = await recheckUnlistable(f);
  assert.equal(entry.earlier, undefined);
  assert.match(entry.earlierError ?? '', /EACCES/);

  assert.doesNotMatch(
    updateChoice(entry, f.updates.snapshot, agents),
    /not verified/,
  );

  assert.doesNotMatch(updatesText(f.updates.snapshot, agents), /to qualify it/);
  f.updates.close();
});
