import {
  styledCharsFromTokens,
  styledCharsToString,
  tokenize,
} from '@alcalzone/ansi-tokenize';
import type { StyledChar } from '@alcalzone/ansi-tokenize';
import stringWidth from 'string-width';
import { placeholder } from './images.js';
import { colors } from './theme.js';

/** a transcript row and a column in it. */
export interface Point {
  row: number;
  column: number;
}

// Ink draws neither invisible characters nor controls, so they take no cell and are never copied
const undrawn = /^(?:\p{Default_Ignorable_Code_Point}|\p{Cc})+$/u;

/** `line` cut at columns `start` and `end`, measured as Ink lays characters out. */
function cut(line: string, start: number, end: number) {
  const before: StyledChar[] = [];
  const inside: StyledChar[] = [];
  const after: StyledChar[] = [];
  let width = 0;
  for (const char of styledCharsFromTokens(tokenize(line))) {
    if (undrawn.test(char.value)) continue;
    // a wide character is selected when either of its cells is
    const next = width + Math.max(1, stringWidth(char.value));
    if (next <= start) before.push(char);
    else if (width < end) inside.push(char);
    else after.push(char);
    width = next;
  }
  return { before, inside, after, width };
}

/** columns `start` up to but not including `end` of a row, drawn as Ghostty draws a selection, in the window's colors swapped. */
export function highlight(line: string, start: number, end: number): string {
  // inverting a placeholder changes the color that names its image
  if (line.includes(placeholder)) return line;
  const { before, inside, after, width } = cut(line, start, end);
  // past the text, the selection covers empty cells, as the terminal's does
  const gap = ' '.repeat(Math.max(0, start - width));
  const blank = ' '.repeat(Math.max(0, end - Math.max(start, width)));
  // the selected cells keep their links, so a click on one still opens it, and drop their other styles
  const selected = inside.map((char) => ({
    ...char,
    styles: char.styles.filter(({ code }) => code.startsWith('\u001b]8;')),
  }));
  return `${styledCharsToString(before)}${gap}${colors.inverse(styledCharsToString(selected) + blank)}${styledCharsToString(after)}`;
}

/** the plain text from `start` through `end`, each row after the first joined on by what `joint` gives for it. */
export function selectedText(
  lines: readonly string[],
  start: Point,
  end: Point,
  joint: (row: number) => string,
): string {
  let text: string | undefined;
  for (let row = start.row; row <= end.row; row++) {
    const line = lines[row] ?? '';
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
