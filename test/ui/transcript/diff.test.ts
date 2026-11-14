import assert from 'node:assert/strict';
import { test } from 'vitest';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import type { FileDiff } from '../../../src/agents/types.js';
import {
  canExpandDiff,
  diffRows,
  prepareDiff,
} from '../../../src/ui/transcript/diff.js';
import { syntaxSpans } from '../../../src/ui/transcript/syntax.js';

const rows = (files: FileDiff[], width = 30) =>
  diffRows(files, width, '/work').flat();

const plainRows = (files: FileDiff[], width = 30) =>
  rows(files, width).map((row) => stripAnsi(row).trimEnd());

const green = '\u001b[48;2;34;92;43m';
const red = '\u001b[48;2;122;41;54m';
const addedWord = '\u001b[48;2;56;166;96m';
const removedWord = '\u001b[48;2;179;89;107m';

test('diffs wrap line numbers and notices when the gutter cannot fit', () => {
  const files: FileDiff[] = [
    {
      path: '/work/narrow.ts',
      kind: 'update',
      hunks: [
        { oldStart: 10000, newStart: 10000, lines: ['-old', '+replacement'] },
        { oldStart: 20000, newStart: 20000, lines: [' unchanged'] },
      ],
    },
    {
      path: '/work/preview.ts',
      kind: 'add',
      hunks: [
        {
          oldStart: 0,
          newStart: 1,
          lines: Array.from({ length: 12 }, (_, i) => `+line${i}`),
        },
      ],
    },
    {
      path: '/work/binary.dat',
      kind: 'update',
      hunks: [],
      unshown: 'binary',
    },
    {
      path: '/work/omitted.ts',
      kind: 'update',
      hunks: [],
      unshown: { added: 200, removed: 300 },
    },
  ];

  for (const width of [1, 2, 4, 7]) {
    const lines = rows(files, width);

    assert.ok(lines.every((line) => stringWidth(line) <= width));

    const text = stripAnsi(lines.join('')).replaceAll(' ', '');

    assert.ok(text.includes('10000-old'));

    assert.ok(text.includes('10000+replacement'));

    assert.ok(text.includes('...'));

    assert.ok(text.includes('…+2lines'));

    assert.ok(text.includes('…binary'));

    assert.ok(text.includes('…notshown'));
  }
});

test('a narrow diff leaves room for wide characters beside line numbers', () => {
  const files: FileDiff[] = [
    {
      path: '/work/a.txt',
      kind: 'add',
      hunks: [{ oldStart: 0, newStart: 1, lines: ['+界'] }],
    },
  ];

  const lines = rows(files, 4);

  assert.ok(lines.every((line) => stringWidth(line) <= 4));

  assert.ok(stripAnsi(lines.join('')).includes('界'));
});

test('a prepared diff preserves earlier rows while rendering new widths', () => {
  const files: FileDiff[] = [
    {
      path: '/work/new.ts',
      kind: 'add',
      hunks: [
        {
          oldStart: 0,
          newStart: 1,
          lines: [
            '+\tconst wide = "' + 'wide '.repeat(30) + '";',
            ...Array.from(
              { length: 11 },
              (_, i) => `+const value_${i + 2} = ${i + 2};`,
            ),
          ],
        },
      ],
    },
  ];

  const original = structuredClone(files);

  for (const full of [false, true]) {
    const render = prepareDiff(files, '/work', full);
    const earlier = render(78);
    const saved = structuredClone(earlier);

    for (const width of [28, 198, 78]) {
      const drawn = render(width);
      const plain = drawn.flat().map((line) => stripAnsi(line).trimEnd());

      assert.equal(plain[0], 'Create ./new.ts +12');

      assert.ok(plain.includes('10 +const value_10 = 10;'));

      assert.equal(plain.includes('12 +const value_12 = 12;'), full);

      assert.equal(plain.includes('… +2 lines'), !full);

      assert.ok(drawn.flat().every((line) => stringWidth(line) <= width));

      assert.deepEqual(drawn, diffRows(files, width, '/work', full));

      assert.deepEqual(earlier, saved);
    }

    assert.deepEqual(render(78), saved);
  }

  assert.deepEqual(files, original);
});

test('whole-file expansion exposes every supplied line without changing updates or stored hunks', () => {
  for (const kind of ['add', 'delete'] as const) {
    const marker = kind === 'add' ? '+' : '-';

    const file: FileDiff = {
      path: '/work/long.txt',
      kind,
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: Array.from({ length: 12 }, (_, i) => `${marker}line_${i + 1}`),
        },
      ],
    };

    const original = structuredClone(file);
    const preview = plainRows([file]).join('\n');

    assert.match(preview, /line_10/);

    assert.doesNotMatch(preview, /line_11|line_12/);

    assert.match(preview, /… \+2 lines/);

    assert.equal(canExpandDiff([file]), true);

    const full = stripAnsi(
      diffRows([file], 30, '/work', true).flat().join('\n'),
    );

    assert.match(full, /line_11[\s\S]*line_12/);

    assert.doesNotMatch(full, /… \+2 lines/);

    assert.deepEqual(file, original);

    const update: FileDiff = { ...file, kind: 'update' };

    assert.equal(canExpandDiff([update]), false);

    assert.deepEqual(
      diffRows([update], 30, '/work', true),
      diffRows([update], 30, '/work'),
    );

    const short: FileDiff = {
      ...file,
      hunks: [
        {
          ...file.hunks[0]!,
          lines: [
            ...file.hunks[0]!.lines.slice(0, 10),
            '\\ No newline at end of file',
          ],
        },
      ],
    };

    assert.equal(canExpandDiff([short]), false);
  }

  assert.equal(canExpandDiff([]), false);
});

test('an edited file shows under a header counting its lines, each row numbered from its own side, added and removed rows padded on green and red, and hunks apart', () => {
  const files: FileDiff[] = [
    {
      path: '/work/a.txt',
      kind: 'update',
      hunks: [
        {
          oldStart: 3,
          newStart: 3,
          lines: [' gamma', '-delta', '+DELTA', ' epsilon'],
        },
        { oldStart: 19, newStart: 20, lines: [' x', '-w', '+y'] },
      ],
    },
  ];

  assert.deepEqual(plainRows(files), [
    'Update ./a.txt +2 -2',
    ' 3  gamma',
    ' 4 -delta',
    ' 4 +DELTA',
    ' 5  epsilon',
    '...',
    '20  x',
    '20 -w',
    '21 +y',
  ]);

  const drawn = rows(files);

  const row = (code: string) =>
    drawn.find((line) => stripAnsi(line).trimEnd().endsWith(code))!;

  for (const code of ['-delta', '+DELTA', '-w', '+y'])
    assert.equal(stripAnsi(row(code)).length, 30, code);

  for (const code of ['-delta', '-w']) {
    assert.ok(row(code).includes(red), code);

    assert.ok(!row(code).includes(green), code);
  }

  for (const code of ['+DELTA', '+y']) {
    assert.ok(row(code).includes(green), code);

    assert.ok(!row(code).includes(red), code);
  }

  for (const code of [' gamma', ' epsilon', ' x'])
    assert.ok(!row(code).includes(green) && !row(code).includes(red), code);

  assert.ok(drawn[0]!.includes('vscode://file/work/a.txt'));
});

test('a new file shows its first 10 lines and counts the rest, a deleted one numbers its old lines, and a move names both paths', () => {
  const added = Array.from({ length: 12 }, (_, index) => `+l${index + 1}`);

  assert.deepEqual(
    plainRows([
      {
        path: '/work/b.txt',
        kind: 'add',
        hunks: [{ oldStart: 0, newStart: 1, lines: added }],
      },
      {
        path: '/work/c.txt',
        kind: 'delete',
        hunks: [{ oldStart: 1, newStart: 0, lines: ['-x', '-y'] }],
      },
      {
        path: '/work/a.txt',
        kind: 'update',
        movePath: '/work/d.txt',
        hunks: [],
      },
    ]),
    [
      'Create ./b.txt +12',
      ...added
        .slice(0, 10)
        .map((line, index) => `${String(index + 1).padStart(2)} ${line}`),
      '… +2 lines',
      '',
      'Delete ./c.txt -2',
      '1 -x',
      '2 -y',
      '',
      'Move ./a.txt → ./d.txt +0 -0',
    ],
  );
});

test('tabs and wide characters keep every row within the width, and a long line wraps under its code past a blank gutter', () => {
  const files: FileDiff[] = [
    {
      path: '/work/a.txt',
      kind: 'update',
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: ['+\tx中文', '+' + 'a'.repeat(30)],
        },
      ],
    },
  ];

  for (const row of rows(files, 20)) {
    assert.ok(stringWidth(stripAnsi(row)) <= 20, row);

    if (row.includes(green)) assert.equal(stringWidth(stripAnsi(row)), 20);
  }

  const shown = plainRows(files, 20);

  assert.ok(shown.includes('1 +        x中文'), shown.join('\n'));

  assert.ok(shown.includes('2 +' + 'a'.repeat(17)), shown.join('\n'));

  assert.ok(shown.includes('   ' + 'a'.repeat(13)), shown.join('\n'));
});

test('escape sequences and carriage returns in a file never reach the terminal', () => {
  const drawn = rows([
    {
      path: '/work/a\u001b]8;;https://y\u0007.txt',
      kind: 'update',
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: ['+a\u001b]8;;https://x\u0007b\r', ' c\r'],
        },
      ],
    },
  ]);

  for (const row of drawn) {
    assert.ok(!row.includes(']8;;https://x'), JSON.stringify(row));

    assert.ok(!row.includes('\u001b]8;;https://y'), JSON.stringify(row));

    assert.ok(!row.includes('\r'), JSON.stringify(row));
  }

  assert.deepEqual(
    drawn.slice(1).map((row) => stripAnsi(row).trimEnd()),
    ['1 +ab', '2  c'],
  );
});

test(
  'a column narrower than its line numbers still draws every line',
  { timeout: 2000 },
  () => {
    const shown = plainRows(
      [
        {
          path: '/work/a.txt',
          kind: 'update',
          hunks: [{ oldStart: 99998, newStart: 99998, lines: [' a', '+b'] }],
        },
      ],
      4,
    )
      .join('')
      .replaceAll(' ', '');

    assert.ok(shown.includes('99998') && shown.includes('99999'), shown);
  },
);

test('a no-newline marker gets no row and leaves the numbering', () => {
  assert.deepEqual(
    plainRows([
      {
        path: '/work/a.txt',
        kind: 'update',
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            lines: [' a', '-b', '\\ No newline at end of file', '+B'],
          },
        ],
      },
    ]).slice(1),
    ['1  a', '2 -b', '2 +B'],
  );
});

/** `row` without its number and marker colors, so only syntax colors are left. */
const syntaxOf = (row: string) =>
  row
    .replaceAll('\u001b[38;2;80;200;80m', '')
    .replaceAll('\u001b[38;2;220;90;90m', '');

test('code reads as the language its extension names, colored as Claude Code colors it, while removed rows stay plain and every row keeps its background and width', () => {
  const files: FileDiff[] = [
    {
      path: '/work/a.ts',
      kind: 'update',
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            ' /**',
            '- * old',
            '+ * new',
            ' */',
            '-let y = 1;',
            '+const x = "s"; if (x) return; // done',
          ],
        },
      ],
    },
  ];

  const drawn = rows(files, 50);

  const row = (code: string) =>
    drawn.find((line) => stripAnsi(line).trimEnd().endsWith(code))!;

  const added = row('// done');

  assert.ok(added.includes('\u001b[38;2;102;217;239mconst'));

  assert.ok(added.includes('\u001b[38;2;230;219;116m"s"'));

  assert.ok(added.includes('\u001b[38;2;249;38;114mif'));

  assert.ok(added.includes('\u001b[38;2;117;113;94m// done'));

  for (const code of ['- * old', '-let y = 1;'])
    assert.ok(!syntaxOf(row(code)).includes('\u001b[38;'), code);

  assert.ok(added.startsWith(`${green}\u001b[38;2;80;200;80m4 +`));

  assert.ok(row('-let y = 1;').startsWith(`${red}\u001b[38;2;220;90;90m4 -`));

  assert.ok(
    // a reset before the row's end would drop its background for the rest
    // eslint-disable-next-line no-control-regex
    !/\u001b\[0?m/.test(added.slice(0, -5)),
    JSON.stringify(added),
  );

  assert.equal(stringWidth(stripAnsi(added)), 50);

  assert.deepEqual(plainRows(files, 50), [
    'Update ./a.ts +2 -2',
    '1  /**',
    '2 - * old',
    '2 + * new',
    '3  */',
    '4 -let y = 1;',
    '4 +const x = "s"; if (x) return; // done',
  ]);
});

test('each line reads alone, as Claude Code reads it, so a hunk that opens inside a string colors the code after it as code', () => {
  const drawn = rows(
    [
      {
        path: '/work/a.py',
        kind: 'update',
        hunks: [
          {
            oldStart: 5,
            newStart: 5,
            lines: [' the rest of the docs."""', '+import os', ' class A(B):'],
          },
        ],
      },
    ],
    40,
  );

  const row = (code: string) =>
    drawn.find((line) => stripAnsi(line).trimEnd().endsWith(code))!;

  assert.ok(row('+import os').includes('\u001b[38;2;249;38;114mimport'));

  assert.ok(row(' class A(B):').includes('\u001b[38;2;166;226;46mA'));
});

test('a line whose colored runs would split a character, such as an emoji or a keycap, or change one, as the CSS grammars change U+2028, draws plain and keeps it whole, while the lines around it keep their colors', () => {
  const drawn = rows(
    [
      {
        path: '/work/a.pl',
        kind: 'update',
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            lines: [' my $x = 1;', '+my $😀 = 2;'],
          },
        ],
      },
      {
        path: '/work/b.ts',
        kind: 'update',
        hunks: [{ oldStart: 1, newStart: 1, lines: ['+f(1\uFE0F\u20E3);'] }],
      },
      {
        path: '/work/c.css',
        kind: 'update',
        hunks: [{ oldStart: 1, newStart: 1, lines: ['+a[b\u2028] {}'] }],
      },
    ],
    40,
  );

  const row = (code: string) =>
    drawn.find((line) => stripAnsi(line).trimEnd().endsWith(code))!;

  assert.ok(row('+my $😀 = 2;').includes('my $😀 = 2;'));

  assert.ok(row('+f(1\uFE0F\u20E3);').includes('f(1\uFE0F\u20E3);'));

  assert.ok(row('+a[b\u2028] {}').includes('a[b\u2028] {}'));

  assert.ok(row(' my $x = 1;').includes('\u001b[38;2;249;38;114mmy'));
});

test('a line highlight.js fails on draws plain', () => {
  // an unknown language makes it throw, as a nesting deep enough to overflow the stack does
  assert.deepEqual(syntaxSpans(['const a = 1;'], 'not-a-language'), [
    [{ text: 'const a = 1;' }],
  ]);
});

test("the language comes from the file's name ahead of its extension, a move's new name, or a shebang, PHP or XML opening on the file's first line, read only from a context or added row of a first hunk at line 1, and a file that names none draws plain", () => {
  const colored = (
    path: string,
    lines: string[],
    { start = 1, ...extra }: Partial<FileDiff> & { start?: number } = {},
  ) =>
    rows([
      {
        path,
        kind: 'update',
        hunks: [
          {
            oldStart: start,
            newStart: start,
            lines,
          },
        ],
        ...extra,
      },
    ])
      .slice(1)
      .some((row) => syntaxOf(row).includes('\u001b[38;'));

  // lowlight registers `txt` as plaintext, so only the name map colors this
  assert.ok(
    colored('/work/CMakeLists.txt', [
      ' project(demo)',
      '+add_executable(app main.c)',
    ]),
  );

  assert.ok(
    colored('/work/a.txt', ['+const a = 1'], { movePath: '/work/a.ts' }),
  );

  assert.ok(
    !colored(
      '/work/bin/tool.zz',
      [' #!/usr/bin/env python', '+def f(): pass'],
      { start: 5 },
    ),
  );

  assert.ok(
    !colored('/work/bin/tool.zz', ['-#!/usr/bin/env python', '+x = 1']),
  );

  assert.ok(colored('/work/x', ['+<?php', '+echo 1;']));

  assert.ok(
    colored('/work/x', ['+\uFEFF<?xml version="1.0"?>', '+<a b="c"/>']),
  );

  for (const path of ['/work/notes', '/work/a.zz'])
    assert.ok(!colored(path, [' const a = 1', '+if (a) return']), path);
});

test("words a removed row and the added row at its place in the next run changed show brighter, even across a no-newline marker, unless over 40% of their text changed, and a longer run's extra rows pair with nothing", () => {
  const drawn = rows(
    [
      {
        path: '/work/a.ts',
        kind: 'update',
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            lines: [
              ' a;',
              '-const answer = one;',
              '+const answer = forty;',
              ' b;',
              '-a = 1',
              '-b = 2',
              '+a = 3',
              '+b = 4',
              ' c;',
              '-foo bar',
              '+baz qux',
              ' d;',
              '-const n = 1;',
              '+const n = f(1);',
              ' e;',
              '-const z = one;',
              '\\ No newline at end of file',
              '+const z = forty;',
              '\\ No newline at end of file',
              ' f;',
              '-const p = one;',
              '-const q = two;',
              '+const p = forty;',
              ' g;',
              '-const r = one;',
              '+const r = forty;',
              '+const s = two;',
            ],
          },
        ],
      },
    ],
    40,
  );

  const row = (code: string) =>
    drawn.find((line) => stripAnsi(line).trimEnd().endsWith(code))!;

  const count = (text: string, part: string) => text.split(part).length - 1;
  const removed = row('-const answer = one;');

  assert.ok(removed.includes(`${removedWord}one\u001b[49m`));

  assert.equal(count(removed, removedWord), 1);

  const added = row('+const answer = forty;');

  assert.ok(added.includes(`${addedWord}forty\u001b[49m`));

  assert.equal(count(added, addedWord), 1);

  for (const [code, word] of [
    ['+a = 3', '3'],
    ['+b = 4', '4'],
  ] as const) {
    assert.ok(
      row(code).includes(`${addedWord}\u001b[38;2;190;132;255m${word}`),
      code,
    );

    assert.equal(count(row(code), addedWord), 1, code);
  }

  assert.ok(row('+const n = f(1);').includes(`${addedWord}(`));

  assert.ok(row('+const z = forty;').includes(`${addedWord}forty`));

  assert.ok(row('+const p = forty;').includes(`${addedWord}forty`));

  assert.ok(!row('-const q = two;').includes(removedWord));

  assert.ok(row('+const r = forty;').includes(`${addedWord}forty`));

  assert.ok(!row('+const s = two;').includes(addedWord));

  assert.ok(
    // the row's own background comes back after each brighter word
    // eslint-disable-next-line no-control-regex
    !/\u001b\[49m(?!\u001b\[48;)/.test(added.slice(0, -5)),
  );

  for (const code of ['-foo bar', '+baz qux'])
    assert.ok(
      !row(code).includes(addedWord) && !row(code).includes(removedWord),
      code,
    );
});

test('repeated shared tokens keep a pair at 400 token edits colored and 401 uncolored, counting emoji tokens rather than their string lengths', () => {
  const prefix = '+ '.repeat(250) + 'x'.repeat(1200) + ' ';
  const before = '🧙'.repeat(200);

  for (const [suffix, colored] of [
    ['', true],
    ['!', false],
  ] as const) {
    const after = '👻'.repeat(200) + suffix;

    const drawn = rows(
      [
        {
          path: '/work/a.zz',
          kind: 'update',
          hunks: [
            {
              oldStart: 1,
              newStart: 1,
              lines: ['-' + prefix + before, '+' + prefix + after],
            },
          ],
        },
      ],
      3000,
    ).join('\n');

    for (const [color, text] of [
      [removedWord, before],
      [addedWord, after],
    ] as const) {
      assert.equal(drawn.includes(`${color}${text}\u001b[49m`), colored);

      assert.equal(drawn.split(color).length - 1, colored ? 1 : 0);
    }
  }
});

test('reordered tokens still receive word colors when their occurrence counts match', () => {
  const prefix = 'x '.repeat(250);

  const drawn = rows(
    [
      {
        path: '/work/a.zz',
        kind: 'update',
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            lines: ['-' + prefix + 'one two', '+' + prefix + 'two one'],
          },
        ],
      },
    ],
    1000,
  ).join('\n');

  assert.ok(drawn.includes(`${removedWord}one \u001b[49m`));

  assert.ok(drawn.includes(`${addedWord} one\u001b[49m`));
});

test('unrelated large diff lines draw within twice the cost of equally sized colorable lines', () => {
  const before = Array.from({ length: 1000 }, (_, index) => `old${index}`).join(
    ' ',
  );

  const unrelated = Array.from(
    { length: 1000 },
    (_, index) => `new${index}`,
  ).join(' ');

  const files = (after: string): FileDiff[] => [
    {
      path: '/work/a.zz',
      kind: 'update',
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            ...Array<string>(100).fill('-' + before),
            ...Array<string>(100).fill('+' + after),
          ],
        },
      ],
    },
  ];

  const inputs = [files(unrelated), files(before.replace('old500', 'new500'))];
  // the drawing thread's CPU time, since wall time also counts preemption by a loaded machine
  const elapsed: number[][] = [[], []];

  for (let run = 0; run < 4; run++) {
    for (const index of run % 2 ? [1, 0] : [0, 1]) {
      const start = process.threadCpuUsage();
      const drawn = rows(inputs[index]!, 100);
      const { user, system } = process.threadCpuUsage(start);

      if (run) elapsed[index]!.push(user + system);

      assert.equal(
        drawn.filter((row) => row.includes(addedWord)).length,
        index ? 100 : 0,
      );

      assert.equal(
        drawn.filter((row) => row.includes(removedWord)).length,
        index ? 100 : 0,
      );
    }
  }

  const medians = elapsed.map((samples) => samples.sort((a, b) => a - b)[1]!);

  assert.ok(
    medians[0]! < medians[1]! * 2,
    `${medians[0]} µs unrelated, ${medians[1]} µs colorable`,
  );
});

test("a long line past the highlighting budget draws plain while shorter lines keep their colors, the budget adds up across a file's hunks, counts a line's indent and starts again in the next file, and a pair needing over 400 token edits gets no word colors, so long lines draw quickly", () => {
  // each costs about 9,000,000, so the second passes the 16,000,000 budget
  const long = (name: string) =>
    `+const ${name} = [` + 'a, '.repeat(1000) + '];';

  const [, first, second, short, , later, , , next, , , indented] = diffRows(
    [
      {
        path: '/work/a.ts',
        kind: 'update',
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            lines: [long('x'), long('y'), '+const a = 1;'],
          },
          {
            oldStart: 9,
            newStart: 12,
            lines: [`+const z = [${'a, '.repeat(100)}];`],
          },
        ],
      },
      {
        path: '/work/b.ts',
        kind: 'update',
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            lines: [`+const v = [${'a, '.repeat(100)}];`],
          },
        ],
      },
      {
        path: '/work/c.ts',
        kind: 'update',
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            lines: [`+${' '.repeat(4100)}const w = 1;`],
          },
        ],
      },
    ],
    100,
    '/work',
  );

  const colored = (drawn: readonly string[]) =>
    drawn.some((row) => syntaxOf(row).includes('\u001b[38;'));

  assert.ok(colored(first!));

  assert.ok(!colored(second!));

  assert.ok(colored(short!));

  assert.ok(!colored(later!));

  assert.ok(!colored(indented!));

  assert.ok(colored(next!));

  const words = Array.from({ length: 1200 }, (_, index) => `w${index}`);
  const changed = words.map((word, index) => (index % 5 ? word : `v${index}`));

  const paired = rows([
    {
      path: '/work/a.txt',
      kind: 'update',
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: ['-' + words.join(' '), '+' + changed.join(' ')],
        },
      ],
    },
  ]);

  assert.ok(!paired.some((row) => row.includes('\u001b[48;2;56;166;96m')));
});

test('an html line opening many script tags draws quickly, with JavaScript and CSS colors and no XML comment colors', () => {
  const started = process.threadCpuUsage();

  const drawn = rows(
    [
      {
        path: '/work/a.html',
        kind: 'update',
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            lines: [
              '+' + '<script>'.repeat(20),
              '+<script>const a = 1;</script>',
              '+<script><!-- c --></script>',
              '+<style><!-- c --></style>',
              '+<style>p { color: red; }</style>',
            ],
          },
        ],
      },
    ],
    60,
  );

  // reading each tag's content as both xml and handlebars takes seconds
  const { user, system } = process.threadCpuUsage(started);

  assert.ok(user + system < 500_000);

  const row = (code: string) =>
    drawn.find((line) => stripAnsi(line).trimEnd().endsWith(code))!;

  assert.ok(
    row('<script>const a = 1;</script>').includes(
      '\u001b[38;2;102;217;239mconst',
    ),
  );

  assert.ok(
    row('<style>p { color: red; }</style>').includes(
      '\u001b[38;2;166;226;46mcolor\u001b[39m',
    ),
  );

  // an html comment colors only where xml reads it, directly or through handlebars
  for (const code of [
    '<script><!-- c --></script>',
    '<style><!-- c --></style>',
  ])
    assert.ok(!syntaxOf(row(code)).includes('\u001b[38;'), code);
});

for (const [name, before, after, oldWord, newWord] of [
  ['Unicode identifiers', 'const café = 1;', 'const cafè = 1;', 'café', 'cafè'],
  ['changed graphemes', 'const icon = "👍🏻";', 'const icon = "👍🏽";', '👍🏻', '👍🏽'],
] as const) {
  test(`word colors cover whole ${name} and preserve their text`, () => {
    const [, removed, added] = rows(
      [
        {
          path: '/work/a.zz',
          kind: 'update',
          hunks: [
            { oldStart: 1, newStart: 1, lines: ['-' + before, '+' + after] },
          ],
        },
      ],
      80,
    );

    assert.ok(removed!.includes(`${removedWord}${oldWord}\u001b[49m`));

    assert.ok(added!.includes(`${addedWord}${newWord}\u001b[49m`));

    assert.equal(removed!.split(removedWord).length - 1, 1);

    assert.equal(added!.split(addedWord).length - 1, 1);

    assert.equal(stripAnsi(removed!).trimEnd(), '1 -' + before);

    assert.equal(stripAnsi(added!).trimEnd(), '1 +' + after);
  });
}

test('word colors include exactly 40 percent changed text and exclude one additional changed character', () => {
  for (const [after, colored] of [
    ['bbbb', true],
    ['bbbbb', false],
  ] as const) {
    // the changed proportions are 8/20 and 9/21; the shared prefix is six characters
    const [, removed, added] = rows([
      {
        path: '/work/a.zz',
        kind: 'update',
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            lines: ['-keep: aaaa', '+keep: ' + after],
          },
        ],
      },
    ]);

    for (const [row, color, word] of [
      [removed!, removedWord, 'aaaa'],
      [added!, addedWord, after],
    ] as const) {
      assert.equal(row.includes(`${color}${word}\u001b[49m`), colored);

      assert.equal(row.split(color).length - 1, colored ? 1 : 0);
    }
  }
});

test('syntax coloring includes the exact file budget and charges only lines longer than 256 characters', () => {
  const line = (length: number) =>
    'const x = "' + 'a'.repeat(length - 13) + '";';

  const inputs = [line(4000), line(4001), line(256), line(257)];

  assert.deepEqual(
    inputs.map((text) => text.length),
    [4000, 4001, 256, 257],
  );

  const within = syntaxSpans([inputs[0]!], 'javascript');
  const exhausted = syntaxSpans(inputs.slice(1), 'javascript');
  const rendered = [...within, ...exhausted];

  assert.deepEqual(
    rendered.map((spans) =>
      spans.some(({ text, color }) => text === 'const' && color === '#66d9ef'),
    ),
    [true, false, true, false],
  );

  assert.deepEqual(
    rendered.map((spans) => spans.map(({ text }) => text).join('')),
    inputs,
  );
});

test('a declaration word used as a function name keeps its title color', () => {
  const [, row] = rows([
    {
      path: '/work/a.py',
      kind: 'update',
      hunks: [{ oldStart: 1, newStart: 1, lines: ['+def type(): pass'] }],
    },
  ]);

  assert.ok(row!.includes('\u001b[38;2;102;217;239mdef\u001b[39m'));

  assert.ok(row!.includes('\u001b[38;2;166;226;46mtype\u001b[39m'));

  assert.equal(stripAnsi(row!).trimEnd(), '1 +def type(): pass');
});

test('a Python shebang selects Python syntax for code in updates and added files', () => {
  for (const kind of ['update', 'add'] as const) {
    const [, , code] = rows([
      {
        path: '/work/bin/tool.zz',
        kind,
        hunks: [
          {
            oldStart: kind === 'add' ? 0 : 1,
            newStart: 1,
            lines: [
              (kind === 'add' ? '+' : ' ') + '#!/usr/bin/env python',
              '+def f(): pass',
            ],
          },
        ],
      },
    ]);

    assert.ok(code!.includes('\u001b[38;2;102;217;239mdef\u001b[39m'));

    assert.ok(code!.includes('\u001b[38;2;249;38;114mpass\u001b[39m'));

    assert.equal(stripAnsi(code!).trimEnd(), '2 +def f(): pass');
  }
});

test('a later hunk retains syntax colors while the file has budget', () => {
  const drawn = rows([
    {
      path: '/work/a.ts',
      kind: 'update',
      hunks: [
        { oldStart: 1, newStart: 1, lines: ['+const a = 1;'] },
        { oldStart: 9, newStart: 9, lines: ['+const b = 2;'] },
      ],
    },
  ]);

  assert.ok(drawn[3]!.includes('\u001b[38;2;102;217;239mconst\u001b[39m'));

  assert.deepEqual(
    drawn.map((row) => stripAnsi(row).trimEnd()),
    ['Update ./a.ts +2 -0', '1 +const a = 1;', '...', '9 +const b = 2;'],
  );
});

test("a file whose lines were left out keeps its header, with Git's counts unless it is binary", () => {
  const files: FileDiff[] = [
    {
      path: '/work/pnpm-lock.yaml',
      kind: 'update',
      hunks: [],
      unshown: { added: 812, removed: 640 },
    },
    { path: '/work/shot.png', kind: 'add', hunks: [], unshown: 'binary' },
    // a mode change has nothing left out
    { path: '/work/run.sh', kind: 'update', hunks: [] },
  ];

  assert.deepEqual(plainRows(files, 60), [
    'Update ./pnpm-lock.yaml +812 -640',
    '… not shown',
    '',
    'Create ./shot.png',
    '… binary',
    '',
    'Update ./run.sh +0 -0',
  ]);
});
