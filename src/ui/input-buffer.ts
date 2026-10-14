export interface InputBuffer {
  value: string;
  cursor: number;
}
export type Edit =
  | { type: 'insert'; text: string }
  | {
      type:
        | 'left'
        | 'right'
        | 'up'
        | 'down'
        | 'home'
        | 'end'
        | 'backspace'
        | 'delete';
    };

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function initialInput(value: string): InputBuffer {
  const normalized = normalize(value);
  return { value: normalized, cursor: normalized.length };
}

/** grapheme boundaries of one line; a cluster never spans a normalized newline. */
function boundaries(value: string, start: number, end: number): number[] {
  const result = [...segmenter.segment(value.slice(start, end))].map(
    (segment) => start + segment.index,
  );
  result.push(end);
  return result;
}

function lineAt(value: string, position: number): [number, number] {
  const newline = value.indexOf('\n', position);
  return [
    // lastIndexOf treats a negative start as 0 and would find a leading newline
    position && value.lastIndexOf('\n', position - 1) + 1,
    newline < 0 ? value.length : newline,
  ];
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
    case 'backspace': {
      const target = left();
      return {
        value: value.slice(0, target) + value.slice(cursor),
        cursor: target,
      };
    }
    case 'delete':
      return { value: value.slice(0, cursor) + value.slice(right()), cursor };
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
