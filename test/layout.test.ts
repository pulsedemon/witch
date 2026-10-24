import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Lexer } from 'marked';
import stripAnsi from 'strip-ansi';
import { Graphics, placeholder } from '../src/ui/images.js';
import { TranscriptLayout } from '../src/ui/transcript-layout.js';
import type { FileDiff } from '../src/agents/types.js';
import type { DisplayItem, DisplayUpdate } from '../src/core/state.js';
import { applyDisplayUpdate, foldDisplayUpdates } from '../src/core/state.js';
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
      rendered.lines.slice().some((line) => line.includes('line_12')),
      full,
    );
  }
  const full = new Set(['full']);
  const initial = layout.render(items, 40, new Map(), full);
  const last = initial.anchorAt(
    initial.lines.slice().findIndex((line) => line.includes('line_12')),
  )!;
  const after = initial.anchorAt(initial.starts.get('after')!)!;
  for (const width of [100, 30]) {
    const resized = layout.render(items, width, new Map(), full);
    assert.equal(
      stripAnsi(resized.lines.at(resized.rowOf(last))!).trim(),
      '12 +line_12',
    );
    assert.equal(
      stripAnsi(resized.lines.at(resized.rowOf(after))!),
      '+ ✓ Following tool',
    );
  }
  const closed = layout.render(items, 30, new Map([['full', false]]), full);
  assert.equal(
    closed.lines.slice().some((line) => line.includes('line_12')),
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
    stripAnsi(layout.render([item], 60, new Map()).lines.slice().join('\n')),
    /Done/,
  );
  const expanded = layout.render([item], 60, new Map([['tool', true]]));
  assert.match(stripAnsi(expanded.lines.slice().join('\n')), /Done/);
  assert.ok(
    expanded.lines
      .slice()
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
  const row = wide.lines
    .slice()
    .findIndex((line) => stripAnsi(line).startsWith('Line 700:'));
  const anchor = wide.anchorAt(row)!;
  const narrow = layout.render([item], 30, new Map([['log', true]]));
  assert.match(stripAnsi(narrow.lines.at(narrow.rowOf(anchor))!), /^Line 700:/);
  assert.doesNotMatch(stripAnsi(narrow.lines.at(row)!), /^Line 700:/);
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
      output.lines
        .slice()
        .filter((line) => stripAnsi(line) === (wrapped ? 'xx' : 'line')).length,
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
  assert.match(stripAnsi(narrow.lines.at(2)!), /^word009/);
  const wide = layout.render([item], 80, new Map());
  assert.equal(wide.rowOf(anchor), 1);
  assert.match(stripAnsi(wide.lines.at(wide.rowOf(anchor))!), /^word009/);
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
    output.lines.slice().map((line) => stripAnsi(line)),
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
    first.lines.slice().map((_, row) => first.anchorAt(row)),
    expected,
  );
  const second = layout.render(items.slice(1), 24, new Map());
  assert.deepEqual(
    second.lines.slice().map((_, row) => second.anchorAt(row)),
    [
      { item: 'middle', line: 0, offset: 0 },
      { item: 'middle', line: 1, offset: 0 },
      { item: 'last', line: 0, offset: 0 },
      { item: 'last', line: 1, offset: 0 },
      { item: 'last', line: 2, offset: 0 },
    ],
  );
  assert.deepEqual(
    first.lines.slice().map((_, row) => first.anchorAt(row)),
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
  const actual = output.lines.slice().map((_, row) => output.anchorAt(row));
  const elapsed = performance.now() - started;
  assert.deepEqual(actual, expected);
  assert.ok(elapsed < 500, `anchor lookups took ${elapsed} ms`);
});

interface Frame {
  updates: DisplayUpdate[];
  width: number;
  expanded: string[];
}

function sameAsFull(frames: Frame[]) {
  const layout = new TranscriptLayout();
  let items: DisplayItem[] = [];
  for (const frame of frames) {
    for (const update of frame.updates)
      items = applyDisplayUpdate(items, update);
    const expanded = new Map(frame.expanded.map((id) => [id, true]));
    const incremental = layout.render(items, frame.width, expanded);
    const full = new TranscriptLayout().render(items, frame.width, expanded);
    assert.deepEqual(incremental.lines.slice(), full.lines.slice());
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

await test('an OSC 8 separator arriving after a terminator rebuilds the uncertain tail', () => {
  for (const stable of ['', 'stable\n']) {
    const prefix =
      stable +
      '\u001b]8;x\u0007\n' +
      'earlier line\n'.repeat(stable ? 2000 : 1);
    let items = applyDisplayUpdate([], tool(prefix));
    const layout = new TranscriptLayout();
    const expanded = new Map([['tool', true]]);
    const before = layout.render(items, 100, expanded);
    const saved = before.lines.slice();
    items = applyDisplayUpdate(items, tool(';https://x.test/\u0007one\ntwo'));
    const frame = layout.render(items, 100, expanded);
    assert.deepEqual(
      frame.lines.slice(1, -1).map(stripAnsi),
      stable ? ['stable', 'one', 'two'] : ['one', 'two'],
    );
    for (const row of frame.lines.slice(-3, -1)) {
      assert.ok(row.includes('\u001b]8;;https://x.test/\u0007'));
      assert.ok(row.includes('\u001b[4m'));
      assert.ok(!row.includes('https://x.test/one'));
    }
    for (const row of [1, 2])
      assert.deepEqual(frame.anchorAt(row + Number(!!stable)), {
        item: 'tool',
        line: row + Number(!!stable),
        offset: 0,
      });
    const fresh = new TranscriptLayout().render(items, 100, expanded);
    assert.deepEqual(frame.lines.slice(), fresh.lines.slice());
    for (let row = 0; row < frame.lines.length; row++)
      assert.deepEqual(frame.anchorAt(row), fresh.anchorAt(row));
    assert.deepEqual(before.lines.slice(), saved);
  }
});

for (const [name, prefix, suffix, body, target] of [
  [
    'URL',
    'see https://exa',
    'mple.com/a\nnext',
    ['see https://example.com/a', 'next'],
    'https://example.com/a',
  ],
  [
    'quoted path near a link chunk boundary',
    'x'.repeat(1980) + '\n"src/notes ',
    'chapter.md"\nnext',
    ['x'.repeat(1980), '"src/notes chapter.md"', 'next'],
    'vscode://file/work/src/notes%20chapter.md',
  ],
  ['grapheme', 'a\ud83d', '\ude00z', ['a😀z'], undefined],
] as const)
  await test(`an append completes a ${name} without changing earlier output`, () => {
    let items = applyDisplayUpdate([], tool(prefix));
    const layout = new TranscriptLayout();
    const expanded = new Map([['tool', true]]);
    layout.render(items, 2200, expanded);
    items = applyDisplayUpdate(items, tool(suffix));
    const frame = layout.render(items, 2200, expanded);
    assert.deepEqual(frame.lines.slice(1, -1).map(stripAnsi), body);
    if (target)
      assert.ok(
        frame.lines.slice().join('\n').includes(`\u001b]8;;${target}\u0007`),
      );
    const fresh = new TranscriptLayout().render(items, 2200, expanded);
    assert.deepEqual(frame.lines.slice(), fresh.lines.slice());
  });

for (const [name, frames] of [
  [
    'skipped link updates in the same frame as a resize',
    [
      { updates: [tool('first\nsee src/ma')], width: 80, expanded: ['tool'] },
      {
        updates: [tool('in.ts:3\nhttps://exa'), tool('mple.com/log\nlast')],
        width: 30,
        expanded: ['tool'],
      },
      { updates: [], width: 80, expanded: ['tool'] },
    ],
  ],
  [
    'an unresolved OSC opener across resizes and appends',
    [
      {
        updates: [tool('first\n\u001b]8;x\u0007\nfoo')],
        width: 80,
        expanded: ['tool'],
      },
      { updates: [], width: 30, expanded: ['tool'] },
      {
        updates: [tool(';https://x.test/\u0007one\ntwo')],
        width: 40,
        expanded: ['tool'],
      },
      { updates: [], width: 80, expanded: ['tool'] },
    ],
  ],
  [
    'an append to an expanded running tool',
    [
      { updates: [tool(early)], width: 40, expanded: ['tool'] },
      { updates: [tool('ning\nmore')], width: 40, expanded: ['tool'] },
    ],
  ],
  [
    'a done flip and an append in one update',
    [
      { updates: [tool(early)], width: 40, expanded: ['tool'] },
      { updates: [tool(' done', true)], width: 40, expanded: ['tool'] },
    ],
  ],
  [
    'a link split across the append',
    [
      { updates: [tool('see src/ma')], width: 40, expanded: ['tool'] },
      {
        updates: [tool('in.ts:3\nnext')],
        width: 40,
        expanded: ['tool'],
      },
    ],
  ],
  [
    'a link opened on an earlier line',
    [
      {
        updates: [tool('\u001b]8;;https://example.com\u0007start\nmid')],
        width: 40,
        expanded: ['tool'],
      },
      {
        updates: [tool('dle\u001b]8;;\u0007')],
        width: 40,
        expanded: ['tool'],
      },
    ],
  ],
  [
    'a raw newline inside an OSC string',
    [
      {
        updates: [tool('PASS a\nstep \u001b]0;build\nlog\u0007one')],
        width: 40,
        expanded: ['tool'],
      },
      {
        updates: [tool(' two')],
        width: 40,
        expanded: ['tool'],
      },
    ],
  ],
  [
    'an OSC string that ends after the append',
    [
      {
        updates: [tool('PASS a\nstep \u001b]0;build\nlog')],
        width: 40,
        expanded: ['tool'],
      },
      {
        updates: [tool('\u0007one')],
        width: 40,
        expanded: ['tool'],
      },
    ],
  ],
  [
    'an OSC string opened by a C1 introducer',
    [
      {
        updates: [tool('PASS a\nstep \u009b]0;build\nlog')],
        width: 40,
        expanded: ['tool'],
      },
      {
        updates: [tool('\u0007one')],
        width: 40,
        expanded: ['tool'],
      },
    ],
  ],
  [
    'a replacement that does not extend the text',
    [
      { updates: [tool(early)], width: 40, expanded: ['tool'] },
      {
        updates: [{ ...tool('replaced output'), replace: true }],
        width: 40,
        expanded: ['tool'],
      },
    ],
  ],
  [
    'an append to a last line that wraps',
    [
      {
        updates: [tool('first\nprogress 0123456789abcdef')],
        width: 12,
        expanded: ['tool'],
      },
      {
        updates: [tool('ghij')],
        width: 12,
        expanded: ['tool'],
      },
    ],
  ],
  [
    'an append to a collapsed tool',
    [
      { updates: [tool(early)], width: 40, expanded: [] },
      { updates: [tool(' more')], width: 40, expanded: [] },
    ],
  ],
  [
    'an append after a resize narrower than an earlier line',
    [
      { updates: [tool(early)], width: 80, expanded: ['tool'] },
      { updates: [], width: 12, expanded: ['tool'] },
      { updates: [tool(' more')], width: 12, expanded: ['tool'] },
    ],
  ],
  [
    'a resize, an append, then a resize back',
    [
      { updates: [tool(early)], width: 160, expanded: ['tool'] },
      { updates: [], width: 159, expanded: ['tool'] },
      { updates: [tool(' more')], width: 159, expanded: ['tool'] },
      { updates: [], width: 160, expanded: ['tool'] },
    ],
  ],
  [
    'an append in the frame that expands the tool',
    [
      { updates: [tool(early)], width: 40, expanded: ['tool'] },
      { updates: [], width: 40, expanded: [] },
      { updates: [tool(' more')], width: 40, expanded: ['tool'] },
    ],
  ],
  [
    'an append that also renames the tool',
    [
      { updates: [tool('see src/a.ts\nnext')], width: 40, expanded: ['tool'] },
      {
        updates: [{ ...tool(' line'), title: 'npm run test' }],
        width: 40,
        expanded: ['tool'],
      },
    ],
  ],
  [
    'a replacement that also moves the tool to another directory',
    [
      { updates: [tool('see src/a.ts\nnext')], width: 40, expanded: ['tool'] },
      {
        updates: [
          {
            ...tool('see src/a.ts\nnext src/b.ts'),
            cwd: '/other',
            replace: true,
          },
        ],
        width: 40,
        expanded: ['tool'],
      },
    ],
  ],
  [
    'an append to an expanded tool with no output yet',
    [
      { updates: [tool('')], width: 40, expanded: ['tool'] },
      { updates: [tool('first line')], width: 40, expanded: ['tool'] },
    ],
  ],
  [
    'a streaming heading in an expanded assistant item',
    [
      {
        updates: [
          { id: 'tool', kind: 'assistant', text: 'Title', cwd: '/work' },
        ],
        width: 40,
        expanded: ['tool'],
      },
      {
        updates: [
          { id: 'tool', kind: 'assistant', text: '\n===', cwd: '/work' },
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
  let items = applyDisplayUpdate([], tool(text));
  layout.render(items, 118, expanded);
  const appends: number[] = [];
  for (let index = 0; index < 3; index++) {
    items = applyDisplayUpdate(
      items,
      tool(`PASS test/extra-${index}.test.ts\n`),
    );
    start = performance.now();
    layout.render(items, 118, expanded);
    appends.push(performance.now() - start);
  }
  assert.ok(
    Math.min(...appends) < full / 10,
    `append ${Math.min(...appends)} ms against a full ${full} ms`,
  );
});

await test('layout receives every skipped append and rebuilds after replacements or unrelated history', () => {
  for (const replay of [false, true]) {
    const seed = [tool('first\n'), tool('part')];
    let items = replay
      ? foldDisplayUpdates(seed)
      : seed.reduce(applyDisplayUpdate, [] as DisplayItem[]);
    const base = items;
    const layout = new TranscriptLayout();
    const expanded = new Map([['tool', true]]);
    const body = () =>
      layout.render(items, 80, expanded).lines.slice(1, -1).map(stripAnsi);
    assert.deepEqual(body(), ['first', 'part']);
    for (const delta of ['ial', '\nsecond', '\nthird'])
      items = applyDisplayUpdate(items, tool(delta));
    assert.deepEqual(body(), ['first', 'partial', 'second', 'third']);
    items = applyDisplayUpdate(items, {
      ...tool('first\npartial\nsecond\nthird replaced'),
      replace: true,
    });
    assert.deepEqual(body(), ['first', 'partial', 'second', 'third replaced']);
    items = applyDisplayUpdate(items, tool('\nlast'));
    assert.deepEqual(body(), [
      'first',
      'partial',
      'second',
      'third replaced',
      'last',
    ]);
    items = applyDisplayUpdate(items, tool(''));
    assert.deepEqual(body(), [
      'first',
      'partial',
      'second',
      'third replaced',
      'last',
    ]);
    items = applyDisplayUpdate(base, tool(' sibling'));
    assert.deepEqual(body(), ['first', 'part sibling']);
    items = applyDisplayUpdate(
      applyDisplayUpdate(base, tool(' other')),
      tool(' branch'),
    );
    assert.deepEqual(body(), ['first', 'part other branch']);
    items = base;
    assert.deepEqual(body(), ['first', 'part']);
    items = [tool('independent')];
    assert.deepEqual(body(), ['independent']);
  }
});

await test('an earlier layout frame retains its rows and anchors after the tool grows', () => {
  const following: DisplayItem = {
    id: 'after',
    kind: 'notice',
    text: 'after',
    cwd: '/work',
  };
  let items = applyDisplayUpdate([], tool('first\npart'));
  items = applyDisplayUpdate(items, following);
  const layout = new TranscriptLayout();
  const expanded = new Map([['tool', true]]);
  const before = layout.render(items, 80, expanded);
  const lines = before.lines.slice();
  const anchors = lines.map((_, row) => before.anchorAt(row)!);
  const positions = anchors.map((anchor) => before.rowOf(anchor));
  const starts = [...before.starts];
  assert.equal(before.starts.get('after'), 4);
  for (const [delta, width] of [
    ['ial', 40],
    ['\nsecond\n', 80],
    ['third', 30],
  ] as const) {
    items = applyDisplayUpdate(items, tool(delta));
    layout.render(items, width, expanded);
  }
  const after = layout.render(items, 80, expanded);
  assert.deepEqual(after.lines.slice(1, 5).map(stripAnsi), [
    'first',
    'partial',
    'second',
    'third',
  ]);
  assert.equal(after.starts.get('after'), 6);
  assert.deepEqual(before.lines.slice(), lines);
  assert.deepEqual([...before.starts], starts);
  assert.deepEqual(
    lines.map((_, row) => before.anchorAt(row)),
    anchors,
  );
  assert.deepEqual(
    anchors.map((anchor) => before.rowOf(anchor)),
    positions,
  );
  const page = after.lines.slice(0, 2);
  page[0] = 'highlighted';
  assert.notEqual(after.lines.at(0), 'highlighted');
  assert.equal(after.lines.at(-2), 'after');
  assert.deepEqual(after.lines.slice(-2), ['after', '']);
});

await test('warm tool appends and a fixed page do not scale with completed prefix rows', () => {
  const expanded = new Map([['tool', true]]);
  const results: number[] = [];
  for (const count of [2000, 100000]) {
    let items = applyDisplayUpdate(
      [],
      tool('plain output row\n'.repeat(count)),
    );
    const layout = new TranscriptLayout();
    layout.render(items, 100, expanded);
    const append = () => {
      items = applyDisplayUpdate(items, tool('appended row\n'));
      const frame = layout.render(items, 100, expanded);
      assert.equal(frame.lines.slice(-30).length, 30);
      assert.equal(frame.lines.at(-3), 'appended row');
    };
    for (let index = 0; index < 10; index++) append();
    const samples: number[] = [];
    for (let batch = 0; batch < 5; batch++) {
      const started = process.cpuUsage();
      for (let index = 0; index < 50; index++) append();
      const used = process.cpuUsage(started);
      samples.push((used.user + used.system) / 50000);
    }
    results.push(samples.sort((a, b) => a - b)[2]!);
  }
  const [small, large] = results as [number, number];
  assert.ok(
    large <= small * 4 + 0.5,
    `append CPU: ${small} ms at 2k rows, ${large} ms at 100k`,
  );
});

await test('an image arriving with an append replaces the text-only cached block', async () => {
  const directory = await scratch('witch-layout-');
  await writeFile(join(directory, 'shot.png'), png(160, 80));
  const layout = new TranscriptLayout(new Graphics(() => {}));
  const expanded = new Map([['tool', true]]);
  let items = applyDisplayUpdate([], { ...tool('read\n'), cwd: directory });
  const before = layout.render(items, 100, expanded);
  assert.ok(!before.lines.slice().some((line) => line.includes(placeholder)));
  items = applyDisplayUpdate(items, {
    ...tool('finished'),
    cwd: directory,
    images: ['shot.png'],
  });
  const frame = layout.render(items, 100, expanded);
  const rows = frame.lines.slice();
  const first = rows.findIndex((line) => line.includes(placeholder));
  assert.equal(rows.filter((line) => line.includes(placeholder)).length, 5);
  assert.deepEqual(frame.anchorAt(first), { item: 'tool', line: 3, offset: 0 });
  assert.equal(frame.rowOf({ item: 'tool', line: 3, offset: 4 }), first + 4);
  assert.ok(!before.lines.slice().some((line) => line.includes(placeholder)));
});

await test('an append retries a named image that was unavailable during the first render', async () => {
  for (const [initial, imageLine] of [
    ['', 2],
    ['waiting\n', 3],
  ] as const) {
    const directory = await scratch('witch-layout-');
    const layout = new TranscriptLayout(new Graphics(() => {}));
    const expanded = new Map([['tool', true]]);
    let items = applyDisplayUpdate([], {
      ...tool(initial),
      cwd: directory,
      images: ['shot.png'],
    });
    const before = layout.render(items, 100, expanded);
    assert.ok(!before.lines.slice().some((line) => line.includes(placeholder)));
    const images = items[0]!.images;
    await writeFile(join(directory, 'shot.png'), png(160, 80));
    items = applyDisplayUpdate(items, { ...tool('ready'), cwd: directory });
    assert.equal(items[0]!.images, images);
    const frame = layout.render(items, 100, expanded);
    const rows = frame.lines.slice();
    const first = rows.findIndex((line) => line.includes(placeholder));
    assert.equal(rows.filter((line) => line.includes(placeholder)).length, 5);
    assert.deepEqual(frame.anchorAt(first), {
      item: 'tool',
      line: imageLine,
      offset: 0,
    });
    assert.equal(
      frame.rowOf({ item: 'tool', line: imageLine, offset: 4 }),
      first + 4,
    );
    assert.ok(!before.lines.slice().some((line) => line.includes(placeholder)));
  }
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
  assert.equal(imageRows(shown!.slice()), 5);
  assert.ok(
    shown!
      .slice()
      .findIndex((line) => stripAnsi(line).includes('look at shot.png')) <
      shown!.slice().findIndex((line) => line.includes(placeholder)),
  );
  assert.equal(imageRows(collapsed.blocks[1]!.slice()), 0);

  const expanded = new Map([['tool', true]]);
  assert.equal(
    imageRows(layout.render([message, tool], 100, expanded).blocks[1]!.slice()),
    5,
  );
  const grown = layout
    .render([message, { ...tool, text: 'Read it\nand more' }], 100, expanded)
    .blocks[1]!.slice();
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
    assert.equal(narrow.lines.at(11), '');
    assert.equal(wide.lines.at(25), '');
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
  const narrowImage = narrow.lines
    .slice()
    .findIndex((line) => line.includes(placeholder));
  const wideImage = wide.lines
    .slice()
    .findIndex((line) => line.includes(placeholder));
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
    stripAnsi(
      layout.render(items, 60, expanded).lines.slice().join('\n'),
    ).split('\n');
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
      .lines.slice()
      .map((line) => stripAnsi(line).trimEnd());
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
      .lines.slice()
      .map((line) => stripAnsi(line).trimEnd());
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
        .lines.slice()
        .map((line) => stripAnsi(line).trimEnd());
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
    stripAnsi(layout.render([item], width, new Map()).lines.at(row)!).trimEnd();
  const narrow = layout.render([item], 40, new Map());
  const tail = narrow.lines
    .slice()
    .findIndex((line) => stripAnsi(line).includes('tail'));
  const continuation = narrow.anchorAt(3)!;
  const anchor = narrow.anchorAt(tail)!;
  const wide = layout.render([item], 200, new Map());
  assert.equal(
    stripAnsi(wide.lines.at(wide.rowOf(anchor))!).trimEnd(),
    '3  tail',
  );
  // the long line no longer wraps, so its continuation's anchor lands on the line itself
  assert.match(plainAt(200, wide.rowOf(continuation)), /^1 {2}long long/);
  assert.equal(
    plainAt(30, layout.render([item], 30, new Map()).rowOf(anchor)),
    '3  tail',
  );
});

const assistant = (text: string): DisplayItem => ({
  id: 'reply',
  kind: 'assistant',
  text,
  cwd: '/work',
});

await test('assistant appends keep Markdown rows and anchors correct through syntax changes', () => {
  for (const source of [
    'First.\n\nSecond.\n\nHeading\n---\n\nAfter',
    'First.\n\nSecond.\n\n- first\n\n  next\n\nAfter',
    'First.\n\nSecond.\n\n```\n```\n\nAfter',
    'First.\n\nSecond.\n\n```\n**literal**\n```\n\nAfter',
    '[Guide][g]\n\nSecond.\n\nThird.\n\n[g]: src/guide.ts\n\nAfter',
    '[Guide][g]\n\nSecond.\n\nThird.\n\n> [g]: src/guide.ts\n',
    'First.\n\nSecond.\n\n<a>\n\nwww.example\n\n</a>',
    'First.\n\nSecond.\n\nNext\r\n\r\nLast',
    'First.\n\nSecond.\n\ne\u0301 🐈\n\na | b\n---|---\n1|2',
  ]) {
    const frames = source.split('').map((text) => ({
      updates: [assistant(text)],
      width: 40,
      expanded: [],
    }));
    sameAsFull(frames);
    sameAsFull(
      frames.map((frame, index) => ({
        ...frame,
        width: [40, 80, 31][index % 3]!,
      })),
    );
  }
});

await test('assistant layout follows batched ancestry and rebuilds for replacements or metadata changes', () => {
  for (const replay of [false, true]) {
    const seed = [assistant('First.\n\nSecond.\n\n'), assistant('part')];
    let items = replay
      ? foldDisplayUpdates(seed)
      : seed.reduce(applyDisplayUpdate, [] as DisplayItem[]);
    const base = items;
    const layout = new TranscriptLayout();
    const check = (expected: string, width = 80) => {
      const frame = layout.render(items, width, new Map());
      const fresh = new TranscriptLayout().render(items, width, new Map());
      assert.deepEqual(frame.lines.slice(), fresh.lines.slice());
      for (let row = 0; row < frame.lines.length; row++)
        assert.deepEqual(frame.anchorAt(row), fresh.anchorAt(row));
      assert.equal(
        frame.lines.slice(1, -1).map(stripAnsi).join('\n'),
        expected,
      );
      return frame;
    };
    check('First.\n\nSecond.\n\npart');
    for (const delta of ['ial', '\n\nLast.', ''])
      items = applyDisplayUpdate(items, assistant(delta));
    check('First.\n\nSecond.\n\npartial\n\nLast.');
    items = applyDisplayUpdate(items, {
      ...assistant('First.\n\nSecond.\n\npartial replaced'),
      replace: true,
    });
    check('First.\n\nSecond.\n\npartial replaced');
    items = applyDisplayUpdate(items, assistant('\n\nNew.'));
    for (const width of [80, 31, 80])
      check('First.\n\nSecond.\n\npartial replaced\n\nNew.', width);
    items = applyDisplayUpdate(base, assistant(' sibling'));
    check('First.\n\nSecond.\n\npart sibling');
    items = applyDisplayUpdate(
      applyDisplayUpdate(base, assistant(' other')),
      assistant(' branch'),
    );
    check('First.\n\nSecond.\n\npart other branch');
    items = base;
    check('First.\n\nSecond.\n\npart');
    items = [assistant('independent')];
    check('independent');
    items = applyDisplayUpdate(items, {
      ...assistant('src/changed.ts:7'),
      cwd: '/other',
      title: 'New title',
      replace: true,
    });
    const moved = check('src/changed.ts:7');
    assert.equal(stripAnsi(moved.lines.at(0)!), 'New title');
    assert.ok(
      moved.lines.at(1)!.includes('vscode://file/other/src/changed.ts:7'),
    );
    items = applyDisplayUpdate(items, {
      ...assistant('**literal**'),
      kind: 'tool',
      replace: true,
      shell: true,
    });
    check('**literal**');
  }
});

await test('earlier assistant frames survive appends and a reference that changes completed rows', () => {
  const layout = new TranscriptLayout();
  let items = applyDisplayUpdate(
    [],
    assistant('[Guide][g]\n\nSecond.\n\nThird.\n\npart'),
  );
  items = applyDisplayUpdate(items, {
    id: 'following',
    kind: 'notice',
    text: 'following notice',
    cwd: '/work',
  });
  const before = layout.render(items, 40, new Map());
  const lines = before.lines.slice();
  const anchors = lines.map((_, row) => before.anchorAt(row)!);
  const rows = anchors.map((anchor) => before.rowOf(anchor));
  const starts = [...before.starts];
  for (const [text, width] of [
    ['ial\n\nNext.', 80],
    ['\n\n[g]: src/guide.ts\n', 30],
    ['\nLast.', 40],
  ] as const) {
    items = applyDisplayUpdate(items, assistant(text));
    const frame = layout.render(items, width, new Map());
    const fresh = new TranscriptLayout().render(items, width, new Map());
    assert.deepEqual(frame.lines.slice(), fresh.lines.slice());
    assert.ok(frame.starts.get('following')! > before.starts.get('following')!);
    assert.deepEqual(before.lines.slice(), lines);
    assert.deepEqual([...before.starts], starts);
    assert.deepEqual(
      lines.map((_, row) => before.anchorAt(row)),
      anchors,
    );
    assert.deepEqual(
      anchors.map((anchor) => before.rowOf(anchor)),
      rows,
    );
  }
  const final = layout.render(items, 40, new Map());
  assert.ok(final.lines.at(1)!.includes('vscode://file/work/src/guide.ts'));
  assert.equal(stripAnsi(final.lines.at(-2)!), 'following notice');
});

await test('completed assistant blocks have bounded parsing and wrapping work', (t) => {
  const lex = Lexer.prototype.lex;
  const normalize = String.prototype.normalize;
  let parsed = 0;
  let wrapped = 0;
  let measure = false;
  t.mock.method(Lexer.prototype, 'lex', function (this: Lexer, source: string) {
    if (measure) parsed += source.length;
    return lex.call(this, source);
  });
  t.mock.method(
    String.prototype,
    'normalize',
    function (this: string, form?: string) {
      if (measure) wrapped += this.length;
      return normalize.call(this, form);
    },
  );
  const counts: { parsed: number; wrapped: number }[] = [];
  for (const size of [51200, 102400]) {
    const paragraph =
      'A completed paragraph has text, **emphasis**, and src/main.ts:9.\n\n';
    const text = paragraph
      .repeat(Math.ceil(size / paragraph.length))
      .slice(0, size);
    const layout = new TranscriptLayout();
    let items: DisplayItem[] = [];
    parsed = 0;
    wrapped = 0;
    measure = true;
    for (let offset = 0; offset < text.length; offset += 1024) {
      items = applyDisplayUpdate(
        items,
        assistant(text.slice(offset, offset + 1024)),
      );
      layout.render(items, 80, new Map()).lines.slice(-30);
    }
    items = applyDisplayUpdate(items, { ...assistant(text), replace: true });
    const final = layout.render(items, 80, new Map());
    measure = false;
    assert.ok(parsed <= 4 * size, `parsed ${parsed} characters for ${size}`);
    assert.ok(
      wrapped <= 6 * size,
      `wrapped ${wrapped} plain characters for ${size}`,
    );
    counts.push({ parsed, wrapped });
    const fresh = new TranscriptLayout().render(items, 80, new Map());
    assert.deepEqual(final.lines.slice(), fresh.lines.slice());
    for (let row = 0; row < final.lines.length; row++)
      assert.deepEqual(final.anchorAt(row), fresh.anchorAt(row));
    assert.equal(
      stripAnsi(final.lines.at(1)!),
      'A completed paragraph has text, emphasis, and src/main.ts:9.',
    );
    assert.ok(final.lines.at(1)!.includes('vscode://file/work/src/main.ts:9'));
    t.diagnostic(JSON.stringify({ size, parsed, wrapped }));
  }
  for (const field of ['parsed', 'wrapped'] as const)
    assert.ok(counts[1]![field] <= counts[0]![field] * 2.3 + 8192, field);
});

await test('a late setext underline reinterprets every preceding thematic line', () => {
  for (const [source, heading] of [
    ['a\n***\nb\n', ['a', '***', 'b']],
    ['a\n___\nb\n___\nc\n', ['a', '___', 'b', '___', 'c']],
  ] as const) {
    const prefix = 'Settled.\n\nEarlier.\n\n';
    const layout = new TranscriptLayout();
    let items = applyDisplayUpdate([], assistant(prefix + source));
    const before = layout.render(items, 80, new Map());
    const saved = before.lines.slice();
    items = applyDisplayUpdate(items, assistant('-'));
    const frame = layout.render(items, 80, new Map());
    const expected = [
      'Settled.',
      '',
      'Earlier.',
      '',
      ...heading.map((line) => `\u001b[1m${line}\u001b[22m`),
    ];
    assert.deepEqual(frame.lines.slice(1, -1), expected);
    assert.equal(frame.lines.length, expected.length + 2);
    for (let row = 0; row < frame.lines.length; row++) {
      assert.deepEqual(frame.anchorAt(row), {
        item: 'reply',
        line: row,
        offset: 0,
      });
      assert.equal(frame.rowOf(frame.anchorAt(row)!), row);
    }
    assert.deepEqual(before.lines.slice(), saved);
  }
});
