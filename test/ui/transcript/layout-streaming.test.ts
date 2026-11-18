import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { Lexer } from 'marked';
import stripAnsi from 'strip-ansi';
import { TranscriptLayout } from '../../../src/ui/transcript/transcript-layout.js';
import type { DisplayItem, DisplayUpdate } from '../../../src/core/state.js';
import {
  applyDisplayUpdate,
  foldDisplayUpdates,
} from '../../../src/core/state.js';

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

test('JSON array context follows completed tool lines and ends at the closing bracket', () => {
  for (const [open, close] of [
    ['[', ']'],
    ['[[', ']]'],
  ]) {
    let items = applyDisplayUpdate([], tool(open + '\n'));
    const layout = new TranscriptLayout();
    const expanded = new Map([['tool', true]]);
    layout.render(items, 100, expanded);

    const files = [
      'vscode://file/work/src/a.ts',
      'vscode://file/work/src/b.ts',
    ];

    for (const [suffix, expected, plain] of [
      ['"x",\n', [], open + '\n"x",\n'],
      [
        '"src/a.ts\\nsrc/b.ts"\n',
        files,
        open + '\n"x",\n"src/a.ts\\nsrc/b.ts"\n',
      ],
      [
        close + '\n"src/a\\b.ts"',
        [...files, 'vscode://file/work/src/a%5Cb.ts'],
        open + '\n"x",\n"src/a.ts\\nsrc/b.ts"\n' + close + '\n"src/a\\b.ts"',
      ],
    ] as const) {
      items = applyDisplayUpdate(items, tool(suffix));
      const frame = layout.render(items, 100, expanded);
      const body = frame.lines.slice(1, -1).join('\n');

      assert.deepEqual(
        body
          .split('\u001b]8;;')
          .slice(1)
          .map((part) => part.slice(0, part.indexOf('\u0007')))
          .filter(Boolean),
        expected,
      );

      assert.equal(stripAnsi(body), plain);
    }
  }
});

test('a streamed opener waits for its next token before treating quoted paths as JSON', () => {
  for (const opener of ['[', '{', '[[', '[\n[']) {
    const layout = new TranscriptLayout();
    const expanded = new Map([['tool', true]]);
    let items: DisplayItem[] = [];

    for (const chunk of [opener + '\n', ' \n', '-f "src/a\\b.ts"\n']) {
      items = applyDisplayUpdate(items, tool(chunk));
      layout.render(items, 100, expanded);
    }

    const frame = layout.render(items, 100, expanded);
    const body = frame.lines.slice(1, -1).join('\n');

    assert.deepEqual(
      body
        .split('\u001b]8;;')
        .slice(1)
        .map((part) => part.slice(0, part.indexOf('\u0007')))
        .filter(Boolean),
      ['vscode://file/work/src/a%5Cb.ts'],
    );

    assert.equal(stripAnsi(body), opener + '\n \n-f "src/a\\b.ts"\n');
  }
});

test('a streamed comparison reclassifies a quoted filename before or after its operator', () => {
  for (const [left, right] of [
    ['"$x"', '"src/a\\b.ts"'],
    ['"src/a\\b.ts"', '"$x"'],
  ]) {
    const layout = new TranscriptLayout();
    const expanded = new Map([['tool', true]]);
    let items: DisplayItem[] = [];
    const chunks = ['[[\n', left + '\n', ' \n', '==\n', right + ' ]]\n'];

    for (const chunk of chunks) {
      items = applyDisplayUpdate(items, tool(chunk));
      const frame = layout.render(items, 100, expanded);

      assert.deepEqual(
        frame.lines.slice(),
        new TranscriptLayout().render(items, 100, expanded).lines.slice(),
      );
    }

    const body = layout
      .render(items, 100, expanded)
      .lines.slice(1, -1)
      .join('\n');

    assert.deepEqual(
      body
        .split('\u001b]8;;')
        .slice(1)
        .map((part) => part.slice(0, part.indexOf('\u0007')))
        .filter(Boolean),
      ['vscode://file/work/src/a%5Cb.ts'],
    );

    assert.equal(stripAnsi(body), chunks.join(''));
  }
});

test('provisional quoted lines keep bounded parsing and wrapping across blank appends', () => {
  const segment = Intl.Segmenter.prototype.segment;
  const normalize = String.prototype.normalize;
  let parsed = 0;
  let wrapped = 0;
  let measure = false;

  vi.spyOn(Intl.Segmenter.prototype, 'segment').mockImplementation(function (
    this: Intl.Segmenter,
    text: string,
  ) {
    if (measure) parsed += text.length;

    return segment.call(this, text);
  });

  vi.spyOn(String.prototype, 'normalize').mockImplementation(function (
    this: string,
    form?: string,
  ) {
    if (measure) wrapped += this.length;

    return normalize.call(this, form);
  });

  for (const chunks of [
    ['\n'],
    [' \t\n'],
    [' ', '\t', '\n'],
    ['\u001b[0m\n'],
    ['\u001b', '[0m\n'],
    ['\u001b[', '0m\n'],
    ['\u001b[0', 'm\n'],
    ['\u009b[', '0m\n'],
    ['\u001b]0;t', 'itle\u0007\n'],
    ['\u00a0', '\n'],
    ['\u0007\n'],
  ]) {
    const counts: { parsed: number; wrapped: number }[] = [];

    for (const count of [1000, 4000]) {
      const layout = new TranscriptLayout();
      const expanded = new Map([['tool', true]]);
      const prefix = '[\n"src/a.ts"\n';
      let items = applyDisplayUpdate([], tool(prefix));
      const before = layout.render(items, 80, expanded);
      const saved = before.lines.slice();
      const anchors = saved.map((_, row) => before.anchorAt(row));
      parsed = 0;
      wrapped = 0;
      measure = true;

      for (let index = 0; index < count; index++)
        for (const chunk of chunks) {
          items = applyDisplayUpdate(items, tool(chunk));
          layout.render(items, 80, expanded);
        }

      measure = false;
      const provisional = layout.render(items, 80, expanded);
      const current = new TranscriptLayout().render(items, 80, expanded);
      assert.deepEqual(provisional.lines.slice(), current.lines.slice());

      for (let row = 0; row < current.lines.length; row++)
        assert.deepEqual(provisional.anchorAt(row), current.anchorAt(row));

      measure = true;
      items = applyDisplayUpdate(items, tool(']\n'));
      const final = layout.render(items, 80, expanded);
      measure = false;
      counts.push({ parsed, wrapped });
      const fresh = new TranscriptLayout().render(items, 80, expanded);
      assert.deepEqual(final.lines.slice(), fresh.lines.slice());
      assert.deepEqual(before.lines.slice(), saved);

      assert.deepEqual(
        saved.map((_, row) => before.anchorAt(row)),
        anchors,
      );

      assert.ok(final.lines.at(2)!.includes('vscode://file/work/src/a.ts'));
      assert.equal(stripAnsi(final.lines.at(-3)!), ']');
    }

    const [small, large] = counts;

    assert.ok(
      large!.parsed <= small!.parsed * 5,
      `${JSON.stringify(chunks)} parsed ${small!.parsed} then ${large!.parsed} characters`,
    );

    assert.ok(
      large!.wrapped <= small!.wrapped * 5,
      `${JSON.stringify(chunks)} wrapped ${small!.wrapped} then ${large!.wrapped} characters`,
    );
  }
});

test('provisional blanks keep parsing and wrapping bounded through visible and control chunks', () => {
  const segment = Intl.Segmenter.prototype.segment;
  const normalize = String.prototype.normalize;
  let work = 0;

  vi.spyOn(Intl.Segmenter.prototype, 'segment').mockImplementation(function (
    this: Intl.Segmenter,
    text: string,
  ) {
    work += text.length;

    return segment.call(this, text);
  });

  vi.spyOn(String.prototype, 'normalize').mockImplementation(function (
    this: string,
    form?: string,
  ) {
    work += this.length;

    return normalize.call(this, form);
  });

  for (const first of ['x', 'x\u001b]0;t', '\u001b]0;t', '\u001b]0;t\nmore']) {
    const counts: number[] = [];

    for (const count of [1000, 4000]) {
      const layout = new TranscriptLayout();
      const expanded = new Map([['tool', true]]);
      const prefix = '[\n"src/a.ts"\n' + '\n'.repeat(count);
      const initial = first.startsWith('x') ? prefix : prefix + first;
      let items = applyDisplayUpdate([], tool(initial));
      layout.render(items, 80, expanded);

      if (first.startsWith('x')) {
        items = applyDisplayUpdate(items, tool(first));
        layout.render(items, 80, expanded);
      }

      work = 0;

      for (let index = 0; index < 50; index++) {
        items = applyDisplayUpdate(items, tool('x'));
        layout.render(items, 80, expanded);
      }

      counts.push(work);

      if (first !== 'x') items = applyDisplayUpdate(items, tool('\u0007'));

      const frame = layout.render(items, 80, expanded);
      const fresh = new TranscriptLayout().render(items, 80, expanded);
      assert.deepEqual(frame.lines.slice(), fresh.lines.slice());

      assert.equal(
        stripAnsi(frame.lines.at(-2)!),
        first === 'x' ? 'x'.repeat(51) : first.startsWith('x') ? 'x' : '',
      );
    }

    assert.equal(counts[1], counts[0]);
  }
});

test('provisional whitespace keeps an explicit target through split chunks and resize', () => {
  const open = '\u001b]8;;https://x.test/\u0007';
  const close = '\u001b]8;;\u0007';

  for (const prefix of [open + '[\n"one"\n', '[\n' + open + '"one"\n']) {
    const frames = [
      prefix,
      ' ',
      '\u001b]8;;https://y.test/\u0007',
      '\t',
      open,
      '\n',
      ' \t\n',
      ']\n' + close,
    ].map((text, index) => ({
      updates: [tool(text)],
      width: index === 2 ? 13 : 80,
      expanded: ['tool'],
    }));

    sameAsFull(frames);
  }
});

test('partial style escapes revise only the quoted line while earlier frames stay stable', () => {
  const layout = new TranscriptLayout();
  const expanded = new Map([['tool', true]]);
  let items: DisplayItem[] = [];

  const snapshots: {
    frame: ReturnType<TranscriptLayout['render']>;
    lines: string[];
  }[] = [];

  for (const [chunk, width] of [
    ['[\n"src/a.ts\\nsrc/b.ts"\n', 80],
    [' \n'.repeat(50), 80],
    ['\u001b[', 80],
    ['0', 13],
    ['m\n', 13],
    ['\u001b[31;', 13],
    ['1m\n', 80],
    [']\n', 80],
  ] as const) {
    items = applyDisplayUpdate(items, tool(chunk));
    const frame = layout.render(items, width, expanded);
    const fresh = new TranscriptLayout().render(items, width, expanded);
    assert.deepEqual(frame.lines.slice(), fresh.lines.slice());

    for (let row = 0; row < fresh.lines.length; row++)
      assert.deepEqual(frame.anchorAt(row), fresh.anchorAt(row));

    for (const saved of snapshots)
      assert.deepEqual(saved.frame.lines.slice(), saved.lines);

    snapshots.push({ frame, lines: frame.lines.slice() });
  }
});

test('committing a quoted path retains the following line that established terminal escaping', () => {
  const layout = new TranscriptLayout();
  const expanded = new Map([['tool', true]]);
  let items: DisplayItem[] = [];

  for (const chunk of [
    '[\n"/tmp/a\\notes.md"\n',
    '["x"\n',
    ']\n',
    '"src/a\\b.ts"\n',
  ]) {
    items = applyDisplayUpdate(items, tool(chunk));
    const frame = layout.render(items, 100, expanded);
    const fresh = new TranscriptLayout().render(items, 100, expanded);
    assert.deepEqual(frame.lines.slice(), fresh.lines.slice());
  }

  const body = layout
    .render(items, 100, expanded)
    .lines.slice(1, -1)
    .join('\n');

  assert.deepEqual(
    body
      .split('\u001b]8;;')
      .slice(1)
      .map((part) => part.slice(0, part.indexOf('\u0007')))
      .filter(Boolean),
    ['vscode://file/tmp/a%5Cnotes.md', 'vscode://file/work/src/a%5Cb.ts'],
  );

  assert.equal(
    stripAnsi(body),
    '[\n"/tmp/a\\notes.md"\n["x"\n]\n"src/a\\b.ts"\n',
  );
});

test('an OSC sequence completed later rebuilds the uncertain tail', () => {
  sameAsFull(
    ['[\n"src/a.ts"\n', '\u001b]0;title\n[\n"x"\n', '\u0007'].map((text) => ({
      updates: [tool(text)],
      width: 80,
      expanded: ['tool'],
    })),
  );

  for (const end of ['\u0007', '\u009c', '\u001b\\']) {
    const frames = [
      '[\n"src/a.ts\\nsrc/b.ts"\n',
      ' \n'.repeat(30),
      '\u001b[',
      '0m \n\u001b]8;;https://x.test/\u0007 \n\u001b]0;title\n[\n"x"\n',
      'more',
      end + '\n',
      ']\n',
    ].map((text, index) => ({
      updates: [tool(text)],
      width: index === 4 ? 13 : 80,
      expanded: ['tool'],
    }));

    sameAsFull(frames);
  }

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
  test(`an append completes a ${name} without changing earlier output`, () => {
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
  test(`incremental layout matches a full render for ${name}`, () =>
    sameAsFull(frames));

test('a warm append to a 20k-line tool costs under a tenth of a full render', () => {
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

test('layout receives every skipped append and rebuilds after replacements or unrelated history', () => {
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

test('an earlier layout frame retains its rows and anchors after the tool grows', () => {
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
  assert.equal(stripAnsi(after.lines.at(-2)!), 'after');
  assert.deepEqual(after.lines.slice(-2).map(stripAnsi), ['after', '']);
});

test('warm tool appends and a fixed page do not scale with completed prefix rows', () => {
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

const assistant = (text: string): DisplayItem => ({
  id: 'reply',
  kind: 'assistant',
  text,
  cwd: '/work',
});

test('assistant appends keep Markdown rows and anchors correct through syntax changes', () => {
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

test('assistant layout follows batched ancestry and rebuilds for replacements or metadata changes', () => {
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

test('earlier assistant frames survive appends and a reference that changes completed rows', () => {
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

test('completed assistant blocks have bounded parsing and wrapping work', () => {
  const lex = Lexer.prototype.lex;
  const normalize = String.prototype.normalize;
  let parsed = 0;
  let wrapped = 0;
  let measure = false;

  vi.spyOn(Lexer.prototype, 'lex').mockImplementation(function (
    this: Lexer,
    source: string,
  ) {
    if (measure) parsed += source.length;

    return lex.call(this, source);
  });

  vi.spyOn(String.prototype, 'normalize').mockImplementation(function (
    this: string,
    form?: string,
  ) {
    if (measure) wrapped += this.length;

    return normalize.call(this, form);
  });

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
    console.info(JSON.stringify({ size, parsed, wrapped }));
  }

  for (const field of ['parsed', 'wrapped'] as const)
    assert.ok(counts[1]![field] <= counts[0]![field] * 2.3 + 8192, field);
});

test('a late setext underline reinterprets every preceding thematic line', () => {
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
