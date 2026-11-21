import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Box, Text, measureElement, useInput } from 'ink';
import type { DOMElement } from 'ink';
import { usePointer, useWheel } from './terminal/mouse.js';
import { useSelection } from './useSelection.js';
import { pageSelection } from './page-selection.js';
import { highlightRow } from './selection.js';
import type { WrappedLines } from './wrap.js';
import { pageAnchorAt, pageRowOf } from './scroll-page-layout.js';
import type { PagePosition } from './scroll-page-layout.js';

interface Props {
  lines: WrappedLines;
  width: number;
  identity: unknown;
  copy?(text: string): void;

  current?(): boolean;
  height: number;
  scroll: PagePosition;
  setScroll: Dispatch<SetStateAction<PagePosition>>;
  arrows?: boolean;
  active?: boolean;
}

export function ScrollPage({
  lines,
  width,
  identity,
  copy,
  current,
  height,
  scroll,
  setScroll,
  arrows = false,
  active = true,
}: Props) {
  const source = useMemo(() => pageSelection(lines), [lines]);
  const rows = source.lines;
  const box = useRef<DOMElement>(null);
  const liveScroll = useRef(scroll);

  useLayoutEffect(() => {
    liveScroll.current = scroll;
  });

  const position = useMemo(() => pageRowOf(lines, scroll), [lines, scroll]);
  const last = Math.max(0, rows.length - height);
  const top = Math.min(position, last);

  /** steps from the shown top, so movement still works after the page shrinks. */
  const scrollBy = (amount: number) => {
    const shown = Math.min(pageRowOf(lines, liveScroll.current), last);
    const next = Math.max(0, Math.min(last, shown + amount));

    if (next === shown) return false;

    liveScroll.current = pageAnchorAt(lines, next);
    setScroll(liveScroll.current);

    return true;
  };

  const shown = () => active && (current?.() ?? true);

  const selection = useSelection({
    source,
    identity,
    width,
    bodyWidth: width,
    box,
    shown,
    viewport: () => ({
      top: Math.min(pageRowOf(lines, liveScroll.current), last),
      height,
    }),
    scrollBy,
    covers: ({ column }) =>
      !!box.current && column < measureElement(box.current).x,
    copy,
  });

  usePointer(selection.point);

  // request input guards do not block scrolling.
  useWheel((rows, cell) => {
    if (shown() && scrollBy(rows)) selection.point('wheel', cell);
  });

  useInput((input, key) => {
    if (!shown() || key.eventType === 'release') return;

    if (key.super && input === 'c') selection.key(input, key);

    const rows = key.pageDown
      ? height
      : arrows && key.downArrow
        ? 1
        : key.pageUp
          ? -height
          : arrows && key.upArrow
            ? -1
            : 0;

    if (rows) scrollBy(rows);
  });

  return (
    <Box ref={box} height={height} overflow="hidden">
      <Text>
        {Array.from(
          { length: Math.max(0, Math.min(height, rows.length - top)) },
          (_, index) => {
            const row = top + index;
            const text = rows.at(row)!;

            return selection.ends &&
              row >= selection.ends[0].row &&
              row <= selection.ends[1].row
              ? highlightRow(text, row, ...selection.ends, width)
              : text;
          },
        ).join('\n')}
      </Text>
    </Box>
  );
}
