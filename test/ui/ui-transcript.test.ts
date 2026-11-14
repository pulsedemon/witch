import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { applyDisplayUpdate } from '../../src/core/state.js';
import { App } from '../../src/ui/App.js';
import { Graphics, placeholder } from '../../src/ui/transcript/images.js';
import { png } from '../fixtures/png.js';
import {
  DOWN,
  ENTER,
  TAB,
  approval,
  drag,
  fake,
  openCommand,
  show,
  tools,
} from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';
import {
  CMD_C,
  first,
  long,
  mounted,
  wheelUp,
} from '../fixtures/ui-transcript.js';

const pendingEdit = {
  id: 'edit',
  kind: 'tool' as const,
  title: 'Edit ./a.txt',
  text: JSON.stringify(
    { file_path: '/work/a.txt', old_string: 'b', new_string: 'B' },
    null,
    2,
  ),
  cwd: '/work',
  done: false,
};

const completedEdit = {
  ...pendingEdit,
  text: '',
  done: true,
  diff: [
    {
      path: '/work/a.txt',
      kind: 'update' as const,
      hunks: [{ oldStart: 1, newStart: 1, lines: [' a', '-b', '+B'] }],
    },
  ],
};

test('Tab, Down and Enter in one read expand a tool instead of submitting the draft, and Enter collapses it', async () => {
  const { app, calls } = fake({ items: tools('first') });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await delay(60);

    ui.stdin.write('hello');

    await delay(30);

    ui.stdin.write(`\t${DOWN}${ENTER}`);

    await until('the expanded tool', () =>
      ui.text().includes('first output 2'),
    );

    assert.ok(!ui.text().includes('first output 1'));

    const row = (text: string) =>
      ui
        .frame()
        .split('\n')
        .find((line) => line.includes(text)) ?? '';

    assert.ok(row('first tool 2').includes('\u001b[7m'));

    assert.ok(!row('first tool 1').includes('\u001b[7m'));

    ui.stdin.write(ENTER);

    await until(
      'the collapsed tool',
      () => !ui.text().includes('first output 2'),
    );

    assert.deepEqual(calls, []);
  } finally {
    ui.unmount();
  }
});

test('a manually expanded tool stays open when its project diff arrives', async () => {
  const { app, coordinator } = fake({
    phase: 'running',
    items: [pendingEdit],
  });

  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await delay(60);

    ui.stdin.write(`\t${ENTER}`);

    await until('the opened input', () =>
      ui.text().includes('"old_string": "b"'),
    );

    coordinator.publish({ items: [completedEdit] });

    await until('the completed tool', () =>
      ui.text().includes('✓ Edit ./a.txt'),
    );

    assert.match(ui.text(), /2 \+B/);

    ui.stdin.write(ENTER);

    await until('the collapsed tool', () =>
      ui.text().includes('+ ✓ Edit ./a.txt'),
    );

    assert.doesNotMatch(ui.text(), /2 \+B/);

    ui.stdin.write(ENTER);

    await until('the reopened tool', () => ui.text().includes('2 +B'));
  } finally {
    ui.unmount();
  }
});

test('a manual collapse survives a project diff and batched toggles use the previous choice', async () => {
  const { app, coordinator } = fake({
    phase: 'running',
    items: [pendingEdit],
  });

  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await delay(60);

    ui.stdin.write(`\t${ENTER}${ENTER}`);

    await delay(60);

    coordinator.publish({ items: [completedEdit] });

    await until('the completed tool', () =>
      ui.text().includes('✓ Edit ./a.txt'),
    );

    assert.ok(ui.text().includes('+ ✓ Edit ./a.txt'));

    assert.doesNotMatch(ui.text(), /2 \+B/);

    ui.stdin.write(ENTER);

    await until('the reopened tool', () => ui.text().includes('2 +B'));
  } finally {
    ui.unmount();
  }

  const automatic = fake({ items: [completedEdit] });

  const opened = show(
    createElement(App, { coordinator: automatic.app, onExit: () => {} }),
  );

  try {
    await delay(60);

    assert.match(opened.text(), /2 \+B/);

    opened.stdin.write(`\t${ENTER}`);

    await until('the collapsed automatic tool', () =>
      opened.text().includes('+ ✓ Edit ./a.txt'),
    );

    assert.doesNotMatch(opened.text(), /2 \+B/);
  } finally {
    opened.unmount();
  }
});

test('a conversation switch resets the tool selection within the next read', async () => {
  const { app, coordinator } = fake({ items: tools('first') });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await delay(60);

    ui.stdin.write(`\t${DOWN}`);

    await delay(30);

    ui.stdin.write('\u001b');

    await delay(30);

    coordinator.publish({
      conversation: { ...coordinator.snapshot.conversation!, id: 'c2' },
      items: tools('second'),
    });

    await until('the new conversation', () =>
      ui.text().includes('second tool 1'),
    );

    ui.stdin.write(`\t${ENTER}`);

    await until('the expanded tool', () =>
      ui.text().includes('second output 1'),
    );
  } finally {
    ui.unmount();
  }
});

test('two page keys in one read scroll two pages, PageDown back to the bottom follows output again, and PageUp scrolls a request back', async () => {
  const { app, coordinator } = fake({
    items: [long],
  });

  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  const rows = () =>
    ui
      .text()
      .split('\n')
      .map((row) => row.trim());

  try {
    await delay(60);

    ui.stdin.write('\u001b[5~\u001b[5~');

    // 302 lines in a 29-row transcript start at row 273; two pages up is 215
    await until('two pages up', () => rows()[1] === 'row 215');

    assert.ok(ui.text().includes('READING EARLIER OUTPUT'));

    ui.stdin.write('\u001b[6~\u001b[6~');

    await until(
      'live output',
      () => !ui.text().includes('READING EARLIER OUTPUT'),
    );

    coordinator.publish({
      phase: 'running',
      requests: [
        {
          ...approval,
          detail: Array.from({ length: 200 }, (_, n) => `d${n + 1}`).join('\n'),
        },
      ],
    });

    await delay(600);

    ui.stdin.write('\u001b[6~\u001b[6~');

    // the detail starts on line 4, and two 30-row pages down show line 61
    await until('two pages down', () => {
      const all = rows();

      return all[all.indexOf('Approval required') + 1] === 'd58';
    });

    ui.stdin.write('\u001b[5~');

    await until('a page up', () => {
      const all = rows();

      return all[all.indexOf('Approval required') + 1] === 'd28';
    });
  } finally {
    ui.unmount();
  }
});

const wheelDown = '\u001b[<65;10;10M';

test('the wheel scrolls the transcript a row a step, and back at the bottom follows output again', async () => {
  const { app } = fake({
    items: [long],
  });

  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await until('the transcript', () => first(ui) > 0);

    const bottom = first(ui);

    ui.stdin.write(wheelUp.repeat(3));

    await until('three rows up', () => first(ui) === bottom - 3);

    assert.ok(ui.text().includes('READING EARLIER OUTPUT'));

    ui.stdin.write(wheelDown.repeat(3));

    await until(
      'live output',
      () => !ui.text().includes('READING EARLIER OUTPUT'),
    );

    assert.equal(first(ui), bottom);
  } finally {
    ui.unmount();
  }
});

test('the viewport keeps the blank after an image across resizes', async () => {
  const placements: string[] = [];

  const graphics = new Graphics((data) => {
    if (data.includes('a=p,')) placements.push(data);
  });

  const { app } = fake({
    items: [
      {
        id: 'image',
        kind: 'tool',
        title: 'Read',
        text: 'Image',
        cwd: '/work',
        done: true,
        images: [`data:image/png;base64,${png(800, 200).toString('base64')}`],
      },
      {
        id: 'after',
        kind: 'assistant',
        text: Array.from({ length: 80 }, (_, n) => `after ${n + 1}`).join('\n'),
        cwd: '/work',
      },
    ],
  });

  const ui = show(
    createElement(App, { coordinator: app, graphics, onExit: () => {} }),
    42,
    24,
  );

  const rows = () =>
    ui
      .text()
      .split('\n')
      .map((row) => row.trim());

  try {
    await until('the transcript bottom', () => ui.text().includes('after 80'));

    ui.stdin.write(wheelUp.repeat(100));

    await until('the tool title at the top', () => rows()[1] === '+ ✓ Read');

    ui.stdin.write(`\t${ENTER}`);

    await until('the expanded image', () => ui.text().includes(placeholder));

    ui.stdin.write('\u001b');

    await until('the composer', () => !ui.text().includes('↑/↓ TOOLS'));

    ui.stdin.write(wheelDown.repeat(7));

    await until('the blank after the image', () => rows()[2] === 'Assistant');

    assert.deepEqual(rows().slice(1, 4), ['', 'Assistant', 'after 1']);

    for (const [columns, placement] of [
      [102, 'c=100,r=13'],
      [42, 'c=40,r=5'],
    ] as const) {
      const before = ui.frame();
      const count = placements.length;

      ui.resize(columns);

      await until(
        'the resized frame and image',
        () =>
          ui.frame() !== before &&
          placements.length > count &&
          placements.at(-1)!.includes(placement),
      );

      assert.deepEqual(rows().slice(1, 4), ['', 'Assistant', 'after 1']);
    }
  } finally {
    ui.unmount();

    graphics.release();
  }
});

test('the wheel scrolls a page and a request by rows', async () => {
  const { app, coordinator } = fake({});

  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    100,
    24,
  );

  try {
    await delay(60);

    await openCommand(ui, '/help', '/new  New');

    // the COMMANDS heading sits above /new
    ui.stdin.write(wheelDown.repeat(3));

    await until(
      'three rows down',
      () => !ui.text().includes('/sessions') && ui.text().includes('/model'),
    );

    ui.stdin.write(wheelUp);

    await until('a row up', () => ui.text().includes('/sessions'));

    assert.ok(!ui.text().includes('/new  New'));

    ui.stdin.write('\u001b');

    coordinator.publish({
      phase: 'running',
      requests: [
        {
          ...approval,
          detail: Array.from({ length: 200 }, (_, n) => `d${n + 1}`).join('\n'),
        },
      ],
    });

    await until('the request', () => ui.text().includes('d1\n'));

    // the detail starts on line 4, so five rows down show d3 first
    ui.stdin.write(wheelDown.repeat(5));

    await until('five rows down', () => {
      const rows = ui
        .text()
        .split('\n')
        .map((row) => row.trim());

      return rows[rows.indexOf('Approval required') + 1] === 'd3';
    });
  } finally {
    ui.unmount();
  }
});

test('a click and a wheel step between keys leave the draft as typed', async () => {
  const { app } = fake({});
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await delay(60);

    ui.stdin.write(`xq\u001b[<0;3;4M\u001b[<0;3;4m${wheelUp}zw`);

    await until('the draft', () => ui.text().includes('xqzw'));
  } finally {
    ui.unmount();
  }
});

test('a typed cross-runtime /model returns to live output', async () => {
  const { app, calls } = fake({
    items: [long],
  });

  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await delay(60);

    ui.stdin.write('\u001b[5~');

    await until('earlier output', () =>
      ui.text().includes('READING EARLIER OUTPUT'),
    );

    ui.stdin.write('/model b:m');

    await delay(30);

    ui.stdin.write(ENTER);

    await until('the switch', () => calls.length > 0);

    await until('live output', () => !ui.text().includes('READING EARLIER'));

    assert.deepEqual(calls, [
      ['selectModel', { agent: 'b', id: 'm', effort: undefined }],
    ]);
  } finally {
    ui.unmount();
  }
});

test('Down with tools focused and no tools keeps the reading position, and End returns to live output', async () => {
  const { app } = fake({
    items: [long],
  });

  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  const top = () => ui.text().split('\n')[1]?.trim();

  try {
    await delay(60);

    ui.stdin.write('\u001b[5~');

    await until('a page up', () => top() === 'row 244');

    ui.stdin.write(`\t${DOWN}`);

    await delay(60);

    assert.equal(top(), 'row 244');

    ui.stdin.write('\u001b[F');

    // the tools hint takes a transcript row
    await until('live output', () => top() === 'row 274');
  } finally {
    ui.unmount();
  }
});

test('Escape while tools are focused during a turn leaves focus without interrupting', async () => {
  const { app, calls } = fake({ phase: 'running', items: tools('first') });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await delay(60);

    ui.stdin.write('\t');

    await until('tool focus', () => ui.text().includes('ESC LEAVE TOOLS'));

    ui.stdin.write('\u001b');

    await until('the composer', () => !ui.text().includes('ESC LEAVE TOOLS'));

    assert.ok(!calls.some(([call]) => call === 'interrupt'));
  } finally {
    ui.unmount();
  }
});

test('Ctrl+O expands only the selected tool without editing the draft', async () => {
  const items = ['alpha', 'beta'].map((name) => ({
    id: name,
    kind: 'tool' as const,
    title: `Write ${name}`,
    text: '',
    cwd: '/work',
    done: true,
    diff: [
      {
        path: `/work/${name}.txt`,
        kind: 'add' as const,
        hunks: [
          {
            oldStart: 0,
            newStart: 1,
            lines: Array.from({ length: 12 }, (_, i) => `+${name}_${i + 1}`),
          },
        ],
      },
    ],
  }));

  const { app, coordinator, calls } = fake({ items });
  const copied: string[] = [];

  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      copy: (text) => copied.push(text),
    }),
  );

  const expand = '\u001b[111;5u';

  try {
    await until(
      'the previews',
      () => ui.text().includes('alpha_10') && ui.text().includes('beta_10'),
    );

    ui.stdin.write('draft stays');

    await until('the draft', () => ui.text().includes('draft stays'));

    ui.stdin.write(TAB + expand);

    await until('full alpha', () => ui.text().includes('alpha_12'));

    assert.doesNotMatch(ui.text(), /beta_11|beta_12/);

    assert.match(ui.text(), /CTRL\+O SHOW PREVIEW/);

    const rows = ui.text().split('\n');

    drag(
      ui,
      [1, rows.findIndex((row) => row.includes('alpha_11'))],
      [98, rows.findIndex((row) => row.includes('alpha_12'))],
    );

    await until('the selection', () => ui.frame().includes('\u001b[7m'));

    ui.stdin.write('\u001b[99;9u');

    await until('the numbered copy', () => copied.length > 0);

    assert.deepEqual(copied, ['11 +alpha_11\n12 +alpha_12']);

    ui.stdin.write(ENTER);

    await until('alpha closed', () => !ui.text().includes('alpha_1'));

    ui.stdin.write(ENTER);

    await until('full choice retained', () => ui.text().includes('alpha_12'));

    ui.stdin.write(expand);

    await until('preview restored', () => !ui.text().includes('alpha_11'));

    ui.resize(120);

    await until('narrower body', () => ui.text().includes('alpha_10'));

    ui.stdin.write(ENTER);

    await until(
      'closed before expansion',
      () => !ui.text().includes('alpha_1'),
    );

    ui.stdin.write(expand);

    await until('Ctrl+O opens the full diff', () =>
      ui.text().includes('alpha_12'),
    );

    assert.match(ui.text(), /draft stays/);

    assert.deepEqual(calls, []);

    coordinator.publish({
      conversation: { ...coordinator.snapshot.conversation!, id: 'next' },
    });

    await until(
      'new conversation preview',
      () => ui.text().includes('alpha_10') && !ui.text().includes('alpha_11'),
    );
  } finally {
    ui.unmount();
  }
});

test('batched tool appends preserve selection and a reading position through row views', async () => {
  const output = (text: string) => ({
    id: 'tool',
    kind: 'tool' as const,
    title: 'probe',
    text,
    cwd: '/work',
    done: false,
    shell: true,
  });

  const reply = {
    id: 'reply',
    kind: 'assistant' as const,
    title: 'Assistant',
    text: 'selected words',
    cwd: '/work',
  };

  let items = applyDisplayUpdate(
    applyDisplayUpdate([], output('alpha\n')),
    reply,
  );

  const { app, coordinator } = fake({ items });
  const { ui, copied } = mounted(app, 80, 30);

  const selectReply = async () => {
    const lines = ui.text().split('\n');
    const row = lines.findIndex((line) => line.includes('selected words'));

    assert.ok(row >= 0);

    const column = lines[row]!.indexOf('selected words');

    drag(ui, [column, row], [column + 7, row]);

    await until('the selected reply', () =>
      ui.frame().includes('\u001b[7mselected'),
    );
  };

  const append = (text: string) => {
    items = applyDisplayUpdate(items, output(text));

    coordinator.publish({ items });
  };

  try {
    await until('the reply', () => ui.text().includes('selected words'));

    await selectReply();

    for (const text of ['beta\n', 'gamma\n', 'delta\n']) append(text);

    await until('the batched output', () => ui.text().includes('delta'));

    assert.ok(ui.frame().includes('\u001b[7mselected'));

    ui.stdin.write(CMD_C);

    await until('the copied selection', () => copied.length === 1);

    assert.deepEqual(copied, ['selected']);

    append(
      Array.from({ length: 100 }, (_, index) => `row ${index}\n`).join(''),
    );

    await until('the long output', () => ui.text().includes('row 99'));

    ui.stdin.write(wheelUp.repeat(20));

    await until('the reading position', () =>
      ui.text().includes('READING EARLIER OUTPUT'),
    );

    const first = ui.text().split('\n')[1];

    append('newest row\n');

    await delay(100);

    assert.equal(ui.text().split('\n')[1], first);

    ui.stdin.write('\u001b[6~'.repeat(20));

    await until(
      'following output',
      () => !ui.text().includes('READING EARLIER OUTPUT'),
    );

    assert.ok(ui.text().includes('newest row'));

    ui.resize(70);

    await delay(100);

    assert.ok(ui.text().includes('newest row'));

    await selectReply();

    items = applyDisplayUpdate(items, {
      ...reply,
      text: 'replacement',
      replace: true,
    });

    coordinator.publish({ items });

    await until('the replacement', () => ui.text().includes('replacement'));

    ui.stdin.write(CMD_C);

    await delay(60);

    assert.deepEqual(copied, ['selected']);
  } finally {
    ui.unmount();
  }
});

test('batched assistant Markdown preserves typing, selection and reading position', async () => {
  const output = (text: string) => ({
    id: 'reply',
    kind: 'assistant' as const,
    text,
    cwd: '/work',
  });

  let items = applyDisplayUpdate(
    [],
    output(
      'selected words in first paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\npart',
    ),
  );

  items = applyDisplayUpdate(items, {
    id: 'following',
    kind: 'notice',
    text: 'following notice',
    cwd: '/work',
  });

  const { app, coordinator, calls } = fake({ items, phase: 'running' });
  const { ui, copied } = mounted(app, 80, 30);

  const append = (text: string) => {
    items = applyDisplayUpdate(items, output(text));

    coordinator.publish({ items });
  };

  try {
    await until('the assistant paragraph', () =>
      ui.text().includes('selected words'),
    );

    ui.stdin.write('typed while streaming');

    await until('the typed draft', () =>
      ui.text().includes('typed while streaming'),
    );

    const lines = ui.text().split('\n');
    const row = lines.findIndex((line) => line.includes('selected words'));
    const column = lines[row]!.indexOf('selected words');

    drag(ui, [column, row], [column + 7, row]);

    await until('the selected paragraph', () =>
      ui.frame().includes('\u001b[7mselected'),
    );

    for (const text of ['ial', ' **bold**', '\n\nLast.']) append(text);

    await until('the batched assistant output', () =>
      ui.text().includes('partial bold'),
    );

    assert.ok(ui.frame().includes('\u001b[7mselected'));

    assert.ok(ui.text().includes('typed while streaming'));

    ui.stdin.write(CMD_C);

    await until('the copied paragraph', () => copied.length === 1);

    assert.deepEqual(copied, ['selected']);

    append(
      '\n\n' +
        Array.from(
          { length: 100 },
          (_, index) => `paragraph ${index}\n\n`,
        ).join(''),
    );

    await until('the long assistant output', () =>
      ui.text().includes('paragraph 99'),
    );

    ui.stdin.write(wheelUp.repeat(20));

    await until('the assistant reading position', () =>
      ui.text().includes('READING EARLIER OUTPUT'),
    );

    const first = ui.text().split('\n')[1];

    append('Newest [source](src/newest.ts:9).\n\n');

    await delay(100);

    assert.equal(ui.text().split('\n')[1], first);

    ui.stdin.write('\u001b[6~'.repeat(20));

    await until(
      'following assistant output',
      () =>
        !ui.text().includes('READING EARLIER OUTPUT') &&
        ui.text().includes('Newest source'),
    );

    assert.ok(ui.frame().includes('vscode://file/work/src/newest.ts:9'));

    assert.ok(ui.frame().includes('\u001b[4m'));

    assert.ok(ui.text().includes('following notice'));

    ui.resize(70);

    await delay(100);

    assert.ok(ui.text().includes('Newest source'));

    assert.ok(ui.frame().includes('vscode://file/work/src/newest.ts:9'));

    ui.stdin.write(CMD_C);

    await delay(60);

    assert.deepEqual(copied, ['selected']);

    ui.stdin.write(ENTER);

    await until('the preserved draft is sent', () =>
      calls.some((call) => call[0] === 'send'),
    );

    assert.deepEqual(
      calls.find((call) => call[0] === 'send'),
      ['send', 'typed while streaming', { composer: true }],
    );
  } finally {
    ui.unmount();
  }
});
