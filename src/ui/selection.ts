import {
  styledCharsFromTokens,
  styledCharsToString,
  tokenize,
} from '@alcalzone/ansi-tokenize';
import type { StyledChar } from '@alcalzone/ansi-tokenize';
import stringWidth from 'string-width';
import { placeholder } from './images.js';
import { plain } from './links.js';
import { colors } from './theme.js';

/** a transcript row and a column in it. */
export interface Point {
  row: number;
  column: number;
}

/** `line` cut at columns `start` and `end`, measured as Ink lays characters out. */
function cut(line: string, start: number, end: number) {
  const before: StyledChar[] = [];
  const after: StyledChar[] = [];
  let inside = '';
  let width = 0;
  for (const char of styledCharsFromTokens(tokenize(line))) {
    if (/^\p{Default_Ignorable_Code_Point}+$/u.test(char.value)) continue;
    if (width < start) before.push(char);
    else if (width < end) inside += char.value;
    else after.push(char);
    width += Math.max(1, stringWidth(char.value));
  }
  return { before, inside: plain(inside), after, width };
}

/** columns `start` up to but not including `end` of a row, drawn as Ghostty draws a selection, in the window's colors swapped. */
export function highlight(line: string, start: number, end: number): string {
  // inverting a placeholder changes the color that names its image
  if (line.includes(placeholder)) return line;
  const { before, inside, after, width } = cut(line, start, end);
  // past the text, the selection covers empty cells, as the terminal's does
  const gap = ' '.repeat(Math.max(0, start - width));
  const blank = ' '.repeat(Math.max(0, end - Math.max(start, width)));
  return `${styledCharsToString(before)}${gap}${colors.inverse(inside + blank)}${styledCharsToString(after)}`;
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
    ).inside;
  }
  return (text ?? '').replace(/[ \t]+$/gm, '');
}
