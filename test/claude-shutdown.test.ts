import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import type { AgentEvent } from '../src/agents/types.js';
import { InputQueue } from '../src/agents/input-queue.js';
import { familiarMarker } from '../src/agents/familiar-report.js';
import { frameWriter, jsonLines, launcher } from './fixtures/claude-adapter.js';
import { until, within } from './fixtures/within.js';

for (const phase of ['dispatch', 'response', 'idle'])
  test(`Claude interruption bounds missing input ${phase} without replaying uncertain input`, async () => {
    const f = await launcher('background');
    const events: AgentEvent[] = [];
    const session = await f.connect({ onEvent: (event) => events.push(event) });
    try {
      const turn = session.send('initial');
      await until('initial result', () =>
        events.some(
          (event) =>
            event.type === 'skills' && event.skills[0]?.name === 'result-1',
        ),
      );
      if (phase !== 'idle') {
        assert.equal(await session.steer('uncertain follow-up'), true);
        await until(
          'written follow-up',
          async () =>
            (await jsonLines(join(f.cwd, 'inputs.jsonl'))).length === 2,
        );
      }
      if (phase === 'dispatch')
        vi.spyOn(InputQueue.prototype, 'flush').mockReturnValue(
          new Promise(() => {}),
        );
      else
        await writeFile(
          join(f.cwd, phase === 'response' ? 'hold-interrupt' : 'hold-idle'),
          '',
        );
      const first = session.interrupt({ deadline: performance.now() + 3200 });
      const second = session.interrupt();
      await within(
        Promise.all([first, second]),
        2500,
        'bounded SDK interruption',
      );
      const result = await within(turn, 1000, 'interrupted turn');
      assert.equal(result.status, 'interrupted');
      assert.match(result.text, /Initial reply/);
      assert.deepEqual(result.unread ?? [], []);
      assert.equal(result.inputUnsent, undefined);
      assert.equal(session.closed, true);
      assert.ok(
        f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null,
      );
      assert.equal(events.filter((event) => event.type === 'closed').length, 1);
      assert.equal(
        events.filter(
          (event) =>
            event.type === 'notice' && /did not stop in time/.test(event.text),
        ).length,
        1,
      );
      await within(session.close(), 1000, 'repeated close');
    } finally {
      vi.restoreAllMocks();
      await session.close();
    }
  });

test('Claude closure bounds a missing familiar stop acknowledgment and resolves its request', async () => {
  const f = await launcher('background');
  const events: AgentEvent[] = [];
  const binding = {
    directory: '/control',
    conversation: 'owner',
    activation: randomUUID(),
  };
  const session = await f.connect({
    familiarBinding: binding,
    onEvent: (event) => events.push(event),
  });
  const emit = frameWriter(
    f.cwd,
    (name) =>
      events.some(
        (event) => event.type === 'skills' && event.skills[0]?.name === name,
      ),
    f.children[0]!,
  );
  const run = randomUUID();
  try {
    const turn = session.send('initial');
    await until('initial result', () =>
      events.some(
        (event) =>
          event.type === 'skills' && event.skills[0]?.name === 'result-1',
      ),
    );
    await emit({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
    });
    await turn;
    await writeFile(
      join(f.cwd, 'task-outputs.json'),
      JSON.stringify({
        reviewer: familiarMarker({
          version: 1,
          conversation: binding.conversation,
          activation: binding.activation,
          run,
        }),
      }),
    );
    await emit({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        {
          task_id: 'reviewer',
          run_id: '1',
          task_type: 'local_bash',
          description: 'Review',
        },
      ],
    });
    assert.equal(
      (
        await session.familiar!.report(
          { kind: 'familiar-register', run, name: 'review' },
          Date.now() + 5000,
        )
      ).kind,
      'familiar-registered',
    );
    await session.familiar!.report(
      {
        kind: 'familiar-request',
        run,
        request: {
          id: 'approval',
          kind: 'approval',
          title: 'Write',
          detail: '',
        },
      },
      Date.now() + 5000,
    );
    const request = events.find((event) => event.type === 'request');
    assert.ok(request?.type === 'request');
    await writeFile(join(f.cwd, 'hold-stop'), '');
    await within(
      session.close({ deadline: performance.now() + 3200 }),
      2500,
      'bounded familiar cleanup',
    );
    assert.equal(session.closed, true);
    assert.ok(
      events.some(
        (event) =>
          event.type === 'subagent' && event.subagent.status === 'stopped',
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === 'request-resolved' && event.id === request.request.id,
      ),
    );
    assert.ok(
      f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null,
    );
  } finally {
    await session.close();
  }
});
