import type { ScrollAnchor } from './transcript-layout.js';
import {
  styledCharsFromTokens,
  styledCharsToString,
  tokenize,
} from '@alcalzone/ansi-tokenize';
import type { StyledChar } from '@alcalzone/ansi-tokenize';
import stringWidth from 'string-width';
import { placeholder } from './images.js';
import { colors } from '../theme.js';

/** a transcript row and a column in it. */
export interface Point {
  row: number;
  column: number;
}

/** one end of a drag in the transcript: the row it is on, by its text, and the column. */
export interface RangeEnd {
  anchor: ScrollAnchor;
  column: number;
  /** the width it was measured at; a width change drops the range, since a column from a wider one can lie past the edge. */
  width: number;
  /** its row as measured; output growing into the row, or its tool expanding or collapsing, changes it. */
  text: string;
}

// Ink draws neither invisible characters nor controls, so they take no cell and are never copied
const undrawn = /^(?:\p{Default_Ignorable_Code_Point}|\p{Cc})+$/u;

/** each character of `line` that takes cells, with the columns it covers up to but not including `end`, as Ink lays them out. */
function* drawn(line: string) {
  let start = 0;

  for (const char of styledCharsFromTokens(tokenize(line))) {
    if (undrawn.test(char.value)) continue;

    const end = start + Math.max(1, stringWidth(char.value));
    yield { char, start, end };
    start = end;
  }
}

/** `line` cut at columns `start` and `end`. */
function cut(line: string, start: number, end: number) {
  const before: StyledChar[] = [];
  const inside: StyledChar[] = [];
  const after: StyledChar[] = [];
  let width = 0;

  for (const { char, start: from, end: next } of drawn(line)) {
    // a wide character is selected when either of its cells is
    if (next <= start) before.push(char);
    else if (from < end) inside.push(char);
    else after.push(char);

    width = next;
  }

  return { before, inside, after, width };
}

const linkOf = ({ styles }: StyledChar) =>
  styles.find(({ code }) => code.startsWith('\u001b]8;'))?.code;

const wordBreak = /^[\s'"`()[\]{}<>│]$/u;

/**
 * the first and last column of the word at `column`: the cells around it up to whitespace, a quote, a bracket or a
 * table rule, without any `.`, `,`, `;`, `:`, `!` or `?` that ends it. on a link it is the link's cells on this row,
 * so a linked path with spaces stays whole. none on a space, a quote, a bracket or a rule.
 */
export function wordAt(
  line: string,
  column: number,
): { start: number; end: number } | undefined {
  const cells = [...drawn(line)];

  const at = cells.findIndex(
    ({ start, end }) => column >= start && column < end,
  );

  if (at < 0) return undefined;

  const link = linkOf(cells[at]!.char);

  const inWord = (index: number) =>
    link
      ? linkOf(cells[index]!.char) === link
      : !wordBreak.test(cells[index]!.char.value);

  if (!inWord(at)) return undefined;

  let first = at;
  let last = at;

  while (first > 0 && inWord(first - 1)) first--;

  while (last < cells.length - 1 && inWord(last + 1)) last++;

  if (!link)
    while (last > first && /[.,;:!?]/.test(cells[last]!.char.value)) last--;

  return { start: cells[first]!.start, end: cells[last]!.end - 1 };
}

/** the last column of `line` that holds a character other than a space, or none in a blank row. */
export function textEnd(line: string): number | undefined {
  let last: number | undefined;

  for (const { char, end } of drawn(line))
    if (char.value.trim()) last = end - 1;

  return last;
}

/** columns `start` up to but not including `end` of a row, drawn as Ghostty draws a selection, in the window's colors swapped. */
export function highlight(line: string, start: number, end: number): string {
  // inverting a placeholder changes the color that names its image
  if (line.includes(placeholder)) return line;

  const { before, inside, after, width } = cut(line, start, end);
  // past the text, the selection covers empty cells, as the terminal's does
  const gap = ' '.repeat(Math.max(0, start - width));
  const blank = ' '.repeat(Math.max(0, end - Math.max(start, width)));

  // the selected cells keep their links and underline, so a link still opens and looks like one, as in the
  // terminal's own selection, and drop their other styles
  const selected = inside.map((char) => ({
    ...char,
    styles: char.styles.filter(
      ({ code }) => code.startsWith('\u001b]8;') || code === '\u001b[4m',
    ),
  }));

  return `${styledCharsToString(before)}${gap}${colors.inverse(styledCharsToString(selected) + blank)}${styledCharsToString(after)}`;
}

/** plain text from `start` through `end`, skipping images and joining each copied row after the first with `joint`. */
export function selectedText(
  lines: Pick<readonly string[], 'at'>,
  start: Point,
  end: Point,
  joint: (row: number) => string,
): string {
  let text: string | undefined;

  for (let row = start.row; row <= end.row; row++) {
    const line = lines.at(row)!;

    if (line.includes(placeholder)) continue;

    text = text === undefined ? '' : text + joint(row);

    text += cut(
      line,
      row === start.row ? start.column : 0,
      row === end.row ? end.column + 1 : Infinity,
    )
      .inside.map(({ value }) => value)
      .join('');
  }

  // starting only at a run's first space keeps a long run of spaces before text linear
  return (text ?? '').replace(/(?<! ) +$/gm, '');
}
