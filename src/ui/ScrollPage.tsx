import { useEffect, useMemo, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Box, Text, useInput } from 'ink';
import stripAnsi from 'strip-ansi';
import { useWheel } from './terminal/mouse.js';

interface Props {
  /** each source line's wrapped rows, retained across widths. */
  lines: readonly (readonly string[])[];
  width: number;
  height: number;
  scroll: number;
  setScroll: Dispatch<SetStateAction<number>>;
  arrows?: boolean;
  active?: boolean;
}

function anchorAt(lines: Props['lines'], row: number) {
  let line = 0;

  while (line < lines.length - 1 && row >= lines[line]!.length) {
    row -= lines[line]!.length;

    line++;
  }

  const offset =
    lines[line]
      ?.slice(0, row)
      .reduce((sum, text) => sum + stripAnsi(text).length, 0) ?? 0;

  return { line, offset };
}

function rowAt(lines: Props['lines'], anchor: ReturnType<typeof anchorAt>) {
  const first = lines
    .slice(0, anchor.line)
    .reduce((sum, line) => sum + line.length, 0);

  const source = lines[anchor.line] ?? [];
  let offset = 0;

  for (const [row, text] of source.entries()) {
    offset += stripAnsi(text).length;

    if (anchor.offset < offset || row === source.length - 1) return first + row;
  }

  return first;
}

export function ScrollPage({
  lines,
  width,
  height,
  scroll,
  setScroll,
  arrows = false,
  active = true,
}: Props) {
  const rows = useMemo(() => lines.flat(), [lines]);
  const last = Math.max(0, rows.length - height);
  const top = Math.min(scroll, last);

  const previous = useRef<
    | (Pick<Props, 'width' | 'lines' | 'scroll'> & {
        last: number;
        anchor: ReturnType<typeof anchorAt>;
      })
    | undefined
  >(undefined);

  useEffect(() => {
    const before = previous.current;

    if (!before) {
      previous.current = {
        width,
        lines,
        scroll,
        last,
        anchor: anchorAt(lines, top),
      };

      return;
    }

    const resized = before.width !== width;

    const anchor = resized
      ? before.scroll === scroll
        ? before.anchor
        : anchorAt(before.lines, Math.min(scroll, before.last))
      : before.scroll !== scroll || before.lines !== lines
        ? anchorAt(lines, top)
        : before.anchor;

    const next = resized ? rowAt(lines, anchor) : scroll;

    previous.current = { width, lines, scroll: next, last, anchor };

    if (next !== scroll) setScroll(next);
  }, [width, lines, scroll, last, top, setScroll]);

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
      <Text>{rows.slice(top, top + height).join('\n')}</Text>
    </Box>
  );
}
