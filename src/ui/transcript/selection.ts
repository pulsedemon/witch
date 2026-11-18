import type { ScrollAnchor } from './transcript-layout.js';
import {
  styledCharsFromTokens,
  styledCharsToString,
  tokenize,
} from '@alcalzone/ansi-tokenize';
import type { StyledChar } from '@alcalzone/ansi-tokenize';
import stringWidth from 'string-width';
import { copiedDestination } from '../link-destination.js';
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
/** written before a drawn `│` to leave it and the space after it out of a copy. */
export const uncopied = '\u2063';
/** written before a drawn `│` to copy it and the space on each side as one tab. */
export const tabbed = '\u2062';

const linkOf = ({ styles }: StyledChar) =>
  styles.find(({ code }) => code.startsWith('\u001b]8;'))?.code;

/** `text` without the characters that take no cell, which is what of it a copy keeps. */
export function shown(text: string): string {
  let kept = '';

  for (const { char } of drawn(text)) kept += char.value;

  return kept;
}

/**
 * each character of `line` that takes cells, with the columns it covers up to but not including `end`, as Ink lays
 * them out, and what it copies as: itself, unless it is a `│` right after a mark.
 */
function* drawn(line: string) {
  let start = 0;
  let mark: string | undefined;

  for (const char of styledCharsFromTokens(tokenize(line))) {
    if (undrawn.test(char.value)) {
      mark = char.value;

      continue;
    }

    const end = start + Math.max(1, stringWidth(char.value));
    const rule = char.value === '│' ? mark : undefined;

    yield {
      char,
      start,
      end,
      copied:
        rule === tabbed ? '\t' : rule === uncopied ? uncopied : char.value,
    };

    mark = undefined;
    start = end;
  }
}

/** `line` cut at columns `start` and `end`, with what each cell inside copies as and the destination its link copies. */
function cut(line: string, start: number, end: number) {
  const before: StyledChar[] = [];
  const inside: StyledChar[] = [];
  const after: StyledChar[] = [];
  const copied: { text: string; destination: string | undefined }[] = [];
  let width = 0;

  for (const { char, start: from, end: next, copied: text } of drawn(line)) {
    // a wide character is selected when either of its cells is
    if (next <= start) before.push(char);
    else if (from < end) {
      inside.push(char);
      copied.push({ text, destination: copiedDestination(linkOf(char)) });
    } else after.push(char);

    width = next;
  }

  return { before, inside, after, width, copied };
}

const wordBreak = /^[\s'"`()[\]{}<>│]$/u;

/**
 * the first and last column of the word at `column`: the cells around it up to whitespace, a quote, a bracket or a
 * table rule, without any `.`, `,`, `;`, `:`, `!` or `?` that ends it; of a run that is nothing else, its first character. on a link it is the link's cells on this row,
 * so a linked path with spaces stays whole. none on a space, a quote, a bracket or a rule outside a link.
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

/**
 * plain text from `start` through `end`, skipping images and joining each copied row after the first with `joint`.
 * a marked quote rule goes with the space after it, and a marked table rule with the space on each side becomes a tab,
 * where that space is a `joint` too. a link that copies its destination gets it in parentheses after its last selected
 * cell, once for a label wrapped over rows.
 */
export function selectedText(
  lines: Pick<readonly string[], 'at'>,
  start: Point,
  end: Point,
  joint: (row: number) => string,
): string {
  let text: string | undefined;
  // `end` is past the link's last cell that isn't a space, so a row's trailing space stays after the destination
  let open: { destination: string; end: number } | undefined;

  const close = () => {
    if (!open) return;

    text = `${text!.slice(0, open.end)} (${open.destination})${text!.slice(open.end)}`;
    open = undefined;
  };

  for (let row = start.row; row <= end.row; row++) {
    const line = lines.at(row)!;

    if (line.includes(placeholder)) continue;

    const cells = cut(
      line,
      row === start.row ? start.column : 0,
      row === end.row ? end.column + 1 : Infinity,
    ).copied;

    const joined = text === undefined ? '' : joint(row);

    // a label goes on over a wrap, not over a line break in its source
    if (joined.includes('\n')) close();

    text = (text ?? '') + joined;

    for (const cell of cells) {
      if (cell.destination !== open?.destination) close();

      if (cell.destination)
        open ??= { destination: cell.destination, end: text.length };

      text += cell.text;

      if (open && cell.text.trim()) open.end = text.length;
    }
  }

  close();

  return (
    (text ?? '')
      // a rule's padding goes here, not row by row: a wrap can trim it and the join puts it back
      .replaceAll(`${uncopied} `, '')
      .replaceAll(uncopied, '')
      .replace(/ ?\t ?/g, '\t')
      // starting only at a run's first space keeps a long run of spaces before text linear
      .replace(/(?<! ) +$/gm, '')
  );
}
