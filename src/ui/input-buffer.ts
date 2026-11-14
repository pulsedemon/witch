export interface InputBuffer {
  value: string;
  cursor: number;
}

/** edits that need nothing but the buffer. */
export type Step =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'home'
  | 'end'
  | 'backspace'
  | 'delete'
  | 'wordLeft'
  | 'wordRight'
  | 'backspaceWord'
  | 'deleteWord';

export type Edit =
  | { type: 'insert'; text: string }
  /** deletes back to `start`; at a line's start, what backspace would. */
  | { type: 'backspaceRow'; start: number }
  | { type: Step };

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const words = new Intl.Segmenter(undefined, { granularity: 'word' });

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function initialInput(value: string): InputBuffer {
  const normalized = normalize(value);

  return { value: normalized, cursor: normalized.length };
}

/** grapheme boundaries of one line; a cluster never spans a normalized newline. */
export function boundaries(
  value: string,
  start: number,
  end: number,
): number[] {
  const result = [...segmenter.segment(value.slice(start, end))].map(
    (segment) => start + segment.index,
  );

  result.push(end);

  return result;
}

export function lineAt(value: string, position: number): [number, number] {
  const newline = value.indexOf('\n', position);

  return [
    // lastIndexOf treats a negative start as 0 and would find a leading newline
    position && value.lastIndexOf('\n', position - 1) + 1,
    newline < 0 ? value.length : newline,
  ];
}

/** the words of a whole line as `[start, end]` pairs; segmenting only up to the cursor moves stops in Thai, Japanese and around `_`. */
function lineWords(
  value: string,
  start: number,
  end: number,
): [number, number][] {
  return [...words.segment(value.slice(start, end))]
    .filter((segment) => segment.isWordLike)
    .map(({ index, segment }) => [
      start + index,
      start + index + segment.length,
    ]);
}

/** the start of the nearest word that starts before `position`, else 0. */
function wordStart(value: string, position: number): number {
  for (let at = position; ;) {
    const [start, end] = lineAt(value, at);

    const word = lineWords(value, start, end).findLast(
      ([from]) => from < position,
    );

    if (word) return word[0];

    if (start === 0) return 0;

    at = start - 1;
  }
}

/** the end of the nearest word that ends after `position`, else the value's end. */
function wordEnd(value: string, position: number): number {
  for (let at = position; ;) {
    const [start, end] = lineAt(value, at);

    const word = lineWords(value, start, end).find(([, to]) => to > position);

    if (word) return word[1];

    if (end === value.length) return end;

    at = end + 1;
  }
}

export function editInput(state: InputBuffer, action: Edit): InputBuffer {
  const { value, cursor } = state;

  const [start, end] = lineAt(value, cursor);

  const left = () =>
    cursor === start
      ? Math.max(0, cursor - 1)
      : boundaries(value, start, end).findLast((index) => index < cursor)!;

  const right = () =>
    cursor === end
      ? Math.min(value.length, cursor + 1)
      : boundaries(value, start, end).find((index) => index > cursor)!;

  const back = (target: number) => ({
    value: value.slice(0, target) + value.slice(cursor),
    cursor: target,
  });

  const forward = (target: number) => ({
    value: value.slice(0, cursor) + value.slice(target),
    cursor,
  });

  switch (action.type) {
    case 'insert': {
      const text = normalize(action.text);

      return {
        value: value.slice(0, cursor) + text + value.slice(cursor),
        cursor: cursor + text.length,
      };
    }

    case 'left':
      return { value, cursor: left() };

    case 'right':
      return { value, cursor: right() };

    case 'home':
      return { value, cursor: start };

    case 'end':
      return { value, cursor: end };

    case 'wordLeft':
      return { value, cursor: wordStart(value, cursor) };

    case 'wordRight':
      return { value, cursor: wordEnd(value, cursor) };

    case 'backspace':
      return back(left());

    case 'backspaceWord':
      return back(wordStart(value, cursor));

    case 'backspaceRow':
      return back(cursor === start ? left() : action.start);

    case 'delete':
      return forward(right());

    case 'deleteWord':
      return forward(wordEnd(value, cursor));

    case 'up': {
      if (start === 0) return state;

      const [previous] = lineAt(value, start - 1);

      const destination = Math.min(start - 1, previous + cursor - start);

      return {
        value,
        cursor: boundaries(value, previous, start - 1).findLast(
          (position) => position <= destination,
        )!,
      };
    }

    case 'down': {
      if (end === value.length) return state;

      const nextEnd = lineAt(value, end + 1)[1];

      const destination = Math.min(nextEnd, end + 1 + cursor - start);

      return {
        value,
        cursor: boundaries(value, end + 1, nextEnd).findLast(
          (position) => position <= destination,
        )!,
      };
    }
  }
}
