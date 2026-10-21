import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import stripAnsi from 'strip-ansi';
import { Graphics, placeholder } from '../src/ui/images.js';
import { TranscriptLayout } from '../src/ui/transcript-layout.js';
import type { FileDiff } from '../src/agents/types.js';
import type { DisplayItem } from '../src/core/state.js';
import { png } from './fixtures/png.js';
import { scratch } from './fixtures/scratch.js';

await test('full diff choices survive cached renders and resizes', () => {
  const item: DisplayItem = {
    id: 'full',
    kind: 'tool',
    title: 'Write',
    text: '',
    cwd: '/work',
    done: true,
    diff: [
      {
        path: '/work/a.txt',
        kind: 'add',
        hunks: [
          {
            oldStart: 0,
            newStart: 1,
            lines: [
              '+' + 'wide '.repeat(20),
              ...Array.from({ length: 11 }, (_, i) => `+line_${i + 2}`),
            ],
          },
        ],
      },
    ],
  };
  const following: DisplayItem = {
    id: 'after',
    kind: 'tool',
    title: 'Following tool',
    text: '',
    cwd: '/work',
    done: true,
  };
  const items = [item, following];
  const layout = new TranscriptLayout();
  for (const full of [false, true, false, true]) {
    const rendered = layout.render(
      items,
      40,
      new Map(),
      new Set(full ? ['full'] : []),
    );
    assert.equal(
      rendered.lines.some((line) => line.includes('line_12')),
      full,
    );
  }
  const full = new Set(['full']);
  const initial = layout.render(items, 40, new Map(), full);
  const last = initial.anchorAt(
    initial.lines.findIndex((line) => line.includes('line_12')),
  )!;
  const after = initial.anchorAt(initial.starts.get('after')!)!;
  for (const width of [100, 30]) {
    const resized = layout.render(items, width, new Map(), full);
    assert.equal(
      stripAnsi(resized.lines[resized.rowOf(last)]!).trim(),
      '12 +line_12',
    );
    assert.equal(
      stripAnsi(resized.lines[resized.rowOf(after)]!),
      '+ ✓ Following tool',
    );
  }
  const closed = layout.render(items, 30, new Map([['full', false]]), full);
  assert.equal(
    closed.lines.some((line) => line.includes('line_12')),
    false,
  );
});

await test('expanding a tool shows its complete output without losing links', () => {
  const item: DisplayItem = {
    id: 'tool',
    kind: 'tool',
    title: 'Build',
    text: 'https://example.com/log\nsrc/main.ts:9\nDone',
    cwd: '/work/project',
    done: true,
  };
  const layout = new TranscriptLayout();
  assert.doesNotMatch(
    stripAnsi(layout.render([item], 60, new Map()).lines.join('\n')),
    /Done/,
  );
  const expanded = layout.render([item], 60, new Map([['tool', true]]));
  assert.match(stripAnsi(expanded.lines.join('\n')), /Done/);
  assert.ok(
    expanded.lines
      .join('\n')
      .includes('vscode://file/work/project/src/main.ts:9'),
  );
});

await test('completed output is cached when another message streams', () => {
  const items: DisplayItem[] = [
    {
      id: 'large',
      kind: 'tool',
      title: 'Long output',
      text: 'log line\n'.repeat(10000),
      cwd: '/work',
      done: true,
    },
    { id: 'reply', kind: 'assistant', text: 'First', cwd: '/work' },
  ];
  const layout = new TranscriptLayout();
  const first = layout.render(items, 80, new Map([['large', true]]));
  const second = layout.render(
    [items[0]!, { ...items[1]!, text: 'First response' }],
    80,
    new Map([['large', true]]),
  );
  assert.equal(first.blocks[0], second.blocks[0]);
  assert.match(stripAnsi(second.lines.at(-2) ?? ''), /First response/);
});

await test('a reading anchor follows its original log line when a narrower window wraps earlier lines', () => {
  const item: DisplayItem = {
    id: 'log',
    kind: 'tool',
    title: 'Build',
    cwd: '/work',
    done: true,
    text: Array.from(
      { length: 1000 },
      (_, index) =>
        `Line ${index + 1}: https://example.com/result/${index + 1}`,
    ).join('\n'),
  };
  const layout = new TranscriptLayout();
  const wide = layout.render([item], 100, new Map([['log', true]]));
  const row = wide.lines.findIndex((line) =>
    stripAnsi(line).startsWith('Line 700:'),
  );
  const anchor = wide.anchorAt(row)!;
  const narrow = layout.render([item], 30, new Map([['log', true]]));
  assert.match(stripAnsi(narrow.lines[narrow.rowOf(anchor)]!), /^Line 700:/);
  assert.doesNotMatch(stripAnsi(narrow.lines[row]!), /^Line 700:/);
});

await test('expanded logs exceed the argument limit with complete output and usable anchors', () => {
  const layout = new TranscriptLayout();
  for (const wrapped of [false, true]) {
    const item: DisplayItem = {
      id: 'large',
      kind: 'tool',
      title: 'Log',
      cwd: '/work',
      done: true,
      text: wrapped
        ? 'x'.repeat(400000)
        : Array<string>(200000).fill('line').join('\n'),
    };
    const output = layout.render(
      [item],
      wrapped ? 2 : 80,
      new Map([['large', true]]),
    );
    assert.equal(
      output.lines.filter(
        (line) => stripAnsi(line) === (wrapped ? 'xx' : 'line'),
      ).length,
      200000,
    );
    assert.equal(stripAnsi(output.lines.at(-2)!), wrapped ? 'xx' : 'line');
    const anchor = output.anchorAt(150000)!;
    assert.equal(anchor.item, 'large');
    if (wrapped) assert.equal(anchor.line, 1);
    assert.equal(output.rowOf(anchor), 150000);
  }
});

await test('a reading anchor keeps its position within a wrapped line after resize', () => {
  const item: DisplayItem = {
    id: 'log',
    kind: 'tool',
    title: 'Log',
    text: 'x'.repeat(10000),
    cwd: '/work',
    done: true,
  };
  const layout = new TranscriptLayout();
  const expanded = new Map([['log', true]]);
  const original = layout.render([item], 80, expanded);
  const anchor = original.anchorAt(90)!;
  assert.equal(original.rowOf(anchor), 90);
  assert.equal(layout.render([item], 40, expanded).rowOf(anchor), 179);
  assert.equal(layout.render([item], 160, expanded).rowOf(anchor), 45);
});

await test('an anchor on a line that no longer renders falls back to its item start', () => {
  const item: DisplayItem = {
    id: 'log',
    kind: 'tool',
    title: 'Log',
    text: 'a\nb\nc',
    cwd: '/work',
    done: true,
  };
  const notice: DisplayItem = {
    id: 'notice',
    kind: 'notice',
    text: 'one\ntwo',
    cwd: '/work',
  };
  const layout = new TranscriptLayout();
  const expanded = layout.render([notice, item], 80, new Map([['log', true]]));
  const anchor = expanded.anchorAt(expanded.starts.get('log')! + 2)!;
  const collapsed = layout.render([notice, item], 80, new Map());
  assert.ok(collapsed.starts.get('log')! > 0);
  assert.equal(collapsed.rowOf(anchor), collapsed.starts.get('log'));
});

await test('a reading anchor includes spaces trimmed while wrapping a title', () => {
  const item: DisplayItem = {
    id: 'log',
    kind: 'tool',
    title: Array.from(
      { length: 20 },
      (_, index) => `word${String(index).padStart(3, '0')}`,
    ).join(' '),
    text: 'body',
    cwd: '/work',
    done: true,
  };
  const layout = new TranscriptLayout();
  const narrow = layout.render([item], 40, new Map());
  const anchor = narrow.anchorAt(2)!;
  assert.match(stripAnsi(narrow.lines[2]!), /^word009/);
  const wide = layout.render([item], 80, new Map());
  assert.equal(wide.rowOf(anchor), 1);
  assert.match(stripAnsi(wide.lines[wide.rowOf(anchor)]!), /^word009/);
});

await test('a title row changed by wrapping does not take another row’s anchor', () => {
  const item: DisplayItem = {
    id: 'tool',
    kind: 'tool',
    title: `${'a'.repeat(53)} \u00a0\u200b ${'b'.repeat(55)} tail`,
    text: '',
    cwd: '/work',
    done: true,
  };
  const output = new TranscriptLayout().render([item], 58, new Map());
  assert.deepEqual(
    output.lines.map((line) => stripAnsi(line)),
    [`+ ✓ ${'a'.repeat(53)}`, `\u200b${'b'.repeat(55)}`, 'tail', ''],
  );
  assert.deepEqual(
    [0, 1, 2, 3].map((row) => output.rowOf(output.anchorAt(row)!)),
    [0, 1, 2, 3],
  );
});

await test('anchors keep item boundaries and wrapped offsets in their own render frame', () => {
  const items: DisplayItem[] = [
    { id: 'first', kind: 'notice', text: 'first', cwd: '/work' },
    {
      id: 'middle',
      kind: 'tool',
      title: 'Build',
      text: 'abcdefghijklmnop\nnext',
      cwd: '/work',
      done: true,
    },
    { id: 'last', kind: 'user', text: 'last', cwd: '/work' },
  ];
  const layout = new TranscriptLayout();
  const first = layout.render(items, 12, new Map([['middle', true]]));
  const expected = [
    ['first', 0, 0],
    ['first', 1, 0],
    ['first', 2, 0],
    ['middle', 0, 0],
    ['middle', 1, 0],
    ['middle', 1, 12],
    ['middle', 2, 0],
    ['middle', 3, 0],
    ['last', 0, 0],
    ['last', 1, 0],
    ['last', 2, 0],
  ].map(([item, line, offset]) => ({ item, line, offset }));
  assert.deepEqual(
    first.lines.map((_, row) => first.anchorAt(row)),
    expected,
  );
  const second = layout.render(items.slice(1), 24, new Map());
  assert.deepEqual(
    second.lines.map((_, row) => second.anchorAt(row)),
    [
      { item: 'middle', line: 0, offset: 0 },
      { item: 'middle', line: 1, offset: 0 },
      { item: 'last', line: 0, offset: 0 },
      { item: 'last', line: 1, offset: 0 },
      { item: 'last', line: 2, offset: 0 },
    ],
  );
  assert.deepEqual(
    first.lines.map((_, row) => first.anchorAt(row)),
    expected,
  );
  assert.equal(first.anchorAt(-1), undefined);
  assert.equal(layout.render([], 12, new Map()).anchorAt(0), undefined);
  assert.deepEqual(first.anchorAt(first.lines.length), {
    item: 'last',
    line: 0,
    offset: 0,
  });
});

await test('anchor lookups stay fast across ten thousand messages', () => {
  const items: DisplayItem[] = Array.from({ length: 10000 }, (_, index) => ({
    id: `message-${index}`,
    kind: 'user',
    text: `message ${index}`,
    cwd: '/work',
  }));
  const output = new TranscriptLayout().render(items, 58, new Map());
  assert.equal(output.lines.length, 30000);
  const expected = items.flatMap((item) =>
    [0, 1, 2].map((line) => ({ item: item.id, line, offset: 0 })),
  );
  const started = performance.now();
  const actual = output.lines.map((_, row) => output.anchorAt(row));
  const elapsed = performance.now() - started;
  assert.deepEqual(actual, expected);
  assert.ok(elapsed < 500, `anchor lookups took ${elapsed} ms`);
});

interface Frame {
  items: DisplayItem[];
  width: number;
  expanded: string[];
}

/** renders each frame on one layout and on a fresh one, which must agree in lines and anchors. */
function sameAsFull(frames: Frame[]) {
  const layout = new TranscriptLayout();
  for (const frame of frames) {
    const expanded = new Map(frame.expanded.map((id) => [id, true]));
    const incremental = layout.render(frame.items, frame.width, expanded);
    const full = new TranscriptLayout().render(
      frame.items,
      frame.width,
      expanded,
    );
    assert.deepEqual(incremental.lines, full.lines);
    for (let row = 0; row < full.lines.length; row++)
      assert.deepEqual(incremental.anchorAt(row), full.anchorAt(row));
  }
}

const tool = (text: string, done = false): DisplayItem => ({
  id: 'tool',
  kind: 'tool',
  title: 'npm test',
  text,
  cwd: '/work',
  done,
});
const early =
  'PASS src/a.ts:1 https://example.com/a\nPASS test/b.test.ts:2\nrun';

for (const [name, frames] of [
  [
    'an append to an expanded running tool',
    [
      { items: [tool(early)], width: 40, expanded: ['tool'] },
      { items: [tool(`${early}ning\nmore`)], width: 40, expanded: ['tool'] },
    ],
  ],
  [
    'a done flip and an append in one update',
    [
      { items: [tool(early)], width: 40, expanded: ['tool'] },
      { items: [tool(`${early} done`, true)], width: 40, expanded: ['tool'] },
    ],
  ],
  [
    'a link split across the append',
    [
      { items: [tool('see src/ma')], width: 40, expanded: ['tool'] },
      {
        items: [tool('see src/main.ts:3\nnext')],
        width: 40,
        expanded: ['tool'],
      },
    ],
  ],
  [
    'a link opened on an earlier line',
    [
      {
        items: [tool('\u001b]8;;https://example.com\u0007start\nmid')],
        width: 40,
        expanded: ['tool'],
      },
      {
        items: [
          tool(
            '\u001b]8;;https://example.com\u0007start\nmiddle\u001b]8;;\u0007',
          ),
        ],
        width: 40,
        expanded: ['tool'],
      },
    ],
  ],
  [
    'a raw newline inside an OSC string',
    [
      {
        items: [tool('PASS a\nstep \u001b]0;build\nlog\u0007one')],
        width: 40,
        expanded: ['tool'],
      },
      {
        items: [tool('PASS a\nstep \u001b]0;build\nlog\u0007one two')],
        width: 40,
        expanded: ['tool'],
      },
    ],
  ],
  [
    'an OSC string that ends after the append',
    [
      {
        items: [tool('PASS a\nstep \u001b]0;build\nlog')],
        width: 40,
        expanded: ['tool'],
      },
      {
        items: [tool('PASS a\nstep \u001b]0;build\nlog\u0007one')],
        width: 40,
        expanded: ['tool'],
      },
    ],
  ],
  [
    'an OSC string opened by a C1 introducer',
    [
      {
        items: [tool('PASS a\nstep \u009b]0;build\nlog')],
        width: 40,
        expanded: ['tool'],
      },
      {
        items: [tool('PASS a\nstep \u009b]0;build\nlog\u0007one')],
        width: 40,
        expanded: ['tool'],
      },
    ],
  ],
  [
    'a replacement that does not extend the text',
    [
      { items: [tool(early)], width: 40, expanded: ['tool'] },
      { items: [tool('replaced output')], width: 40, expanded: ['tool'] },
    ],
  ],
  [
    'an append to a last line that wraps',
    [
      {
        items: [tool('first\nprogress 0123456789abcdef')],
        width: 12,
        expanded: ['tool'],
      },
      {
        items: [tool('first\nprogress 0123456789abcdefghij')],
        width: 12,
        expanded: ['tool'],
      },
    ],
  ],
  [
    'an append to a collapsed tool',
    [
      { items: [tool(early)], width: 40, expanded: [] },
      { items: [tool(`${early} more`)], width: 40, expanded: [] },
    ],
  ],
  [
    'an append after a resize narrower than an earlier line',
    [
      { items: [tool(early)], width: 80, expanded: ['tool'] },
      { items: [tool(early)], width: 12, expanded: ['tool'] },
      { items: [tool(`${early} more`)], width: 12, expanded: ['tool'] },
    ],
  ],
  [
    'a resize, an append, then a resize back',
    [
      { items: [tool(early)], width: 160, expanded: ['tool'] },
      { items: [tool(early)], width: 159, expanded: ['tool'] },
      { items: [tool(`${early} more`)], width: 159, expanded: ['tool'] },
      { items: [tool(`${early} more`)], width: 160, expanded: ['tool'] },
    ],
  ],
  [
    'an append in the frame that expands the tool',
    [
      { items: [tool(early)], width: 40, expanded: ['tool'] },
      { items: [tool(early)], width: 40, expanded: [] },
      { items: [tool(`${early} more`)], width: 40, expanded: ['tool'] },
    ],
  ],
  [
    'an append that also renames the tool',
    [
      { items: [tool('see src/a.ts\nnext')], width: 40, expanded: ['tool'] },
      {
        items: [{ ...tool('see src/a.ts\nnext line'), title: 'npm run test' }],
        width: 40,
        expanded: ['tool'],
      },
    ],
  ],
  [
    'an append that also moves the tool to another directory',
    [
      { items: [tool('see src/a.ts\nnext')], width: 40, expanded: ['tool'] },
      {
        items: [{ ...tool('see src/a.ts\nnext src/b.ts'), cwd: '/other' }],
        width: 40,
        expanded: ['tool'],
      },
    ],
  ],
  [
    'an append to an expanded tool with no output yet',
    [
      { items: [tool('')], width: 40, expanded: ['tool'] },
      { items: [tool('first line')], width: 40, expanded: ['tool'] },
    ],
  ],
  [
    'a streaming heading in an expanded assistant item',
    [
      {
        items: [{ id: 'tool', kind: 'assistant', text: 'Title', cwd: '/work' }],
        width: 40,
        expanded: ['tool'],
      },
      {
        items: [
          { id: 'tool', kind: 'assistant', text: 'Title\n===', cwd: '/work' },
        ],
        width: 40,
        expanded: ['tool'],
      },
    ],
  ],
] as [string, Frame[]][])
  await test(`incremental layout matches a full render for ${name}`, () =>
    sameAsFull(frames));

await test('a warm append to a 20k-line tool costs under a tenth of a full render', () => {
  let text = '';
  for (let index = 0; index < 20000; index++)
    text += `PASS test/case-${index}.test.ts (12 ms) see src/a.ts:${index}\n`;
  const expanded = new Map([['tool', true]]);
  let start = performance.now();
  new TranscriptLayout().render([tool(text)], 118, expanded);
  const full = performance.now() - start;
  const layout = new TranscriptLayout();
  let item = tool(text);
  layout.render([item], 118, expanded);
  const appends: number[] = [];
  for (let index = 0; index < 3; index++) {
    item = tool(`${item.text}PASS test/extra-${index}.test.ts\n`);
    start = performance.now();
    layout.render([item], 118, expanded);
    appends.push(performance.now() - start);
  }
  assert.ok(
    Math.min(...appends) < full / 10,
    `append ${Math.min(...appends)} ms against a full ${full} ms`,
  );
});

await test('a message shows the images it names below its text, and a tool shows its images only while expanded, keeping them as its output grows', async () => {
  const directory = await scratch('witch-layout-');
  await writeFile(join(directory, 'shot.png'), png(160, 80));
  const layout = new TranscriptLayout(new Graphics(() => {}));
  const message: DisplayItem = {
    id: 'message',
    kind: 'user',
    text: 'look at shot.png',
    cwd: directory,
  };
  const tool: DisplayItem = {
    id: 'tool',
    kind: 'tool',
    title: 'Read',
    text: 'Read it',
    cwd: directory,
    done: true,
    images: ['shot.png'],
  };
  const imageRows = (lines: string[]) =>
    lines.filter((line) => line.includes(placeholder)).length;

  const collapsed = layout.render([message, tool], 100, new Map());
  const [shown] = collapsed.blocks;
  assert.equal(imageRows(shown!), 5);
  assert.ok(
    shown!.findIndex((line) => stripAnsi(line).includes('look at shot.png')) <
      shown!.findIndex((line) => line.includes(placeholder)),
  );
  assert.equal(imageRows(collapsed.blocks[1]!), 0);

  const expanded = new Map([['tool', true]]);
  assert.equal(
    imageRows(layout.render([message, tool], 100, expanded).blocks[1]!),
    5,
  );
  const grown = layout.render(
    [message, { ...tool, text: 'Read it\nand more' }],
    100,
    expanded,
  ).blocks[1]!;
  assert.equal(imageRows(grown), 5);
  assert.ok(grown.some((line) => stripAnsi(line).includes('and more')));
});

for (const kind of ['tool', 'user'] as const) {
  await test(`a ${kind}'s image anchors keep their image and closing blank across resizes`, async () => {
    const directory = await scratch('witch-layout-');
    await writeFile(join(directory, 'a.png'), png(800, 200));
    await writeFile(join(directory, 'b.png'), png(800, 160));
    const item: DisplayItem = {
      id: 'images',
      kind,
      text: 'a.png b.png',
      cwd: directory,
      ...(kind === 'tool'
        ? { title: 'Read', done: true, images: ['a.png', 'b.png'] }
        : {}),
    };
    const layout = new TranscriptLayout(new Graphics(() => {}));
    const expanded = new Map([['images', true]]);
    const narrow = layout.render([item], 40, expanded);
    const wide = layout.render([item], 100, expanded);

    assert.equal(narrow.lines.length, 12);
    assert.equal(wide.lines.length, 26);
    assert.equal(narrow.lines[11], '');
    assert.equal(wide.lines[25], '');
    assert.equal(wide.rowOf(narrow.anchorAt(11)!), 25);
    assert.equal(narrow.rowOf(wide.anchorAt(25)!), 11);
    assert.equal(wide.rowOf(narrow.anchorAt(4)!), 4);
    assert.equal(wide.rowOf(narrow.anchorAt(9)!), 17);
    assert.equal(narrow.rowOf(wide.anchorAt(14)!), 6);
    assert.equal(narrow.rowOf(wide.anchorAt(24)!), 10);
  });
}

await test('an image anchor follows wrapped diff output', async () => {
  const directory = await scratch('witch-layout-');
  await writeFile(join(directory, 'a.png'), png(800, 200));
  const item: DisplayItem = {
    id: 'mixed',
    kind: 'tool',
    title: 'Read',
    text: 'Image',
    cwd: directory,
    done: true,
    images: ['a.png'],
    diff: [
      {
        path: '/elsewhere/a.txt',
        kind: 'update',
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            lines: [' ' + 'long '.repeat(30), '-old', '+new', ' tail'],
          },
        ],
      },
    ],
  };
  const layout = new TranscriptLayout(new Graphics(() => {}));
  const expanded = new Map([['mixed', true]]);
  const narrow = layout.render([item], 40, expanded);
  const wide = layout.render([item], 100, expanded);
  const narrowImage = narrow.lines.findIndex((line) =>
    line.includes(placeholder),
  );
  const wideImage = wide.lines.findIndex((line) => line.includes(placeholder));
  assert.equal(narrowImage, 11);
  assert.equal(wideImage, 8);
  assert.equal(wide.rowOf(narrow.anchorAt(narrowImage + 2)!), wideImage + 2);
});

await test("a shell tool row shows expanded until toggled, and an agent's tool row collapsed until toggled", () => {
  const items: DisplayItem[] = [
    {
      id: 's',
      kind: 'tool',
      title: 'ls',
      text: 'shell-a\nshell-b',
      cwd: '/work',
      done: true,
      shell: true,
    },
    {
      id: 't',
      kind: 'tool',
      title: 'Read',
      text: 'agent-x',
      cwd: '/work',
      done: true,
    },
  ];
  const layout = new TranscriptLayout();
  const lines = (expanded: ReadonlyMap<string, boolean>) =>
    stripAnsi(layout.render(items, 60, expanded).lines.join('\n')).split('\n');
  const untoggled = lines(new Map());
  assert.ok(untoggled.includes('− ✓ ls'), untoggled.join('\n'));
  assert.ok(untoggled.includes('shell-a') && untoggled.includes('shell-b'));
  assert.ok(untoggled.includes('+ ✓ Read'));
  assert.ok(!untoggled.includes('agent-x'));
  const toggled = lines(
    new Map([
      ['s', false],
      ['t', true],
    ]),
  );
  assert.ok(toggled.includes('+ ✓ ls'), toggled.join('\n'));
  assert.ok(!toggled.includes('shell-a'));
  assert.ok(toggled.includes('− ✓ Read'));
  assert.ok(toggled.includes('agent-x'));
});

await test('a tool that changed a file under its directory shows its diff until toggled, one elsewhere collapsed until toggled, and a diff that arrives under unchanged output still shows', () => {
  const diff = (path: string): FileDiff[] => [
    {
      path,
      kind: 'update',
      hunks: [{ oldStart: 1, newStart: 1, lines: [' a', '-b', '+B'] }],
    },
  ];
  const items: DisplayItem[] = [
    {
      id: 'in',
      kind: 'tool',
      title: 'Edit in',
      text: '',
      cwd: '/work',
      done: true,
      diff: diff('/work/a.txt'),
    },
    {
      id: 'out',
      kind: 'tool',
      title: 'Edit out',
      text: '',
      cwd: '/work',
      done: true,
      diff: diff('/elsewhere/a.txt'),
    },
  ];
  const layout = new TranscriptLayout();
  const lines = (
    shown: DisplayItem[],
    expanded: ReadonlyMap<string, boolean>,
  ) =>
    layout
      .render(shown, 60, expanded)
      .lines.map((line) => stripAnsi(line).trimEnd());
  const untoggled = lines(items, new Map());
  assert.ok(untoggled.includes('− ✓ Edit in'), untoggled.join('\n'));
  assert.ok(untoggled.includes('Update ./a.txt +1 -1'));
  assert.ok(untoggled.includes('2 +B'));
  assert.ok(untoggled.includes('+ ✓ Edit out'));
  assert.ok(!untoggled.includes('Update /elsewhere/a.txt +1 -1'));
  const toggled = lines(
    items,
    new Map([
      ['in', false],
      ['out', true],
    ]),
  );
  assert.ok(toggled.includes('+ ✓ Edit in'), toggled.join('\n'));
  assert.ok(toggled.includes('− ✓ Edit out'));
  assert.ok(toggled.includes('Update /elsewhere/a.txt +1 -1'));
  assert.ok(!toggled.includes('Update ./a.txt +1 -1'));

  const growing: DisplayItem = {
    id: 'g',
    kind: 'tool',
    title: 'Patch',
    text: 'out\n',
    cwd: '/work',
    done: false,
  };
  lines([growing], new Map([['g', true]]));
  const patched = lines(
    [{ ...growing, diff: diff('/elsewhere/a.txt') }],
    new Map([['g', true]]),
  );
  assert.ok(
    patched.includes('Update /elsewhere/a.txt +1 -1'),
    patched.join('\n'),
  );
});

await test('a tool in a conversation at / shows the diff of a file anywhere until toggled', () => {
  const item: DisplayItem = {
    id: 'root',
    kind: 'tool',
    title: 'Edit root',
    text: '',
    cwd: '/',
    done: true,
    diff: [
      {
        path: '/Users/me/a.txt',
        kind: 'update',
        hunks: [{ oldStart: 1, newStart: 1, lines: [' a', '-b', '+B'] }],
      },
    ],
  };
  const layout = new TranscriptLayout();
  const lines = (expanded: ReadonlyMap<string, boolean>) =>
    layout
      .render([item], 60, expanded)
      .lines.map((line) => stripAnsi(line).trimEnd());
  const untoggled = lines(new Map());
  assert.ok(untoggled.includes('− ✓ Edit root'), untoggled.join('\n'));
  assert.ok(untoggled.includes('Update /Users/me/a.txt +1 -1'));
  assert.ok(lines(new Map([['root', false]])).includes('+ ✓ Edit root'));
});

await test('explicit expansion choices survive a project diff arriving', () => {
  const pending: DisplayItem = {
    id: 'edit',
    kind: 'tool',
    title: 'Edit',
    cwd: '/work',
    text: JSON.stringify({
      file_path: '/work/a.txt',
      old_string: 'b',
      new_string: 'B',
    }),
    done: false,
  };
  const completed: DisplayItem = {
    ...pending,
    text: '',
    done: true,
    diff: [
      {
        path: '/work/a.txt',
        kind: 'update',
        hunks: [{ oldStart: 1, newStart: 1, lines: [' a', '-b', '+B'] }],
      },
    ],
  };
  for (const [choice, before, after] of [
    [undefined, false, true],
    [true, true, true],
    [false, false, false],
  ] as const) {
    const layout = new TranscriptLayout();
    const choices = new Map<string, boolean>();
    if (choice !== undefined) choices.set(pending.id, choice);
    const render = (item: DisplayItem) =>
      layout
        .render([item], 60, choices)
        .lines.map((line) => stripAnsi(line).trimEnd());
    const initial = render(pending);
    assert.equal(initial[0], `${before ? '−' : '+'} … Edit`);
    assert.equal(
      initial.some((line) => line.includes('old_string')),
      before,
    );
    const result = render(completed);
    assert.equal(result[0], `${after ? '−' : '+'} ✓ Edit`);
    assert.equal(result.includes('2 +B'), after);
  }
});

await test('a scroll anchor on a diff line stays on that line when a resize rewraps the lines above it', () => {
  const item: DisplayItem = {
    id: 't',
    kind: 'tool',
    title: 'Edit',
    text: '',
    cwd: '/work',
    done: true,
    diff: [
      {
        path: '/work/a.md',
        kind: 'update',
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            lines: [' ' + 'long '.repeat(30), '-old', '+new', ' tail'],
          },
        ],
      },
    ],
  };
  const layout = new TranscriptLayout();
  const plainAt = (width: number, row: number) =>
    stripAnsi(layout.render([item], width, new Map()).lines[row]!).trimEnd();
  const narrow = layout.render([item], 40, new Map());
  const tail = narrow.lines.findIndex((line) =>
    stripAnsi(line).includes('tail'),
  );
  const continuation = narrow.anchorAt(3)!;
  const anchor = narrow.anchorAt(tail)!;
  const wide = layout.render([item], 200, new Map());
  assert.equal(stripAnsi(wide.lines[wide.rowOf(anchor)]!).trimEnd(), '3  tail');
  // the long line no longer wraps, so its continuation's anchor lands on the line itself
  assert.match(plainAt(200, wide.rowOf(continuation)), /^1 {2}long long/);
  assert.equal(
    plainAt(30, layout.render([item], 30, new Map()).rowOf(anchor)),
    '3  tail',
  );
});
