import assert from 'node:assert/strict';
import { test } from 'node:test';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import type { FileDiff } from '../src/agents/types.js';
import { diffRows } from '../src/ui/diff.js';

const rows = (files: FileDiff[], width = 30) =>
  diffRows(files, width, '/work').flat();
const plainRows = (files: FileDiff[], width = 30) =>
  rows(files, width).map((row) => stripAnsi(row).trimEnd());
const green = '\u001b[48;2;34;92;43m';
const red = '\u001b[48;2;122;41;54m';

await test('an edited file shows under a header counting its lines, each row numbered from its own side, added and removed rows padded on green and red, and hunks apart', () => {
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

await test('a new file shows its first 10 lines and counts the rest, a deleted one numbers its old lines, and a move names both paths', () => {
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

await test('tabs and wide characters keep every row within the width, and a long line wraps under its code past a blank gutter', () => {
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

await test('escape sequences and carriage returns in a file never reach the terminal', () => {
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

await test(
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
    ).join('\n');
    assert.ok(shown.includes('99998') && shown.includes('99999'), shown);
  },
);

await test('a no-newline marker gets no row and leaves the numbering', () => {
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

await test('code reads as the language its extension names, colored as Claude Code colors it, while removed rows stay plain and every row keeps its background and width', () => {
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

await test('each line reads alone, as Claude Code reads it, so a hunk that opens inside a string colors the code after it as code', () => {
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

await test('a line whose colors would end inside an emoji draws plain and keeps it whole, while the lines around it keep their colors', () => {
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
    ],
    40,
  );
  const row = (code: string) =>
    drawn.find((line) => stripAnsi(line).trimEnd().endsWith(code))!;
  assert.ok(row('+my $😀 = 2;').includes('my $😀 = 2;'));
  assert.ok(row(' my $x = 1;').includes('\u001b[38;2;249;38;114mmy'));
});

await test("the language comes from the file's name ahead of its extension, a move's new name, or a shebang, PHP or XML opening on the file's first line, read only from a context or added row of a first hunk at line 1, and a file that names none draws plain", () => {
  const colored = (
    path: string,
    lines: string[],
    { start = 1, ...extra }: Partial<FileDiff> & { start?: number } = {},
  ) =>
    rows([
      {
        path,
        kind: 'update',
        hunks: [{ oldStart: start, newStart: start, lines }],
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
    colored('/work/bin/tool.zz', [' #!/usr/bin/env python', '+def f(): pass']),
  );
  assert.ok(
    colored('/work/bin/tool.zz', ['+#!/usr/bin/env python', '+def f(): pass'], {
      kind: 'add',
    }),
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

await test("words a removed row and the added row at its place in the next run changed show brighter, even across a no-newline marker, unless over 40% of their text changed, and a longer run's extra rows pair with nothing", () => {
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
  const addedWord = '\u001b[48;2;56;166;96m';
  const removedWord = '\u001b[48;2;179;89;107m';
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

await test("a long line past the highlighting budget draws plain while shorter lines keep their colors, the budget adds up across a file's hunks, counts a line's indent and starts again in the next file, and a pair needing over 400 token edits gets no word colors, so long lines draw quickly", () => {
  // each costs about 9,000,000, so the second passes the 16,000,000 budget
  const long = (name: string) =>
    `+const ${name} = [` + 'a, '.repeat(1000) + '];';
  const [, first, second, short, , later, , indented, , , next] = diffRows(
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
          {
            oldStart: 30,
            newStart: 33,
            lines: [`+${' '.repeat(4100)}const w = 1;`],
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
