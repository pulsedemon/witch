import stripAnsi from 'strip-ansi';
import {
  styledCharsFromTokens,
  styledCharsToString,
  tokenize,
} from '@alcalzone/ansi-tokenize';
import type { StyledChar } from '@alcalzone/ansi-tokenize';
import stringWidth from 'string-width';
import { copiedDestination } from './link-destination.js';
import { placeholder } from './transcript/images.js';
import { colors } from './theme.js';

/** a text row and a column in it. */
export interface Point {
  row: number;
  column: number;
}

export interface SelectionSource<Anchor> {
  lines: Pick<readonly string[], 'at' | 'length'>;
  anchorAt(row: number): Anchor | undefined;

  rowOf(anchor: Anchor): number | undefined;

  sameAnchor(a: Anchor, b: Anchor): boolean;

  lineAt(row: number): { first: number; last: number };

  joinBefore(row: number): string;
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

/** `line` cut at columns `start` and `end`, with what each cell inside copies as and its link's code. */
function cut(line: string, start: number, end: number) {
  const before: StyledChar[] = [];
  const inside: StyledChar[] = [];
  const after: StyledChar[] = [];
  const copied: { text: string; link: string | undefined }[] = [];
  let width = 0;

  for (const { char, start: from, end: next, copied: text } of drawn(line)) {
    // a wide character is selected when either of its cells is
    if (next <= start) before.push(char);
    else if (from < end) {
      inside.push(char);
      copied.push({ text, link: linkOf(char) });
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

const image = (line: string) => line.includes(placeholder);

/**
 * where a selection's end at `at` goes for one arrow key. ← and → step by drawn character, so a wide one takes one
 * press, and wrap between rows at the row's last text column. ↑ and ↓ keep the column. no key lands on an image
 * row, which draws and copies nothing: each passes over it, or stays when only image rows are left that way.
 */
export function stepEnd(
  lines: Pick<readonly string[], 'at' | 'length'>,
  at: Point,
  direction: 'left' | 'right' | 'up' | 'down',
): Point {
  const { row, column } = at;
  const back = direction === 'left' || direction === 'up';
  let beside = row + (back ? -1 : 1);

  while (beside >= 0 && beside < lines.length && image(lines.at(beside)!))
    beside += back ? -1 : 1;

  const wrapped = (place: (line: string) => number): Point =>
    beside >= 0 && beside < lines.length
      ? { row: beside, column: place(lines.at(beside)!) }
      : at;

  if (direction === 'up' || direction === 'down') return wrapped(() => column);

  const line = lines.at(row)!;
  const onImage = image(line);
  const end = textEnd(line) ?? 0;
  const starts = [...drawn(line)].map(({ start }) => start);
  const covering = starts.findLastIndex((start) => start <= column);

  if (direction === 'right') {
    const next = starts[covering + 1];

    return !onImage && next !== undefined && next <= end
      ? { row, column: next }
      : wrapped(() => 0);
  }

  if (!onImage && column > end) return { row, column: end };

  return !onImage && covering > 0
    ? { row, column: starts[covering - 1]! }
    : wrapped((previous) => textEnd(previous) ?? 0);
}

/** columns `start` up to but not including `end` of a row, drawn as Ghostty draws a selection, in the window's colors swapped. */
export function highlight(line: string, start: number, end: number): string {
  // inverting a placeholder changes the color that names its image
  if (image(line)) return line;

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

export function highlightRow(
  line: string,
  row: number,
  start: Point,
  end: Point,
  width: number,
): string {
  return highlight(
    line,
    row === start.row ? start.column : 0,
    row === end.row ? end.column + 1 : width,
  );
}

/**
 * plain text from `start` through `end`, skipping images and joining each copied row after the first with `joint`.
 * a marked quote rule goes with the space after it, and a marked table rule with the space on each side becomes a tab,
 * where that space is a `joint` too. a link that copies its destination gets it in parentheses after its last selected
 * cell that isn't a space, once for a label wrapped over rows.
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
  // a link's cells share one code, so its destination is worked out once
  let link: string | undefined;
  let destination: string | undefined;

  const close = () => {
    if (!open) return;

    text = `${text!.slice(0, open.end)} (${open.destination})${text!.slice(open.end)}`;
    open = undefined;
  };

  for (let row = start.row; row <= end.row; row++) {
    const line = lines.at(row)!;

    if (image(line)) continue;

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
      if (cell.link !== link) {
        link = cell.link;
        destination = copiedDestination(link);
      }

      if (destination !== open?.destination) close();

      if (destination) open ??= { destination, end: text.length };

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
      // a table cell's no-break padding before its rule; ordinary spaces stay
      .replace(/(?<!\u00a0)\u00a0[\u00a0 ]*\t/g, '\t')
      .replace(/ ?\t ?/g, '\t')
      // starting only at a run's first space keeps a long run of spaces before text linear
      .replace(/(?<! ) +$/gm, '')
  );
}

/** the first and last cell of the word or line at a cell, or none where there is no text to select. */
export function spanOf(
  transcript: {
    lines: Pick<readonly string[], 'at'>;
    lineAt(row: number): { first: number; last: number };
  },
  { row, column }: Point,
  unit: 'word' | 'line',
): [Point, Point] | undefined {
  if (unit === 'word') {
    const word = wordAt(transcript.lines.at(row)!, column);

    return (
      word && [
        { row, column: word.start },
        { row, column: word.end },
      ]
    );
  }

  const { first, last } = transcript.lineAt(row);

  // a line's last rows can hold only characters that are not drawn
  for (let end = last; end >= first; end--) {
    const column = textEnd(transcript.lines.at(end)!);

    if (column !== undefined)
      return [
        { row: first, column: 0 },
        { row: end, column },
      ];
  }

  return undefined;
}

/** the first cell and the last text cell of `lines`, or none when no row holds text. */
export function textEnds(
  lines: Pick<readonly string[], 'at' | 'length'>,
): [Point, Point] | undefined {
  for (let row = lines.length - 1; row >= 0; row--) {
    const line = lines.at(row)!;
    const column = image(line) ? undefined : textEnd(line);

    if (column !== undefined)
      return [
        { row: 0, column: 0 },
        { row, column },
      ];
  }

  return undefined;
}

/** whether a selection from `start` through `end` highlights any cell of rows `top` through `bottom`; images and rows past it draw none. */
export function drawsIn(
  lines: Pick<readonly string[], 'at'>,
  start: Point,
  end: Point,
  top: number,
  bottom: number,
  width: number,
): boolean {
  for (
    let row = Math.max(top, start.row);
    row <= Math.min(end.row, bottom);
    row++
  ) {
    const line = lines.at(row)!;

    if (highlightRow(line, row, start, end, width) !== line) return true;
  }

  return false;
}

/** restores only the spaces trimmed by a soft wrap; negative offsets have no source spacing. */
export function wrapJoin(
  previousText: string,
  previousOffset: number,
  currentOffset: number,
): string {
  if (currentOffset < 0 || previousOffset < 0) return ' ';

  const trimmed =
    currentOffset - previousOffset - stripAnsi(previousText).length;

  return trimmed < 0 ? '\n' : ' '.repeat(trimmed);
}
