import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement, Profiler } from 'react';
import { test, vi } from 'vitest';
import { App } from '../../src/ui/App.js';
import { fake, left, show } from '../fixtures/ui.js';
import { CMD_C, first, long, wheelUp } from '../fixtures/ui-transcript.js';
import { until } from '../fixtures/within.js';

for (const [edge, unit, presses] of [
  ['top', 'cell', 1],
  ['bottom', 'cell', 1],
  ['top', 'word', 2],
  ['bottom', 'line', 3],
] as const) {
  test(`a held ${unit} selection at the ${edge} limit keeps its text without rendering on unchanged ticks`, async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { app } = fake({ items: [long] });
    const copied: string[] = [];
    let commits = 0;

    const ui = show(
      createElement(
        Profiler,
        { id: 'selection', onRender: () => commits++ },
        createElement(App, {
          coordinator: app,
          onExit() {},
          copy: (text) => copied.push(text),
        }),
      ),
      60,
      24,
    );

    try {
      await until('the transcript', () => first(ui) > 0);

      if (edge === 'top') {
        ui.stdin.write(wheelUp.repeat(400));
        await until('the top', () => first(ui) === 1);
      }

      for (let click = 1; click < presses; click++)
        ui.stdin.write(left('press', 1, 5) + left('release', 1, 5));

      const beforeDrag = commits;

      ui.stdin.write(
        left('press', 1, 5) + left('drag', 1, edge === 'top' ? 0 : 23),
      );

      await until('the selection render', () => commits > beforeDrag);
      ui.stdin.write(CMD_C);
      await until('the selected text', () => copied.length === 1);
      assert.ok(copied[0]!.length > 0);
      await delay(60);
      const beforeTicks = commits;

      for (let tick = 0; tick < 5; tick++) {
        vi.advanceTimersByTime(50);
        await delay(60);
        assert.equal(commits, beforeTicks);
      }

      ui.stdin.write(CMD_C);
      await until('the same selection copied again', () => copied.length === 2);
      assert.equal(copied[1], copied[0]);
    } finally {
      ui.unmount();
    }
  });
}

test('a wheel at an anchored bottom resumes following even when the viewport cannot move', async () => {
  const { app, coordinator } = fake({ items: [long] });

  const ui = show(
    createElement(App, { coordinator: app, onExit() {} }),
    60,
    24,
  );

  try {
    await until('the transcript', () => first(ui) > 0);
    ui.stdin.write(wheelUp.repeat(10));

    await until('the anchored view', () =>
      ui.text().includes('READING EARLIER OUTPUT'),
    );

    coordinator.publish({ items: [{ ...long, text: 'short output' }] });

    await until('the shortened output', () =>
      ui.text().includes('short output'),
    );

    assert.ok(ui.text().includes('↓ New messages'));
    ui.stdin.write('\u001b[<65;10;10M');

    await until(
      'follow mode',
      () =>
        !ui.text().includes('↓ New messages') &&
        !ui.text().includes('READING EARLIER OUTPUT'),
    );

    coordinator.publish({ items: [long] });
    await until('the newest output', () => ui.text().includes('row 300'));
  } finally {
    ui.unmount();
  }
});
