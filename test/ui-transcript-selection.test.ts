import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { App } from '../src/ui/app.js';
import { ENTER, drag, fake, left, openCommand, show } from './fixtures/ui.js';
import { until } from './fixtures/within.js';
import {
  CMD_C,
  first,
  long,
  mounted,
  wheelUp,
} from './fixtures/ui-transcript.js';

test('a drag over the transcript highlights it and Cmd+C copies it with wrapped rows joined, a click or a resize clears it, and a drag from above the transcript, the composer or the sidebar selects nothing', async () => {
  const words =
    'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi';

  const { app } = fake({
    items: [{ id: 'u', kind: 'user', text: words, cwd: '/work' }],
  });

  const { ui, copied } = mounted(app);

  try {
    // the transcript starts at row 1 and column 1 under the phase row, the message wraps onto rows 2 and 3, and the composer's text is on row 15
    await until('the wrapped message', () => ui.text().includes(' omicron pi'));

    // each write renders before the next, so Cmd+C reads what the mouse left selected
    for (const data of [
      left('press', 1, 2) + left('release', 1, 2),
      left('press', 5, 0),
      left('drag', 5, 2),
      left('release', 5, 2),
      CMD_C,
      left('press', 5, 15),
      left('drag', 5, 2),
      left('release', 5, 2),
      CMD_C,
    ]) {
      ui.stdin.write(data);

      await delay(60);
    }

    assert.deepEqual(copied, []);

    drag(ui, [1, 2], [58, 3]);

    await until('the highlight', () => ui.frame().includes('\u001b[7malpha'));

    ui.stdin.write(CMD_C);

    await until('the copy', () => copied.length > 0);

    assert.deepEqual(copied, [words]);

    ui.stdin.write(left('press', 1, 2) + left('release', 1, 2));

    await until('no highlight', () => !ui.frame().includes('\u001b[7m'));

    ui.stdin.write(CMD_C);

    await delay(60);

    assert.deepEqual(copied, [words]);

    drag(ui, [1, 2], [58, 3]);

    await until('the highlight again', () =>
      ui.frame().includes('\u001b[7malpha'),
    );

    ui.resize(120);

    await until(
      'no highlight once resized',
      () => !ui.frame().includes('\u001b[7m'),
    );

    ui.stdin.write(left('press', 50, 2));

    await delay(60);

    ui.resize(60);

    await until('the narrow layout', () => ui.text().includes(' omicron pi'));

    for (const data of [left('drag', 5, 2), left('release', 5, 2), CMD_C]) {
      ui.stdin.write(data);

      await delay(60);
    }

    assert.ok(!ui.frame().includes('\u001b[7m'));

    assert.deepEqual(copied, [words]);
  } finally {
    ui.unmount();
  }

  // mounted at its width, so the first press runs on a handler measured at it
  const { ui: wide, copied: copiedWide } = mounted(app, 130);

  try {
    // the sidebar takes the 35 columns from 95, and the message fits on row 2
    await until('the message', () => wide.text().includes(' omicron pi'));

    for (const data of [
      left('press', 110, 2),
      left('drag', 5, 2),
      left('release', 5, 2),
      CMD_C,
    ]) {
      wide.stdin.write(data);

      await delay(60);
    }

    assert.deepEqual(copiedWide, []);

    // the title row reads the same at both widths, so only the width drops a selection past its text
    drag(wide, [1, 1], [90, 1]);

    await until('the highlight on the title', () =>
      wide.frame().includes('\u001b[7mYou'),
    );

    wide.resize(60);

    await until('the narrow layout', () =>
      wide.text().includes('\n lambda mu'),
    );

    assert.ok(!wide.frame().includes('\u001b[7m'));
  } finally {
    wide.unmount();
  }
});

test('a drag inside the view leaves it where it is, on its first and last rows too', async () => {
  const { app } = fake({
    items: [long],
  });

  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await until('the transcript', () => first(ui) > 0);

    const bottom = first(ui);

    // scrolled up, so a drag could scroll either way
    ui.stdin.write(wheelUp + wheelUp);

    await until('two rows up', () => first(ui) === bottom - 2);

    const last = ui
      .text()
      .split('\n')
      .findLastIndex((row) => /row \d+/.test(row));

    ui.stdin.write(left('press', 1, 5));

    ui.stdin.write(left('drag', 1, 8));

    ui.stdin.write(left('drag', 1, 1));

    await delay(60);

    assert.equal(first(ui), bottom - 2);

    ui.stdin.write(left('drag', 1, last));

    await delay(60);

    assert.equal(first(ui), bottom - 2);
  } finally {
    ui.unmount();
  }
});

test('copying a wrapped tool title keeps the space its wrap trimmed', async () => {
  const title =
    'echo alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';

  const { app } = fake({
    items: [
      { id: 't', kind: 'tool', title, text: '', cwd: '/work', done: true },
    ],
  });

  const { ui, copied } = mounted(app);

  try {
    // the title starts at row 1 and wraps onto row 2
    await until('the wrapped title', () => ui.text().includes(' lambda'));

    drag(ui, [1, 1], [58, 2]);

    await until('the highlight', () => ui.frame().includes('\u001b[7m'));

    ui.stdin.write(CMD_C);

    await until('the copy', () => copied.length > 0);

    assert.deepEqual(copied, [`+ ✓ ${title}`]);
  } finally {
    ui.unmount();
  }
});

test('copying across a diff joins its rows with line breaks', async () => {
  const { app } = fake({
    items: [
      {
        id: 't',
        kind: 'tool',
        title: 'Edit  ./a.txt',
        text: '',
        cwd: '/work',
        done: true,
        diff: [
          {
            path: '/work/a.txt',
            kind: 'update',
            hunks: [{ oldStart: 1, newStart: 1, lines: [' a', '-b', '+B'] }],
          },
        ],
      },
    ],
  });

  const { ui, copied } = mounted(app);

  try {
    // the title is on row 1 and the diff's header and rows on rows 2 to 5
    await until('the diff', () => ui.text().includes('2 +B'));

    drag(ui, [1, 1], [58, 5]);

    await until('the highlight', () => ui.frame().includes('\u001b[7m'));

    ui.stdin.write(CMD_C);

    await until('the copy', () => copied.length > 0);

    assert.deepEqual(copied, [
      '− ✓ Edit  ./a.txt\nUpdate ./a.txt +1 -1\n1  a\n2 -b\n2 +B',
    ]);
  } finally {
    ui.unmount();
  }
});

test('copying across a wrapped diff line breaks before its continuation', async () => {
  const { app } = fake({
    items: [
      {
        id: 't',
        kind: 'tool',
        title: 'Edit  ./a.txt',
        text: '',
        cwd: '/work',
        done: true,
        diff: [
          {
            path: '/work/a.txt',
            kind: 'update',
            hunks: [
              { oldStart: 1, newStart: 1, lines: [' a', '+' + 'x'.repeat(70)] },
            ],
          },
        ],
      },
    ],
  });

  const { ui, copied } = mounted(app);

  try {
    // the added line's 70 characters wrap at 55, after its number and marker, onto row 5
    await until('the wrapped line', () => ui.text().includes('x'.repeat(15)));

    drag(ui, [1, 1], [58, 5]);

    await until('the highlight', () => ui.frame().includes('\u001b[7m'));

    ui.stdin.write(CMD_C);

    await until('the copy', () => copied.length > 0);

    assert.deepEqual(copied, [
      `− ✓ Edit  ./a.txt\nUpdate ./a.txt +1 -0\n1  a\n2 +${'x'.repeat(55)}\n   ${'x'.repeat(15)}`,
    ]);
  } finally {
    ui.unmount();
  }
});

test('a wrapped title row the wrap changed beyond trimming joins the rows beside it with a space', async () => {
  // the wrap drops the space after the zero-width space, so the title's second row is not found in it
  const title = `${'a'.repeat(53)} \u00a0\u200b ${'b'.repeat(55)} tail`;

  const { app } = fake({
    items: [
      { id: 'u', kind: 'user', text: 'hello', cwd: '/work' },
      { id: 't', kind: 'tool', title, text: '', cwd: '/work', done: true },
    ],
  });

  const { ui, copied } = mounted(app);

  try {
    // the message is on row 2 and the title wraps from row 4 onto rows 5 and 6
    await until('the wrapped title', () => ui.text().includes('tail'));

    drag(ui, [1, 2], [58, 6]);

    await until('the highlight', () => ui.frame().includes('\u001b[7mhello'));

    ui.stdin.write(CMD_C);

    await until('the copy', () => copied.length > 0);

    assert.deepEqual(copied, [
      `hello\n\n+ ✓ ${'a'.repeat(53)} ${'b'.repeat(55)} tail`,
    ]);
  } finally {
    ui.unmount();
  }
});

test('a wrapped title can be scrolled to and selected from its first row', async () => {
  const { app } = fake({
    items: [
      {
        id: 'tool',
        kind: 'tool',
        title: `${'a'.repeat(53)} \u00a0\u200b ${'b'.repeat(55)} tail`,
        text: '',
        cwd: '/work',
        done: true,
      },
      long,
    ],
  });

  const { ui, copied } = mounted(app);

  try {
    await until('the transcript', () => ui.text().includes('row 300'));

    ui.stdin.write(wheelUp.repeat(400));

    await until('the title reached', () => ui.text().includes('tail'));

    assert.equal(ui.text().split('\n')[1]?.trim(), `+ ✓ ${'a'.repeat(53)}`);

    drag(ui, [1, 1], [4, 3]);

    await until('the first title row highlighted', () =>
      ui.frame().includes('\u001b[7m+ ✓ a'),
    );

    ui.stdin.write(CMD_C);

    await until('the copied title', () => copied.length > 0);

    assert.deepEqual(copied, [`+ ✓ ${'a'.repeat(53)} ${'b'.repeat(55)} tail`]);
  } finally {
    ui.unmount();
  }
});

test('a drag past the last transcript row or its right edge selects to the end without wrapping a row', async () => {
  const { app } = fake({
    items: [
      { id: 'u', kind: 'user', text: 'first message', cwd: '/work' },
      { id: 'a', kind: 'assistant', text: 'second reply', cwd: '/work' },
    ],
  });

  const { ui, copied } = mounted(app);

  const rows = () =>
    ui
      .text()
      .split('\n')
      .map((row) => row.trimEnd());

  try {
    // the messages take rows 1 to 6 and the transcript runs on to row 13, between columns 1 and 58
    await until('the reply', () => ui.text().includes('second reply'));

    const before = rows();

    // ending above the reply, so a highlighted row that wrapped would push the reply down
    drag(ui, [1, 2], [59, 4]);

    await until('the highlight', () => ui.frame().includes('\u001b[7mfirst'));

    assert.deepEqual(rows(), before);

    drag(ui, [1, 2], [5, 12]);

    await until('the highlight to the end', () =>
      ui.frame().includes('\u001b[7msecond reply'),
    );

    ui.stdin.write(CMD_C);

    await until('the copy', () => copied.length > 0);

    assert.deepEqual(copied, ['first message\n\nAssistant\nsecond reply\n']);
  } finally {
    ui.unmount();
  }
});

test('a selection that runs past the bottom of the view stays drawn as the wheel scrolls', async () => {
  const { app } = fake({
    items: [long],
  });

  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await until('the transcript', () => first(ui) > 0);

    const bottom = first(ui);

    const last = ui
      .text()
      .split('\n')
      .findLastIndex((row) => /row \d+/.test(row));

    // the view ends with the blank row under the last row of text
    drag(ui, [1, 1], [5, last + 1]);

    await until('the highlight', () => ui.frame().includes('\u001b[7m'));

    ui.stdin.write(wheelUp);

    await until('a row up', () => first(ui) === bottom - 1);

    assert.ok(ui.frame().includes(`\u001b[7mrow ${bottom}`));

    assert.ok(ui.frame().split('\n')[last + 1]!.includes('\u001b[7mrow 300'));
  } finally {
    ui.unmount();
  }
});

test('a selection follows its text as output above it grows, and drops for good when its tool collapses or its item leaves', async () => {
  const items = (first: string) => [
    { id: 'u', kind: 'user' as const, text: first, cwd: '/work' },
    {
      id: 'a',
      kind: 'assistant' as const,
      text: 'selected words',
      cwd: '/work',
    },
    {
      id: 't',
      kind: 'tool' as const,
      title: 'run',
      text: 'line one\nline two\nline three',
      cwd: '/work',
      done: true,
    },
  ];

  const { app, coordinator } = fake({ items: items('first') });
  const { ui, copied } = mounted(app);

  const select = async (
    from: number,
    to: number,
    row: number,
    shown: string,
  ) => {
    drag(ui, [from, row], [to, row]);

    await until(`the highlight on ${shown}`, () =>
      ui.frame().includes(`\u001b[7m${shown}`),
    );
  };

  try {
    // the message's title is on row 1, the reply's text on row 5, and the expanded tool's output on rows 8 to 10
    await until('the reply', () => ui.text().includes('selected words'));

    await select(1, 8, 5, 'selected');

    coordinator.publish({ items: items('first\nsecond\nthird') });

    await until('the taller message', () => ui.text().includes('third'));

    assert.ok(ui.frame().includes('\u001b[7mselected'));

    ui.stdin.write(CMD_C);

    await until('the copy', () => copied.length > 0);

    assert.deepEqual(copied, ['selected']);

    coordinator.publish({ items: items('first') });

    ui.stdin.write(`\t${ENTER}`);

    await until('the expanded tool', () => ui.text().includes('line two'));

    await select(1, 8, 9, 'line two');

    ui.stdin.write(CMD_C);

    await until('the second copy', () => copied.length > 1);

    assert.deepEqual(copied.at(-1), 'line two');

    ui.stdin.write(ENTER);

    await until('the collapsed tool', () => !ui.text().includes('line two'));

    ui.stdin.write(CMD_C);

    await delay(60);

    assert.equal(copied.length, 2);

    ui.stdin.write(ENTER);

    await until('the tool expanded again', () =>
      ui.text().includes('line two'),
    );

    ui.stdin.write(CMD_C);

    await delay(60);

    assert.equal(copied.length, 2);

    // the new transcript starts with a title like the one selected, so only the item drops it
    await select(1, 3, 1, 'You');

    coordinator.publish({
      items: [{ id: 'b', kind: 'user', text: 'first', cwd: '/work' }],
    });

    await until('the new transcript', () => !ui.text().includes('run'));

    assert.ok(!ui.frame().includes('\u001b[7m'));

    ui.stdin.write(CMD_C);

    await delay(60);

    assert.equal(copied.length, 2);
  } finally {
    ui.unmount();
  }
});

test('a selection drops when output arrives under one of its ends', async () => {
  const reply = (text: string) => ({
    items: [{ id: 'a', kind: 'assistant' as const, text, cwd: '/work' }],
  });

  const { app, coordinator } = fake(reply('alpha\nbeta'));
  const { ui, copied } = mounted(app);

  try {
    // the reply's lines are on rows 2 and 3, and the blank row under them is the next line's first
    await until('the reply', () => ui.text().includes('beta'));

    drag(ui, [1, 2], [30, 4]);

    await until('the highlight', () => ui.frame().includes('\u001b[7malpha'));

    coordinator.publish(reply('alpha\nbeta\ngamma'));

    await until('the longer reply', () => ui.text().includes('gamma'));

    assert.ok(!ui.frame().includes('\u001b[7m'));

    ui.stdin.write(CMD_C);

    await delay(60);

    assert.deepEqual(copied, []);

    // pressed on the blank row now under gamma and dragged up, so the next line lands under the press
    drag(ui, [30, 5], [1, 2]);

    await until('the highlight from below', () =>
      ui.frame().includes('\u001b[7malpha'),
    );

    coordinator.publish(reply('alpha\nbeta\ngamma\ndelta'));

    await until('the reply under the press', () => ui.text().includes('delta'));

    assert.ok(!ui.frame().includes('\u001b[7m'));

    ui.stdin.write(CMD_C);

    await delay(60);

    assert.deepEqual(copied, []);
  } finally {
    ui.unmount();
  }
});

test('a drag into the left margin or above a transcript at its top reaches the edge cell or row, and a press under a short transcript selects nothing', async () => {
  const words =
    'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi';

  const { app } = fake({
    items: [{ id: 'u', kind: 'user', text: words, cwd: '/work' }],
  });

  const { ui, copied } = mounted(app);

  try {
    // the title is on row 1, the message wraps onto rows 2 and 3 from column 1, and the blank row under it is row 4
    await until('the wrapped message', () => ui.text().includes(' omicron pi'));

    drag(ui, [5, 2], [0, 3]);

    await until('the highlight', () => ui.frame().includes('\u001b[7ma beta'));

    ui.stdin.write(CMD_C);

    await until('the copy', () => copied.length > 0);

    assert.deepEqual(copied, [
      'a beta gamma delta epsilon zeta eta theta iota kappa l',
    ]);

    drag(ui, [5, 3], [8, 0]);

    await until('the highlight from the title', () =>
      ui.frame().includes('\u001b[7malpha'),
    );

    ui.stdin.write(CMD_C);

    await until('the second copy', () => copied.length > 1);

    assert.equal(
      copied[1],
      '\nalpha beta gamma delta epsilon zeta eta theta iota kappa lambd',
    );

    drag(ui, [5, 8], [8, 2]);

    await delay(60);

    ui.stdin.write(CMD_C);

    await delay(60);

    assert.equal(copied.length, 2);
  } finally {
    ui.unmount();
  }
});

test('a drag back along a row selects from the pointer to the press, one forward from mid-row draws from the press, and a typed c or Cmd+V copies nothing', async () => {
  const { app } = fake({
    items: [{ id: 'u', kind: 'user', text: 'alpha beta gamma', cwd: '/work' }],
  });

  const { ui, copied } = mounted(app);

  try {
    // the message is on row 2, from column 1
    await until('the message', () => ui.text().includes('alpha beta gamma'));

    drag(ui, [11, 2], [1, 2]);

    await until('the highlight', () => ui.frame().includes('\u001b[7malpha'));

    // a typed c and Cmd+V leave the clipboard alone
    ui.stdin.write('c');

    ui.stdin.write('\u001b[118;9u');

    await delay(60);

    assert.deepEqual(copied, []);

    ui.stdin.write(CMD_C);

    await until('the copy', () => copied.length > 0);

    assert.deepEqual(copied, ['alpha beta']);

    drag(ui, [7, 2], [10, 2]);

    await until('the highlight from the press', () =>
      ui.frame().includes('alpha \u001b[7mbeta\u001b[27m'),
    );
  } finally {
    ui.unmount();
  }
});

test('a press or release anywhere ends a drag, so a drag report with no press of its own selects nothing', async () => {
  const { app } = fake({
    items: [{ id: 'u', kind: 'user', text: 'alpha beta gamma', cwd: '/work' }],
  });

  const { ui, copied } = mounted(app);

  try {
    // the message is on row 2, and the composer's text on row 15
    await until('the message', () => ui.text().includes('alpha beta gamma'));

    ui.stdin.write(left('press', 1, 2));

    ui.stdin.write(left('drag', 5, 2));

    await until('the highlight', () => ui.frame().includes('\u001b[7malpha'));

    await openCommand(ui, '/help', '/new  New');

    ui.stdin.write(left('release', 5, 2));

    ui.stdin.write('\u001b');

    await until('the transcript', () => ui.frame().includes('\u001b[7malpha'));

    // Ghostty keeps a Shift+press for itself but reports its motion once Shift lifts
    ui.stdin.write(left('drag', 16, 2));

    await delay(60);

    ui.stdin.write(CMD_C);

    await until('the copy', () => copied.length > 0);

    assert.deepEqual(copied, ['alpha']);

    ui.stdin.write(left('press', 1, 2));

    ui.stdin.write(left('drag', 5, 2));

    drag(ui, [5, 15], [6, 15]);

    await delay(60);

    ui.stdin.write(CMD_C);

    await delay(60);

    assert.deepEqual(copied, ['alpha']);
  } finally {
    ui.unmount();
  }
});

test('a held press whose width changes ends its drag, so the width coming back brings no selection back', async () => {
  const { app } = fake({
    items: [
      {
        id: 'u',
        kind: 'user',
        text: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi',
        cwd: '/work',
      },
    ],
  });

  const { ui, copied } = mounted(app);
  // at 60 columns the message wraps before lambda, and at 120 it does not
  const narrow = () => /^ lambda/m.test(ui.text());

  try {
    await until('the narrow layout', narrow);

    ui.stdin.write(left('press', 1, 2));

    ui.stdin.write(left('drag', 5, 2));

    await until('the highlight', () => ui.frame().includes('\u001b[7malpha'));

    ui.resize(120);

    await until('the wide layout', () => !narrow());

    ui.resize(60);

    await until('the narrow layout again', narrow);

    ui.stdin.write(left('drag', 10, 2));

    ui.stdin.write(left('release', 10, 2));

    await delay(60);

    ui.stdin.write(CMD_C);

    await delay(60);

    assert.ok(!ui.frame().includes('\u001b[7malpha'));

    assert.deepEqual(copied, []);
  } finally {
    ui.unmount();
  }
});

test('a drag and Cmd+C in one read copy what the drag selected, and a click and Cmd+C in one read copy nothing', async () => {
  const { app } = fake({
    items: [{ id: 'u', kind: 'user', text: 'alpha beta gamma', cwd: '/work' }],
  });

  const { ui, copied } = mounted(app);

  try {
    // the message is on row 2, and row 9 is empty transcript
    await until('the message', () => ui.text().includes('alpha beta gamma'));

    ui.stdin.write(
      left('press', 1, 2) + left('drag', 5, 2) + left('release', 5, 2) + CMD_C,
    );

    await until('the copy', () => copied.length > 0);

    assert.deepEqual(copied, ['alpha']);

    ui.stdin.write(
      left('press', 7, 2) + left('drag', 10, 2) + left('release', 10, 2),
    );

    await until('the highlight', () => ui.frame().includes('\u001b[7mbeta'));

    ui.stdin.write(left('press', 20, 9) + left('release', 20, 9) + CMD_C);

    await delay(60);

    assert.deepEqual(copied, ['alpha']);
  } finally {
    ui.unmount();
  }
});

test('a drag past the transcript top or bottom scrolls it a row a move, and past the top each move in one read scrolls on from where the last left the view and selects the row it brings in', async () => {
  const { app } = fake({
    items: [long],
  });

  const { ui, copied } = mounted(app, 100, 40);

  try {
    await until('the transcript', () => first(ui) > 0);

    const bottom = first(ui);

    ui.stdin.write(left('press', 1, 1));

    ui.stdin.write(
      left('drag', 1, 0) + left('drag', 2, 0) + left('drag', 3, 0),
    );

    await until('three rows up', () => first(ui) === bottom - 3);

    ui.stdin.write(left('release', 3, 0));

    await delay(60);

    ui.stdin.write(CMD_C);

    await until('the copy', () => copied.length > 0);

    assert.deepEqual(copied, [
      `w ${bottom - 3}\nrow ${bottom - 2}\nrow ${bottom - 1}\nr`,
    ]);

    ui.stdin.write(left('press', 1, 1));

    ui.stdin.write(left('drag', 1, 39));

    await until('a row down', () => first(ui) === bottom - 2);
  } finally {
    ui.unmount();
  }
});

test('Cmd+C copies nothing while a page covers the selection or from blank rows alone', async () => {
  const { app } = fake({
    items: [
      { id: 'u', kind: 'user', text: 'hello', cwd: '/work' },
      {
        id: 't',
        kind: 'tool',
        title: 'run',
        text: 'one\n',
        cwd: '/work',
        done: true,
      },
    ],
  });

  const { ui, copied } = mounted(app);

  try {
    // the message is on row 2, and the expanded tool's output on row 5 ends with a blank line on row 6 and the blank row under it
    await until('the message', () => ui.text().includes('hello'));

    drag(ui, [1, 2], [5, 2]);

    await until('the highlight', () => ui.frame().includes('\u001b[7mhello'));

    await openCommand(ui, '/help', '/new  New');

    ui.stdin.write(CMD_C);

    await delay(60);

    assert.deepEqual(copied, []);

    ui.stdin.write('\u001b');

    await until('the transcript', () => ui.frame().includes('\u001b[7mhello'));

    ui.stdin.write(CMD_C);

    await until('the copy', () => copied.length > 0);

    assert.deepEqual(copied, ['hello']);

    ui.stdin.write(`\t${ENTER}`);

    await until('the expanded tool', () => ui.text().includes('one'));

    drag(ui, [1, 6], [20, 7]);

    await until('the blank highlight', () =>
      ui.frame().includes('\u001b[7m        '),
    );

    ui.stdin.write(CMD_C);

    await delay(60);

    assert.deepEqual(copied, ['hello']);
  } finally {
    ui.unmount();
  }
});

test('a composer press while scrolled above more transcript text cannot start a selection', async () => {
  const { app } = fake({ items: [long] });
  const { ui, copied } = mounted(app);

  try {
    await until('the transcript', () => first(ui) > 0);

    const bottom = first(ui);

    ui.stdin.write(wheelUp.repeat(20));

    await until('twenty rows up', () => first(ui) === bottom - 20);

    drag(ui, [5, 15], [5, 2]);

    ui.stdin.write(CMD_C);

    assert.deepEqual(copied, []);
  } finally {
    ui.unmount();
  }
});

test('selection starts on the last text column and visible row but not the right padding', async () => {
  const { app } = fake({
    items: [
      {
        ...long,
        text: Array.from(
          { length: 50 },
          (_, n) => `row ${n + 1}`.padEnd(57, '.') + 'Z',
        ).join('\n'),
      },
    ],
  });

  const { ui, copied } = mounted(app);

  try {
    await until('the transcript', () => first(ui) > 0);

    const bottom = first(ui);

    ui.stdin.write(wheelUp.repeat(20));

    await until('twenty rows up', () => first(ui) === bottom - 20);

    drag(ui, [58, 4], [57, 4]);

    ui.stdin.write(CMD_C);

    assert.deepEqual(copied, ['.Z']);

    drag(ui, [59, 4], [57, 4]);

    ui.stdin.write(CMD_C);

    assert.deepEqual(copied, ['.Z']);

    const last = ui
      .text()
      .split('\n')
      .findLastIndex((row) => /row \d+/.test(row));

    assert.equal(last, 13);

    drag(ui, [1, last], [2, last]);

    ui.stdin.write(CMD_C);

    assert.deepEqual(copied, ['.Z', 'ro']);
  } finally {
    ui.unmount();
  }
});

test('a wheel step while the left button is held preserves the press anchor for later dragging', async () => {
  const { app } = fake({ items: [long] });
  const { ui, copied } = mounted(app);

  try {
    await until('the transcript', () => first(ui) > 0);

    const bottom = first(ui);

    ui.stdin.write(wheelUp.repeat(20));

    await until('twenty rows up', () => first(ui) === bottom - 20);

    const before = first(ui);

    ui.stdin.write(left('press', 1, 5));

    ui.stdin.write(wheelUp);

    await until('one more row up', () => first(ui) === before - 1);

    ui.stdin.write(left('drag', 5, 7) + left('release', 5, 7) + CMD_C);

    assert.deepEqual(copied, [
      `row ${before + 4}\n${`row ${before + 5}`.slice(0, 5)}`,
    ]);
  } finally {
    ui.unmount();
  }
});
