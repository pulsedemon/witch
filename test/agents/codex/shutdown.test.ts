import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import type { AgentEvent } from '../../../src/agents/types.js';
import { fixture, close } from '../../fixtures/codex-adapter.js';
import { appears, settled, within } from '../../fixtures/within.js';

for (const phase of ['start', 'response', 'completion', 'late response'])
  test(`Codex interruption closes a session stuck waiting for turn ${phase}`, async () => {
    const events: AgentEvent[] = [];

    const { session, cwd, child } = await fixture((event) =>
      events.push(event),
    );

    try {
      if (phase !== 'completion')
        await writeFile(
          join(cwd, phase === 'start' ? 'hold-start' : 'hold-interrupt'),
          '',
        );

      if (phase === 'late response')
        await writeFile(join(cwd, 'late-interrupt'), '');

      const turn = session.send('hold');
      await appears(join(cwd, 'prompt.json'));
      const started = performance.now();
      const interruption = session.interrupt({ deadline: started + 3200 });

      if (phase === 'late response') {
        await appears(join(cwd, 'interrupt.json'));
        child.stdin.end();
      }

      await within(interruption, 2500, 'bounded interrupt');
      assert.equal((await turn).status, 'interrupted');

      if (phase === 'late response')
        assert.deepEqual(
          JSON.parse(await readFile(join(cwd, 'late-response.json'), 'utf8')),
          { sent: true },
        );

      assert.equal(session.closed, true);
      assert.ok(child.exitCode !== null || child.signalCode !== null);
      assert.equal(events.filter((event) => event.type === 'closed').length, 1);

      assert.equal(
        events.filter(
          (event) =>
            event.type === 'notice' && /did not stop in time/.test(event.text),
        ).length,
        1,
      );

      await assert.rejects(session.send('too late'), /closed/);
      await within(session.close(), 1000, 'close after timeout');
    } finally {
      await close(session, cwd);
    }
  });

test('Codex restart does not acquire the interrupt escalation deadline', async () => {
  const { session, cwd } = await fixture();

  try {
    const turn = session.send('hold');
    await appears(join(cwd, 'prompt.json'));

    const interrupting = session.interrupt({
      restart: true,
      deadline: performance.now() + 50,
    });

    const done = settled(interrupting);
    await appears(join(cwd, 'replied'));
    await delay(150);
    assert.equal(done(), false);
    assert.equal(session.closed, false);
    await writeFile(join(cwd, 'release'), '');
    await within(interrupting, 2000, 'released restart interrupt');
    assert.equal((await turn).status, 'interrupted');
  } finally {
    await close(session, cwd);
  }
});

test('a successful Codex interruption leaves a fresh budget for the next turn', async () => {
  const { session, cwd } = await fixture();

  try {
    const first = session.send('hold');
    await appears(join(cwd, 'prompt.json'));

    const interrupting = session.interrupt({
      deadline: performance.now() + 3200,
    });

    await writeFile(join(cwd, 'release'), '');
    await interrupting;
    assert.equal((await first).status, 'interrupted');
    await unlink(join(cwd, 'release'));
    await delay(250);
    const second = session.send('hold');
    assert.equal(await session.steer('second turn'), true);
    const stopping = session.interrupt({ deadline: performance.now() + 3200 });
    await delay(50);
    assert.equal(session.closed, false);
    await writeFile(join(cwd, 'release'), '');
    await within(stopping, 2000, 'second interrupt');
    assert.equal((await second).status, 'interrupted');
    assert.equal(session.closed, false);
  } finally {
    await close(session, cwd);
  }
});
