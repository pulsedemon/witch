import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import chalk from 'chalk';
import { createElement } from 'react';
import type { Snapshot } from '../src/core/snapshot.js';
import { App } from '../src/ui/app.js';
import {
  show,
  forgedLink,
  fake,
  prompts,
  ENTER,
  SHIFT_ENTER,
  DOWN,
  UP,
  LEFT,
  TAB,
  commands,
} from './fixtures/ui.js';
import { until } from './fixtures/within.js';

const skills = [
  { name: 'x-one', description: 'First skill' },
  { name: 'x-two', description: 'Second skill' },
];

/** mounts while starting and then goes to `phase`, so App's key listener comes before the composer's as in the real app. */
async function launched(snapshot: Partial<Snapshot>, files?: string[]) {
  const context = fake({ ...snapshot, phase: 'starting' }, files);
  const ui = show(
    createElement(App, { coordinator: context.app, onExit: () => {} }),
  );
  await delay(60);
  context.coordinator.publish({ phase: snapshot.phase ?? 'idle' });
  await delay(60);
  return { ...context, ui };
}

test('Down and Enter in one read run the second matching skill', async () => {
  const { ui, calls } = await launched({ skills });
  try {
    ui.stdin.write(`/x${DOWN}${ENTER}`);
    await until('the send', () => calls.length > 0);
    assert.deepEqual(calls, [['send', '/x-two']]);
  } finally {
    ui.unmount();
  }
});

test('typing after Down in the same read resets the selection', async () => {
  const { ui, calls } = await launched({ skills });
  try {
    ui.stdin.write(`/${DOWN}x${ENTER}`);
    await until('the send', () => calls.length > 0);
    assert.deepEqual(calls, [['send', '/x-one']]);
  } finally {
    ui.unmount();
  }
});

test('a slash command nothing matches is sent as typed', async () => {
  const { ui, calls } = await launched({ skills });
  try {
    ui.stdin.write(`/zzz${ENTER}`);
    await until('the send', () => calls.length > 0);
    assert.deepEqual(calls, [['send', '/zzz']]);
  } finally {
    ui.unmount();
  }
});

test('Tab completes a skill and the arguments typed in the same read follow it', async () => {
  const { ui, calls } = await launched({ skills });
  try {
    ui.stdin.write(`/x-o${TAB}arg${ENTER}`);
    await until('the send', () => calls.length > 0);
    assert.deepEqual(calls, [['send', '/x-one arg']]);
  } finally {
    ui.unmount();
  }
});

test('Escape closes the list during a turn, a new token reopens it, and Escape then interrupts', async () => {
  const { ui, calls } = await launched({ skills, phase: 'running' });
  const open = () => ui.text().includes('/x-one First skill');
  try {
    ui.stdin.write('/x');
    await until('the list', open);
    ui.stdin.write('\u001b');
    await until('the closed list', () => !open());
    ui.stdin.write('-');
    await until('the reopened list', open);
    // back on the dismissed token, the list stays open
    ui.stdin.write('\u007f');
    await until('the shorter token', () => ui.text().includes('┃ /x '));
    assert.ok(open());
    ui.stdin.write('\u001b');
    await until('the closed list', () => !open());
    assert.deepEqual(calls, []);
    ui.stdin.write('\u001b');
    await until('the interrupt', () => calls.length > 0);
    assert.deepEqual(calls, [['interrupt']]);
  } finally {
    ui.unmount();
  }
});

test('Tab inserts a file into the middle of a draft', async () => {
  const { ui, calls } = await launched({}, ['src/app.ts', 'lib/x.ts']);
  try {
    ui.stdin.write(`see @sr now${LEFT.repeat(4)}`);
    await until('the file list', () => ui.text().includes('@src/app.ts'));
    ui.stdin.write(TAB);
    await until('the inserted path', () =>
      ui.text().includes('┃ see @src/app.ts now'),
    );
    assert.deepEqual(calls, []);
  } finally {
    ui.unmount();
  }
});

test('Enter inserts a file without sending', async () => {
  const { ui, calls } = await launched({}, ['src/app.ts']);
  try {
    ui.stdin.write('see @sr');
    await until('the file list', () => ui.text().includes('@src/app.ts'));
    ui.stdin.write(ENTER);
    await until('the inserted path', () =>
      ui.text().includes('┃ see @src/app.ts'),
    );
    await delay(60);
    assert.deepEqual(calls, []);
  } finally {
    ui.unmount();
  }
});

test('a paste the coordinator turns into an image marker goes into the draft and is sent with it', async () => {
  const { app, coordinator, calls } = fake({});
  coordinator.paste = (text, before) => {
    calls.push(['paste', text, before]);
    return ' [Image #1]';
  };
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write('session');
    await until('the draft', () => ui.text().includes('┃ session'));
    ui.stdin.write('\u001b[200~/tmp/shot.png\u001b[201~');
    await until('the marker', () => ui.text().includes('┃ session [Image #1]'));
    ui.stdin.write(ENTER);
    await until('the send', () => calls.some(([name]) => name === 'send'));
    assert.deepEqual(calls, [
      ['paste', '/tmp/shot.png', 'session'],
      ['send', 'session [Image #1]'],
    ]);
  } finally {
    ui.unmount();
  }
});

test('Up chooses in an open list without moving the cursor, and moves it once a space closes the list', async () => {
  const { ui } = await launched({}, ['src/app.ts', 'src/apx.ts']);
  try {
    ui.stdin.write('abc');
    await delay(30);
    ui.stdin.write(SHIFT_ENTER);
    await delay(30);
    ui.stdin.write('see @sr');
    await until('the file list', () => ui.text().includes('@src/apx.ts'));
    ui.stdin.write(DOWN);
    await delay(30);
    ui.stdin.write(UP);
    await delay(30);
    ui.stdin.write(TAB);
    await until('the first file at the token', () =>
      ui.text().includes('┃ see @src/app.ts'),
    );
    ui.stdin.write(` ${UP}Z`);
    await until('typing on the first line', () => ui.text().includes('┃ abcZ'));
  } finally {
    ui.unmount();
  }
});

test('tool focus hides a remounted draft list, which shows once focus returns', async () => {
  const { ui, coordinator } = await launched({ skills });
  const conversation = coordinator.snapshot.conversation!;
  const open = (id: string) =>
    coordinator.publish({ conversation: { ...conversation, id } });
  try {
    open('d');
    await delay(60);
    ui.stdin.write('/x');
    await until('the list', () => ui.text().includes('/x-one'));
    open('c');
    await until('the empty draft', () => !ui.text().includes('/x-one'));
    ui.stdin.write(TAB);
    await until('tool focus', () => ui.text().includes('ESC LEAVE TOOLS'));
    open('d');
    await delay(100);
    assert.ok(!ui.text().includes('/x-one'));
    ui.stdin.write(TAB);
    await until('the list again', () => ui.text().includes('/x-one'));
  } finally {
    ui.unmount();
  }
});

test('Ctrl+P over an open list gives the picker its keys', async () => {
  const { ui, calls } = await launched({ skills });
  try {
    ui.stdin.write('/x');
    await until('the list', () => ui.text().includes('/x-one'));
    await commands(ui);
    ui.stdin.write('\u001b');
    await until('the list again', () => ui.text().includes('/x-one'));
    await commands(ui);
    ui.stdin.write(`${DOWN}${ENTER}`);
    await until('the conversations picker', () =>
      ui.text().includes('Conversations'),
    );
    assert.deepEqual(calls, []);
  } finally {
    ui.unmount();
  }
});

test('the composer grows with its text up to half the body, sizes a ! command beside its !, and shrinks after a send', async () => {
  const { app, calls } = fake({});
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  const composerRows = () => {
    const lines = ui.text().split('\n');
    const top = lines.findIndex((line) => line.trimStart().startsWith('┏'));
    const bottom = lines.findIndex((line) => line.trimStart().startsWith('┗'));
    return bottom - top - 1;
  };
  try {
    await delay(60);
    assert.equal(composerRows(), 1);
    // 94 columns hold 200 characters and the cursor in 3 rows
    ui.stdin.write('x'.repeat(200));
    await until('a grown composer', () => composerRows() === 3);
    // 2200 would take 24 rows, and half of the 36-row body is 18
    ui.stdin.write('x'.repeat(2000));
    await until('a capped composer', () => composerRows() === 18);
    ui.stdin.write(ENTER);
    await until('the send', () => calls.length > 0);
    await until('an empty composer', () => composerRows() === 1);
    // beside its `!`, a command has 92 of the 94 columns, so 92 characters and the cursor take 2 rows
    ui.stdin.write(`!${'x'.repeat(92)}`);
    await until('a grown ! command', () => composerRows() === 2);
  } finally {
    ui.unmount();
  }
});

test('an open list of 8 or more keeps the newest transcript row and its own last row in view', async () => {
  const items = Array.from({ length: 60 }, (_, index) => ({
    id: `n${index}`,
    kind: 'notice' as const,
    text: `row ${index}`,
    cwd: '/work',
  }));
  const many = Array.from({ length: 10 }, (_, index) => ({
    name: `x-${index}`,
    description: `Skill ${index}`,
  }));
  const { ui } = await launched({ items, skills: many });
  try {
    ui.stdin.write('/x');
    await until('the list', () => ui.text().includes('/x-0'));
    const text = ui.text();
    assert.ok(text.includes('row 59'));
    assert.ok(text.includes('/x-7') && !text.includes('/x-8'));
    // above the row the body leaves free and the status line's two
    assert.match(text.trimEnd().split('\n').at(-4)!, /\/x-7 Skill 7$/);
  } finally {
    ui.unmount();
  }
});

test('a skill named like a Witch command is left out, since the command runs instead', async () => {
  const { ui } = await launched({
    skills: [{ name: 'help', description: 'Native help' }],
  });
  try {
    ui.stdin.write('/he');
    await until('the list', () => ui.text().includes('/help Keyboard help'));
    assert.ok(!ui.text().includes('Native help'));
  } finally {
    ui.unmount();
  }
});

test("the composer's list leaves out built-in commands", async () => {
  // a shared prefix, since `/` alone lists Witch's commands first and the list shows eight rows
  const { ui } = await launched({
    skills: [
      { name: 'x-context', description: 'Context usage', builtin: true },
      { name: 'x-review', description: 'Review changes' },
    ],
  });
  try {
    ui.stdin.write('/x');
    await until('the list', () => ui.text().includes('/x-review Review'));
    assert.ok(!ui.text().includes('x-context'));
  } finally {
    ui.unmount();
  }
});

test('list rows drop a link forged in a skill description or a file name', async () => {
  const forged = (text: string) => forgedLink('https://evil.example', text);
  const skill = await launched({
    skills: [{ name: 'x-evil', description: `see ${forged('docs')}` }],
  });
  const file = await launched({}, [`a${forged('b')}.txt`]);
  try {
    skill.ui.stdin.write('/x');
    await until('the skill list', () =>
      skill.ui.text().includes('/x-evil see docs'),
    );
    assert.ok(!skill.ui.frame().includes('\u001b]8;;https://evil.example'));
    file.ui.stdin.write('@a');
    await until('the file list', () => file.ui.text().includes('.txt'));
    assert.ok(!file.ui.frame().includes('\u001b]8;;https://evil.example'));
  } finally {
    skill.ui.unmount();
    file.ui.unmount();
  }
});

test('a skill description with a line break stays on its list row', async () => {
  const { ui } = await launched({
    skills: [{ name: 'x-wrapped', description: 'first\nsecond' }],
  });
  try {
    ui.stdin.write('/x');
    await until('the skill list', () =>
      ui.text().includes('/x-wrapped first second'),
    );
  } finally {
    ui.unmount();
  }
});

const POTION = '38;2;163;230;53';
const VIOLET = '38;2;168;85;247';

test('a draft starting with ! draws the border potion green and opens no file list, and Backspace over the ! brings violet and the list back', async () => {
  // Ink colors borders through the default chalk, which has no color under the test runner
  const level = chalk.level;
  chalk.level = 3;
  const { ui } = await launched({}, ['src/a.ts']);
  const listed = () => /^ *@src\/a\.ts *$/m.test(ui.text());
  try {
    ui.stdin.write('cat @sr');
    await until('the file list', listed);
    assert.ok(ui.frame().includes(VIOLET));
    // Home, then `!` at the start, then End, where a file list would open again
    ui.stdin.write('\u001b[H!\u001b[F');
    await until(
      'the potion border',
      () => ui.frame().includes(POTION) && ui.text().includes('┃ ! cat @sr'),
    );
    await delay(60);
    assert.equal(listed(), false);
    // Home stops after the `!`, and Backspace there takes it
    ui.stdin.write('\u001b[H\u007f\u001b[F');
    await until('the list back', listed);
    assert.ok(ui.frame().includes(VIOLET));
    assert.ok(!ui.frame().includes(POTION));
  } finally {
    ui.unmount();
    chalk.level = level;
  }
});

test('a ! command is sent and recorded with its !, and a lone ! sends nothing and stays in the draft', async () => {
  const { app, calls } = fake({});
  const { store, added } = prompts([]);
  const ui = show(
    createElement(App, { coordinator: app, store, onExit: () => {} }),
  );
  try {
    await delay(60);
    ui.stdin.write('!');
    await delay(30);
    ui.stdin.write(ENTER);
    await delay(60);
    assert.deepEqual(calls, []);
    assert.ok(ui.text().includes('┃ ! '), ui.text());
    ui.stdin.write('git status');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the send', () => calls.length > 0);
    assert.deepEqual(calls, [['send', '!git status']]);
    assert.deepEqual(added, [['/work', '!git status']]);
  } finally {
    ui.unmount();
  }
});
