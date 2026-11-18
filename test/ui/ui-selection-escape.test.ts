import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { test, vi } from 'vitest';
import { App } from '../../src/ui/App.js';
import { Graphics, placeholder } from '../../src/ui/transcript/images.js';
import { png } from '../fixtures/png.js';
import { drag, fake, left, openCommand, show } from '../fixtures/ui.js';
import {
  CMD_C,
  first,
  long,
  mounted,
  wheelUp,
} from '../fixtures/ui-transcript.js';
import { until } from '../fixtures/within.js';

const message = {
  id: 'u',
  kind: 'user' as const,
  text: 'alpha beta gamma',
  cwd: '/work',
};

const highlighted = (ui: { frame(): string }) =>
  ui.frame().includes('\u001b[7malpha');

test('Escape interrupts after an image-only drag that draws no selection', async () => {
  const graphics = new Graphics(() => {});

  const { app, calls } = fake({
    phase: 'running',
    items: [
      {
        ...message,
        images: [`data:image/png;base64,${png(160, 80).toString('base64')}`],
      },
    ],
  });

  const ui = show(
    createElement(App, { coordinator: app, graphics, onExit: () => {} }),
    60,
    24,
  );

  try {
    await until('the image', () => ui.text().includes(placeholder));

    const row = ui
      .text()
      .split('\n')
      .findIndex((line) => line.includes(placeholder));

    drag(ui, [1, row], [4, row]);
    await delay(60);
    assert.ok(!ui.frame().includes('\u001b[7m'));
    ui.stdin.write('\u001b');
    await until('the interrupt', () => calls.length > 0);
    assert.deepEqual(calls, [['interrupt']]);
  } finally {
    ui.unmount();
    graphics.release();
  }
});

test('Escape clears a selection without copying or interrupting, then the next Escape interrupts', async () => {
  const { app, calls } = fake({ phase: 'running', items: [message] });
  const { ui, copied } = mounted(app);

  try {
    await until('the message', () => ui.text().includes(message.text));
    drag(ui, [1, 2], [5, 2]);
    await until('the highlight', () => highlighted(ui));
    ui.stdin.write(CMD_C);
    await until('the initial copy', () => copied.length === 1);
    assert.deepEqual(copied, ['alpha']);
    ui.stdin.write('\u001b');
    await until('the cleared highlight', () => !highlighted(ui));
    assert.deepEqual(calls, []);
    ui.stdin.write(CMD_C);
    await delay(60);
    assert.deepEqual(copied, ['alpha']);
    ui.stdin.write('\u001b');
    await until('the interrupt', () => calls.length > 0);
    assert.deepEqual(calls, [['interrupt']]);
  } finally {
    ui.unmount();
  }
});

test('a drag and Escape in one read clear the selection before it renders', async () => {
  const { app, calls } = fake({ phase: 'running', items: [message] });
  const { ui, copied } = mounted(app);

  try {
    await until('the message', () => ui.text().includes(message.text));

    ui.stdin.write(
      left('press', 1, 2) +
        left('drag', 5, 2) +
        left('release', 5, 2) +
        CMD_C +
        '\u001b[27u' +
        CMD_C,
    );

    await until('the initial copy', () => copied.length > 0);
    await delay(60);
    assert.deepEqual(copied, ['alpha']);
    assert.ok(!highlighted(ui));
    assert.deepEqual(calls, []);
  } finally {
    ui.unmount();
  }
});

test('Escape ends a held edge drag so timer ticks and later motion cannot restore the selection', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const { app } = fake({ items: [long] });
  const { ui, copied } = mounted(app);

  try {
    await until('the transcript', () => first(ui) > 0);
    const baseline = vi.getTimerCount();
    ui.stdin.write(left('press', 1, 5) + left('drag', 1, 0));
    await until('the highlight', () => ui.frame().includes('\u001b[7m'));
    assert.equal(vi.getTimerCount(), baseline + 1);
    ui.stdin.write('\u001b');

    await until(
      'the cleared highlight',
      () => !ui.frame().includes('\u001b[7m'),
    );

    assert.equal(vi.getTimerCount(), baseline);
    const position = first(ui);
    vi.advanceTimersByTime(200);
    ui.stdin.write(left('drag', 4, 6) + left('release', 4, 6) + CMD_C);
    await delay(60);
    assert.equal(first(ui), position);
    assert.ok(!ui.frame().includes('\u001b[7m'));
    assert.deepEqual(copied, []);
  } finally {
    ui.unmount();
  }
});

for (const focus of ['completion list', 'tools'] as const) {
  test(`Escape clears a selection before leaving ${focus}`, async () => {
    const { app, calls } = fake({
      phase: 'running',
      items: [
        message,
        {
          id: 't',
          kind: 'tool',
          title: 'run',
          text: 'output',
          cwd: '/work',
          done: true,
        },
      ],
      skills: [{ name: 'x-one', description: 'First skill' }],
    });

    const { ui } = mounted(app);

    const focused = () =>
      ui
        .text()
        .includes(focus === 'tools' ? 'ESC LEAVE TOOLS' : '/x-one First skill');

    try {
      await until('the message', () => ui.text().includes(message.text));
      ui.stdin.write(focus === 'tools' ? '\t' : '/x');
      await until(focus, focused);
      drag(ui, [1, 2], [5, 2]);
      await until('the highlight', () => highlighted(ui));
      ui.stdin.write('\u001b');
      await until('the cleared highlight', () => !highlighted(ui));
      assert.ok(focused());
      assert.deepEqual(calls, []);
      ui.stdin.write('\u001b');
      await until('focus dismissed', () => !focused());
      assert.deepEqual(calls, []);
    } finally {
      ui.unmount();
    }
  });
}

test('Escape closes a covering view without clearing its hidden transcript selection', async () => {
  const { app } = fake({ items: [message] });
  const { ui } = mounted(app);

  try {
    await until('the message', () => ui.text().includes(message.text));
    drag(ui, [1, 2], [5, 2]);
    await until('the highlight', () => highlighted(ui));
    await openCommand(ui, '/help', '/new  New');
    assert.ok(!highlighted(ui));
    ui.stdin.write('\u001b');
    await until('the highlighted transcript again', () => highlighted(ui));
  } finally {
    ui.unmount();
  }
});

test('Escape after a scroll in the same read interrupts when the selection is off screen', async () => {
  const { app, calls } = fake({ phase: 'running', items: [long] });
  const { ui, copied } = mounted(app);

  try {
    await until('the transcript', () => first(ui) > 0);
    drag(ui, [1, 5], [5, 5]);
    await until('the highlight', () => ui.frame().includes('\u001b[7m'));
    ui.stdin.write(CMD_C);
    await until('the initial copy', () => copied.length === 1);
    ui.stdin.write(wheelUp.repeat(30) + '\u001b[27u');
    await until('the interrupt', () => calls.length > 0);
    assert.deepEqual(calls, [['interrupt']]);
    assert.ok(!ui.frame().includes('\u001b[7m'));
    ui.stdin.write(CMD_C);
    await until('the retained selection copied', () => copied.length === 2);
    assert.equal(copied[1], copied[0]);
  } finally {
    ui.unmount();
  }
});
