import assert from 'node:assert/strict';
import { createElement } from 'react';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import type { DisplayItem } from '../../src/core/state.js';
import { App } from '../../src/ui/App.js';
import { fake, left, show, DOWN, ENTER, UP } from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';

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
