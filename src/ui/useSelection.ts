import { useEffect, useLayoutEffect, useRef } from 'react';
import { measureElement } from 'ink';
import type { DOMElement, Key } from 'ink';
import type { RefObject } from 'react';
import { useLiveState } from './useLiveState.js';
import { useHover } from './terminal/mouse.js';
import type { Cell, Pointer } from './terminal/mouse.js';
import {
  drawsIn,
  selectedText,
  spanOf,
  stepEnd,
  textEnds,
} from './selection.js';
import type { Point, SelectionSource } from './selection.js';

interface SelectionEnd<Anchor> {
  identity: unknown;
  anchor: Anchor;
  column: number;
  width: number;
  text: string;
}

interface SelectionOptions<Anchor> {
  source: SelectionSource<Anchor>;
  identity: unknown;
  /** streamed transcript output can rewrite the far endpoint while the original press stays held. */
  continueDragOnChange?: boolean;
  /** recorded at each endpoint so a resize invalidates the range. */
  width: number;
  bodyWidth: number;
  /** the selectable content box; unset while another view covers it. */
  box: RefObject<DOMElement | null>;
  /** false when the source is no longer visible or current. */
  shown(): boolean;

  /** the viewport from the latest scroll position, not the rendered one. */
  viewport(): { top: number; height: number; originShift?: number };

  scrollBy(rows: number): boolean;

  /** reserves a press for controls outside the text. */
  covers(cell: Cell): boolean;

  markerAt?(anchor: Anchor, column: number): boolean;

  copy?(text: string): void;
}

/** anchored text selection with mouse gestures, edge scrolling and optional keyboard controls. */
export function useSelection<Anchor>({
  source,
  identity,
  continueDragOnChange = false,
  width,
  bodyWidth,
  box: contentBox,
  shown,
  viewport,
  scrollBy,
  covers,
  copy,
  markerAt,
}: SelectionOptions<Anchor>) {
  // a drag's ends are anchored to their text, so they follow it when output above grows
  const [range, rangeRef, setRange] = useLiveState<
    { from: SelectionEnd<Anchor>; to: SelectionEnd<Anchor> } | undefined
  >(undefined);

  const pressedAt = useRef<SelectionEnd<Anchor>>(undefined);
  /** what the held press selects by: a double click's words, a triple click's lines. */
  const pressedUnit = useRef<'cell' | 'word' | 'line'>('cell');

  /** the last press's text and how many presses its cell had seen before that text came under it. */
  const pressStreak = useRef<{ end: SelectionEnd<Anchor>; before: number }>(
    undefined,
  );

  /** the scrolling of a drag held past the content's top or bottom, and the cell it is held on. */
  const edgeScroll = useRef<{ timer: NodeJS.Timeout; cell: Cell }>(undefined);

  const pointOf = (end: SelectionEnd<Anchor>): Point | undefined => {
    if (end.identity !== identity) return undefined;

    const row = source.rowOf(end.anchor);

    return row !== undefined &&
      end.width === width &&
      source.lines.at(row) === end.text
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

  /** the current visible source is the only one whose selection can copy or move. */
  const selection = () =>
    shown() && contentBox.current ? endsOf(rangeRef.current) : undefined;

  const stopEdgeScroll = () => {
    clearInterval(edgeScroll.current?.timer);
    edgeScroll.current = undefined;
  };

  const endPress = () => {
    pressedAt.current = undefined;
    stopEdgeScroll();
  };

  useEffect(() => {
    if (range && !ends) {
      setRange(undefined);

      if (!continueDragOnChange) endPress();
    }

    if (pressedAt.current && !pointOf(pressedAt.current)) endPress();
  });

  const visible = shown();

  useEffect(() => {
    if (!visible) endPress();
  }, [visible]);

  useLayoutEffect(() => {
    setRange(undefined);
    endPress();
    pressStreak.current = undefined;
    pressedUnit.current = 'cell';
  }, [identity]);

  useEffect(() => stopEdgeScroll, []);
  // any report but the left button's or a vertical wheel step ends the press: motion with no button held means its release went missing
  useHover(endPress);

  const rangeEnd = ({
    row,
    column,
  }: Point): SelectionEnd<Anchor> | undefined => {
    const anchor = source.anchorAt(row);

    return anchor === undefined
      ? undefined
      : { identity, anchor, column, width, text: source.lines.at(row)! };
  };

  const select = (from: SelectionEnd<Anchor>, to: SelectionEnd<Anchor>) => {
    const same = (a: SelectionEnd<Anchor>, b: SelectionEnd<Anchor>) =>
      a.identity === b.identity &&
      source.sameAnchor(a.anchor, b.anchor) &&
      a.column === b.column &&
      a.width === b.width &&
      a.text === b.text;

    const previous = rangeRef.current;

    if (previous && same(previous.from, from) && same(previous.to, to)) return;

    setRange({ from, to });
  };

  const spanAt = (at: Point, unit: 'word' | 'line') => spanOf(source, at, unit);

  /** updates the selection and reports whether the held press is past the content's top or bottom. */
  const point = (
    pointer: Pointer | 'wheel',
    { column, row }: Cell,
    presses = 1,
  ) => {
    if (!continueDragOnChange && rangeRef.current && !endsOf(rangeRef.current))
      endPress();

    // a press or release ends the drag even while another view covers the content
    if (pointer === 'press' || pointer === 'release')
      pressedAt.current = undefined;

    // a press anywhere but on the same source text, another view included, ends the run of presses on it
    const streak = pressStreak.current;

    if (pointer === 'press') {
      pressStreak.current = undefined;
      setRange(undefined);

      if (covers({ column, row })) return false;
    }

    if (!shown() || !contentBox.current || !source.lines.length) return false;

    const box = measureElement(contentBox.current);
    // reports in one read arrive before a render, so each starts where the last one scrolled
    const { top: first, height, originShift = 0 } = viewport();

    if (height <= 0 || bodyWidth <= 0) return false;

    const shownRows = Math.min(height, source.lines.length - first);
    // a queued scroll can move the notice before Ink moves the content box
    const origin = box.y + originShift;
    const offset = Math.max(-1, Math.min(shownRows, row - origin));

    // a wheel already scrolled; a drag reaches the adjacent row its scroll will reveal
    const selectedOffset =
      pointer === 'wheel'
        ? Math.max(0, Math.min(shownRows - 1, offset))
        : offset;

    const at = {
      row: Math.max(
        0,
        Math.min(source.lines.length - 1, first + selectedOffset),
      ),
      column: Math.max(0, Math.min(bodyWidth - 1, column - box.x)),
    };

    const end = rangeEnd(at);

    if (pointer === 'press') {
      if (offset < 0 || offset >= shownRows || column >= box.x + bodyWidth)
        return false;

      pressedAt.current = end;

      // presses count by screen cell, and other text can come under it between them: an opened link's notice
      // moves the rows, and streamed output rewrites one
      const before =
        end &&
        streak &&
        presses > 1 &&
        streak.end.identity === identity &&
        source.sameAnchor(streak.end.anchor, end.anchor) &&
        streak.end.column === end.column &&
        streak.end.text === end.text
          ? streak.before
          : presses - 1;

      pressStreak.current = end && { end, before };
      const repeats = presses - before;

      // two clicks on a marker in one read toggle it back to the text it had, so the count alone would select it
      pressedUnit.current =
        repeats < 2 || (end && markerAt?.(end.anchor, end.column))
          ? 'cell'
          : repeats === 2
            ? 'word'
            : 'line';

      const span =
        pressedUnit.current !== 'cell' && spanAt(at, pressedUnit.current);

      const [from, to] = span ? span.map(rangeEnd) : [];

      if (from && to) select(from, to);

      return false;
    }

    if (!pressedAt.current || !pointOf(pressedAt.current) || !end) return false;

    // rows of the box under short content are not past its bottom
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
          // a resize can bring the held cell back inside the content
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
      // nothing copies while another view covers the content, and blank rows or images hold no text to replace the clipboard with
      const selected = selection();

      const text =
        selected && selectedText(source.lines, ...selected, source.joinBefore);

      if (text?.trim()) copy?.(text);

      return true;
    }

    // Ghostty keeps Cmd+A for its own selection
    if (key.ctrl && key.shift && input === 'a') {
      const [from, to] = (
        (shown() && contentBox.current && textEnds(source.lines)) ||
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
      const next = stepEnd(source.lines, pointOf(moved.to)!, direction);
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

    if (key.escape && shown() && contentBox.current) {
      const selected = endsOf(rangeRef.current);
      const { top, height } = viewport();

      if (
        selected &&
        drawsIn(source.lines, ...selected, top, top + height - 1, bodyWidth)
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
    /** whether the current source has a visible selection. */
    active: () => !!selection(),
    point: onPointer,
    pressed: () =>
      shown() && pressedAt.current && pointOf(pressedAt.current)
        ? pressedAt.current
        : undefined,
    key: onKey,
  };
}
