import assert from 'node:assert/strict';
import { createElement } from 'react';
import { test, vi } from 'vitest';
import type { UserRequest } from '../../src/agents/types.js';
import { App } from '../../src/ui/App.js';
import { TurnGate } from '../fixtures/agent.js';
import { unitFixture } from '../fixtures/coordinator.js';
import { approval, fake, openCommand, show } from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';

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
