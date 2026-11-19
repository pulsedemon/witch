import assert from 'node:assert/strict';
import { createElement } from 'react';
import { test, vi } from 'vitest';
import type { UserRequest } from '../../src/agents/types.js';
import type { DisplayItem } from '../../src/core/state.js';
import { App } from '../../src/ui/App.js';
import { Activity } from '../../src/ui/status/Activity.js';
import { TurnGate } from '../fixtures/agent.js';
import { unitFixture } from '../fixtures/coordinator.js';
import { approval, fake, openCommand, show } from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';

test('native compaction replaces the activity verb at narrow width without resetting the turn clock', async () => {
  const { coordinator, a } = await unitFixture();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  const gate = new TurnGate();
  a.gate = gate;
  const ui = show(createElement(App, { coordinator, onExit() {} }), 36, 24);
  const sending = coordinator.send('keep working');

  const row = () =>
    ui
      .text()
      .split('\n')
      .find((line) => line.includes('ESC TO')) ?? '';

  try {
    await gate.entered;
    await until('the running activity', () => row().includes('| 0S |'));
    const verb = row().trim().split(' ')[1];
    const startedAt = coordinator.snapshot.activityStartedAt;
    const { onEvent } = a.sessions.at(-1)!.options;
    clock.mockReturnValue(110_000);
    onEvent({ type: 'compacting', compacting: true });

    await until('native compaction on the narrow row', () =>
      row().includes('COMPACTING | 10S |'),
    );

    assert.equal(coordinator.snapshot.phase, 'running');
    assert.equal(coordinator.snapshot.activityStartedAt, startedAt);
    clock.mockReturnValue(115_000);
    onEvent({ type: 'compacting', compacting: false });
    onEvent({ type: 'compacted' });

    await until('the original verb returns', () =>
      row().includes(`${verb} | 15S |`),
    );

    assert.equal(coordinator.snapshot.activityStartedAt, startedAt);

    assert.ok(
      coordinator.snapshot.items.some(
        (item) => item.text === 'Conversation compacted',
      ),
    );

    onEvent({ type: 'compacting', compacting: true });

    await until('the second native compaction', () =>
      row().includes('COMPACTING'),
    );

    onEvent({ type: 'closed' });

    await until('closure clears the compaction label', () =>
      row().includes(`${verb} | 15S |`),
    );

    assert.equal(coordinator.snapshot.nativeCompacting, false);
  } finally {
    gate.open();
    await sending;
    ui.unmount();
    clock.mockRestore();
    await coordinator.close();
  }
});

test('disconnect clears native compaction and ignores the closed session’s later events', async () => {
  const { coordinator, a } = await unitFixture();

  try {
    const { onEvent } = a.sessions.at(-1)!.options;
    onEvent({ type: 'compacting', compacting: true });
    assert.equal(coordinator.snapshot.nativeCompacting, true);
    await coordinator.close();
    assert.equal(coordinator.snapshot.nativeCompacting, false);
    onEvent({ type: 'compacting', compacting: true });
    assert.equal(coordinator.snapshot.nativeCompacting, false);
  } finally {
    await coordinator.close();
  }
});

test('the activity start survives automatic compaction and request updates, then resets for the next operation', async () => {
  const { coordinator, a } = await unitFixture(undefined, (a) => {
    a.connectUsage = { context: 90, contextWindow: 100_000 };
  });

  const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  const session = a.sessions.at(-1)!.session;
  const contextUsage = session.contextUsage.bind(session);

  session.contextUsage = async () => {
    clock.mockReturnValue(102_000);

    return contextUsage();
  };

  const compacting = new TurnGate();
  const running = new TurnGate();
  const next = new TurnGate();
  a.gate = compacting;
  const sending = coordinator.send('first turn');

  try {
    await compacting.entered;
    assert.equal(coordinator.snapshot.phase, 'compacting');
    assert.equal(coordinator.snapshot.activityStartedAt, 100_000);
    session.contextUsage = contextUsage;
    clock.mockReturnValue(105_000);
    a.gate = running;
    compacting.open();
    await running.entered;
    assert.equal(coordinator.snapshot.phase, 'running');
    assert.equal(coordinator.snapshot.activityStartedAt, 100_000);
    const { onEvent } = a.sessions.at(-1)!.options;
    onEvent({ type: 'request', request: approval });
    clock.mockReturnValue(112_000);
    onEvent({ type: 'request-resolved', id: approval.id });
    assert.equal(coordinator.snapshot.activityStartedAt, 100_000);
    running.open();
    await sending;
    assert.equal(coordinator.snapshot.phase, 'idle');
    clock.mockReturnValue(120_000);
    a.gate = next;
    const sendingNext = coordinator.send('second turn');
    await next.entered;
    assert.equal(coordinator.snapshot.activityStartedAt, 120_000);
    next.open();
    await sendingNext;
  } finally {
    compacting.open();
    running.open();
    next.open();
    await sending;
    session.contextUsage = contextUsage;
    clock.mockRestore();
    await coordinator.close();
  }
});

test('the working row counts hidden time across requests and pages from its operation start', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(105_000);

  const { app, coordinator } = fake({
    phase: 'running',
    activityStartedAt: 100_000,
    requests: [approval],
  });

  const ui = show(createElement(App, { coordinator: app, onExit() {} }));

  const row = () =>
    ui
      .text()
      .split('\n')
      .find((line) => line.includes('ESC TO INTERRUPT'));

  try {
    await until('the initial approval', () =>
      ui.text().includes(approval.title),
    );

    assert.equal(row(), undefined);
    vi.setSystemTime(112_000);
    coordinator.publish({ requests: [] });

    await until(
      'the first visible activity includes hidden time',
      () => row()?.includes('| 12S |') === true,
    );

    for (const [request, now, expected] of [
      [approval, 119_000, '| 19S |'],
      [
        {
          id: 'question',
          kind: 'question',
          title: 'Choose one',
          detail: '',
          questions: [
            { id: 'answer', title: 'Choose one', options: ['first', 'second'] },
          ],
        },
        126_000,
        '| 26S |',
      ],
    ] satisfies [UserRequest, number, string][]) {
      coordinator.publish({ requests: [request] });

      await until(
        'the request replaces the activity',
        () => row() === undefined && ui.text().includes(request.title),
      );

      vi.setSystemTime(now);
      coordinator.publish({ requests: [] });

      await until(
        'the returning activity keeps elapsed time',
        () => row()?.includes(expected) === true,
      );
    }

    await openCommand(ui, '/help', 'COMMANDS');
    assert.equal(row(), undefined);
    vi.setSystemTime(133_000);
    ui.stdin.write('\u001b');

    await until(
      'the activity includes time on the page',
      () => row()?.includes('| 33S |') === true,
    );
  } finally {
    ui.unmount();
    vi.useRealTimers();
  }
});

test('a new operation resets the activity before its next tick when the UI batches idle and running', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(105_000);

  const { app, coordinator } = fake({
    phase: 'running',
    activityStartedAt: 100_000,
  });

  const ui = show(createElement(App, { coordinator: app, onExit() {} }));

  try {
    await until('the first operation at five seconds', () =>
      ui.text().includes('| 5S | ESC TO INTERRUPT'),
    );

    vi.setSystemTime(120_000);
    coordinator.publish({ phase: 'idle' });
    coordinator.publish({ phase: 'running', activityStartedAt: 120_000 });

    await until('the next operation starts at zero', () =>
      ui.text().includes('| 0S | ESC TO INTERRUPT'),
    );
  } finally {
    ui.unmount();
    vi.useRealTimers();
  }
});

const at = (milliseconds: number) => new Date(milliseconds).toISOString();

const said = (text: string, when: number): DisplayItem => ({
  id: 'turn/a/said',
  kind: 'assistant',
  title: 'a',
  text,
  cwd: '/work',
  at: at(when),
});

const call = (name: string, when: number, done = true): DisplayItem => ({
  id: `turn/a/${name}`,
  kind: 'tool',
  title: name,
  text: '',
  cwd: '/work',
  done,
  at: at(when),
});

test('the working row counts quiet time from the agent’s last update and names what runs', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(400_000);

  const items = [
    said('Merging main now.', 160_000),
    call('git merge origin/main', 175_000),
  ];

  const { app, coordinator } = fake({
    phase: 'running',
    activityStartedAt: 100_000,
    items,
  });

  const ui = show(createElement(App, { coordinator: app, onExit() {} }));

  const row = () =>
    ui
      .text()
      .split('\n')
      .find((line) => line.includes('QUIET'))
      ?.trim() ?? '';

  try {
    await until('a quiet turn', () =>
      row().endsWith('| 5M00S | ESC TO INTERRUPT | QUIET 3M45S'),
    );

    coordinator.publish({
      items: [...items, call('pnpm check', 400_000, false)],
    });

    await until('a running tool', () =>
      row().endsWith('| QUIET 0S | RUNNING pnpm check'),
    );

    vi.setSystemTime(470_000);
    vi.advanceTimersByTime(100);

    await until('the quiet count advancing', () =>
      row().endsWith('| QUIET 1M10S | RUNNING pnpm check'),
    );

    coordinator.publish({ requests: [approval] });

    await until(
      'the approval replaces the row',
      () => row() === '' && ui.text().includes(approval.title),
    );

    vi.setSystemTime(500_000);
    coordinator.publish({ requests: [] });

    await until('the quiet count kept across the approval', () =>
      row().endsWith('| QUIET 1M40S | RUNNING pnpm check'),
    );
  } finally {
    ui.unmount();
    vi.useRealTimers();
  }
});

test('the working row says how long ago the model reasoned', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(400_000);
  const items = [said('Merging main now.', 175_000)];

  const { app, coordinator } = fake({
    phase: 'running',
    activityStartedAt: 100_000,
    items,
    reasonedAt: 381_000,
  });

  const ui = show(createElement(App, { coordinator: app, onExit() {} }));

  const row = () =>
    ui
      .text()
      .split('\n')
      .find((line) => line.includes('QUIET'))
      ?.trim() ?? '';

  try {
    await until('the last reasoning', () =>
      row().endsWith('| QUIET 3M45S | THOUGHT 19S AGO'),
    );

    coordinator.publish({
      items: [...items, call('pnpm check', 390_000, false)],
      reasonedAt: 395_000,
    });

    await until('reasoning beside a running tool', () =>
      row().endsWith('| QUIET 10S | THOUGHT 5S AGO | RUNNING pnpm check'),
    );

    coordinator.publish({
      items: [
        ...items,
        call('pnpm check', 390_000, false),
        { ...said('Checks pass.', 400_000), id: 'turn/a/said-2' },
      ],
    });

    await until('a newer message', () =>
      row().endsWith('| QUIET 0S | RUNNING pnpm check'),
    );
  } finally {
    ui.unmount();
    vi.useRealTimers();
  }
});

test('the agent’s latest message stays above the tool window while a diff fills the transcript', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(1_000_000);

  const { app } = fake({
    phase: 'running',
    activityStartedAt: 100_000,
    pendingCompaction: true,
    queue: ['after this'],
    items: [
      said(
        'Main also received a formatting sweep.\nI’m integrating it.',
        159_000,
      ),
      {
        ...call('git merge --no-commit origin/main', 775_000),
        diff: [
          {
            path: '/work/a.txt',
            kind: 'update',
            hunks: [
              {
                oldStart: 1,
                newStart: 1,
                lines: Array.from({ length: 80 }, (_, i) => `+line ${i + 1}`),
              },
            ],
          },
        ],
      },
      call('cat a.txt', 775_000),
      call('cat b.txt', 775_000),
    ],
  });

  const ui = show(createElement(App, { coordinator: app, onExit() {} }));
  const lines = () => ui.text().split('\n');

  const top = () =>
    lines().findIndex((line) => line.trimStart().startsWith('TOOLS'));

  try {
    await until('the tool window', () => top() > 0);
    const transcript = lines().slice(0, top() - 3);
    // the message itself is out of view, above the diff its turn made
    assert.ok(transcript.every((line) => !line.includes('formatting sweep')));
    assert.match(transcript.join('\n'), /\+ ✓ 2 tools/);

    assert.deepEqual(
      lines()
        .slice(top() - 3, top())
        .map((line) => line.trim()),
      [
        '14M01S AGO · Main also received a formatting sweep. I’m integrating it.',
        'Pending: /compact',
        '❯ after this',
      ],
    );
  } finally {
    ui.unmount();
    vi.useRealTimers();
  }
});

test('a working phase that is not the agent’s run leaves the message row to the transcript', async () => {
  const { app, coordinator } = fake({
    phase: 'compacting',
    items: [
      {
        id: 'reading',
        kind: 'assistant',
        cwd: '/work',
        text: Array.from(
          { length: 160 },
          (_, i) => `source line ${i + 1}`,
        ).join('\n'),
      },
    ],
  });

  const ui = show(createElement(App, { coordinator: app, onExit() {} }));

  /** rows between the transcript's last text and the tool window: its closing blank row, then the message row when reserved. */
  const between = () => {
    const lines = ui.text().split('\n');
    const top = lines.findIndex((line) => line.trimStart().startsWith('TOOLS'));
    const last = lines.findIndex((line) => line.trim() === 'source line 160');

    return top < 0 || last < 0 ? undefined : top - last - 1;
  };

  try {
    await until(
      'the transcript against the tool window',
      () => between() === 1,
    );

    coordinator.publish({ phase: 'running' });
    await until('the message row in the agent’s run', () => between() === 2);
  } finally {
    ui.unmount();
  }
});

test('activity age stays nonnegative between shared clock boundaries', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(100_023);

  const ui = show(
    createElement(Activity, {
      startedAt: 100_023,
      quietSince: 100_023,
      reasonedAt: 100_023,
    }),
  );

  try {
    await until('the activity clocks', () =>
      ui.text().includes('THOUGHT 0S AGO'),
    );

    assert.ok(ui.text().includes('| 0S |'));
    assert.ok(ui.text().includes('QUIET 0S'));
    assert.ok(!ui.text().includes('-1S'));
  } finally {
    ui.unmount();
  }
});
