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

export function editInput(state: InputBuffer, action: Edit): InputBuffer {
  const { value, cursor } = state;
  const boundaries = [...segmenter.segment(value)].map(
    (segment) => segment.index,
  );
  boundaries.push(value.length);
  const left = boundaries.findLast((index) => index < cursor) ?? 0;
  const right = boundaries.find((index) => index > cursor) ?? value.length;
  const start = value.slice(0, cursor).lastIndexOf('\n') + 1;
  const newline = value.indexOf('\n', cursor);
  const end = newline < 0 ? value.length : newline;
  switch (action.type) {
    case 'insert': {
      const text = action.text.replace(/\r\n?/g, '\n');
      return {
        value: value.slice(0, cursor) + text + value.slice(cursor),
        cursor: cursor + text.length,
      };
    }
    case 'left':
      return { value, cursor: left };
    case 'right':
      return { value, cursor: right };
    case 'home':
      return { value, cursor: start };
    case 'end':
      return { value, cursor: end };
    case 'backspace':
      return {
        value: value.slice(0, left) + value.slice(cursor),
        cursor: left,
      };
    case 'delete':
      return { value: value.slice(0, cursor) + value.slice(right), cursor };
    case 'up': {
      if (start === 0) return state;
      const previous = value.lastIndexOf('\n', start - 2) + 1;
      const destination = Math.min(start - 1, previous + cursor - start);
      return {
        value,
        cursor: boundaries.findLast((position) => position <= destination) ?? 0,
      };
    }
    case 'down': {
      if (end === value.length) return state;
      const nextEnd = value.indexOf('\n', end + 1);
      const destination = Math.min(
        nextEnd < 0 ? value.length : nextEnd,
        end + 1 + cursor - start,
      );
      return {
        value,
        cursor: boundaries.findLast((position) => position <= destination) ?? 0,
      };
    }
  }
}
