import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import stringWidth from 'string-width';
import { applyDisplayUpdate } from '../../src/core/state.js';
import { App } from '../../src/ui/App.js';
import { ENTER, LEFT, fake, show } from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';

for (const [columns, rows] of [
  [100, 23],
  [29, 24],
  [30, 12],
  [20, 8],
  [8, 4],
  [1, 1],
  [1, 40],
  [4, 40],
] as const) {
  test(`the composer stays editable inside ${columns} by ${rows}`, async () => {
    const { app, calls } = fake({
      phase: 'running',
      pendingCompaction: true,
      queue: ['queued prompt'],
    });

    const ui = show(
      createElement(App, { coordinator: app, onExit() {} }),
      columns,
      rows,
    );

    try {
      await until('rendered app', () => ui.frame().length > 0);

      ui.stdin.write('hello' + LEFT);

      await until('visible cursor character', () => ui.text().includes('o'));

      const frame = ui.text().split('\n');

      assert.equal(frame.length, rows);

      assert.ok(frame.every((line) => stringWidth(line) <= columns));

      assert.doesNotMatch(ui.text(), /Resize terminal/);

      ui.stdin.write(ENTER);

      await until('submitted text', () => calls.length > 0);

      assert.deepEqual(calls, [['send', 'hello', { composer: true }]]);

      ui.resize(100, 40);

      await until('restored composer', () => ui.text().includes('┏'));
    } finally {
      ui.unmount();
    }
  });
}

test('funding and errors cannot push a short terminal composer offscreen', async () => {
  const { app, calls } = fake({
    phase: 'running',
    error: 'long error '.repeat(100),
    accounts: {
      a: {
        limits: [],
        funding: {
          kind: 'extra-usage',
          enabled: false,
          used: 651,
          limit: 10000,
          currency: 'USD',
          decimalPlaces: null,
          observedAt: Date.now(),
        },
      },
    },
  });

  const ui = show(createElement(App, { coordinator: app, onExit() {} }), 20, 8);

  try {
    ui.stdin.write('visible');

    await until('visible draft', () => ui.text().includes('visible'));

    assert.equal(ui.text().split('\n').length, 8);

    ui.stdin.write(ENTER);

    await until('submitted text', () => calls.length > 0);

    assert.deepEqual(calls, [['send', 'visible', { composer: true }]]);

    ui.resize(100, 40);

    await until('full balance restored', () =>
      ui.text().includes('USD 10000 minor units cap'),
    );

    assert.match(ui.text(), /USD 651 minor units spent/);
  } finally {
    ui.unmount();
  }
});

test('the sidebar width transition preserves the reading line and draft', async () => {
  const output = (text: string) => ({
    id: 'reply',
    kind: 'assistant' as const,
    cwd: '/work',
    text,
  });

  let items = applyDisplayUpdate(
    [],
    output(
      Array.from({ length: 150 }, (_, i) => `row ${i + 1} src/main.ts:7`).join(
        '\n',
      ),
    ),
  );

  const { app, coordinator } = fake({ items, phase: 'running' });

  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    114,
    30,
  );

  try {
    await until('the last row', () => ui.text().includes('row 150'));

    ui.stdin.write('draft across a resize');

    await until('the typed draft', () =>
      ui.text().includes('draft across a resize'),
    );

    ui.stdin.write('\u001b[<64;10;10M'.repeat(200));

    await until('the first item', () =>
      ui.text().split('\n')[1]!.includes('Assistant'),
    );

    ui.stdin.write('\u001b[<65;10;10M'.repeat(21));

    await until('the reading marker', () =>
      /^\s*row 21 src\/main.ts:7/.test(ui.text().split('\n')[1]!),
    );

    for (const columns of [115, 114, 120]) {
      const before = ui.frame();

      ui.resize(columns);

      await until('the resized frame', () => ui.frame() !== before);

      assert.match(ui.text().split('\n')[1]!, /^\s*row 21 src\/main.ts:7/);

      assert.ok(ui.text().includes('draft across a resize'));

      assert.ok(ui.frame().includes('vscode://file/work/src/main.ts:7'));
    }

    items = applyDisplayUpdate(items, output('\nnewest src/latest.ts:9'));

    coordinator.publish({ items });

    await delay(100);

    assert.match(ui.text().split('\n')[1]!, /^\s*row 21 src\/main.ts:7/);

    ui.stdin.write('\u001b[6~'.repeat(20));

    await until('the latest output', () =>
      ui.text().includes('newest src/latest.ts:9'),
    );

    assert.ok(ui.frame().includes('vscode://file/work/src/latest.ts:9'));

    assert.ok(ui.text().includes('draft across a resize'));
  } finally {
    ui.unmount();
  }
});
