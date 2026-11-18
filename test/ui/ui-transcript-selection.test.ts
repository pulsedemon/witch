import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { App } from '../../src/ui/App.js';
import { ENTER, drag, fake, left, openCommand, show } from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';
import {
  CMD_C,
  first,
  long,
  mounted,
  wheelUp,
} from '../fixtures/ui-transcript.js';

const click = (column: number, row: number) =>
  left('press', column, row) + left('release', column, row);

const words =
  'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi';

test('a drag over the transcript highlights it and Cmd+C copies it with wrapped rows joined, a click or a resize clears it, and a drag from above the transcript, the composer or the sidebar selects nothing', async () => {
  const { app } = fake({
    items: [{ id: 'u', kind: 'user', text: words, cwd: '/work' }],
  });

  const { ui, copied } = mounted(app);

  try {
    // the transcript starts at row 1 and column 1 under the phase row, the message wraps onto rows 2 and 3, and the composer's text is on row 15
    await until('the wrapped message', () => ui.text().includes(' omicron pi'));

    // each write renders before the next, so Cmd+C reads what the mouse left selected
    for (const data of [
      click(1, 2),
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
    ui.stdin.write(click(1, 2));
    await until('no highlight', () => !ui.frame().includes('\u001b[7m'));
    ui.stdin.write(CMD_C);
    await delay(60);
    assert.deepEqual(copied, [words]);
    // a second press on 1,2 would count as a double click
    ui.stdin.write(click(2, 2));
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
    ui.stdin.write(click(20, 9) + CMD_C);
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

    // released in the same read, so no held drag keeps scrolling
    ui.stdin.write(
      left('drag', 1, 0) +
        left('drag', 2, 0) +
        left('drag', 3, 0) +
        left('release', 3, 0),
    );

    await until('three rows up', () => first(ui) === bottom - 3);
    await delay(60);
    ui.stdin.write(CMD_C);
    await until('the copy', () => copied.length > 0);

    assert.deepEqual(copied, [
      `w ${bottom - 3}\nrow ${bottom - 2}\nrow ${bottom - 1}\nr`,
    ]);

    ui.stdin.write(left('press', 1, 1));
    ui.stdin.write(left('drag', 1, 39) + left('release', 1, 39));
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

test('a double press highlights the word under it before its release and Cmd+C copies it, on a linked path the whole link, and on a blank row nothing', async () => {
  const path = '/work/my notes.md';

  const { app } = fake({
    items: [
      { id: 'u', kind: 'user', text: 'alpha beta gamma', cwd: '/work' },
      {
        id: 't',
        kind: 'tool',
        title: `Read  ${path}`,
        path,
        text: '',
        cwd: '/work',
        done: true,
      },
    ],
  });

  const { ui, copied } = mounted(app);

  try {
    // the message is on row 2, the blank row under it is row 3, and the tool's path runs from column 11 of row 4
    await until('the tool', () => ui.text().includes('my notes.md'));
    ui.stdin.write(click(8, 2));
    ui.stdin.write(left('press', 8, 2));

    await until('the word highlighted', () =>
      ui.frame().includes('alpha \u001b[7mbeta\u001b[27m gamma'),
    );

    ui.stdin.write(CMD_C);
    await until('the copy', () => copied.length > 0);
    assert.deepEqual(copied, ['beta']);
    ui.stdin.write(left('release', 8, 2));
    ui.stdin.write(click(20, 4));
    ui.stdin.write(left('press', 20, 4));
    await until('the link highlighted', () => ui.frame().includes('\u001b[7m'));
    ui.stdin.write(left('release', 20, 4) + CMD_C);
    await until('the second copy', () => copied.length > 1);
    assert.deepEqual(copied, ['beta', path]);
    ui.stdin.write(click(8, 3));
    ui.stdin.write(left('press', 8, 3));

    await until(
      'no highlight on the blank row',
      () => !ui.frame().includes('\u001b[7m'),
    );

    ui.stdin.write(left('release', 8, 3) + CMD_C);
    // a copy from the blank row would land before this one
    ui.stdin.write(click(8, 2));
    ui.stdin.write(left('press', 8, 2) + CMD_C);
    await until('the third copy', () => copied.length > 2);
    assert.deepEqual(copied, ['beta', path, 'beta']);
  } finally {
    ui.unmount();
  }
});

test('a second press on a cell whose text moved or was rewritten under it since the first is a first press on that text', async () => {
  // the clock stands still, so the second press counts with the first by its cell
  vi.useFakeTimers({ toFake: ['performance'] });
  const said = { id: 'u', kind: 'user' as const, text: words, cwd: '/work' };
  const { app, coordinator } = fake({ items: [said] });
  const { ui } = mounted(app);

  try {
    await until('the message', () => ui.text().includes('alpha beta'));
    ui.stdin.write(click(8, 2));

    coordinator.publish({
      items: [{ ...said, id: 'n', text: 'first second third' }, said],
    });

    await until('the message above', () => ui.text().includes('first second'));
    ui.stdin.write(left('press', 8, 2));
    ui.stdin.write(left('drag', 10, 2));

    // a drag by cells, where one after a double press would take all of `second`
    await until('the cells highlighted', () =>
      ui.frame().includes('\u001b[7meco\u001b[27m'),
    );

    ui.stdin.write(left('release', 10, 2));
    ui.stdin.write(click(8, 5));

    // the same row of the same message, rewritten as streamed output rewrites one
    coordinator.publish({
      items: [
        { ...said, id: 'n', text: 'first second third' },
        { ...said, text: words.replace('beta', 'betamax') },
      ],
    });

    await until('the rewritten row', () => ui.text().includes('betamax'));
    ui.stdin.write(left('press', 8, 5));
    ui.stdin.write(left('drag', 10, 5));

    await until('its cells highlighted', () =>
      ui.frame().includes('\u001b[7meta\u001b[27m'),
    );
  } finally {
    ui.unmount();
  }
});

test('a double press, a held drag and Cmd+C in one read copy the whole words dragged over', async () => {
  const { app } = fake({
    items: [
      { id: 'u', kind: 'user', text: 'alpha beta gamma delta', cwd: '/work' },
    ],
  });

  const { ui, copied } = mounted(app);

  try {
    // the message is on row 2, from column 1
    await until('the message', () => ui.text().includes('gamma delta'));

    ui.stdin.write(
      click(8, 2) + left('press', 8, 2) + left('drag', 13, 2) + CMD_C,
    );

    await until('the copy', () => copied.length > 0);
    assert.deepEqual(copied, ['beta gamma']);
  } finally {
    ui.unmount();
  }
});

test('a third press on the middle row of a wrapped line highlights all its rows, the last through its text, and copies them as one line, and a fourth keeps it', async () => {
  const text = `${words} rho sigma tau upsilon phi chi psi omega one two three four five six seven`;

  const { app } = fake({
    items: [{ id: 'u', kind: 'user', text, cwd: '/work' }],
  });

  const { ui, copied } = mounted(app);
  const rows = () => ui.frame().split('\n').slice(2, 5);

  const line = [
    ' \u001b[7malpha beta gamma delta epsilon zeta eta theta iota kappa  \u001b[27m',
    ' \u001b[7mlambda mu nu xi omicron pi rho sigma tau upsilon phi chi  \u001b[27m',
    ' \u001b[7mpsi omega one two three four five six seven\u001b[27m',
  ];

  try {
    // the message wraps over rows 2 to 4, from column 1
    await until('the wrapped message', () => ui.text().includes(' psi omega'));
    ui.stdin.write(click(5, 3));
    ui.stdin.write(click(5, 3));
    ui.stdin.write(left('press', 5, 3));

    await until('the line highlighted', () =>
      ui.frame().includes('seven\u001b[27m'),
    );

    assert.deepEqual(rows(), line);
    ui.stdin.write(left('release', 5, 3) + CMD_C);
    await until('the copy', () => copied.length > 0);
    assert.deepEqual(copied, [text]);
    ui.stdin.write(click(9, 3));
    await until('no highlight', () => !ui.frame().includes('\u001b[7m'));

    for (let press = 0; press < 4; press++) ui.stdin.write(click(5, 3));

    await until('the line highlighted again', () =>
      ui.frame().includes('seven\u001b[27m'),
    );

    assert.deepEqual(rows(), line);
    ui.stdin.write(CMD_C);
    await until('the second copy', () => copied.length > 1);
    assert.deepEqual(copied, [text, text]);
  } finally {
    ui.unmount();
  }
});

test('a triple press on a line whose last wrapped row holds only an undrawn character selects through its text', async () => {
  const text = 'a'.repeat(58);

  const { app } = fake({
    items: [
      {
        id: 'a',
        kind: 'assistant',
        text: `${text}${' '.repeat(20)}\u200b`,
        cwd: '/work',
      },
    ],
  });

  const { ui, copied } = mounted(app);

  try {
    // the a's fill row 2, and the zero-width space wraps alone onto row 3
    await until('the reply', () => ui.text().includes(text));
    ui.stdin.write(click(5, 2));
    ui.stdin.write(click(5, 2));
    ui.stdin.write(click(5, 2));

    await until('the highlight', () =>
      ui.frame().includes(`\u001b[7m${text}\u001b[27m`),
    );

    // a selection running on into the undrawn row would highlight a cell of it
    assert.equal(ui.frame().split('\u001b[7m').length, 2);
    ui.stdin.write(CMD_C);
    await until('the copy', () => copied.length > 0);
    assert.deepEqual(copied, [text]);
  } finally {
    ui.unmount();
  }
});

test('a held double press dragged to another row selects whole words at both ends either way, and a held triple press dragged down selects whole lines', async () => {
  const { app } = fake({
    items: [
      { id: 'u', kind: 'user', text: words, cwd: '/work' },
      {
        id: 'a',
        kind: 'assistant',
        text: 'first line\nsecond line\nthird line',
        cwd: '/work',
      },
    ],
  });

  const { ui, copied } = mounted(app);

  const dragged =
    'beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron';

  try {
    // beta is at column 8 of row 2, omicron at column 18 of row 3, and the reply's lines are on rows 6 to 8
    await until('the reply', () => ui.text().includes('third line'));
    ui.stdin.write(click(8, 2));

    ui.stdin.write(
      left('press', 8, 2) +
        left('drag', 18, 3) +
        left('release', 18, 3) +
        CMD_C,
    );

    await until('the copy', () => copied.length > 0);
    ui.stdin.write(click(18, 3));

    ui.stdin.write(
      left('press', 18, 3) + left('drag', 8, 2) + left('release', 8, 2) + CMD_C,
    );

    await until('the second copy', () => copied.length > 1);
    ui.stdin.write(click(3, 6));
    ui.stdin.write(click(3, 6));

    ui.stdin.write(
      left('press', 3, 6) + left('drag', 3, 7) + left('release', 3, 7) + CMD_C,
    );

    await until('the third copy', () => copied.length > 2);
    assert.deepEqual(copied, [dragged, dragged, 'first line\nsecond line']);
  } finally {
    ui.unmount();
  }
});

test('a held triple press whose line changes its last row selects the current line on the next drag and leaves no stale highlight', async () => {
  const longer = `${words} rho sigma tau upsilon phi chi psi omega one two three`;

  const message = (text: string) => ({
    items: [{ id: 'u', kind: 'user' as const, text, cwd: '/work' }],
  });

  const { app, coordinator } = fake(message(words));
  const { ui, copied } = mounted(app);

  try {
    // the message wraps from row 2 onto row 3, and the longer one on to row 4 with row 2 unchanged
    await until('the wrapped message', () => ui.text().includes(' omicron pi'));
    ui.stdin.write(click(3, 2));
    ui.stdin.write(click(3, 2));
    ui.stdin.write(left('press', 3, 2));

    await until('the line highlighted', () =>
      ui.frame().includes('pi\u001b[27m'),
    );

    coordinator.publish(message(longer));
    await until('the longer message', () => ui.text().includes(' psi omega'));
    assert.ok(!ui.frame().includes('\u001b[7m'));
    ui.stdin.write(left('drag', 5, 2));

    await until('the longer line highlighted', () =>
      ui.frame().includes('three\u001b[27m'),
    );

    ui.stdin.write(left('release', 5, 2) + CMD_C);
    await until('the copy', () => copied.length > 0);
    assert.deepEqual(copied, [longer]);
  } finally {
    ui.unmount();
  }
});

/** the timer count before any drag, under faked intervals; the status line's own interval is part of it. */
async function fakedInterval(ui: { text(): string }) {
  await until('the transcript', () => first(ui) > 0);

  return vi.getTimerCount();
}

const tick = () => vi.advanceTimersByTime(50);

test('a drag held below the bottom while more rows arrive copies through the newest row', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

  const rows = (count: number) => ({
    ...long,
    text: Array.from({ length: count }, (_, n) => `row ${n + 1}`).join('\n'),
  });

  const { app, coordinator } = fake({ items: [rows(300)] });
  const { ui, copied } = mounted(app);

  try {
    await until('the transcript', () => first(ui) > 0);
    const bottom = first(ui);
    ui.stdin.write(wheelUp.repeat(2));
    await until('two rows up', () => first(ui) === bottom - 2);
    const pressed = first(ui) + 4;
    ui.stdin.write(left('press', 1, 5));
    ui.stdin.write(left('drag', 1, 20));
    await until('a row down', () => first(ui) === bottom - 1);
    tick();
    await until('the bottom', () => first(ui) === bottom);
    coordinator.publish({ items: [rows(305)] });
    await until('the new rows', () => ui.text().includes('row 305'));
    // the tick after the new layout selects with it
    tick();
    ui.stdin.write(CMD_C);
    await until('the copy', () => copied.length > 0);

    assert.deepEqual(copied, [
      Array.from(
        { length: 306 - pressed },
        (_, n) => `row ${pressed + n}`,
      ).join('\n') + '\n',
    ]);
  } finally {
    ui.unmount();
  }
});

test('a drag back inside the transcript stops its scrolling and a further drag still extends the selection', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const { app } = fake({ items: [long] });
  const { ui, copied } = mounted(app);

  try {
    const baseline = await fakedInterval(ui);
    const bottom = first(ui);
    ui.stdin.write(left('press', 1, 5));
    ui.stdin.write(left('drag', 1, 0));
    await until('a row up', () => first(ui) === bottom - 1);
    tick();
    await until('two rows up', () => first(ui) === bottom - 2);
    assert.equal(vi.getTimerCount(), baseline + 1);
    ui.stdin.write(left('drag', 1, 8));
    assert.equal(vi.getTimerCount(), baseline);
    ui.stdin.write(left('drag', 3, 1) + left('release', 3, 1) + CMD_C);
    await until('the copy', () => copied.length > 0);

    assert.deepEqual(copied, [
      [
        `w ${bottom - 2}`,
        ...Array.from({ length: 5 }, (_, n) => `row ${bottom - 1 + n}`),
        'r',
      ].join('\n'),
    ]);
  } finally {
    ui.unmount();
  }
});

test('a press held while a page opens and closes ends there, so a later drag selects nothing and one held past the edge stops scrolling', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const { app } = fake({ items: [long] });
  const { ui, copied } = mounted(app);

  try {
    const baseline = await fakedInterval(ui);
    const bottom = first(ui);
    ui.stdin.write(left('press', 1, 5));
    await openCommand(ui, '/help', '/new  New');
    ui.stdin.write('\u001b');
    await until('the transcript again', () => first(ui) > 0);
    ui.stdin.write(left('drag', 5, 5) + CMD_C);
    // a copy of that drag would land before this one
    ui.stdin.write(left('release', 5, 5));
    ui.stdin.write(left('press', 1, 5) + left('drag', 3, 5) + CMD_C);
    await until('the copy', () => copied.length > 0);
    assert.deepEqual(copied, [`row ${bottom + 4}`.slice(0, 3)]);
    ui.stdin.write(left('drag', 1, 0));
    await until('a row up', () => first(ui) === bottom - 1);
    assert.equal(vi.getTimerCount(), baseline + 1);
    await openCommand(ui, '/help', '/new  New');
    await until('the interval cleared', () => vi.getTimerCount() === baseline);
  } finally {
    ui.unmount();
  }
});

test('a drag held past the edge keeps one 50 ms interval, which a release, a hover report, a resize that drops the press or unmounting clears', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const { app } = fake({ items: [long] });
  const { ui, copied } = mounted(app);

  const held = () => {
    ui.stdin.write(left('press', 1, 5));
    ui.stdin.write(left('drag', 1, 0));
  };

  try {
    const baseline = await fakedInterval(ui);
    const bottom = first(ui);
    held();
    assert.equal(vi.getTimerCount(), baseline + 1);
    await until('a row up', () => first(ui) === bottom - 1);

    // no further report arrives, and each tick scrolls a row on the one interval
    for (let rows = 2; rows < 6; rows++) {
      tick();
      await until(`${rows} rows up`, () => first(ui) === bottom - rows);
      assert.equal(vi.getTimerCount(), baseline + 1);
    }

    ui.stdin.write(left('release', 1, 0));
    assert.equal(vi.getTimerCount(), baseline);
    held();
    assert.equal(vi.getTimerCount(), baseline + 1);
    ui.stdin.write(CMD_C);
    // motion with no button held ends the press, so the drag after it moves no end of the selection
    ui.stdin.write('\u001b[<35;2;1M');
    assert.equal(vi.getTimerCount(), baseline);
    ui.stdin.write(left('drag', 3, 8) + CMD_C);
    await until('both copies', () => copied.length > 1);
    assert.equal(copied[1], copied[0]);
    held();
    ui.resize(80);

    await until('the wide layout', () =>
      ui
        .text()
        .split('\n')
        .some((line) => line.length > 60),
    );

    // the press dropped with the width, and the next tick finds none
    tick();
    assert.equal(vi.getTimerCount(), baseline);
    held();
    assert.equal(vi.getTimerCount(), baseline + 1);
  } finally {
    ui.unmount();
  }

  assert.equal(vi.getTimerCount(), 0);
});
