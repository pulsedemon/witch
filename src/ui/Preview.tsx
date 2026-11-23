import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Ref } from 'react';
import { Box, Text, measureElement } from 'ink';
import type { DOMElement } from 'ink';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import type { Preview as PreviewOwner } from '../core/preview.js';
import type { Cell } from './terminal/mouse.js';
import { usePreview } from './usePreview.js';
import { tickMs, useTick } from './useTick.js';

export interface PreviewHandle {
  /** scrolls a cropped preview by `rows` and returns true when `cell` is on its frame, even at an edge. */
  wheel(rows: number, cell: Cell): boolean;
}

export function Preview({
  owner,
  width,
  height,
  request,
  ref,
}: {
  owner?: PreviewOwner;
  width: number;
  height: number;
  request?: string;
  ref?: Ref<PreviewHandle>;
}) {
  const snapshot = usePreview(owner);
  const id = snapshot?.status.id;
  const document = snapshot?.document;
  const rows = width > 0 ? Math.max(0, height - 1) : 0;
  const total = snapshot?.status.rows ?? 0;
  const tick = useTick(1, rows > 0 && (snapshot?.status.frames ?? 0) > 1);
  const box = useRef<DOMElement>(null);
  // an offset kept for another preview id reads as zero, so a replacement starts at its top
  const [scroll, setScroll] = useState({ id, offset: 0 });

  // clamped at render, so a resize or shorter replacement can't leave the offset past the end
  const clamp = (offset: number) =>
    Math.min(Math.max(0, total - rows), Math.max(0, offset));

  const offset = clamp(scroll.id === id ? scroll.offset : 0);

  const [cache, setCache] = useState(() => ({
    document,
    width,
    rows,
    offset,
    frames: new Map<number, string>(),
  }));

  useEffect(() => {
    if (!id) return;

    owner?.placed(id, { columns: width, rows, request });

    return () => owner?.placed(id);
  }, [owner, id, width, rows, request]);

  useImperativeHandle(ref, () => ({
    wheel: (step, { column, row }) => {
      if (!box.current || rows <= 0 || rows >= total) return false;

      const { x, y, width, height } = measureElement(box.current);

      if (column < x || column >= x + width || row <= y || row >= y + height)
        return false;

      // several reports in one read arrive before a render, so each starts where the last one left
      setScroll((current) => ({
        id,
        offset: clamp(clamp(current.id === id ? current.offset : 0) + step),
      }));

      return true;
    },
  }));

  const frame = snapshot
    ? Math.max(0, Math.floor((tick * tickMs - snapshot.startedAt) / tickMs)) %
      snapshot.status.frames
    : 0;

  let frames =
    cache.document === document &&
    cache.width === width &&
    cache.rows === rows &&
    cache.offset === offset
      ? cache.frames
      : new Map<number, string>();

  let text = frames.get(frame);

  if (document && rows > 0 && text === undefined) {
    text = document.frames[frame]!.slice(offset, offset + rows)
      .map((line) => {
        const first =
          wrapAnsi(line, width, {
            hard: true,
            trim: false,
            wordWrap: false,
          }).split('\n')[0] ?? '';

        return `${stringWidth(first) <= width ? first : ''}\u001b[0m`;
      })
      .join('\n');

    frames = new Map(frames).set(frame, text);
  }

  if (frames !== cache.frames)
    setCache({ document, width, rows, offset, frames });

  if (!snapshot || !rows) return null;

  return (
    <Box
      ref={box}
      height={height}
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
    >
      {/* the range leads so truncation cuts the title, not the range */}
      <Text dimColor wrap="truncate-end">
        {rows < total
          ? `rows ${offset + 1}–${offset + rows} of ${total} · ${snapshot.status.title}`
          : snapshot.status.title}
      </Text>
      <Text>{text}</Text>
    </Box>
  );
}
