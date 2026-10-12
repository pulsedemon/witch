import assert from 'node:assert/strict';
import { test } from 'node:test';
import stripAnsi from 'strip-ansi';
import { TranscriptLayout } from '../src/ui/transcript-layout.js';
import type { DisplayItem } from '../src/core/state.js';

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
    stripAnsi(layout.render([item], 60, new Set()).lines.join('\n')),
    /Done/,
  );
  const expanded = layout.render([item], 60, new Set(['tool']));
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
  const first = layout.render(items, 80, new Set(['large']));
  const second = layout.render(
    [items[0]!, { ...items[1]!, text: 'First response' }],
    80,
    new Set(['large']),
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
  const wide = layout.render([item], 100, new Set(['log']));
  const row = wide.lines.findIndex((line) =>
    stripAnsi(line).startsWith('Line 700:'),
  );
  const anchor = wide.anchorAt(row)!;
  const narrow = layout.render([item], 30, new Set(['log']));
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
    const output = layout.render([item], wrapped ? 2 : 80, new Set(['large']));
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
  const expanded = new Set(['log']);
  const original = layout.render([item], 80, expanded);
  const anchor = original.anchorAt(90)!;
  assert.equal(original.rowOf(anchor), 90);
  assert.equal(layout.render([item], 40, expanded).rowOf(anchor), 179);
  assert.equal(layout.render([item], 160, expanded).rowOf(anchor), 45);
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
  const narrow = layout.render([item], 40, new Set());
  const anchor = narrow.anchorAt(2)!;
  assert.match(stripAnsi(narrow.lines[2]!), /^word009/);
  const wide = layout.render([item], 80, new Set());
  assert.equal(wide.rowOf(anchor), 1);
  assert.match(stripAnsi(wide.lines[wide.rowOf(anchor)]!), /^word009/);
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
    const expanded = new Set(frame.expanded);
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
  const expanded = new Set(['tool']);
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
