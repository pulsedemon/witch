import { diffArrays } from 'diff';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { shortPath } from '../agents/tool-title.js';
import type { FileDiff } from '../agents/types.js';
import { hyperlink, oneLine, plain } from './links.js';
import type { Span } from './syntax.js';
import { languageOf, syntaxSpans } from './syntax.js';
import {
  colors,
  diffAdded,
  diffAddedMarker,
  diffAddedWord,
  diffRemoved,
  diffRemovedMarker,
  diffRemovedWord,
} from './theme.js';

/** how many lines of a new or deleted file show. */
const preview = 10;

const verbs = { add: 'Create', delete: 'Delete', update: 'Update' };

/** Claude Code's colors for an added or removed row: its background, its changed words' and its number's and marker's. */
const changes: Partial<
  Record<string, { line: string; word: string; marker: string }>
> = {
  '+': { line: diffAdded, word: diffAddedWord, marker: diffAddedMarker },
  '-': { line: diffRemoved, word: diffRemovedWord, marker: diffRemovedMarker },
};

interface Range {
  start: number;
  end: number;
}

interface Row {
  number: number;
  marker: string;
  code: string;
  spans: Span[];
  /** what this row changed against the row it pairs with. */
  words: Range[];
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** word runs, whitespace runs and every other character alone, as Claude Code splits a line, never inside a grapheme. */
function tokens(text: string): string[] {
  const found: string[] = [];
  let kind: string | undefined;
  for (const { segment } of graphemes.segment(text)) {
    const next = /^[\p{L}\p{N}_]/u.test(segment)
      ? 'word'
      : /^\s/.test(segment)
        ? 'space'
        : 'other';
    if (next !== 'other' && next === kind) found[found.length - 1] += segment;
    else found.push(segment);
    kind = next;
  }
  return found;
}

/**
 * the ranges each side changed, as Claude Code finds them, or none when over 40% of their text changed. a pair needing
 * over 400 token edits gets none too, since the search's cost grows with both lengths and lines aren't cut.
 */
function changedWords(before: string, after: string): [Range[], Range[]] {
  const parts = diffArrays(tokens(before), tokens(after), {
    maxEditLength: 400,
  });
  if (!parts) return [[], []];
  const ranges: [Range[], Range[]] = [[], []];
  const at = [0, 0];
  let changed = 0;
  for (const part of parts) {
    const size = part.value.join('').length;
    const sides = part.removed ? [0] : part.added ? [1] : [0, 1];
    for (const side of sides) {
      if (sides.length === 1)
        ranges[side]!.push({ start: at[side]!, end: at[side]! + size });
      at[side]! += size;
    }
    if (sides.length === 1) changed += size;
  }
  return changed / (before.length + after.length) > 0.4 ? [[], []] : ranges;
}

/** each removed row with the added row at its place in the run that follows its own, as Claude Code pairs them, though a no-newline marker, which gets no row, doesn't end a run. */
function pairs(rows: readonly Row[]): [Row, Row][] {
  const paired: [Row, Row][] = [];
  for (let at = 0; at < rows.length;) {
    let removed = at;
    while (rows[removed]?.marker === '-') removed++;
    let added = removed;
    while (rows[added]?.marker === '+') added++;
    for (
      let index = 0;
      index < Math.min(removed - at, added - removed);
      index++
    )
      paired.push([rows[at + index]!, rows[removed + index]!]);
    at = Math.max(added, at + 1);
  }
  return paired;
}

/** `spans` in their colors, with what `words` covers on `background`. */
function paint(
  spans: readonly Span[],
  words: readonly Range[],
  background: string | undefined,
): string {
  let text = '';
  let at = 0;
  for (const span of spans) {
    const end = at + span.text.length;
    const cuts = words
      .flatMap((word) => [word.start, word.end])
      .filter((cut) => cut > at && cut < end);
    const starts = [at, ...cuts];
    for (const [index, start] of starts.entries()) {
      let piece = span.text.slice(start - at, (cuts[index] ?? end) - at);
      if (span.color) piece = colors.hex(span.color)(piece);
      if (
        background &&
        words.some((word) => word.start <= start && start < word.end)
      )
        piece = colors.bgHex(background)(piece);
      text += piece;
    }
    at = end;
  }
  return text;
}

function fileRows(file: FileDiff, width: number, cwd: string): string[][] {
  // undefined separates hunks
  const rows: (Row | undefined)[] = [];
  const whole = file.kind !== 'update';
  let added = 0;
  let removed = 0;
  let shown = 0;
  let hidden = 0;
  const top = file.hunks[0];
  const language = languageOf(
    file.movePath ?? file.path,
    top?.newStart === 1
      ? top.lines.find((line) => line[0] === ' ' || line[0] === '+')?.slice(1)
      : undefined,
  );
  for (const [index, hunk] of file.hunks.entries()) {
    if (index) rows.push(undefined);
    const drawn: Row[] = [];
    let old = hunk.oldStart;
    let now = hunk.newStart;
    for (const line of hunk.lines) {
      const marker = line[0];
      if (marker === '+') added++;
      else if (marker === '-') removed++;
      // such as jsdiff's `\ No newline at end of file`
      else if (marker !== ' ') continue;
      const number = marker === '-' ? old : now;
      if (marker !== '+') old++;
      if (marker !== '-') now++;
      if (whole && shown === preview) hidden++;
      else {
        shown++;
        const code = plain(line.slice(1)).replaceAll('\r', '');
        drawn.push({
          number,
          marker,
          code,
          spans: [{ text: code }],
          words: [],
        });
      }
    }
    // removed rows stay plain, as Claude Code draws them
    const kept = drawn.filter((row) => row.marker !== '-');
    const spans = syntaxSpans(
      kept.map(({ code }) => code),
      language,
    );
    for (const [at, row] of kept.entries()) row.spans = spans[at]!;
    for (const [removed, added] of pairs(drawn))
      [removed.words, added.words] = changedWords(removed.code, added.code);
    for (const row of drawn) rows.push(row);
  }
  // a loop, since spreading every number into Math.max exceeds the argument limit
  let digits = 1;
  for (const row of rows)
    if (row) digits = Math.max(digits, String(row.number).length);

  const link = (path: string) =>
    hyperlink(oneLine(shortPath(path, cwd)), path, cwd);
  const header = [
    colors.dim(file.movePath ? 'Move' : verbs[file.kind]),
    link(file.path),
    ...(file.movePath ? ['→', link(file.movePath)] : []),
    ...(file.kind === 'delete' ? [] : [colors.green(`+${added}`)]),
    ...(file.kind === 'add' ? [] : [colors.red(`-${removed}`)]),
  ].join(' ');
  const lines = [wrapAnsi(header, width, { hard: true }).split('\n')];
  const gutter = ' '.repeat(digits + 2);
  for (const row of rows) {
    if (!row) {
      lines.push([colors.dim('...')]);
      continue;
    }
    const change = changes[row.marker];
    // wrapping the code on its own expands its tabs from its first column
    const code = wrapAnsi(
      paint(row.spans, row.words, change?.word),
      width - digits - 2,
      { hard: true, trim: false },
    ).split('\n');
    const number = String(row.number).padStart(digits);
    lines.push(
      code.map((part, index) => {
        if (!change)
          return index ? gutter + part : `${colors.dim(number)}  ${part}`;
        const text = index
          ? gutter + part
          : colors.hex(change.marker)(`${number} ${row.marker}`) + part;
        return colors.bgHex(change.line)(
          text + ' '.repeat(Math.max(0, width - stringWidth(text))),
        );
      }),
    );
  }
  if (hidden) lines.push([colors.dim(`… +${hidden} lines`)]);
  return lines;
}

/** each file's header and numbered lines, a blank line apart, as the rows each line wraps into. every row fits `width` while it leaves the code two cells, the widest a character takes. */
export function diffRows(
  files: readonly FileDiff[],
  width: number,
  cwd: string,
): string[][] {
  return files.flatMap((file, index) => [
    ...(index ? [['']] : []),
    ...fileRows(file, width, cwd),
  ]);
}
