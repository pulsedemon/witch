import { diffArrays } from 'diff';
import stringWidth from 'string-width';
import { shortPath } from '../agents/tool-title.js';
import type { FileDiff } from '../agents/types.js';
import { hyperlink, oneLine, plain } from './links.js';
import type { Span } from './syntax.js';
import { languageOf, syntaxSpans } from './syntax.js';
import { wrapLines } from './wrap.js';
import {
  colors,
  diffAdded,
  diffAddedMarker,
  diffAddedWord,
  diffRemoved,
  diffRemovedMarker,
  diffRemovedWord,
} from './theme.js';

const preview = 10;

export function canExpandDiff(files: readonly FileDiff[]): boolean {
  return files.some((file) => {
    if (file.kind === 'update') return false;

    let lines = 0;

    for (const hunk of file.hunks)
      for (const line of hunk.lines)
        if (['+', '-', ' '].includes(line[0] ?? '') && ++lines > preview)
          return true;

    return false;
  });
}

export function diffExpansionHint(full: boolean): string {
  return full ? 'CTRL+O SHOW PREVIEW' : 'CTRL+O SHOW ALL LINES';
}

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
 * the ranges each side changed, as Claude Code finds them, or none when over 40% of their text changed.
 * token counts skip searches that cannot finish within the edit cap; order can only require more edits.
 */
function changedWords(before: string, after: string): [Range[], Range[]] {
  const maxEdits = 400;

  const oldTokens = tokens(before);

  const newTokens = tokens(after);

  let unmatched = oldTokens.length + newTokens.length;

  if (unmatched > maxEdits) {
    const counts = new Map<string, number>();

    for (const token of oldTokens)
      counts.set(token, (counts.get(token) ?? 0) + 1);

    for (const token of newTokens) {
      const count = counts.get(token) ?? 0;

      if (count) {
        counts.set(token, count - 1);

        unmatched -= 2;
      }
    }

    if (unmatched > maxEdits) return [[], []];
  }

  const parts = diffArrays(oldTokens, newTokens, { maxEditLength: maxEdits });

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

function prepareFile(
  file: FileDiff,
  cwd: string,
  full: boolean,
): (width: number) => string[][] {
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

      if (whole && !full && shown === preview) hidden++;
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

    for (const [removed, added] of pairs(drawn))
      [removed.words, added.words] = changedWords(removed.code, added.code);

    for (const row of drawn) rows.push(row);
  }

  // removed rows stay plain, as Claude Code draws them
  const kept = rows.filter(
    (row): row is Row => row !== undefined && row.marker !== '-',
  );

  const spans = syntaxSpans(
    kept.map(({ code }) => code),
    language,
  );

  for (const [at, row] of kept.entries()) row.spans = spans[at]!;

  // a loop, since spreading every number into Math.max exceeds the argument limit
  let digits = 1;

  for (const row of rows)
    if (row) digits = Math.max(digits, String(row.number).length);

  const link = (path: string) =>
    hyperlink(oneLine(shortPath(path, cwd)), path, cwd);

  // a file whose lines were left out carries Git's counts, and a binary one has none
  const counts =
    file.unshown === 'binary'
      ? undefined
      : (file.unshown ?? { added, removed });

  const header = [
    colors.dim(file.movePath ? 'Move' : verbs[file.kind]),
    link(file.path),
    ...(file.movePath ? ['→', link(file.movePath)] : []),
    ...(counts && file.kind !== 'delete'
      ? [colors.green(`+${counts.added}`)]
      : []),
    ...(counts && file.kind !== 'add'
      ? [colors.red(`-${counts.removed}`)]
      : []),
  ].join(' ');

  const gutter = ' '.repeat(digits + 2);

  const painted = rows.map((row) => {
    if (!row) return undefined;

    const change = changes[row.marker];

    const number = String(row.number).padStart(digits);

    return {
      code: paint(row.spans, row.words, change?.word),
      prefix: change
        ? colors.hex(change.marker)(`${number} ${row.marker}`)
        : `${colors.dim(number)}  `,
      background: change?.line,
    };
  });

  return (width) => {
    const lines = [wrapLines(header, width, true)];

    for (const row of painted) {
      if (!row) {
        lines.push([colors.dim('...')]);

        continue;
      }

      // wrapping the code on its own expands its tabs from its first column
      const code = wrapLines(row.code, width - digits - 2);

      lines.push(
        code.map((part, index) => {
          const text = (index ? gutter : row.prefix) + part;

          return row.background
            ? colors.bgHex(row.background)(
                text + ' '.repeat(Math.max(0, width - stringWidth(text))),
              )
            : text;
        }),
      );
    }

    if (hidden) lines.push([colors.dim(`… +${hidden} lines`)]);

    if (file.unshown)
      lines.push([
        colors.dim(file.unshown === 'binary' ? '… binary' : '… not shown'),
      ]);

    return lines;
  };
}

export function prepareDiff(
  files: readonly FileDiff[],
  cwd: string,
  full = false,
): (width: number) => string[][] {
  const prepared = files.map((file) => prepareFile(file, cwd, full));

  return (width) =>
    prepared.flatMap((render, index) => [
      ...(index ? [['']] : []),
      ...render(width),
    ]);
}

/** each file's header and numbered lines, a blank line apart, as the rows each line wraps into. every row fits `width` while it leaves the code two cells, the widest a character takes. */
export function diffRows(
  files: readonly FileDiff[],
  width: number,
  cwd: string,
  full = false,
): string[][] {
  return prepareDiff(files, cwd, full)(width);
}
