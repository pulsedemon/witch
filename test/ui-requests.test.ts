import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { App } from '../src/ui/app.js';
import { show, fake, ENTER, DOWN, approval } from './fixtures/ui.js';
import { until } from './fixtures/within.js';

for (const [name, keys, decision] of [
  ['Enter accepts', ENTER, 'accept'],
  ['Down and Enter in one read decline', DOWN + ENTER, 'decline'],
  ['Down, Down and Enter cancel', DOWN + DOWN + ENTER, 'cancel'],
  ['n declines', 'n', 'decline'],
] as const)
  await test(`${name} an approval`, async () => {
    const { app, calls } = fake({ phase: 'running', requests: [approval] });
    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
    try {
      await delay(600);
      ui.stdin.write(keys);
      await until('the response', () => calls.length > 0);
      assert.deepEqual(calls, [['respond', 'r1', { decision }]]);
    } finally {
      ui.unmount();
    }
  });

await test('two questions answered in one read each get their own option', async () => {
  const { app, calls } = fake({
    phase: 'running',
    requests: [
      {
        id: 'q',
        kind: 'question',
        title: 'Questions',
        detail: '',
        questions: [
          { id: 'first', title: 'First?', options: ['a1', 'b1'] },
          { id: 'second', title: 'Second?', options: ['a2', 'b2'] },
        ],
      },
    ],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(600);
    ui.stdin.write(`1${ENTER}${DOWN}${ENTER}`);
    await until('the response', () => calls.length > 0);
    assert.deepEqual(calls, [
      [
        'respond',
        'q',
        { decision: 'accept', answers: { first: ['a1'], second: ['b2'] } },
      ],
    ]);
  } finally {
    ui.unmount();
  }
});

for (const [columns, body] of [
  [100, 98],
  [120, 83],
] as const)
  await test(`a request wraps at the body width at ${columns} columns`, async () => {
    const { app } = fake({
      phase: 'running',
      requests: [{ ...approval, detail: 'x'.repeat(body + 5) }],
    });
    const ui = show(
      createElement(App, { coordinator: app, onExit: () => {} }),
      columns,
    );
    try {
      await until('the request', () => ui.text().includes('Approval required'));
      assert.ok(ui.text().includes('x'.repeat(body)), ui.text());
      // the rest makes a row of 5, where Ink would re-wrap a wider wrap into rows of 2 and 3
      assert.match(ui.text(), /(?<!x)x{5}(?!x)/);
    } finally {
      ui.unmount();
    }
  });

await test('a new request ignores keys for its first 500 ms', async () => {
  const { app, coordinator, calls } = fake({
    phase: 'running',
    requests: [approval],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await until('the request', () => ui.text().includes('Approval required'));
    // a key in the instant the request appears beats even a 0 ms guard
    await delay(150);
    ui.stdin.write('y');
    ui.stdin.write('\u001b');
    await delay(100);
    assert.deepEqual(calls, []);
    await delay(500);
    ui.stdin.write('y');
    await until('the accept', () => calls.length > 0);
    coordinator.publish({
      requests: [{ ...approval, id: 'r2', title: 'rm -rf dist' }],
    });
    await until('the next request', () => ui.text().includes('rm -rf dist'));
    await delay(150);
    ui.stdin.write('y');
    await delay(100);
    assert.deepEqual(calls, [['respond', 'r1', { decision: 'accept' }]]);
  } finally {
    ui.unmount();
  }
  const question = fake({
    phase: 'running',
    requests: [
      {
        id: 'q',
        kind: 'question',
        title: 'Question',
        detail: '',
        questions: [{ id: 'one', title: 'Pick?', options: ['only'] }],
      },
    ],
  });
  const asked = show(
    createElement(App, { coordinator: question.app, onExit: () => {} }),
  );
  try {
    await until('the question', () => asked.text().includes('Pick?'));
    await delay(150);
    asked.stdin.write(ENTER);
    await delay(100);
    assert.deepEqual(question.calls, []);
  } finally {
    asked.unmount();
  }
});

await test('a new request scrolls with PageDown before its other keys work', async () => {
  const { app, calls } = fake({
    phase: 'running',
    requests: [
      {
        ...approval,
        detail: Array.from({ length: 200 }, (_, n) => `d${n + 1}`).join('\n'),
      },
    ],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  const rows = () =>
    ui
      .text()
      .split('\n')
      .map((row) => row.trim());
  try {
    await until('the request', () => ui.text().includes('Approval required'));
    await delay(150);
    ui.stdin.write('\u001b[6~y');
    // one 30-row page down from the top, as in the page key test above
    await until('the page down', () => {
      const all = rows();
      return all[all.indexOf('Approval required') + 1] === 'd28';
    });
    assert.deepEqual(calls, []);
  } finally {
    ui.unmount();
  }
});

await test('Escape declines a question and the turn continues', async () => {
  const { app, calls } = fake({
    phase: 'running',
    requests: [
      {
        id: 'q',
        kind: 'question',
        title: 'Question',
        detail: '',
        questions: [{ id: 'one', title: 'Pick?', options: ['only'] }],
      },
    ],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(600);
    ui.stdin.write('\u001b');
    await until('the decline', () => calls.length > 0);
    assert.deepEqual(calls, [['respond', 'q', { decision: 'decline' }]]);
  } finally {
    ui.unmount();
  }
});
