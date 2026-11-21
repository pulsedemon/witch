import { wrapJoin } from './selection.js';
import type { SelectionSource } from './selection.js';
import type { PagePosition } from './scroll-page-layout.js';
import type { WrappedLines } from './wrap.js';

export function pageSelection(
  lines: WrappedLines,
): SelectionSource<PagePosition> {
  const rows = lines.flatMap((parts, line) =>
    parts.map((part) => ({ ...part, line })),
  );

  const continues = (row: number) => {
    const here = rows[row];
    const before = rows[row - 1];

    return here && before && here.line === before.line && !here.copyBreak;
  };

  return {
    lines: rows.map(({ text }) => text),
    anchorAt: (row) => {
      const at = rows[row];

      return at && { line: at.line, offset: at.offset };
    },
    rowOf: (anchor) => {
      const row = rows.findIndex(
        ({ line, offset }) => line === anchor.line && offset === anchor.offset,
      );

      return row < 0 ? undefined : row;
    },
    sameAnchor: (a, b) => a.line === b.line && a.offset === b.offset,
    lineAt: (row) => {
      let first = row;
      let last = row;

      while (continues(first)) first--;

      while (continues(last + 1)) last++;

      return { first, last };
    },
    joinBefore: (row) =>
      continues(row)
        ? wrapJoin(
            rows[row - 1]!.text,
            rows[row - 1]!.offset,
            rows[row]!.offset,
          )
        : '\n',
  };
}
