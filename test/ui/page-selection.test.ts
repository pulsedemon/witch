import assert from 'node:assert/strict';
import { test } from 'vitest';
import stripAnsi from 'strip-ansi';
import { pageSelection } from '../../src/ui/page-selection.js';
import { selectedText, spanOf, textEnds } from '../../src/ui/selection.js';
import { prepareDiff } from '../../src/ui/transcript/diff.js';
import { wrapSourceLines } from '../../src/ui/wrap.js';

test('page copying restores soft-wrap spaces but keeps source newlines', () => {
  const source = pageSelection(wrapSourceLines('alpha beta gamma\ndelta', 10));

  assert.equal(
    selectedText(source.lines, ...textEnds(source.lines)!, source.joinBefore),
    'alpha beta gamma\ndelta',
  );

  assert.deepEqual(spanOf(source, { row: 1, column: 2 }, 'line'), [
    { row: 0, column: 0 },
    { row: 1, column: 4 },
  ]);
});

test('page endpoints resolve exact source offsets and reject missing text', () => {
  const source = pageSelection(wrapSourceLines('alpha beta gamma', 10));
  assert.deepEqual(source.anchorAt(1), { line: 0, offset: 11 });
  assert.equal(source.rowOf({ line: 0, offset: 11 }), 1);
  assert.equal(source.rowOf({ line: 0, offset: 12 }), undefined);
  assert.equal(source.rowOf({ line: 1, offset: 0 }), undefined);
  assert.equal(source.anchorAt(3), undefined);
});

test('rendered diff continuations copy and triple-click as separate drawn rows', () => {
  const source = pageSelection(
    prepareDiff(
      [
        {
          path: '/work/a',
          kind: 'add',
          hunks: [{ oldStart: 0, newStart: 1, lines: ['+abcdef'] }],
        },
      ],
      '/work',
    )(5),
  );

  const first = Array.from(
    { length: source.lines.length },
    (_, row) => row,
  ).find((row) => stripAnsi(source.lines.at(row)!) === '1 +ab')!;

  assert.equal(
    selectedText(
      source.lines,
      { row: first, column: 0 },
      { row: first + 2, column: 4 },
      source.joinBefore,
    ),
    '1 +ab\n   cd\n   ef',
  );

  assert.deepEqual(spanOf(source, { row: first + 1, column: 3 }, 'line'), [
    { row: first + 1, column: 0 },
    { row: first + 1, column: 4 },
  ]);
});
