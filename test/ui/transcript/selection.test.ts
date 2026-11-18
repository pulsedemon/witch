import assert from 'node:assert/strict';
import { test } from 'vitest';
import { styledCharsFromTokens, tokenize } from '@alcalzone/ansi-tokenize';
import { placeholder } from '../../../src/ui/transcript/images.js';
import { hyperlink } from '../../../src/ui/links.js';
import {
  highlight,
  selectedText,
  stepEnd,
  tabbed,
  textEnd,
  uncopied,
  wordAt,
} from '../../../src/ui/transcript/selection.js';

const red = (text: string) => `\u001b[31m${text}\u001b[39m`;
const inverse = (text: string) => `\u001b[7m${text}\u001b[27m`;

test('a highlight inverts the selected cells as plain text, keeps the styles around it and counts wide characters as two', () => {
  assert.equal(
    highlight(`${red('ab')}日本${red('x')}`, 1, 4),
    `${red('a')}${inverse('b日')}本${red('x')}`,
  );
});

test('a selection from the right half of a wide character takes the whole character', () => {
  assert.equal(highlight('日本x', 1, 3), `${inverse('日本')}x`);

  assert.equal(
    selectedText(
      ['日本x'],
      { row: 0, column: 1 },
      { row: 0, column: 1 },
      () => '',
    ),
    '日',
  );
});

test('a highlight and a copy give no cell to a character Ink drops, such as a soft hyphen or a carriage return', () => {
  assert.equal(highlight('a\u00adb', 1, 2), `a${inverse('b')}`);

  assert.equal(
    selectedText(
      ['ab\rcd'],
      { row: 0, column: 2 },
      { row: 0, column: 3 },
      () => '',
    ),
    'cd',
  );
});

test('a highlight keeps the links of the cells it covers', () => {
  const link = (text: string) =>
    `\u001b]8;;https://example.com/docs\u0007${text}\u001b]8;;\u0007`;

  assert.equal(
    highlight(`see ${link('docs')} here`, 2, 7),
    `se${inverse(`e ${link('doc')}`)}${link('s')} here`,
  );
});

test('a highlighted link keeps its underline, as the terminal draws a selected link', () => {
  const line = `see ${hyperlink('docs', 'https://example.com/docs', '/')} here`;
  const cells = styledCharsFromTokens(tokenize(highlight(line, 2, 7)));

  for (const index of [4, 5, 6]) {
    const codes = cells[index]!.styles.map(({ code }) => code);
    assert.ok(codes.includes('\u001b[7m'), `${index}: ${codes.join(' ')}`);
    assert.ok(codes.includes('\u001b[4m'), `${index}: ${codes.join(' ')}`);

    assert.ok(
      codes.includes('\u001b]8;;https://example.com/docs\u0007'),
      `${index}: ${codes.join(' ')}`,
    );
  }
});

test('a highlight past the text covers the empty cells it reaches', () => {
  assert.equal(highlight('ab', 1, 4), `a${inverse('b  ')}`);
  assert.equal(highlight('ab', 3, 5), `ab ${inverse('  ')}`);
});

test("an image row keeps its placeholders' colors", () => {
  const row = `\u001b[38;5;1m${placeholder.repeat(3)}\u001b[39m`;
  assert.equal(highlight(row, 0, 3), row);
});

test('selected text joins wrapped rows, breaks between lines, drops trailing spaces and images, and ends at the last cell included', () => {
  const lines = [
    'You',
    `Reply ${red('with')} only `,
    'the word ok.   ',
    placeholder.repeat(4),
    '',
    'codex',
  ];

  const joint = (row: number) => (row === 2 ? '' : '\n');

  assert.equal(
    selectedText(lines, { row: 0, column: 0 }, { row: 5, column: 1 }, joint),
    'You\nReply with only the word ok.\n\nco',
  );

  assert.equal(
    selectedText(lines, { row: 1, column: 6 }, { row: 2, column: 7 }, joint),
    'with only the word',
  );
});

test('a copy leaves out a marked rule and the space after it, turns a marked table rule and its spaces into one tab, and keeps a rule nothing marked', () => {
  const copy = (rows: string[], joint = '\n') =>
    selectedText(
      rows,
      { row: 0, column: 0 },
      { row: rows.length - 1, column: 99 },
      () => joint,
    );

  assert.equal(copy([`  ${uncopied}│ ${uncopied}│ inner`]), '  inner');

  assert.equal(
    copy([`${uncopied}│ first`, `${uncopied}│ `, `${uncopied}│ second`]),
    'first\n\nsecond',
  );

  assert.equal(copy([`a ${tabbed}│ b`, `1 ${tabbed}│ 2`]), 'a\tb\n1\t2');
  // a cell's own spaces stay
  assert.equal(copy([`a   ${tabbed}│  b`]), 'a  \t b');
  // a wrap trimmed the space beside the rule and the join put it back
  assert.equal(copy([`${uncopied}│`, 'inner'], ' '), 'inner');
  assert.equal(copy([`alpha ${tabbed}│`, 'beta'], ' '), 'alpha\tbeta');
  assert.equal(copy(['│   ├── src']), '│   ├── src');
  // a mark before any other character changes nothing
  assert.equal(copy([`see${uncopied} this ${tabbed}x`]), 'see this x');

  assert.equal(
    selectedText(
      [`${uncopied}│ quoted`],
      { row: 0, column: 2 },
      { row: 0, column: 4 },
      () => '',
    ),
    'quo',
  );

  assert.equal(highlight(`${uncopied}│ q`, 2, 3), `│ ${inverse('q')}`);
});

test('selected text drops trailing spaces in time linear in a long run of spaces before text', () => {
  const started = performance.now();

  assert.equal(
    selectedText(
      [`${' '.repeat(50_000)}x `],
      { row: 0, column: 0 },
      { row: 0, column: 50_001 },
      () => '',
    ),
    `${' '.repeat(50_000)}x`,
  );

  // a trim that backtracks over the run takes seconds
  assert.ok(performance.now() - started < 500);
});

test('selection keeps complete emoji clusters containing variation selectors and joiners', () => {
  for (const cluster of ['⚠️', '👩‍💻']) {
    const text = `a${cluster}b`;
    assert.equal(highlight(text, 1, 3), `a${inverse(cluster)}b`);

    assert.equal(
      selectedText(
        [text],
        { row: 0, column: 2 },
        { row: 0, column: 2 },
        () => '\n',
      ),
      cluster,
    );
  }
});

test('a selection starting on image rows joins only after its first copied row', () => {
  const calls: number[] = [];
  const lines = [placeholder, placeholder, 'alpha', 'beta'];

  assert.equal(
    selectedText(lines, { row: 0, column: 0 }, { row: 3, column: 3 }, (row) => {
      calls.push(row);

      return '|';
    }),
    'alpha|beta',
  );

  assert.deepEqual(calls, [3]);
});

test('a word runs between spaces, quotes and brackets, keeps a path with its line and column whole, drops the punctuation that ends a sentence and counts a wide character as two cells', () => {
  assert.deepEqual(wordAt('see src/a.ts:12:3 now', 9), { start: 4, end: 16 });

  assert.deepEqual(wordAt(`say ${red('"hello"')} there`, 6), {
    start: 5,
    end: 9,
  });

  assert.deepEqual(wordAt('call (beta) now', 7), { start: 6, end: 9 });
  assert.deepEqual(wordAt('the end.', 5), { start: 4, end: 6 });
  assert.deepEqual(wordAt('the end!', 5), { start: 4, end: 6 });
  assert.deepEqual(wordAt('the end.', 7), { start: 4, end: 6 });
  assert.deepEqual(wordAt('a ... b', 3), { start: 2, end: 2 });
  assert.deepEqual(wordAt('the end?', 5), { start: 4, end: 6 });
  assert.deepEqual(wordAt('a日b c', 2), { start: 0, end: 3 });
  assert.equal(wordAt('alpha beta', 5), undefined);
});

test("a row's text ends at its last drawn character other than a space", () => {
  assert.equal(textEnd(`a${red('日')}b  `), 3);
  assert.equal(textEnd('   '), undefined);
  assert.equal(textEnd('\u200b\u00ad'), undefined);
});

test("a selection's end steps by drawn character and row, and wraps at the text's end", () => {
  const lines = ['ab', '', 'three 日本 four'];

  const step = (
    row: number,
    column: number,
    direction: Parameters<typeof stepEnd>[2],
  ) => stepEnd(lines, { row, column }, direction, 2);

  assert.deepEqual(step(2, 5, 'right'), { row: 2, column: 6 });
  // across a wide character in one press, from either of its cells
  assert.deepEqual(step(2, 6, 'right'), { row: 2, column: 8 });
  assert.deepEqual(step(2, 8, 'left'), { row: 2, column: 6 });
  assert.deepEqual(step(2, 7, 'left'), { row: 2, column: 5 });
  assert.deepEqual(step(2, 14, 'right'), { row: 2, column: 14 });
  assert.deepEqual(step(0, 1, 'right'), { row: 1, column: 0 });
  assert.deepEqual(step(1, 0, 'right'), { row: 2, column: 0 });
  assert.deepEqual(step(2, 0, 'left'), { row: 1, column: 0 });
  assert.deepEqual(step(1, 0, 'left'), { row: 0, column: 1 });
  assert.deepEqual(step(0, 0, 'left'), { row: 0, column: 0 });
  // from the empty cells past the text
  assert.deepEqual(step(0, 30, 'left'), { row: 0, column: 1 });
  assert.deepEqual(step(0, 30, 'right'), { row: 1, column: 0 });
  assert.deepEqual(step(2, 9, 'up'), { row: 1, column: 9 });
  assert.deepEqual(step(0, 9, 'up'), { row: 0, column: 9 });
  assert.deepEqual(step(2, 9, 'down'), { row: 2, column: 9 });
});

test("a selection's end wraps from a wide character that starts or ends its row's text", () => {
  const step = (
    lines: string[],
    row: number,
    column: number,
    direction: 'left' | 'right',
  ) => stepEnd(lines, { row, column }, direction, lines.length - 1);

  assert.deepEqual(step(['a日', 'x'], 0, 1, 'right'), { row: 1, column: 0 });
  assert.deepEqual(step(['a日', 'x'], 0, 2, 'right'), { row: 1, column: 0 });
  assert.deepEqual(step(['a日'], 0, 1, 'right'), { row: 0, column: 1 });
  assert.deepEqual(step(['a', '日本'], 1, 1, 'left'), { row: 0, column: 0 });
  assert.deepEqual(step(['日本'], 0, 1, 'left'), { row: 0, column: 1 });
});
