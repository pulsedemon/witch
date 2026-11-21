import type { DisplayItem } from '../../core/state.js';
import type { ScrollAnchor, TranscriptLayout } from './transcript-layout.js';

interface ViewportOptions {
  anchor: ScrollAnchor | null;
  read: { conversation: string | undefined; items: readonly DisplayItem[] };
  conversation: string | undefined;
  items: readonly DisplayItem[];
  queue: number;
  freeRows: number;
  minimumRows: number;
  transcript: Pick<ReturnType<TranscriptLayout['render']>, 'lines' | 'rowOf'>;
  clearedAt: number | undefined;
}

export function transcriptViewport({
  anchor,
  read,
  conversation,
  items,
  queue,
  freeRows,
  minimumRows,
  transcript,
  clearedAt,
}: ViewportOptions) {
  const newMessages =
    anchor !== null &&
    read.conversation === conversation &&
    read.items !== items;

  const queueRows = Math.max(0, Math.min(queue, freeRows - minimumRows));
  const availableRows = Math.max(minimumRows, freeRows - queueRows);
  const row = anchor === null ? Infinity : transcript.rowOf(anchor);

  // decide before the notice takes a row, so hiding the last old row cannot turn it off
  const unpinnedTop = Math.min(
    row,
    Math.max(0, transcript.lines.length - availableRows),
  );

  const pinned =
    availableRows > 1 && clearedAt !== undefined && unpinnedTop < clearedAt;

  const height = availableRows - Number(pinned);
  const maxTop = Math.max(0, transcript.lines.length - height);

  return {
    pinned,
    newMessages,
    queueRows,
    height,
    maxTop,
    top: Math.min(row, maxTop),
  };
}
