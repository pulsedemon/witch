import assert from 'node:assert/strict';
import { createElement } from 'react';
import { setTimeout as delay } from 'node:timers/promises';
import { test, vi } from 'vitest';
import type { DisplayItem } from '../../src/core/state.js';
import { App } from '../../src/ui/App.js';
import { fake, left, show, DOWN, ENTER, UP } from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';
import { CMD_C } from '../fixtures/ui-transcript.js';

const tool = (id: string): DisplayItem => ({
  id,
  kind: 'tool',
  title: `${id} tool`,
  text: `${id} output`,
  cwd: '/work',
  done: true,
});

/** an agent tool row, whose id has the `<activity>/<agent>/<native id>` shape grouping relies on. */
const agentTool = (name: string, done = true): DisplayItem => ({
  ...tool(name),
  id: `turn/claude/${name}`,
  done,
});

const said = (id: string): DisplayItem => ({
  id: `said-${id}`,
  kind: 'assistant',
  text: `after ${id}`,
  cwd: '/work',
});

/** the raw frame row that shows `text`, with its styling. */
const row = (ui: ReturnType<typeof show>, text: string) =>
  ui
    .frame()
    .split('\n')
    .find((line) => line.includes(text)) ?? '';

test('the selected tool stays selected when a tool is added above it', async () => {
  const items = [
    tool('alpha'),
    said('alpha'),
    tool('beta'),
    said('beta'),
    tool('gamma'),
  ];

  const { app, coordinator } = fake({ items });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await delay(60);
    ui.stdin.write(`\t${DOWN}${DOWN}`);

    await until('gamma selected', () =>
      row(ui, 'gamma tool').includes('\u001b[7m'),
    );

    coordinator.publish({ items: [tool('first'), said('first'), ...items] });
    await until('the new tool', () => ui.text().includes('first tool'));
    assert.ok(row(ui, 'gamma tool').includes('\u001b[7m'));
    assert.ok(!row(ui, 'beta tool').includes('\u001b[7m'));
  } finally {
    ui.unmount();
  }
});

test('Tab and Enter toggle a tool group, and its members are selectable once open', async () => {
  const { app } = fake({ items: [agentTool('alpha'), agentTool('beta')] });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await until('the group', () => ui.text().includes('+ ✓ 2 tools'));
    assert.ok(!ui.text().split('TOOLS')[0]!.includes('alpha tool'));
    ui.stdin.write(`\t${ENTER}`);
    await until('the open group', () => ui.text().includes('− ✓ 2 tools'));

    assert.ok(
      ui.text().split('TOOLS')[0]!.includes('alpha tool') &&
        ui.text().split('TOOLS')[0]!.includes('beta tool'),
    );

    ui.stdin.write(DOWN);

    await until('alpha selected', () =>
      row(ui, 'alpha tool').includes('\u001b[7m'),
    );

    ui.stdin.write(UP);
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the closed group', () => ui.text().includes('+ ✓ 2 tools'));
    assert.ok(!ui.text().split('TOOLS')[0]!.includes('alpha tool'));
  } finally {
    ui.unmount();
  }
});

test('a group open through a member collapses on one Enter', async () => {
  const { app, coordinator } = fake({
    items: [agentTool('alpha', false), agentTool('beta')],
  });

  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await delay(60);
    ui.stdin.write(`\t${ENTER}`);
    await until('alpha open', () => ui.text().includes('alpha output'));
    coordinator.publish({ items: [agentTool('alpha'), agentTool('beta')] });
    await until('the group, open', () => ui.text().includes('− ✓ 2 tools'));
    ui.stdin.write(UP);
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the closed group', () => ui.text().includes('+ ✓ 2 tools'));
    assert.ok(!ui.text().includes('alpha output'));
  } finally {
    ui.unmount();
  }
});

test('reading earlier output keeps its position when a running tool joins a group', async () => {
  const later: DisplayItem = {
    id: 'later',
    kind: 'assistant',
    text: Array.from({ length: 60 }, (_, n) => `later ${n}`).join('\n\n'),
    cwd: '/work',
  };

  const items = [said('start'), agentTool('alpha'), agentTool('beta', false)];
  const { app, coordinator } = fake({ items: [...items, later] });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  const top = () => ui.text().split('\n')[1]!.trim();

  try {
    await delay(60);
    ui.stdin.write(`\t${DOWN}`);
    await until('beta at the top', () => top().endsWith('beta tool'));
    ui.stdin.write('\u001b');

    await until(
      'tools unfocused',
      () => !ui.text().includes('ESC LEAVE TOOLS'),
    );

    coordinator.publish({
      items: [said('start'), agentTool('alpha'), agentTool('beta'), later],
    });

    await until('the group at the top', () => top() === '+ ✓ 2 tools');
    assert.ok(ui.text().includes('READING EARLIER OUTPUT'));
  } finally {
    ui.unmount();
  }
});

test('a selected tool that joins a group leaves the group selected', async () => {
  const items = (done: boolean) => [
    agentTool('west'),
    said('west'),
    agentTool('alpha'),
    agentTool('beta', done),
    said('beta'),
    agentTool('xray'),
  ];

  const { app, coordinator } = fake({ items: items(false) });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await delay(60);
    ui.stdin.write(`\t${DOWN}${DOWN}`);

    await until('beta selected', () =>
      row(ui, 'beta tool').includes('\u001b[7m'),
    );

    coordinator.publish({ items: items(true) });
    await until('the group', () => ui.text().includes('2 tools'));

    await until('the group selected', () =>
      row(ui, '2 tools').includes('\u001b[7m'),
    );

    assert.ok(!row(ui, 'xray tool').includes('\u001b[7m'));
    assert.ok(!row(ui, 'west tool').includes('\u001b[7m'));
  } finally {
    ui.unmount();
  }
});

test("a double or triple click on a tool's marker in one read toggles it each time and selects nothing", async () => {
  // the clock stands still, so every press on one cell counts with the last
  vi.useFakeTimers({ toFake: ['performance'] });
  const { app } = fake({ items: [said('start'), tool('alpha')] });
  const copied: string[] = [];

  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      copy: (text: string) => copied.push(text),
    }),
  );

  try {
    await until('the tool', () => ui.text().includes('+ ✓ alpha tool'));

    const at = ui
      .text()
      .split('\n')
      .findIndex((line) => line.includes('alpha tool'));

    const click = left('press', 1, at) + left('release', 1, at);
    // two toggles leave the row as it was, so only the marker keeps the second press from selecting its word
    ui.stdin.write(click + click + CMD_C);
    // a new count, so a tool only the first click of each batch toggled would end closed
    vi.advanceTimersByTime(600);
    ui.stdin.write(click + click + click + CMD_C);
    await until('the open tool', () => ui.text().includes('alpha output'));
    assert.ok(!ui.frame().includes('\u001b[7m'));

    // a copy from either would land before this one
    ui.stdin.write(
      left('press', 5, at) + left('drag', 9, at) + left('release', 9, at),
    );

    ui.stdin.write(CMD_C);
    await until('the copy', () => copied.length > 0);
    assert.deepEqual(copied, ['alpha']);
  } finally {
    ui.unmount();
  }
});

test("clicking a tool's marker toggles it and a click on its title text does not", async () => {
  const { app } = fake({ items: [said('start'), tool('alpha')] });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  const click = (column: number) => {
    const at = ui
      .text()
      .split('\n')
      .findIndex((line) => line.includes('alpha tool'));

    ui.stdin.write(left('press', column, at) + left('release', column, at));
  };

  try {
    await until('the tool', () => ui.text().includes('+ ✓ alpha tool'));
    click(8);
    await delay(60);
    assert.ok(!ui.text().includes('alpha output'));
    click(1);
    await until('the open tool', () => ui.text().includes('alpha output'));
    assert.ok(ui.text().includes('− ✓ alpha tool'));
    click(1);
    await until('the closed tool', () => !ui.text().includes('alpha output'));
  } finally {
    ui.unmount();
  }
});

const lines = (id: string, count: number): DisplayItem => ({
  id,
  kind: 'assistant',
  text: Array.from({ length: count }, (_, i) => `${id} line ${i}`).join('\n'),
  cwd: '/work',
});

const PAGE_UP = '\u001b[5~';
const TAB = '\u001b[9u';
const wheelDown = '\u001b[<65;10;3M';

test('Tab brings a tool above the viewport into view', async () => {
  const { app } = fake({ items: [tool('alpha'), lines('reply', 40)] });

  const ui = show(
    createElement(App, { coordinator: app, onExit() {} }),
    80,
    16,
  );

  try {
    await until('the reply end', () => ui.text().includes('reply line 39'));
    assert.doesNotMatch(ui.text(), /\+ ✓ alpha tool/);
    ui.stdin.write(TAB);
    await until('the focused tool', () => /\+ ✓ alpha tool/.test(ui.text()));
  } finally {
    ui.unmount();
  }
});

test('Tab keeps a tool on the last transcript row in view once the hints take a row', async () => {
  const { app } = fake({
    items: [lines('before', 30), tool('alpha'), lines('after', 30)],
  });

  const ui = show(
    createElement(App, { coordinator: app, onExit() {} }),
    80,
    16,
  );

  const marker = /\+ ✓ alpha tool/;

  try {
    await until('the reply end', () => ui.text().includes('after line 29'));
    ui.stdin.write(PAGE_UP.repeat(20));
    await until('the top', () => ui.text().includes('before line 0'));

    // a read-earlier view keeps its top, so the tool sits on its last row
    for (let step = 0; step < 40 && !marker.test(ui.text()); step++) {
      ui.stdin.write(wheelDown);
      await delay(20);
    }

    assert.match(ui.text(), marker);
    ui.stdin.write(TAB);
    await until('the tool hints', () => ui.text().includes('ESC LEAVE TOOLS'));
    await delay(60);
    assert.match(ui.text(), marker);
  } finally {
    ui.unmount();
  }
});
