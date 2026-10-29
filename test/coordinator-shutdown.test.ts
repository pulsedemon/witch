import assert from 'node:assert/strict';
import { test } from 'vitest';
import { TurnGate } from './fixtures/agent.js';
import { fixture } from './fixtures/coordinator.js';
import { within } from './fixtures/within.js';

for (const restart of [false, true])
  for (const failInterrupt of [false, true])
    test(`shutdown shares its deadline and restart=${restart} through ${failInterrupt ? 'failed' : 'successful'} interruption`, async () => {
      const { coordinator, a } = await fixture();
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
