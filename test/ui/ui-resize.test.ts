import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import stringWidth from 'string-width';
import type { FileDiff, UserRequest } from '../../src/agents/types.js';
import { applyDisplayUpdate } from '../../src/core/state.js';
import { App } from '../../src/ui/App.js';
import {
  ENTER,
  LEFT,
  approval,
  fake,
  openCommand,
  show,
} from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';
import { wheelUp } from '../fixtures/ui-transcript.js';

for (const [columns, rows, visibleDraft] of [
  [100, 23, 'helloZ'],
  [29, 24, 'helloZ'],
  [30, 12, 'helloZ'],
  [20, 8, 'helloZ'],
  [8, 4, 'helloZ'],
  [1, 1, 'Z'],
  [1, 40, 'Z'],
  [4, 40, 'oZ'],
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
      ui.stdin.write('helloZ' + LEFT);

      await until('visible draft row', () =>
        ui
          .text()
          .split('\n')
          .some((line) => line.replaceAll('┃', '').trim() === visibleDraft),
      );

      const frame = ui.text().split('\n');
      assert.equal(frame.length, rows);
      assert.ok(frame.every((line) => stringWidth(line) <= columns));
      assert.doesNotMatch(ui.text(), /Resize terminal/);
      ui.stdin.write(ENTER);
      await until('submitted text', () => calls.length > 0);
      assert.deepEqual(calls, [['send', 'helloZ', { composer: true }]]);
      ui.resize(100, 40);
      await until('restored composer', () => ui.text().includes('┏'));
    } finally {
      ui.unmount();
    }
  });
}

for (const [columns, draft] of [
  [5, '界'],
  [7, '界'],
  [3, '!界'],
] as const) {
  test(`wide input stays visible at ${columns} columns`, async () => {
    const { app, calls } = fake({});

    const ui = show(
      createElement(App, { coordinator: app, onExit() {} }),
      columns,
      8,
    );

    try {
      await until('rendered app', () => ui.frame().length > 0);
      ui.stdin.write(draft + LEFT);
      await until('visible wide character', () => ui.text().includes('界'));

      assert.ok(
        ui
          .text()
          .split('\n')
          .every((line) => stringWidth(line) <= columns),
      );

      ui.stdin.write(ENTER);
      await until('submitted draft', () => calls.length > 0);
      assert.deepEqual(calls, [['send', draft, { composer: true }]]);
    } finally {
      ui.unmount();
    }
  });
}

for (const [columns, rows, visibleDraft] of [
  [20, 8, 'visibleZ'],
  [1, 40, 'Z'],
] as const) {
  test(`funding and errors cannot hide the composer at ${columns} by ${rows}`, async () => {
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

    const ui = show(
      createElement(App, { coordinator: app, onExit() {} }),
      columns,
      rows,
    );

    try {
      ui.stdin.write('visibleZ' + LEFT);

      await until(
        'visible draft row',
        () =>
          ui.text().split('\n')[rows - 2]?.replaceAll('┃', '').trim() ===
          visibleDraft,
      );

      assert.equal(ui.text().split('\n').length, rows);
      ui.stdin.write(ENTER);
      await until('submitted text', () => calls.length > 0);
      assert.deepEqual(calls, [['send', 'visibleZ', { composer: true }]]);
      ui.resize(100, 40);

      await until('full balance restored', () =>
        ui.text().includes('USD 10000 minor units cap'),
      );

      assert.match(ui.text(), /USD 651 minor units spent/);
    } finally {
      ui.unmount();
    }
  });
}

for (const [columns, rows] of [
  [22, 17],
  [28, 16],
] as const) {
  test(`the tiny footer leaves both draft rows visible at ${columns} columns`, async () => {
    const now = Date.now();

    const limits = [
      { window: '5H', percent: 45, observedAt: now },
      { window: '7D', percent: 80, observedAt: now },
    ];

    const { app, calls } = fake({
      native: {
        id: 's',
        agent: 'a',
        model: 'claude-fable-5-2',
        permissionMode: 'on-request',
        hasHistory: false,
      },
      accounts: {
        a: {
          limits,
          funding: {
            kind: 'extra-usage',
            enabled: false,
            used: 651,
            limit: 10000,
            currency: 'USD',
            decimalPlaces: 2,
            observedAt: now,
          },
        },
        b: { limits },
      },
      items: [
        {
          id: 'reply',
          kind: 'assistant',
          cwd: '/work',
          text: Array.from({ length: 10 }, (_, i) => `transcript ${i}`).join(
            '\n',
          ),
        },
      ],
    });

    const ui = show(
      createElement(App, { coordinator: app, onExit() {} }),
      columns,
      rows,
    );

    try {
      ui.stdin.write('draft line one\ndraft line two' + LEFT);

      await until(
        'draft and delegation pointer',
        () =>
          ui.text().includes('draft line one') &&
          ui.text().includes('/delegation'),
      );

      const frame = ui.text().split('\n');
      assert.equal(frame.length, rows);
      assert.ok(frame.every((line) => stringWidth(line) <= columns));
      assert.match(ui.text(), /draft line two/);
      assert.match(ui.text(), /transcript 9/);

      assert.match(
        frame.map((line) => line.trim()).join(' '),
        /extra off: USD 6\.51 spent \/ USD 100\.00 cap Details: \/delegation/,
      );

      ui.stdin.write(ENTER);
      await until('submitted multiline draft', () => calls.length > 0);

      assert.deepEqual(calls, [
        ['send', 'draft line one\ndraft line two', { composer: true }],
      ]);
    } finally {
      ui.unmount();
    }
  });
}

for (const [mode, expected] of [
  ['approval', 'reading 28'],
  ['recovery', 'reading 33'],
  ['diff', 'reading 27'],
] as const) {
  test(`${mode} preserves its source line across width changes`, async () => {
    const detail = Array.from(
      { length: 90 },
      (_, i) => `reading ${i + 1}: description that wraps in a narrow window`,
    ).join('\n');

    const request: UserRequest = { ...approval, detail };

    if (mode === 'diff') {
      request.detail = '';

      request.diff = [
        {
          kind: 'update',
          path: '/work/a.ts',
          hunks: [
            {
              oldStart: 1,
              newStart: 1,
              lines: detail.split('\n').map((line) => `+${line}`),
            },
          ],
        },
      ];
    }

    const { app, calls } = fake(
      mode === 'recovery'
        ? {
            phase: 'recovery',
            recovery: { kind: 'pending', paths: [], root: '/m', diff: detail },
          }
        : { requests: [request] },
    );

    const ui = show(createElement(App, { coordinator: app, onExit() {} }));
    const first = () => ui.text().match(/reading \d+/)?.[0];

    try {
      await until('first source line', () => first() === 'reading 1');
      ui.stdin.write('\u001b[6~');
      await until('next page', () => first() === expected);

      for (const width of [20, 100]) {
        ui.resize(width, 40);

        await until(
          'rewrapped content',
          () =>
            ui.text().includes('description that wraps in a narrow window') ===
            (width === 100),
        );

        assert.equal(first(), expected);
      }

      assert.deepEqual(calls, []);
    } finally {
      ui.unmount();
    }
  });
}

for (const [mode, expected, nextWord] of [
  ['approval', 'word0261', 'word0262'],
  ['transcript', 'word0331', 'word0332'],
] as const) {
  test(`${mode} diff positions ignore gutters and padding inside a wrapped source line`, async () => {
    const code = Array.from(
      { length: 900 },
      (_, index) => `word${String(index + 1).padStart(4, '0')}`,
    ).join(' ');

    const diff: FileDiff[] = [
      {
        path: '/work/a.ts',
        kind: 'add',
        hunks: [{ oldStart: 0, newStart: 1, lines: [`+${code}`] }],
      },
    ];

    const { app } = fake(
      mode === 'approval'
        ? { requests: [{ ...approval, diff }] }
        : {
            items: [
              {
                id: 'edit',
                kind: 'tool',
                title: 'Edit',
                cwd: '/work',
                done: true,
                text: '',
                diff,
              },
            ],
          },
    );

    const ui = show(createElement(App, { coordinator: app, onExit() {} }));
    const firstWord = () => ui.text().match(/word\d{4}/)?.[0];

    try {
      await until('diff content', () =>
        mode === 'approval'
          ? firstWord() === 'word0001'
          : ui.text().includes('word0900'),
      );

      ui.stdin.write(mode === 'approval' ? '\u001b[6~' : '\u001b[5~');
      await until('scrolled source text', () => firstWord() === expected);

      for (const width of [20, 100]) {
        ui.resize(width, 40);

        await until('rewrapped source text', () => {
          const line = ui
            .text()
            .split('\n')
            .find((row) => row.includes(expected));

          return !!line && line.includes(nextWord) === (width === 100);
        });

        assert.equal(firstWord(), expected);
      }
    } finally {
      ui.unmount();
    }
  });
}

for (const covered of [false, true]) {
  test(`a ${covered ? 'covered ' : ''}command page retains its paragraph offset through width changes`, async () => {
    const { app, coordinator } = fake({});
    const ui = show(createElement(App, { coordinator: app, onExit() {} }));
    const first = () => ui.text().split('\n')[2]!.trim();

    try {
      await openCommand(ui, '/help', 'Keyboard help');
      ui.stdin.write('\u001b[6~');

      await until('shell command explanation', () =>
        first().startsWith('sandbox, and the agent'),
      );

      const before = first();

      if (covered) {
        coordinator.publish({ requests: [approval] });

        await until('covering approval', () =>
          ui.text().includes('Approval required'),
        );
      }

      ui.resize(20, 40);

      if (covered) {
        await until('narrow approval', () =>
          ui
            .text()
            .split('\n')
            .every((line) => stringWidth(line) <= 20),
        );

        coordinator.publish({ requests: [] });
      }

      await until('narrow paragraph', () => first() === 'without a sandbox,');

      assert.ok(
        ui
          .text()
          .split('\n')
          .slice(2, 5)
          .join(' ')
          .replace(/\s+/g, ' ')
          .includes(before.slice(0, 20)),
      );

      ui.resize(100, 40);
      await until('restored paragraph offset', () => first() === before);
    } finally {
      ui.unmount();
    }
  });
}

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

    ui.stdin.write(wheelUp.repeat(200));

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
