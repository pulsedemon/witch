import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { CodexAdapter } from '../../../src/agents/codex/adapter.js';
import { Coordinator } from '../../../src/core/coordinator.js';
import { StateStore } from '../../../src/persistence/store.js';
import { FixtureAgent, TurnGate } from '../../fixtures/agent.js';
import { unitFixture } from '../../fixtures/coordinator.js';
import { scratch } from '../../fixtures/scratch.js';
import { seededMemory } from '../../fixtures/seeded-memory.js';
import { appears, settled, within } from '../../fixtures/within.js';

for (const restart of [false, true])
  for (const failInterrupt of [false, true])
    test(`shutdown shares its deadline and restart=${restart} through ${failInterrupt ? 'failed' : 'successful'} interruption`, async () => {
      const { coordinator, a } = await unitFixture();
      a.stops.length = 0;
      a.gate = new TurnGate();
      a.failInterrupt = failInterrupt;

      try {
        const turn = coordinator.send('hold');

        await within(a.gate.entered, 2000, 'active turn');

        const before = performance.now();
        const closing = coordinator.close({ restart });

        if (failInterrupt) await assert.rejects(closing, /Interrupt failed/);
        else await closing;

        await turn;

        const interrupt = a.stops.find(
          (stop) => stop.operation === 'interrupt',
        )?.options;

        const closed = a.stops.find(
          (stop) => stop.operation === 'close',
        )?.options;

        assert.ok(interrupt?.deadline !== undefined);

        assert.ok(interrupt.deadline > before);

        assert.equal(closed?.deadline, interrupt.deadline);

        assert.equal(interrupt.restart, restart);

        assert.equal(closed?.restart, restart);

        assert.equal(a.sessions.at(-1)!.session.closed, true);
      } finally {
        await coordinator.close();
      }
    });

for (const discovery of [false, true])
  test(`restart preserves the SIGTERM policy during Codex ${discovery ? 'model discovery' : 'connection'}`, async () => {
    const root = await scratch('witch-restart-startup-');
    const project = join(root, 'project');

    await mkdir(project);

    const store = await StateStore.open(join(root, 'state'));
    const memory = await seededMemory(join(root, 'state', 'memory.git'));
    let child: ChildProcessWithoutNullStreams | undefined;

    const codex = new CodexAdapter(
      (_, cwd, signal) =>
        (child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL('../../fixtures/codex.mjs', import.meta.url)),
            'hang-on-init',
            '--ignore-term',
          ],
          { cwd, signal, stdio: 'pipe' },
        )),
    );

    const registrations = [
      ...(discovery
        ? [{ adapter: new FixtureAgent('a'), executable: 'a' }]
        : []),
      { adapter: codex, executable: 'codex' },
    ];

    const coordinator = new Coordinator(store, memory, registrations);
    const initializing = coordinator.initialize(project).catch(() => {});
    let closing: Promise<void> | undefined;

    try {
      await appears(join(project, 'initializing.json'));

      closing = coordinator.close({ restart: true });
      const closed = settled(closing);

      await delay(2500);

      assert.equal(child!.signalCode, null);

      assert.equal(child!.exitCode, null);

      assert.equal(closed(), false);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');

      await within(initializing, 2000, 'initialization cleanup');

      await within(closing ?? coordinator.close(), 2000, 'restart cleanup');
    }
  });
