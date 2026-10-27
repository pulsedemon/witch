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
    const startedAt = coordinator.snapshot.subagents[0]!.startedAt;
    emit({
      type: 'subagent',
      subagent: {
        ...worker,
        status: 'running',
        model: 'claude-opus-5-5',
        tools: 2,
        activity: 'Read source',
      },
    });
    assert.equal(coordinator.snapshot.subagents[0]!.rows.start, start);
    assert.equal(coordinator.snapshot.subagents[0]!.startedAt, startedAt);
    emit({
      type: 'subagent',
      subagent: {
        ...worker,
        status: 'completed',
        model: 'claude-opus-5-5',
        tools: 2,
        activity: 'Read source',
        report: 'Reviewed once.',
      },
    });
    const end = coordinator.snapshot.subagents[0]!.rows.end;
    emit({
      type: 'subagent',
      subagent: {
        ...worker,
        status: 'completed',
        model: 'claude-opus-4-8',
        tools: 2,
        activity: 'Read source',
        report: 'Reviewed once.',
      },
    });
    assert.equal(coordinator.snapshot.subagents.length, 1);
    const familiar = coordinator.snapshot.subagents[0]!;
    assert.deepEqual(familiar.rows, { start, end });
    assert.equal(familiar.startedAt, startedAt);
    assert.equal(familiar.status, 'completed');
    assert.equal(familiar.activity, 'Read source');
    assert.equal(familiar.tools, 2);
    assert.equal(familiar.report, 'Reviewed once.');
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

test('each familiar notice posts once, before its end row', async () => {
  const { coordinator, a } = await fixture();
  const emit = a.sessions[0]!.options.onEvent;
  const worker = {
    id: 'impl',
    name: 'implementation',
    kind: '',
    runtime: 'codex',
    run: 'one',
  };
  try {
    emit({ type: 'subagent', subagent: { ...worker, status: 'running' } });
    for (let heartbeat = 0; heartbeat < 2; heartbeat++)
      emit({
        type: 'subagent',
        subagent: { ...worker, status: 'running', notices: ['first'] },
      });
    // two new notices in one report, as a coalesced report carries them
    emit({
      type: 'subagent',
      subagent: {
        ...worker,
        status: 'completed',
        notices: ['first', 'second', 'third'],
        report: 'Done.',
      },
    });
    assert.deepEqual(
      coordinator.snapshot.items.flatMap((item) =>
        item.title?.startsWith('Familiar')
          ? [item.title]
          : item.kind === 'notice' && item.text.startsWith('Familiar ')
            ? [item.text]
            : [],
      ),
      [
        'Familiar started  implementation  codex',
        'Familiar implementation: first',
        'Familiar implementation: second',
        'Familiar implementation: third',
        'Familiar completed  implementation  codex',
      ],
    );
  } finally {
    await coordinator.close();
  }
});
