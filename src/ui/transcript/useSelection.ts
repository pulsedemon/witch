import { useEffect, useLayoutEffect, useRef } from 'react';
import { measureElement } from 'ink';
import type { DOMElement, Key } from 'ink';
import type { RefObject } from 'react';
import { useLiveState } from '../useLiveState.js';
import { useHover } from '../terminal/mouse.js';
import type { Cell, Pointer } from '../terminal/mouse.js';
import {
  drawsIn,
  selectedText,
  spanOf,
  stepEnd,
  textEnds,
} from './selection.js';
import type { Point, RangeEnd } from './selection.js';
import type { TranscriptLayout } from './transcript-layout.js';

interface SelectionOptions {
  transcript: ReturnType<TranscriptLayout['render']>;
  /** the main column's width, which a range end records so a resize drops it. */
  width: number;
  bodyWidth: number;
  /** the transcript's box; unset while another view covers it. */
  box: RefObject<DOMElement | null>;
  /** false while another view covers the transcript, which ends a held press. */
  shown: boolean;
  /** whether the drawn frame pins the clear reminder above the transcript. */
  pinned: boolean;
  /** the viewport from the latest scroll position, not the rendered one. */
  viewport(): { top: number; height: number; pinned: boolean };

  scrollBy(rows: number): boolean;

  /** called once for every press, before the transcript is measured, so the caller can record the press; true when something outside the transcript takes it, such as the new-messages notice. */
  covers(cell: Cell): boolean;

  /** puts text on the clipboard and calls `copied` once the clipboard holds it. */
  copy?(text: string, copied: () => void): void;

  copied(): void;
}

/** the transcript's selection: its range, the press, click run and edge scroll that drag it, and the keys that copy it, select the whole transcript, and extend and clear it. */
export function useSelection({
  transcript,
  width,
  bodyWidth,
  box: transcriptBox,
  shown: transcriptShown,
  pinned,
  viewport,
  scrollBy,
  covers,
  copy,
  copied,
}: SelectionOptions) {
  // a drag's ends are anchored to their text, so they follow it when output above grows
  const [range, rangeRef, setRange] = useLiveState<
    { from: RangeEnd; to: RangeEnd } | undefined
  >(undefined);

  const pressedAt = useRef<RangeEnd>(undefined);
  /** what the held press selects by: a double click's words, a triple click's lines. */
  const pressedUnit = useRef<'cell' | 'word' | 'line'>('cell');
  /** the last press's text and how many presses its cell had seen before that text came under it. */
  const pressStreak = useRef<{ end: RangeEnd; before: number }>(undefined);
  /** the scrolling of a drag held past the transcript's top or bottom, and the cell it is held on. */
  const edgeScroll = useRef<{ timer: NodeJS.Timeout; cell: Cell }>(undefined);

  const pointOf = (end: RangeEnd): Point | undefined => {
    const row = transcript.rowOf(end.anchor);

    return end.width === width &&
      transcript.starts.has(end.anchor.item) &&
      transcript.lines.at(row) === end.text
      ? { row, column: end.column }
      : undefined;
  };

  const endsOf = (dragged: typeof range) => {
    const from = dragged && pointOf(dragged.from);
    const to = dragged && pointOf(dragged.to);

    return from && to
      ? ([from, to].sort((a, b) => a.row - b.row || a.column - b.column) as [
          Point,
          Point,
        ])
      : undefined;
  };

  const ends = endsOf(range);

  /** the selection's ends while the transcript shows; another view covering it leaves nothing to copy or move. */
  const selection = () =>
    transcriptBox.current ? endsOf(rangeRef.current) : undefined;

  // a range or a held press off its text drops, so it can't come back with the width or the tool
  useEffect(() => {
    if (range && !ends) setRange(undefined);

    if (pressedAt.current && !pointOf(pressedAt.current))
      pressedAt.current = undefined;
  });

  const stopEdgeScroll = () => {
    clearInterval(edgeScroll.current?.timer);
    edgeScroll.current = undefined;
  };

  const endPress = () => {
    pressedAt.current = undefined;
    stopEdgeScroll();
  };

  // a press still held when another view covers the transcript ends there, so no drag resumes once it closes
  useEffect(() => {
    if (!transcriptShown) endPress();
  }, [transcriptShown]);

  useEffect(() => stopEdgeScroll, []);
  // any report but the left button's or a vertical wheel step ends the press: motion with no button held means its release went missing
  useHover(endPress);

  const rangeEnd = ({ row, column }: Point): RangeEnd | undefined => {
    const anchor = transcript.anchorAt(row);

    return anchor && { anchor, column, width, text: transcript.lines.at(row)! };
  };

  const select = (from: RangeEnd, to: RangeEnd) => {
    const same = (a: RangeEnd, b: RangeEnd) =>
      a.anchor.item === b.anchor.item &&
      a.anchor.line === b.anchor.line &&
      a.anchor.offset === b.anchor.offset &&
      a.column === b.column &&
      a.width === b.width &&
      a.text === b.text;

    const previous = rangeRef.current;

    if (previous && same(previous.from, from) && same(previous.to, to)) return;

    setRange({ from, to });
  };

  const spanAt = (at: Point, unit: 'word' | 'line') =>
    spanOf(transcript, at, unit);

  /** the tool whose `+ ✓` cells a press is on; they hold no link, so a click on them toggles it. */
  const markerOf = (pressed: RangeEnd | undefined) => {
    const item = transcript.items.find(({ id }) => id === pressed?.anchor.item);

    return pressed &&
      item?.kind === 'tool' &&
      pressed.column < 3 &&
      transcript.rowOf(pressed.anchor) === transcript.starts.get(item.id)
      ? item
      : undefined;
  };

  /** updates the selection and reports whether the held press is past the transcript's top or bottom. */
  const point = (
    pointer: Pointer | 'wheel',
    { column, row }: Cell,
    presses = 1,
  ) => {
    // a press or release ends the drag even while another view covers the transcript
    if (pointer === 'press' || pointer === 'release')
      pressedAt.current = undefined;

    // a press anywhere but on the same transcript text, another view included, ends the run of presses on it
    const streak = pressStreak.current;

    if (pointer === 'press') {
      pressStreak.current = undefined;
      setRange(undefined);

      if (covers({ column, row })) return false;
    }

    if (!transcriptBox.current) return false;

    const box = measureElement(transcriptBox.current);
    // reports in one read arrive before a render, so each starts where the last one scrolled
    const { top: first, height, pinned: currentPinned } = viewport();
    const shown = Math.min(height, transcript.lines.length - first);
    // a queued scroll can move the notice before Ink moves the content box
    const origin = box.y + Number(currentPinned) - Number(pinned);
    const offset = Math.max(-1, Math.min(shown, row - origin));

    // a wheel already scrolled; a drag reaches the adjacent row its scroll will reveal
    const selectedOffset =
      pointer === 'wheel' ? Math.max(0, Math.min(shown - 1, offset)) : offset;

    const at = {
      row: Math.max(
        0,
        Math.min(transcript.lines.length - 1, first + selectedOffset),
      ),
      column: Math.max(0, Math.min(bodyWidth - 1, column - box.x)),
    };

    const end = rangeEnd(at);

    if (pointer === 'press') {
      if (offset < 0 || offset >= shown || column >= box.x + bodyWidth)
        return false;

      pressedAt.current = end;

      // presses count by screen cell, and other text can come under it between them: an opened link's notice
      // moves the rows, and streamed output rewrites one
      const before =
        end &&
        streak &&
        presses > 1 &&
        streak.end.anchor.item === end.anchor.item &&
        streak.end.anchor.line === end.anchor.line &&
        streak.end.anchor.offset === end.anchor.offset &&
        streak.end.column === end.column &&
        streak.end.text === end.text
          ? streak.before
          : presses - 1;

      pressStreak.current = end && { end, before };
      const repeats = presses - before;

      // two clicks on a marker in one read toggle it back to the text it had, so the count alone would select it
      pressedUnit.current =
        repeats < 2 || markerOf(end) ? 'cell' : repeats === 2 ? 'word' : 'line';

      const span =
        pressedUnit.current !== 'cell' && spanAt(at, pressedUnit.current);

      const [from, to] = span ? span.map(rangeEnd) : [];

      if (from && to) select(from, to);

      return false;
    }

    if (!pressedAt.current || !end) return false;

    // rows of the box under a short transcript are not past its bottom
    const pastEdge = offset < 0 || row - origin >= height;

    if (pastEdge && pointer !== 'wheel') scrollBy(offset < 0 ? -1 : 1);

    const unit = pressedUnit.current;
    const pressed = unit !== 'cell' && pointOf(pressedAt.current);

    if (!pressed) {
      select(pressedAt.current, end);

      return pastEdge;
    }

    // a drag after a double or triple click selects whole words or lines; a cell stands in where there is none
    const ends = [
      ...(spanAt(pressed, unit) ?? [pressed]),
      ...(spanAt(at, unit) ?? [at]),
    ].sort((a, b) => a.row - b.row || a.column - b.column);

    const start = rangeEnd(ends[0]!);
    const stop = rangeEnd(ends.at(-1)!);

    // `to` is the end the drag is on, as in a cell drag, so Shift+arrows move that one
    const back =
      at.row < pressed.row ||
      (at.row === pressed.row && at.column < pressed.column);

    if (start && stop) select(back ? stop : start, back ? start : stop);

    return pastEdge;
  };

  // a tick of the edge scroll runs the handler of the render then current, not the one that started it
  const latestPoint = useRef(point);

  useLayoutEffect(() => {
    latestPoint.current = point;
  });

  const onPointer = (
    pointer: Pointer | 'wheel',
    cell: Cell,
    presses?: number,
  ) => {
    if (!point(pointer, cell, presses)) {
      stopEdgeScroll();

      return;
    }

    // held motion is reported only on reaching a new cell, so a pointer resting past the edge sends nothing more
    edgeScroll.current = {
      cell,
      timer:
        edgeScroll.current?.timer ??
        setInterval(() => {
          // a resize can bring the held cell back inside the transcript
          if (
            !edgeScroll.current ||
            !latestPoint.current('drag', edgeScroll.current.cell)
          )
            stopEdgeScroll();
        }, 50),
    };
  };

  /** true when the key was a selection key and is consumed. */
  const onKey = (input: string, key: Key) => {
    if (key.super && input === 'c') {
      // nothing copies while another view covers the transcript, and blank rows or images hold no text to replace the clipboard with
      const selected = selection();

      const text =
        selected &&
        selectedText(transcript.lines, ...selected, transcript.joinBefore);

      if (text?.trim()) copy?.(text, copied);

      return true;
    }

    // Ghostty keeps Cmd+A for its own selection
    if (key.ctrl && key.shift && input === 'a') {
      const [from, to] = (
        (transcriptBox.current && textEnds(transcript.lines)) ||
        []
      ).map(rangeEnd);

      if (from && to) {
        endPress();
        select(from, to);
      }

      return true;
    }

    const direction = (['left', 'right', 'up', 'down'] as const).find(
      (arrow) => key[`${arrow}Arrow`],
    );

    const moved = rangeRef.current;

    if (
      direction &&
      moved &&
      key.shift &&
      !key.ctrl &&
      !key.meta &&
      !key.super &&
      selection()
    ) {
      const next = stepEnd(transcript.lines, pointOf(moved.to)!, direction);
      const end = rangeEnd(next);

      if (end) {
        endPress();
        select(moved.from, end);
        const { top, height } = viewport();

        if (next.row < top) scrollBy(next.row - top);
        else if (next.row > top + height - 1)
          scrollBy(next.row - (top + height - 1));
      }

      return true;
    }

    if (key.escape && transcriptBox.current) {
      const selected = endsOf(rangeRef.current);
      const { top, height } = viewport();

      if (
        selected &&
        drawsIn(transcript.lines, ...selected, top, top + height - 1, bodyWidth)
      ) {
        endPress();
        setRange(undefined);

        return true;
      }
    }

    return false;
  };

  return {
    /** the drawn range's ends in row order. */
    ends,
    /** whether a selection exists while the transcript shows. */
    active: () => !!selection(),
    point: onPointer,
    /** the tool whose marker the held press is on. */
    pressedTool: () => markerOf(pressedAt.current),
    key: onKey,
  };
}
