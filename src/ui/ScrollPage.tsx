import { useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Box, Text, useInput } from 'ink';
import { useWheel } from './terminal/mouse.js';
import type { WrappedLines } from './wrap.js';
import { pageAnchorAt, pageRowOf } from './scroll-page-layout.js';
import type { PagePosition } from './scroll-page-layout.js';

interface Props {
  lines: WrappedLines;
  height: number;
  scroll: PagePosition;
  setScroll: Dispatch<SetStateAction<PagePosition>>;
  arrows?: boolean;
  active?: boolean;
}

export function ScrollPage({
  lines,
  height,
  scroll,
  setScroll,
  arrows = false,
  active = true,
}: Props) {
  const rows = useMemo(() => lines.flat(), [lines]);
  const position = useMemo(() => pageRowOf(lines, scroll), [lines, scroll]);
  const last = Math.max(0, rows.length - height);
  const top = Math.min(position, last);

  /** steps from the shown top, so movement still works after the page shrinks. */
  const scrollBy = (amount: number) =>
    setScroll((current) => {
      const shown = Math.min(pageRowOf(lines, current), last);
      const next = Math.max(0, Math.min(last, shown + amount));

      return next === shown ? current : pageAnchorAt(lines, next);
    });

  // request input guards do not block scrolling.
  useWheel((rows) => {
    if (active) scrollBy(rows);
  });

  useInput((_, key) => {
    if (!active || key.eventType === 'release') return;

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
    <Box height={height} overflow="hidden">
      <Text>
        {rows
          .slice(top, top + height)
          .map(({ text }) => text)
          .join('\n')}
      </Text>
    </Box>
  );
}
