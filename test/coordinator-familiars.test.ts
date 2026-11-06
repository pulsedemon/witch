import assert from 'node:assert/strict';
import { test } from 'vitest';
import { unitFixture } from './fixtures/coordinator.js';

test('a reported familiar replaces its brew and retitles observed identity without duplicating reports', async () => {
  const { coordinator, a } = await unitFixture();
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
  const { coordinator, a } = await unitFixture();
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

test('a running familiar keeps the job watch active until it ends', async () => {
  const { coordinator, a, active } = await unitFixture();
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
    emit({
      type: 'subagent',
      subagent: { ...worker, status: 'running', notices: ['first'] },
    });
    assert.deepEqual(active, [true, false, true]);
    emit({
      type: 'subagent',
      subagent: { ...worker, status: 'completed', report: 'Done.' },
    });
    assert.deepEqual(active, [true, false, true, false]);
  } finally {
    await coordinator.close();
  }
});

test('familiar and brew rows retain identity, order and reports after reopening', async () => {
  const { coordinator, a, project, reopen } = await unitFixture();
  let reopened: typeof coordinator | undefined;
  const emit = a.sessions[0]!.options.onEvent;
  const worker = {
    id: 'review',
    name: 'Reviewer',
    kind: '',
    runtime: 'claude',
    run: 'one',
    model: 'model-a',
  };
  try {
    await coordinator.send('record background activity');
    emit({
      type: 'command',
      command: { id: 'preview', description: 'Preview', status: 'running' },
    });
    emit({ type: 'subagent', subagent: { ...worker, status: 'running' } });
    for (const model of ['model-a', 'model-b'])
      emit({
        type: 'subagent',
        subagent: {
          ...worker,
          model,
          status: 'completed',
          tools: 2,
          report: 'Review saved.',
          notices: ['Saved note.'],
        },
      });
    const { start, end } = coordinator.snapshot.subagents[0]!.rows;
    const assertRows = (current: typeof coordinator) => {
      const rows = current.snapshot.items.filter((item) =>
        item.kind === 'tool'
          ? /^(Brew|Familiar) /.test(item.title ?? '')
          : item.kind === 'notice' && item.text.startsWith('Familiar '),
      );
      assert.deepEqual(
        rows.map(({ kind, title, text, done, cwd }) => [
          kind,
          title,
          text,
          done,
          cwd,
        ]),
        [
          ['tool', 'Brew started  Preview', '', true, project],
          [
            'tool',
            'Familiar started  Reviewer  claude · model-b',
            '',
            true,
            project,
          ],
          [
            'notice',
            undefined,
            'Familiar Reviewer: Saved note.',
            undefined,
            project,
          ],
          [
            'tool',
            'Familiar completed  Reviewer  claude · model-b  2 tools',
            'Review saved.',
            true,
            project,
          ],
          ['tool', 'Brew stopped  Preview', '', true, project],
        ],
      );
      assert.deepEqual(
        rows
          .filter(({ title }) => title?.startsWith('Familiar'))
          .map(({ id }) => id),
        [start, end],
      );
    };
    await coordinator.close();
    assertRows(coordinator);
    reopened = await reopen();
    assertRows(reopened);
    assert.deepEqual(reopened.snapshot.subagents, []);
    assert.deepEqual(reopened.snapshot.backgroundCommands, []);
  } finally {
    await coordinator.close();
    await reopened?.close();
  }
});

test('the native agent running on its own keeps the session active until it idles, closes or disconnects', async () => {
  const { coordinator, a, b, active } = await unitFixture();
  const shown = () => [
    coordinator.snapshot.nativeRunning,
    coordinator.pentacle.active,
    active.at(-1),
  ];
  try {
    const emitA = a.sessions[0]!.options.onEvent;
    emitA({ type: 'running', running: true });
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.deepEqual(shown(), [true, true, true]);
    emitA({ type: 'running', running: false });
    assert.deepEqual(shown(), [false, false, false]);
    emitA({ type: 'running', running: true });
    await coordinator.selectModel({ agent: 'b', id: 'b-model' });
    assert.deepEqual(shown(), [false, false, false]);
    const emitB = b.sessions[0]!.options.onEvent;
    emitB({ type: 'running', running: true });
    assert.deepEqual(shown(), [true, true, true]);
    emitB({ type: 'closed' });
    assert.deepEqual(shown(), [false, false, false]);
  } finally {
    await coordinator.close();
  }
});

test('the pentacle spins while the session closes', async () => {
  const { coordinator } = await unitFixture();
  assert.equal(coordinator.pentacle.active, false);
  const closing = coordinator.close();
  assert.equal(coordinator.snapshot.phase, 'closing');
  assert.equal(coordinator.pentacle.active, true);
  await closing;
});
