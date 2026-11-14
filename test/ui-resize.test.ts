import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { applyDisplayUpdate } from '../src/core/state.js';
import { App } from '../src/ui/app.js';
import { fake, show } from './fixtures/ui.js';
import { until } from './fixtures/within.js';

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
