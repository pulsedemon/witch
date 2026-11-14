import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { test } from 'vitest';
import type { DisplayItem } from '../src/core/state.js';
import { App } from '../src/ui/app.js';
import { Screen } from '../src/ui/screen.js';
import { unitFixture } from './fixtures/coordinator.js';
import { show, fake, drag, left, ENTER, SHIFT_ENTER } from './fixtures/ui.js';
import { until } from './fixtures/within.js';

const reminder = 'Earlier messages shown here';

const wheelUp = '\u001b[<64;5;5M';

const wheelDown = '\u001b[<65;5;5M';

const marker = (id: string): DisplayItem => ({
  id,
  kind: 'notice',
  text: 'Context cleared.',
  cwd: '/work',
  contextCleared: true,
});

const message = (id: string, text = id): DisplayItem => ({
  id,
  kind: 'assistant',
  text,
  cwd: '/work',
});

async function submit(ui: ReturnType<typeof show>, text: string) {
  ui.stdin.write(text);

  await delay(30);

  ui.stdin.write(ENTER);
}

test('clear runs in the current conversation and its visible boundary survives reopening', async () => {
  const f = await unitFixture();

  let c = f.coordinator;

  let ui: ReturnType<typeof show> | undefined;

  try {
    await c.send('earlier context');

    const id = c.snapshot.conversation!.id;

    const native = c.snapshot.native!.id;

    ui = show(createElement(App, { coordinator: c, onExit: () => {} }), 80, 25);

    await until('old transcript', () => ui!.text().includes('earlier context'));

    await submit(ui, '/clear');

    await until(
      'new native session',
      () => c.snapshot.phase === 'idle' && c.snapshot.native!.id !== native,
    );

    await until(
      'clear boundary',
      () =>
        ui!.text().includes('Context cleared.') &&
        ui!.text().includes(reminder),
    );

    assert.equal(c.snapshot.conversation!.id, id);

    assert.equal(f.a.inputs.length, 1);

    assert.match(ui.text(), /earlier context/);

    ui.unmount();

    await c.close();

    c = await f.reopen();

    ui = show(createElement(App, { coordinator: c, onExit: () => {} }), 80, 25);

    await until(
      'reopened clear boundary',
      () =>
        ui!.text().includes('Context cleared.') &&
        ui!.text().includes(reminder),
    );

    assert.match(ui.text(), /earlier context/);
  } finally {
    ui?.unmount();

    await c.close();
  }
});

test('clear dispatches locally, discards prose and appears in help', async () => {
  const { app, calls } = fake({});

  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await until('composer', () => ui.text().includes('Ask the agent'));

    await submit(ui, '/clear');

    await until('clear dispatch', () => calls.length === 1);

    assert.deepEqual(calls, [['clear']]);

    await submit(ui, '/clear extra');

    await until('clear dispatch', () => calls.length === 2);

    assert.deepEqual(calls[1], ['clear']);

    await submit(ui, '/help');

    await until('help with clear', () =>
      ui.text().includes('/clear  Clear agent context'),
    );

    assert.equal(
      calls.some(([name]) => name === 'send'),
      false,
    );
  } finally {
    ui.unmount();
  }
});

test('the reminder stays stable when its row displaces the last archived row', async () => {
  // the post-clear rows leave exactly one archived row in the unpinned 13-row viewport
  const items = [
    message('old'),
    marker('clear'),
    message('one'),
    message('two'),
    message('three', 'three\nextra'),
  ];

  const { app, coordinator } = fake({ items });

  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    80,
    24,
  );

  try {
    await until('pinned last-row reminder', () => ui.text().includes(reminder));

    for (let i = 0; i < 3; i++) {
      coordinator.publish({ usage: { context: i } });

      await delay(70);

      assert.match(ui.text(), /Earlier messages shown here/);

      assert.equal(
        ui
          .text()
          .split('\n')
          .filter((line) => line.includes(reminder)).length,
        1,
      );
    }

    ui.stdin.write('draft');

    ui.stdin.write(SHIFT_ENTER);

    await until(
      'a smaller viewport has no archived rows',
      () => !ui.text().includes(reminder),
    );

    ui.stdin.write('\u007f');

    await until('the original viewport needs the reminder again', () =>
      ui.text().includes(reminder),
    );

    coordinator.publish({ items: [...items, message('four')] });

    await until(
      'new rows move the boundary above the viewport',
      () => !ui.text().includes(reminder),
    );
  } finally {
    ui.unmount();
  }
});

test('only the latest clear boundary controls the reminder while scrolling', async () => {
  const lines = (name: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${name} ${i}`).join('\n\n');

  const { app } = fake({
    items: [
      message('first', lines('before-first-clear', 30)),
      marker('first-clear'),
      message('middle', lines('between-clears', 40)),
      marker('second-clear'),
      message('latest', lines('after-last-clear', 30)),
    ],
  });

  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    80,
    24,
  );

  try {
    await until('latest output', () =>
      ui.text().includes('after-last-clear 29'),
    );

    assert.ok(!ui.text().includes(reminder));

    ui.stdin.write(wheelUp.repeat(55));

    await until('history between clears', () =>
      ui.text().includes('between-clears'),
    );

    assert.match(ui.text(), /Earlier messages shown here/);

    assert.doesNotMatch(ui.text(), /before-first-clear/);

    ui.stdin.write(wheelDown.repeat(100));

    await until(
      'back at the latest output',
      () =>
        ui.text().includes('after-last-clear 29') &&
        !ui.text().includes(reminder),
    );
  } finally {
    ui.unmount();
  }
});

test('an empty clear and a transcript with no clear have no archived-row reminder', async () => {
  const { app, coordinator } = fake({ items: [message('ordinary')] });

  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await until('ordinary history', () => ui.text().includes('ordinary'));

    assert.ok(!ui.text().includes(reminder));

    coordinator.publish({ items: [marker('empty-clear'), message('fresh')] });

    await until('fresh history', () => ui.text().includes('fresh'));

    assert.ok(!ui.text().includes(reminder));
  } finally {
    ui.unmount();
  }
});

test('batched drag events keep their row coordinates when scrolling removes the reminder', async () => {
  const { app } = fake({
    items: [
      message('old', 'old alpha'),
      marker('clear'),
      ...Array.from({ length: 8 }, (_, i) =>
        message(`fresh-${i}`, `fresh line ${i}`),
      ),
    ],
  });

  const copied: string[] = [];

  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      copy: (text) => copied.push(text),
    }),
    80,
    24,
  );

  try {
    await until('latest rows', () => ui.text().includes('fresh line 7'));

    ui.stdin.write(wheelUp.repeat(40));

    await until('archived first row', () => ui.text().includes('old alpha'));

    ui.stdin.write(
      left('press', 0, 3) +
        left('drag', 8, 14).repeat(4) +
        left('drag', 8, 12) +
        left('release', 8, 12) +
        '\u001b[99;9u',
    );

    await until('batched selection copied', () => copied.length > 0);

    assert.equal(
      copied[0],
      'old alpha\n\nContext cleared.\n\nAssistant\nfresh line 0\n\nAssistant\nfresh line 1\n\nAssistant\nfresh line 2\n\nAssistant\nfresh li',
    );
  } finally {
    ui.unmount();
  }
});

test('the reminder preserves archived colors, selection and hyperlink coordinates after expansion and resize', async () => {
  const old: DisplayItem = {
    id: 'old',
    kind: 'user',
    text: '**old alpha** [archive](https://example.com/archive)',
    cwd: '/work',
  };

  const tool: DisplayItem = {
    id: 'tool',
    kind: 'tool',
    title: 'old tool',
    text: 'retained tool output',
    cwd: '/work',
    done: true,
  };

  const { app, coordinator } = fake({ items: [old, tool] });

  const copied: string[] = [];

  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      copy: (text) => copied.push(text),
    }),
    80,
    25,
  );

  const copy = async (text: string) => {
    const lines = ui.text().split('\n');

    const row = lines.findIndex((line) => line.includes(text));

    assert.ok(row >= 0, ui.text());

    const column = lines[row]!.indexOf(text);

    const count = copied.length;

    drag(ui, [column, row], [column + text.length - 1, row]);

    ui.stdin.write('\u001b[99;9u');

    await until('selected text copied', () => copied.length > count);

    assert.equal(copied.at(-1), text);
  };

  try {
    await until('old colored row', () => ui.text().includes('old alpha'));

    const color = ui
      .frame()
      .split('\n')
      .find((line) => line.includes('old alpha'));

    assert.ok(color);

    coordinator.publish({
      items: [old, tool, marker('clear'), message('fresh', 'fresh beta')],
    });

    await until('pinned history', () => ui.text().includes(reminder));

    assert.equal(
      ui
        .frame()
        .split('\n')
        .find((line) => line.includes('old alpha')),
      color,
    );

    await copy('old alpha');

    await copy('fresh beta');

    ui.stdin.write(`\t${ENTER}`);

    await until('expanded retained tool', () =>
      ui.text().includes('retained tool output'),
    );

    ui.resize(60);

    await until(
      'resized retained tool',
      () =>
        ui.text().includes('retained tool output') &&
        ui.text().includes('old alpha') &&
        ui
          .text()
          .split('\n')
          .every((line) => line.length <= 60),
    );

    const screen = new Screen({ columns: 60, rows: 25 });

    screen.write(ui.frame());

    const rows = ui.text().split('\n');

    const row = rows.findIndex((line) => line.includes('archive'));

    const column = rows[row]!.indexOf('archive');

    assert.equal(screen.linkAt(column, row), 'https://example.com/archive');

    assert.equal(screen.linkAt(column, 1), undefined);

    await copy('old alpha');
  } finally {
    ui.unmount();
  }
});
