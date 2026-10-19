import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { shortPath } from '../agents/tool-title.js';
import type { FileDiff } from '../agents/types.js';
import { hyperlink, oneLine, plain } from './links.js';
import { colors, diffAdded, diffRemoved } from './theme.js';

/** how many lines of a new or deleted file show. */
const preview = 10;

const verbs = { add: 'Create', delete: 'Delete', update: 'Update' };

interface Row {
  number: number;
  marker: string;
  code: string;
}

function fileRows(file: FileDiff, width: number, cwd: string): string[][] {
  // undefined separates hunks
  const rows: (Row | undefined)[] = [];
  const whole = file.kind !== 'update';
  let added = 0;
  let removed = 0;
  let shown = 0;
  let hidden = 0;
  for (const [index, hunk] of file.hunks.entries()) {
    if (index) rows.push(undefined);
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
        rows.push({ number, marker, code: line.slice(1) });
      }
    }
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
    // wrapping the code on its own expands its tabs from its first column
    const code = wrapAnsi(
      plain(row.code).replaceAll('\r', ''),
      width - digits - 2,
      { hard: true, trim: false },
    ).split('\n');
    const number = String(row.number).padStart(digits);
    const background =
      row.marker === '+'
        ? colors.bgHex(diffAdded)
        : row.marker === '-'
          ? colors.bgHex(diffRemoved)
          : undefined;
    lines.push(
      code.map((part, index) => {
        if (!background)
          return index ? gutter + part : `${colors.dim(number)}  ${part}`;
        const text = index ? gutter + part : `${number} ${row.marker}${part}`;
        return background(
          text + ' '.repeat(Math.max(0, width - stringWidth(text))),
        );
      }),
    );
  }
  if (hidden) lines.push([colors.dim(`… +${hidden} lines`)]);
  return lines;
}

/** each file's header and numbered lines, a blank line apart, as the rows each line wraps into. Every row fits `width` while it leaves the code two cells, the widest a character takes. */
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
