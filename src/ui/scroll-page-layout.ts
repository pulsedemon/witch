import type { WrappedLines } from './wrap.js';

export interface PagePosition {
  line: number;
  offset: number;
}

export const pageStart: PagePosition = { line: 0, offset: 0 };

export function pageAnchorAt(lines: WrappedLines, row: number): PagePosition {
  let line = 0;

  while (line < lines.length - 1 && row >= lines[line]!.length) {
    row -= lines[line]!.length;

    line++;
  }

  return { line, offset: lines[line]?.[row]?.offset ?? 0 };
}

export function pageRowOf(lines: WrappedLines, anchor: PagePosition): number {
  const first = lines
    .slice(0, anchor.line)
    .reduce((sum, line) => sum + line.length, 0);

  const source = lines[anchor.line] ?? [];
  let row = 0;

  for (let index = 1; index < source.length; index++) {
    if (source[index]!.offset > anchor.offset) break;

    row = index;
  }

  return first + row;
}
