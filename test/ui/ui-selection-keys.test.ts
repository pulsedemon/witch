import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  DOWN,
  ENTER,
  TAB,
  fake,
  left,
  openCommand,
  tools,
} from '../fixtures/ui.js';
import {
  CMD_C,
  CTRL_SHIFT_A,
  SHIFT_DOWN,
  SHIFT_LEFT,
  SHIFT_RIGHT,
  SHIFT_UP,
  first,
  long,
  mounted,
  wheelUp,
} from '../fixtures/ui-transcript.js';
import { until } from '../fixtures/within.js';

// at 60 columns these draw screen rows 1 to 7 as You, alpha beta gamma, blank, Assistant, one two, blank and
// three 日本 four, each a column in from the transcript's own
const items = [
  { id: 'u', kind: 'user' as const, text: 'alpha beta gamma', cwd: '/work' },
  {
    id: 'a',
    kind: 'assistant' as const,
    text: 'one two\n\nthree 日本 four',
    cwd: '/work',
  },
];

const everything =
  'You\nalpha beta gamma\n\nAssistant\none two\n\nthree 日本 four';

const click = (column: number, row: number) =>
  left('press', column, row) + left('release', column, row);

const highlighted = (ui: { frame(): string }) =>
  ui.frame().includes('\u001b[7m');

async function shown() {
  const { app } = fake({ items });
  const mount = mounted(app);
  await until('the reply', () => mount.ui.text().includes('three 日本 four'));

  return mount;
}

/** writes each key as its own read, which Ink handles before the next, and copies what is then selected. */
async function copyAfter(
  { ui, copied }: ReturnType<typeof mounted>,
  ...keys: string[]
) {
  const before = copied.length;

  for (const key of [...keys, CMD_C]) ui.stdin.write(key);

  await until('the copy', () => copied.length > before);

  return copied.at(-1);
}

test('Ctrl+Shift+A selects the whole transcript through its last text, and Shift+arrows move its end', async () => {
  const mount = await shown();

  try {
    assert.equal(await copyAfter(mount, CTRL_SHIFT_A), everything);
    assert.equal(await copyAfter(mount, SHIFT_LEFT), everything.slice(0, -1));

    assert.equal(
      await copyAfter(mount, SHIFT_UP),
      'You\nalpha beta gamma\n\nAssistant\none two\n',
    );

    assert.equal(await copyAfter(mount, SHIFT_DOWN, SHIFT_RIGHT), everything);
  } finally {
    mount.ui.unmount();
  }
});

test("Shift+arrows move a double-clicked word's end without moving the composer cursor, and after Escape they move it again", async () => {
  const mount = await shown();
  const { ui, copied } = mount;

  try {
    ui.stdin.write(click(7, 2) + click(7, 2));
    await until('the word', () => highlighted(ui));
    ui.stdin.write('xy');
    await until('the draft', () => ui.text().includes('xy'));
    assert.equal(await copyAfter(mount, SHIFT_LEFT, SHIFT_LEFT), 'be');
    ui.stdin.write('z');
    await until('z after the draft', () => ui.text().includes('xyz'));
    ui.stdin.write('\u001b');
    await until('no highlight', () => !highlighted(ui));

    for (const data of [SHIFT_LEFT, 'w', CMD_C]) ui.stdin.write(data);

    await until('w before z', () => ui.text().includes('xywz'));
    assert.deepEqual(copied, ['be']);
  } finally {
    ui.unmount();
  }
});

test('after a word drag upward, Shift+↑ moves the upper end', async () => {
  const mount = await shown();
  const { ui } = mount;

  try {
    // a held double press in `two`, dragged up into `beta`
    ui.stdin.write(click(7, 5) + left('press', 7, 5));
    ui.stdin.write(left('drag', 7, 2));
    ui.stdin.write(left('release', 7, 2));
    assert.equal(await copyAfter(mount), 'beta gamma\n\nAssistant\none two');

    // column 6 of the first row is past `You`, so that row adds only its line break
    assert.equal(
      await copyAfter(mount, SHIFT_UP),
      '\nalpha beta gamma\n\nAssistant\none two',
    );
  } finally {
    ui.unmount();
  }
});

test('a key move ends a held press, so a later drag report leaves the moved selection alone', async () => {
  const mount = await shown();
  const { ui } = mount;

  try {
    ui.stdin.write(left('press', 1, 2));
    ui.stdin.write(left('drag', 5, 2));
    assert.equal(await copyAfter(mount, SHIFT_RIGHT, SHIFT_RIGHT), 'alpha b');
    ui.stdin.write(left('drag', 16, 2));
    assert.equal(await copyAfter(mount), 'alpha b');
  } finally {
    ui.unmount();
  }
});

test('a moved end that leaves the view scrolls the transcript to it', async () => {
  const { app } = fake({ items: [long] });
  const { ui } = mounted(app);

  try {
    await until('the transcript', () => first(ui) > 0);
    const bottom = first(ui);
    ui.stdin.write(wheelUp.repeat(20));
    await until('twenty rows up', () => first(ui) === bottom - 20);
    const before = first(ui);
    const height = ui.text().match(/^ row \d+$/gm)!.length;
    ui.stdin.write(click(2, 1) + click(2, 1));
    ui.stdin.write(SHIFT_UP);
    await until('one row up', () => first(ui) === before - 1);

    // the end starts on the new top row, so a view's height of steps puts it one row past the bottom
    for (let step = 0; step < height; step++) ui.stdin.write(SHIFT_DOWN);

    // a frame drawn after the last step, so a view that scrolled past this row would show it
    ui.stdin.write('q');
    await until('the typed letter', () => /^\W*q\W*$/m.test(ui.text()));
    assert.equal(first(ui), before);
  } finally {
    ui.unmount();
  }
});

test('Ctrl+Shift+A selects nothing under a page or in an empty conversation', async () => {
  const mount = await shown();
  const { ui, copied } = mount;

  try {
    await openCommand(ui, '/help', '/new  New');
    ui.stdin.write(CTRL_SHIFT_A);
    ui.stdin.write('\u001b');
    await until('the transcript again', () => ui.text().includes('one two'));

    // the draft shows in a frame drawn after Cmd+C was handled
    for (const data of [CMD_C, 'zq']) ui.stdin.write(data);

    await until('the draft', () => ui.text().includes('zq'));
    assert.deepEqual(copied, []);
    assert.ok(!highlighted(ui));
  } finally {
    ui.unmount();
  }

  const empty = mounted(fake({ items: [] }).app);

  try {
    await until('the empty transcript', () =>
      empty.ui.text().includes('Start a conversation'),
    );

    for (const data of [CTRL_SHIFT_A, CMD_C, 'zq']) empty.ui.stdin.write(data);

    await until('the draft', () => empty.ui.text().includes('zq'));
    assert.deepEqual(empty.copied, []);
    assert.ok(!highlighted(empty.ui));
  } finally {
    empty.ui.unmount();
  }
});

test('with a selection, Shift+↓ moves its end and leaves an open completion list on its choice', async () => {
  const { app } = fake({
    items,
    skills: [
      { name: 'x-one', description: 'First skill' },
      { name: 'x-two', description: 'Second skill' },
    ],
  });

  const mount = mounted(app);
  const { ui } = mount;

  try {
    await until('the reply', () => ui.text().includes('three 日本 four'));
    ui.stdin.write('/x');
    await until('the list', () => ui.text().includes('/x-two Second skill'));
    ui.stdin.write(click(2, 2) + click(2, 2));
    assert.equal(await copyAfter(mount), 'alpha');
    assert.equal(await copyAfter(mount, SHIFT_DOWN), 'alpha beta gamma\n');
    // Tab completes the list's choice, still its first
    ui.stdin.write(TAB);
    await until('the list closed', () => !ui.text().includes('Second skill'));
    assert.ok(ui.text().includes('/x-one'));
  } finally {
    ui.unmount();
  }
});

test('with a selection, Shift+↓ moves its end and leaves the focused tool chosen', async () => {
  /** focuses the tools, runs `keys` and returns the output of the tool Enter then opens. */
  const opened = async (
    keys: (mount: ReturnType<typeof mounted>) => unknown,
  ) => {
    const mount = mounted(fake({ items: [items[0]!, ...tools('a')] }).app);
    const { ui } = mount;

    try {
      await until('the tools', () => ui.text().includes('a tool 2'));
      ui.stdin.write('\t');
      await until('tool focus', () => ui.text().includes('ESC LEAVE TOOLS'));
      await keys(mount);
      ui.stdin.write(ENTER);
      await until('a tool open', () => ui.text().includes('a output'));

      return /a output \d/.exec(ui.text())![0];
    } finally {
      ui.unmount();
    }
  };

  const untouched = await opened(() => {});
  const afterDown = await opened(({ ui }) => ui.stdin.write(DOWN));
  assert.notEqual(afterDown, untouched);

  assert.equal(
    await opened(async (mount) => {
      mount.ui.stdin.write(click(2, 2) + click(2, 2));
      assert.equal(await copyAfter(mount), 'alpha');
      assert.equal(await copyAfter(mount, SHIFT_DOWN), 'alpha beta gamma\n');
    }),
    untouched,
  );
});
