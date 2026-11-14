import type { Dispatch, SetStateAction } from 'react';
import { Box, Text, useInput } from 'ink';
import { useWheel } from './mouse.js';

interface Props {
  lines: readonly string[];
  height: number;
  scroll: number;
  setScroll: Dispatch<SetStateAction<number>>;
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
  const last = Math.max(0, lines.length - height);
  const top = Math.min(scroll, last);

  /** steps from the shown top, so movement still works after the page shrinks. */
  const scrollBy = (rows: number) =>
    setScroll((value) =>
      Math.max(0, Math.min(last, Math.min(value, last) + rows)),
    );

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
      <Text>{lines.slice(top, top + height).join('\n')}</Text>
    </Box>
  );
}
