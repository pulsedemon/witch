import stringWidth from 'string-width';
import { castRows, castTitle } from '../status/cast.js';
import { colors } from '../theme.js';
import { highlightRow } from '../selection.js';
import type { Point } from '../selection.js';
import type { TranscriptLayout } from './transcript-layout.js';

interface VisibleRowsOptions {
  top: number;
  height: number;
  casting: ReadonlyMap<string, number>;
  starts: ReturnType<TranscriptLayout['render']>['starts'];
  selectedRow: number | undefined;
  ends: [Point, Point] | undefined;
  width: number;
}

export function visibleRows(
  lines: ReturnType<TranscriptLayout['render']>['lines'],
  {
    top,
    height,
    casting,
    starts,
    selectedRow,
    ends,
    width,
  }: VisibleRowsOptions,
): string[] {
  const visible = lines.slice(top, top + height);

  /** in view and outside the selection, which shows the canonical rows it copies. */
  const overlays = (row: number) =>
    row >= top &&
    row - top < visible.length &&
    !(ends && row >= ends[0].row && row <= ends[1].row);

  for (const [id, frame] of casting) {
    const row = starts.get(id);

    if (row === undefined || !overlays(row) || width < stringWidth(castTitle()))
      continue;

    const { heading, above } = castRows(
      frame,
      width,
      id,
      overlays(row - 1) && visible[row - 1 - top] === '',
    );

    visible[row - top] = heading;

    if (above !== undefined) visible[row - 1 - top] = above;
  }

  if (
    selectedRow !== undefined &&
    selectedRow >= top &&
    selectedRow < top + height
  )
    visible[selectedRow - top] = colors.inverse(visible[selectedRow - top]);

  if (ends) {
    const [start, end] = ends;

    for (
      let row = Math.max(top, start.row);
      row <= Math.min(end.row, top + visible.length - 1);
      row++
    )
      visible[row - top] = highlightRow(
        visible[row - top]!,
        row,
        start,
        end,
        width,
      );
  }

  return visible;
}
