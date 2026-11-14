import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { test } from 'vitest';
import { applyDisplayUpdate } from '../src/core/state.js';
import type { DisplayItem } from '../src/core/state.js';
import { App } from '../src/ui/app.js';
import { approval, ENTER, fake, left, show } from './fixtures/ui.js';
import { until } from './fixtures/within.js';

const call = (name: string, done = false): DisplayItem => ({
  id: `turn/a/${name}`,
  kind: 'tool',
  title: name,
  text: '',
  cwd: '/work',
  done,
});
const lines = (ui: ReturnType<typeof show>) => ui.text().split('\n');
const windowTop = (ui: ReturnType<typeof show>) =>
  lines(ui).findIndex((line) => line.trimStart().startsWith('TOOLS'));
const windowText = (ui: ReturnType<typeof show>) =>
  lines(ui)
    .slice(windowTop(ui), windowTop(ui) + 4)
    .join('\n');
const composerRow = (ui: ReturnType<typeof show>) =>
  lines(ui).findIndex((line) => line.trimStart().startsWith('┏'));
const reading: DisplayItem = {
  id: 'reading',
  kind: 'assistant',
  cwd: '/work',
  text: Array.from({ length: 160 }, (_, i) => `source line ${i + 1}`).join(
    '\n',
  ),
};

for (const [columns, rows] of [
  [30, 24],
  [100, 40],
  [140, 40],
]) {
  test(`the command window holds its four rows with zero, one and many calls at ${columns} by ${rows}`, async () => {
    const { app, coordinator } = fake({ phase: 'running' });
    const ui = show(
      createElement(App, { coordinator: app, onExit() {} }),
      columns,
      rows,
    );
    try {
      await until('empty window', () =>
        windowText(ui).includes('No recent tools'),
      );
      const top = windowTop(ui),
        composer = composerRow(ui);
      for (const count of [1, 6, 0]) {
        coordinator.publish({
          items: Array.from({ length: count }, (_, i) =>
            call(`command ${i + 1}`),
          ),
        });
        await until('updated window', () =>
          count
            ? windowText(ui).includes(`${count} RUNNING`)
            : windowText(ui).includes('No recent tools'),
        );
        assert.equal(windowTop(ui), top);
        assert.equal(composerRow(ui), composer);
        assert.equal(lines(ui).length, rows);
        assert.match(lines(ui)[top + 4]!, /[A-Z]+ \| \d+S/);
        if (count === 6) {
          assert.match(windowText(ui), /3 OLDER/);
          assert.match(lines(ui)[top + 1]!, /command 4/);
          assert.match(lines(ui)[top + 3]!, /command 6/);
        }
      }
    } finally {
      ui.unmount();
    }
  });
}

test('instant completion keeps its title through idle, context clear and newer calls, without expanding the transcript', async () => {
  const { app, coordinator } = fake({ phase: 'running' });
  const ui = show(createElement(App, { coordinator: app, onExit() {} }));
  const publish = (item: DisplayItem) =>
    coordinator.publish({
      items: applyDisplayUpdate(coordinator.snapshot.items, item),
    });
  try {
    await until('empty window', () =>
      windowText(ui).includes('No recent tools'),
    );
    publish(call('quick'));
    publish({ ...call('quick', true), title: '', text: 'hidden output' });
    publish(call('second', true));
    await until('completed quick call', () =>
      windowText(ui).includes('✓ quick'),
    );
    assert.match(ui.text(), /\+ ✓ 2 tools/);
    assert.ok(!ui.text().includes('hidden output'));
    coordinator.publish({ phase: 'idle' });
    await until('idle', () => ui.text().startsWith('IDLE'));
    assert.match(windowText(ui), /✓ quick/);
    publish({
      id: 'clear',
      kind: 'notice',
      text: 'Context cleared.',
      contextCleared: true,
      cwd: '/work',
    });
    coordinator.publish({ phase: 'running' });
    publish(call('third', true));
    await until('third call', () => windowText(ui).includes('✓ third'));
    assert.match(windowText(ui), /✓ quick/);
    publish(call('fourth', true));
    await until('fourth call', () => windowText(ui).includes('✓ fourth'));
    assert.ok(!windowText(ui).includes('quick'));
    assert.match(windowText(ui), /second[\s\S]*third[\s\S]*fourth/);
    coordinator.publish({
      conversation: { ...coordinator.snapshot.conversation!, id: 'other' },
      items: [call('destination', true)],
    });
    await until('destination', () => windowText(ui).includes('destination'));
    assert.ok(!windowText(ui).includes('fourth'));
    coordinator.publish({
      conversation: { ...coordinator.snapshot.conversation!, id: 'new' },
      items: [],
    });
    await until('new conversation', () =>
      windowText(ui).includes('No recent tools'),
    );
  } finally {
    ui.unmount();
  }
});

test('the window excludes lifecycle and user shell rows and sanitizes long failed titles without rendering output', async () => {
  const title =
    'failed\ncommand\t' +
    '\u001b]8;;https://forged.test\u0007' +
    'x'.repeat(100);
  const { app, coordinator } = fake({
    items: [
      {
        ...call('failure', true),
        title,
        failed: true,
        text: 'output secret\n'.repeat(1000),
      },
      { ...call('user shell', true), shell: true },
      { ...call('familiar', true), id: 'familiar-uuid' },
      { ...call('brew', true), id: 'brew-uuid' },
    ],
  });
  const ui = show(
    createElement(App, { coordinator: app, onExit() {} }),
    30,
    24,
  );
  try {
    await until('failed call', () =>
      windowText(ui).includes('✗ failed command'),
    );
    const top = windowTop(ui);
    assert.ok(!windowText(ui).includes('output secret'));
    assert.ok(!/user shell|familiar|brew|forged/.test(windowText(ui)));
    assert.equal(lines(ui).length, 24);
    assert.equal(lines(ui)[top + 2]!.trim(), '');
    coordinator.publish({
      items: [...coordinator.snapshot.items, call('latest', true)],
    });
    await until('latest call', () => windowText(ui).includes('✓ latest'));
    assert.equal(windowTop(ui), top);
  } finally {
    ui.unmount();
  }
});

test('grouping tools above a reading anchor and the first new-message button leave the window, draft and source line fixed', async () => {
  const before = call('before', true),
    pending = call('pending');
  const { app, coordinator } = fake({
    phase: 'running',
    items: [before, pending, reading],
  });
  const ui = show(createElement(App, { coordinator: app, onExit() {} }));
  try {
    await until('last source line', () =>
      ui.text().includes('source line 160'),
    );
    ui.stdin.write('keep this draft');
    ui.stdin.write('\u001b[5~\u001b[5~');
    await until('reading earlier', () =>
      ui.text().includes('READING EARLIER OUTPUT'),
    );
    const source = lines(ui)[1],
      top = windowTop(ui),
      composer = composerRow(ui);
    assert.match(source!, /source line \d+/);
    coordinator.publish({
      items: [before, { ...pending, done: true }, reading],
    });
    await until('new-message button', () =>
      ui.text().includes('↓ New messages'),
    );
    assert.equal(lines(ui)[1], source);
    assert.equal(windowTop(ui), top);
    assert.equal(composerRow(ui), composer);
    coordinator.publish({
      items: [...coordinator.snapshot.items, call('instant', true)],
    });
    await until('instant call', () => windowText(ui).includes('✓ instant'));
    assert.equal(lines(ui)[1], source);
    assert.equal(windowTop(ui), top);
    assert.equal(composerRow(ui), composer);
    assert.match(ui.text(), /keep this draft/);
  } finally {
    ui.unmount();
  }
});

test('shrinking hides interactive UI, preserves the draft and reading anchor, and keeps Ctrl+C interrupt available', async () => {
  const { app, coordinator, calls } = fake({
    phase: 'running',
    items: [reading],
  });
  let exits = 0;
  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit() {
        exits++;
      },
    }),
    100,
    40,
  );
  try {
    await until('reading', () => ui.text().includes('source line 160'));
    ui.stdin.write('retained draft');
    ui.stdin.write('\u001b[5~');
    await until('reading earlier', () =>
      ui.text().includes('READING EARLIER OUTPUT'),
    );
    const source = lines(ui)[1];
    for (const [columns, rows] of [
      [30, 23],
      [29, 24],
    ]) {
      ui.resize(columns!, rows!);
      await until('resize message', () =>
        ui.text().includes('Resize terminal'),
      );
      assert.equal(lines(ui).length, rows);
      ui.stdin.write(
        `unseen${ENTER}\t${ENTER}\u001b[5~${left('press', 2, 2)}${left('release', 2, 2)}`,
      );
      await delay(60);
      assert.deepEqual(calls, []);
      ui.stdin.write('\u0003');
      await until('interrupt', () => calls.length === 1);
      assert.deepEqual(calls.splice(0), [['interrupt']]);
      ui.resize(100, 40);
      await until('draft restored', () => ui.text().includes('retained draft'));
      assert.equal(lines(ui)[1], source);
      assert.ok(!ui.text().includes('unseen'));
    }
    coordinator.publish({ phase: 'idle' });
    await until('idle', () => ui.text().startsWith('IDLE'));
    ui.resize(30, 23);
    await until('small idle', () => ui.text().includes('Resize terminal'));
    ui.stdin.write('\u0003\u0003');
    await until('exit', () => exits === 1);
  } finally {
    ui.unmount();
  }
});

test('undersized approval and ready recovery views accept no hidden decisions', async () => {
  const { app, coordinator, calls } = fake({
    requests: [
      {
        ...approval,
        detail: Array.from(
          { length: 100 },
          (_, i) => `approval line ${i}`,
        ).join('\n'),
      },
    ],
  });
  const ui = show(
    createElement(App, { coordinator: app, onExit() {} }),
    100,
    40,
  );
  try {
    await delay(550);
    ui.stdin.write('\u001b[B\u001b[6~');
    await until('decline selected', () => ui.text().includes('› Decline'));
    const firstDetail = lines(ui).find((line) =>
      line.includes('approval line'),
    );
    ui.resize(30, 23);
    await until('hidden approval', () => ui.text().includes('Resize terminal'));
    ui.stdin.write(`y${ENTER}\u001b[6~\u001b[<65;5;5M`);
    await delay(60);
    assert.deepEqual(calls, []);
    ui.resize(100, 40);
    await until('decline retained', () => ui.text().includes('› Decline'));
    assert.equal(
      lines(ui).find((line) => line.includes('approval line')),
      firstDetail,
    );
    await delay(550);
    ui.stdin.write(ENTER);
    await until('declined after restore', () => calls.length === 1);
    assert.deepEqual(calls.splice(0), [
      ['respond', 'r1', { decision: 'decline' }],
    ]);
    coordinator.publish({
      requests: [],
      phase: 'recovery',
      recovery: { kind: 'pending', paths: [], diff: '', root: '/work' },
    });
    await until('ready recovery', () =>
      ui.text().includes('Unfinished memory changes'),
    );
    await delay(550);
    ui.resize(30, 23);
    await until('hidden recovery', () => ui.text().includes('Resize terminal'));
    ui.stdin.write('adk');
    await delay(60);
    assert.deepEqual(calls, []);
    ui.resize(100, 40);
    await until('restored recovery', () =>
      ui.text().includes('Unfinished memory changes'),
    );
    ui.stdin.write('a');
    await until('accepted recovery', () => calls.length === 1);
    assert.deepEqual(calls, [['recoverMemory', 'accept']]);
  } finally {
    ui.unmount();
  }
});

test('wrapped tool hints and completions preserve the composer, reading line and live funding at minimum size', async () => {
  const { app, coordinator } = fake({
    phase: 'running',
    pendingCompaction: true,
    items: [reading, call('current')],
    error: 'A long error which occupies several terminal rows. '.repeat(20),
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
    30,
    24,
  );
  const intact = (draft: string) => {
    assert.equal(lines(ui).length, 24);
    const composer = composerRow(ui);
    assert.ok(lines(ui)[composer + 1]!.trim().startsWith(`┃ ${draft}`));
    assert.match(lines(ui)[composer + 2]!, /┗━+┛/);
    assert.match(
      ui.text(),
      /extra off: USD 651 minor\s+units spent \/ USD 10000\s+minor units cap/,
    );
    assert.match(ui.text(), /Pending: \/compact/);
    assert.match(ui.text(), /[A-Z]+ \| \d+S/);
    assert.match(windowText(ui), /current/);
    assert.match(ui.text(), /source line \d+/);
  };
  try {
    await until('minimum window', () => windowText(ui).includes('current'));
    ui.stdin.write('\u001b[5~');
    ui.stdin.write('draft');
    await until(
      'reading line and draft',
      () => ui.text().includes('source line') && ui.text().includes('┃ draft'),
    );
    coordinator.publish({
      items: [...coordinator.snapshot.items, call('finished', true)],
    });
    await until('new messages', () => ui.text().includes('↓ New messages'));
    intact('draft');
    ui.stdin.write('\t');
    await until('wrapped tool hints', () =>
      ui.text().includes('ESC LEAVE TOOLS'),
    );
    intact('draft');
    ui.stdin.write('\t');
    await until('composer focus', () => !ui.text().includes('ESC LEAVE TOOLS'));
    ui.stdin.write('\u007f'.repeat(5) + '/');
    await until('first completion', () => ui.text().includes('/new'));
    intact('/');
    ui.stdin.write('\u001b[B');
    await until('next completion', () => ui.text().includes('/sessions'));
    intact('/');
  } finally {
    ui.unmount();
  }
});

test('a picker keeps its filter through an undersized window without accepting hidden keys', async () => {
  const { app, calls } = fake({});
  const ui = show(createElement(App, { coordinator: app, onExit() {} }));
  try {
    await until('chat', () => windowText(ui).includes('No recent tools'));
    ui.stdin.write('\u0010');
    await until('picker', () => ui.text().includes('Commands'));
    ui.stdin.write('memory');
    await until('filter', () =>
      lines(ui).some((line) => line.trim() === 'memory'),
    );
    ui.resize(100, 23);
    await until('hidden picker', () => ui.text().includes('Resize terminal'));
    ui.stdin.write(`wrong${ENTER}`);
    await delay(60);
    ui.resize(100, 40);
    await until('filter restored', () =>
      lines(ui).some((line) => line.trim() === 'memory'),
    );
    assert.match(ui.text(), /Browse shared memory/);
    assert.ok(!ui.text().includes('New conversation'));
    assert.ok(!ui.text().includes('wrong'));
    assert.deepEqual(calls, []);
  } finally {
    ui.unmount();
  }
});

test('a partly answered request retains its answers and current input while undersized', async () => {
  const { app, calls } = fake({
    requests: [
      {
        id: 'questions',
        kind: 'question',
        title: 'Two questions',
        detail: '',
        questions: [
          { id: 'first', title: 'First?', options: ['one'] },
          { id: 'second', title: 'Second?', options: ['two'] },
        ],
      },
    ],
  });
  const ui = show(createElement(App, { coordinator: app, onExit() {} }));
  try {
    await delay(550);
    ui.stdin.write('first answer' + ENTER);
    await until('second question', () => ui.text().includes('Question 2/2'));
    ui.stdin.write('second answer');
    await until('draft answer', () => ui.text().includes('second answer'));
    ui.resize(100, 23);
    await until('hidden question', () => ui.text().includes('Resize terminal'));
    ui.stdin.write('wrong' + ENTER);
    await delay(60);
    assert.deepEqual(calls, []);
    ui.resize(100, 40);
    await until('question restored', () => ui.text().includes('Question 2/2'));
    assert.match(ui.text(), /second answer/);
    assert.ok(!ui.text().includes('wrong'));
    await delay(550);
    ui.stdin.write(ENTER);
    await until('answers submitted', () => calls.length === 1);
    assert.deepEqual(calls, [
      [
        'respond',
        'questions',
        {
          decision: 'accept',
          answers: { first: ['first answer'], second: ['second answer'] },
        },
      ],
    ]);
  } finally {
    ui.unmount();
  }
});
