import assert from 'node:assert/strict';
import { test } from 'node:test';
import { styledCharsFromTokens, tokenize } from '@alcalzone/ansi-tokenize';
import { placeholder } from '../src/ui/images.js';
import { hyperlink } from '../src/ui/links.js';
import { highlight, selectedText } from '../src/ui/selection.js';

const red = (text: string) => `\u001b[31m${text}\u001b[39m`;
const inverse = (text: string) => `\u001b[7m${text}\u001b[27m`;

await test('a highlight inverts the selected cells as plain text, keeps the styles around it and counts wide characters as two', () => {
  assert.equal(
    highlight(`${red('ab')}日本${red('x')}`, 1, 4),
    `${red('a')}${inverse('b日')}本${red('x')}`,
  );
});

await test('a selection from the right half of a wide character takes the whole character', () => {
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

await test('a highlight and a copy give no cell to a character Ink drops, such as a soft hyphen or a carriage return', () => {
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

await test('a highlight keeps the links of the cells it covers', () => {
  const link = (text: string) =>
    `\u001b]8;;https://example.com/docs\u0007${text}\u001b]8;;\u0007`;
  assert.equal(
    highlight(`see ${link('docs')} here`, 2, 7),
    `se${inverse(`e ${link('doc')}`)}${link('s')} here`,
  );
});

await test('a highlighted link keeps its underline, as the terminal draws a selected link', () => {
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

await test('a highlight past the text covers the empty cells it reaches', () => {
  assert.equal(highlight('ab', 1, 4), `a${inverse('b  ')}`);
  assert.equal(highlight('ab', 3, 5), `ab ${inverse('  ')}`);
});

await test("an image row keeps its placeholders' colors", () => {
  const row = `\u001b[38;5;1m${placeholder.repeat(3)}\u001b[39m`;
  assert.equal(highlight(row, 0, 3), row);
});

await test('selected text joins wrapped rows, breaks between lines, drops trailing spaces and images, and ends at the last cell included', () => {
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

await test('selected text drops trailing spaces in time linear in a long run of spaces before text', () => {
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
