import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { App } from '../src/ui/app.js';
import type { UserRequest } from '../src/agents/types.js';
import { show, fake, ENTER, DOWN, approval } from './fixtures/ui.js';
import { until } from './fixtures/within.js';

const fileApproval = (id: string, title: string): UserRequest => ({
  ...approval,
  id,
  title,
  detail: 'reason: review this change\ngrant_root: /work',
  diff: [
    {
      path: '/work/new.txt',
      kind: 'add',
      hunks: [
        {
          oldStart: 0,
          newStart: 1,
          lines: Array.from({ length: 45 }, (_, i) => `+${title}_${i + 1}`),
        },
      ],
    },
  ],
});

await test('approval diffs scroll and expand without responding', async () => {
  const request = fileApproval('file-approval', 'proposal');
  request.diff!.unshift({
    path: '/work/old.txt',
    kind: 'update',
    hunks: [
      { oldStart: 2, newStart: 2, lines: ['-removed marker', '+added marker'] },
    ],
  });
  const { app, calls } = fake({ phase: 'running', requests: [request] });
  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    120,
    30,
  );
  try {
    await until('the proposal', () => ui.text().includes('2 +added marker'));
    assert.match(ui.text(), /2 -removed marker/);
    assert.ok(ui.frame().includes('\u001b[48;2;34;92;43m'));
    assert.ok(ui.frame().includes('\u001b[48;2;122;41;54m'));
    ui.stdin.write('\u001b[111;5u');
    await until('full mode', () => ui.text().includes('CTRL+O SHOW PREVIEW'));
    ui.stdin.write('\u001b[<65;1;1M');
    ui.stdin.write('\u001b[6~'.repeat(4));
    await until('last supplied line', () =>
      ui.text().includes('45 +proposal_45'),
    );
    assert.match(ui.text(), /reason: review this change/);
    assert.match(ui.text(), /grant_root: \/work/);
    assert.match(ui.text(), /Allow once.*Decline.*Cancel turn/);
    ui.resize(80);
    await delay(60);
    assert.match(ui.text(), /45 \+proposal_45/);
    assert.deepEqual(calls, []);
    ui.stdin.write('\u001b[111;5u');
    await until(
      'preview at the top',
      () =>
        ui.text().includes('2 +added marker') &&
        ui.text().includes('CTRL+O SHOW ALL LINES'),
    );
    assert.doesNotMatch(ui.text(), /proposal_45/);
    await delay(600);
    ui.stdin.write(DOWN + ENTER);
    await until('decline', () => calls.length > 0);
    assert.deepEqual(calls, [
      ['respond', 'file-approval', { decision: 'decline' }],
    ]);
  } finally {
    ui.unmount();
  }
});

await test('file approval expansion resets for the next request', async () => {
  const { app, coordinator, calls } = fake({
    phase: 'running',
    requests: [fileApproval('first', 'first')],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await until('first preview', () => ui.text().includes('first_10'));
    ui.stdin.write('\u001b[111;5u');
    await until('first full mode', () =>
      ui.text().includes('CTRL+O SHOW PREVIEW'),
    );
    ui.stdin.write('\u001b[6~'.repeat(3));
    await until('first final line', () => ui.text().includes('45 +first_45'));
    coordinator.publish({ requests: [fileApproval('second', 'second')] });
    await until(
      'second preview',
      () =>
        ui.text().includes('second_10') &&
        ui.text().includes('CTRL+O SHOW ALL LINES'),
    );
    ui.stdin.write('y');
    await delay(60);
    assert.deepEqual(calls, []);
    assert.doesNotMatch(ui.text(), /first_45|second_11|second_45/);
  } finally {
    ui.unmount();
  }
});

await test('modified approval letters do not answer', async () => {
  const { app, calls } = fake({ phase: 'running', requests: [approval] });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(600);
    ui.stdin.write('\u001b[121;5u\u001b[110;3u\u001b[121;9u');
    await delay(60);
    assert.deepEqual(calls, []);
    ui.stdin.write('y');
    await until('plain approval', () => calls.length > 0);
    assert.deepEqual(calls, [['respond', 'r1', { decision: 'accept' }]]);
  } finally {
    ui.unmount();
  }
});

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
