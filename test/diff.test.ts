import assert from 'node:assert/strict';
import { test } from 'node:test';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import type { FileDiff } from '../src/agents/types.js';
import { diffRows } from '../src/ui/diff.js';

const rows = (files: FileDiff[], width = 30) => diffRows(files, width, '/work');
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
