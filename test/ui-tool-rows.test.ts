import assert from 'node:assert/strict';
import { createElement } from 'react';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import type { DisplayItem } from '../src/core/state.js';
import { App } from '../src/ui/app.js';
import { fake, show, DOWN } from './fixtures/ui.js';
import { until } from './fixtures/within.js';

const tool = (id: string): DisplayItem => ({
  id,
  kind: 'tool',
  title: `${id} tool`,
  text: `${id} output`,
  cwd: '/work',
  done: true,
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
