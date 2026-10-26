import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fixture } from './fixtures/coordinator.js';

test('a reported familiar replaces its brew and retitles observed identity without duplicating reports', async () => {
  const { coordinator, a } = await fixture();
  const emit = a.sessions[0]!.options.onEvent;
  const worker = {
    id: 'review',
    name: 'plan review',
    kind: '',
    runtime: 'claude',
    run: 'one',
  };
  try {
    emit({
      type: 'command',
      command: {
        id: 'review-command',
        description: 'review',
        status: 'running',
      },
    });
    emit({
      type: 'command',
      command: { id: 'server', description: 'dev server', status: 'running' },
    });
    emit({ type: 'subagent', subagent: { ...worker, status: 'running' } });
    emit({
      type: 'command',
      command: {
        id: 'review-command',
        description: 'review',
        status: 'running',
        familiar: worker.id,
      },
    });
    emit({
      type: 'command',
      command: {
        id: 'review-command',
        description: 'review',
        status: 'running',
        familiar: worker.id,
      },
    });
    assert.deepEqual(
      coordinator.snapshot.backgroundCommands.map((command) => command.id),
      ['server'],
    );
    const start = coordinator.snapshot.subagents[0]!.rows.start;
    emit({
      type: 'subagent',
      subagent: {
        ...worker,
        status: 'running',
        model: 'claude-opus-5-5',
        tools: 2,
      },
    });
    assert.equal(coordinator.snapshot.subagents[0]!.rows.start, start);
    emit({
      type: 'subagent',
      subagent: {
        ...worker,
        status: 'completed',
        model: 'claude-opus-5-5',
        tools: 2,
        report: 'Reviewed once.',
      },
    });
    emit({
      type: 'subagent',
      subagent: {
        ...worker,
        status: 'completed',
        model: 'claude-opus-4-8',
        tools: 2,
        report: 'Reviewed once.',
      },
    });
    const rows = coordinator.snapshot.items.filter((item) =>
      item.title?.startsWith('Familiar'),
    );
    assert.deepEqual(
      rows.map((item) => [item.title, item.text]),
      [
        ['Familiar started  plan review  claude · claude-opus-4-8', ''],
        [
          'Familiar completed  plan review  claude · claude-opus-4-8  2 tools',
          'Reviewed once.',
        ],
      ],
    );
    assert.equal(
      coordinator.snapshot.items.filter((item) =>
        item.title?.startsWith('Brew became familiar'),
      ).length,
      1,
    );
  } finally {
    await coordinator.close();
  }
});
