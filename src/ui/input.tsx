import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Ref } from 'react';
import { Box, Text, measureElement, useCursor, useInput, usePaste } from 'ink';
import type { DOMElement } from 'ink';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { boundaries, editInput, initialInput, lineAt } from './input-buffer.js';
import type { Edit, InputBuffer, Step } from './input-buffer.js';
import { useLiveState } from './live-state.js';

// wrapping at Infinity still expands tabs and applies NFC, which the cursor column depends on
const visible = (value: string, secret = false) =>
  wrapAnsi(
    stripAnsi(secret ? value.replace(/[^\n]/gu, '•') : value),
    Infinity,
    { trim: false },
  );

/** `display` wrapped to `width`. text that ends the buffer gets a cell after its last character for the cursor. */
const wrap = (display: string, width: number, last = true) =>
  wrapAnsi(last ? `${display} ` : display, width, {
    hard: true,
    trim: false,
  }).split('\n');

const backward = new Set<Edit['type']>([
  'backspace',
  'backspaceWord',
  'backspaceRow',
]);

/** Ghostty sends Option+← and Option+→ as Esc B and Esc F. */
const optionSteps: Partial<Record<string, Step>> = {
  b: 'wordLeft',
  f: 'wordRight',
};

/**
 * where Cmd+← and Cmd+→ stop, the edges of the wrapped row the cursor is drawn on, and where Cmd+Delete
 * stops, the start of the row holding the character before it. Cmd+→ stops before a soft row's trailing
 * spaces, since a cursor after them is drawn on the next row.
 */
function rowStops(
  value: string,
  cursor: number,
  width: number,
  secret: boolean,
) {
  const [start, end] = lineAt(value, cursor);
  const line = visible(value.slice(start, end), secret);
  const at = visible(value.slice(start, cursor), secret).length;
  const rows: { from: number; to: number; text: string }[] = [];
  for (const row of wrap(line, width, end === value.length)) {
    const text = stripAnsi(row);
    const from = rows.at(-1)?.to ?? 0;
    rows.push({ from, to: from + text.length, text });
  }
  const stops = boundaries(value, start, end);
  // the last boundary drawn at or before `length`; a row that starts inside an expanded tab takes the whole tab
  const offset = (length: number) => {
    let low = 0;
    let high = stops.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (visible(value.slice(start, stops[middle]), secret).length <= length)
        low = middle;
      else high = middle - 1;
    }
    return stops[low]!;
  };
  const drawn = rows.find((row) => at < row.to) ?? rows.at(-1)!;
  return {
    // restored U+009B sequences can make visible prefixes shrink, so `offset` can pass the cursor
    home: Math.min(cursor, offset(drawn.from)),
    back: Math.min(
      cursor,
      offset((rows.find((row) => at <= row.to) ?? rows.at(-1)!).from),
    ),
    end:
      drawn === rows.at(-1)
        ? end
        : Math.max(cursor, offset(drawn.from + drawn.text.trimEnd().length)),
  };
}

/**
 * with `shell`, a leading `!` is drawn in a column of its own, as Claude Code and Codex draw shell mode, and kept out of
 * the text beside it, so no cursor or edit reaches it.
 */
function split({ value, cursor }: InputBuffer, width: number, shell: boolean) {
  return shell && value.startsWith('!')
    ? {
        mark: '!',
        width: width - 2,
        text: { value: value.slice(1), cursor: Math.max(0, cursor - 1) },
      }
    : { mark: '', width, text: { value, cursor } };
}

/** the rows an input holding `value` fills at `width`. */
export function inputRows(value: string, width: number, shell = false): number {
  const drawn = split({ value, cursor: 0 }, width, shell);
  return wrap(visible(drawn.text.value), drawn.width).length;
}

export interface InputHandle {
  /** replaces the buffer at once, so later keys of the same read edit the new text. */
  set(buffer: InputBuffer): void;
}

interface Props {
  ref?: Ref<InputHandle>;
  width: number;
  height: number;
  active: boolean;
  secret?: boolean;
  /** draws a leading `!` apart from the text, as shell mode's prompt. */
  shell?: boolean;
  multiline?: boolean;
  placeholder?: string;
  initialValue?: string;
  /** fires on every edit and once on mount. */
  onChange?(value: string, cursor: number): void;
  onSubmit(value: string): boolean;
  /** runs before ↑/↓ move the cursor; `true` keeps the cursor where it is. */
  onArrow?(direction: 'up' | 'down', buffer: InputBuffer): boolean;
}

export function Input({
  ref,
  width,
  height,
  active,
  secret = false,
  shell = false,
  multiline = true,
  placeholder = 'Ask the agent, or type /help',
  initialValue = '',
  onChange,
  onSubmit,
  onArrow,
}: Props) {
  const [state, current, setState] = useLiveState(() =>
    initialInput(initialValue),
  );
  const reference = useRef<DOMElement>(null);
  const [origin, setOrigin] = useState<{ x: number; y: number }>();
  const { setCursorPosition } = useCursor();
  const drawnAt = (buffer: InputBuffer) => split(buffer, width, shell);
  const drawn = drawnAt(state);
  const display = visible(drawn.text.value, secret);
  const cursor = visible(
    drawn.text.value.slice(0, drawn.text.cursor),
    secret,
  ).length;
  const wrapped = wrap(display, drawn.width);
  let consumed = 0;
  let row = 0;
  let column = 0;
  for (const [index, line] of wrapped.entries()) {
    const plain = stripAnsi(line);
    const end = consumed + plain.length;
    if (
      cursor < end ||
      (cursor === end && display[end] === '\n') ||
      index === wrapped.length - 1
    ) {
      row = index;
      column = stringWidth(plain.slice(0, cursor - consumed));
      break;
    }
    consumed = end + (display[end] === '\n' ? 1 : 0);
  }
  const offset = Math.max(0, row - height + 1);
  const lines = wrapped.slice(offset, offset + height);

  useEffect(() => {
    if (!reference.current) return;
    const { x, y } = measureElement(reference.current);
    setOrigin((previous) =>
      previous?.x === x && previous.y === y ? previous : { x, y },
    );
  });
  setCursorPosition(
    active && origin
      ? { x: origin.x + column, y: origin.y + row - offset }
      : undefined,
  );

  const replace = (next: InputBuffer) => {
    setState(next);
    onChange?.(next.value, next.cursor);
  };
  const edit = (action: Edit) => {
    const { mark, text } = drawnAt(current.current);
    // Backspace, Option+Delete or Cmd+Delete at the text's start takes the `!`, as Backspace leaves Claude Code's and Codex's shell mode
    if (mark && !text.cursor && backward.has(action.type)) return replace(text);
    const next = editInput(text, action);
    replace({ value: mark + next.value, cursor: mark.length + next.cursor });
  };
  /** stored terminal sequences can hide the printable text after them when rendered. */
  const insert = (text: string) => {
    const filtered = text.replace(/(?![\t\n\r])\p{Cc}/gu, '');
    if (filtered) edit({ type: 'insert', text: filtered });
  };
  useImperativeHandle(ref, () => ({ set: replace }));
  useEffect(() => {
    onChange?.(current.current.value, current.current.cursor);
  }, []);

  usePaste(insert, { isActive: active });
  useInput(
    (input, key) => {
      if (
        key.eventType === 'release' ||
        key.escape ||
        key.tab ||
        key.pageUp ||
        key.pageDown
      )
        return;
      // Ghostty sends Cmd+←, Cmd+→ and Cmd+Delete as Ctrl+A, Ctrl+E and Ctrl+U
      if (key.ctrl) {
        if (input === 'a' || input === 'e' || input === 'u') {
          const { mark, width: rowWidth, text } = drawnAt(current.current);
          const stops = rowStops(text.value, text.cursor, rowWidth, secret);
          if (input === 'u') edit({ type: 'backspaceRow', start: stops.back });
          else
            replace({
              value: current.current.value,
              cursor: mark.length + (input === 'a' ? stops.home : stops.end),
            });
        }
        return;
      }
      // a secret takes no Option keys: word stops in masked text would show where its words break
      if (key.meta && !secret) {
        const type = key.backspace
          ? 'backspaceWord'
          : key.delete
            ? 'deleteWord'
            : optionSteps[input];
        if (type) edit({ type });
      }
      if (key.meta || key.super) return;
      if (key.return) {
        if (key.shift && multiline) insert('\n');
        else if (onSubmit(current.current.value))
          replace({ value: '', cursor: 0 });
      } else if (key.leftArrow) edit({ type: 'left' });
      else if (key.rightArrow) edit({ type: 'right' });
      else if (key.upArrow || key.downArrow) {
        const direction = key.upArrow ? 'up' : 'down';
        if (!onArrow?.(direction, current.current) && multiline)
          edit({ type: direction });
      } else if (key.home) edit({ type: 'home' });
      else if (key.end) edit({ type: 'end' });
      else if (key.backspace) edit({ type: 'backspace' });
      else if (key.delete) edit({ type: 'delete' });
      else if (input) insert(input);
    },
    { isActive: active },
  );

  return (
    <Box width={width} height={height}>
      {drawn.mark && <Text>{`${drawn.mark} `}</Text>}
      <Box
        ref={reference}
        width={drawn.width}
        height={height}
        overflow="hidden"
      >
        <Text>
          {state.value ? lines.join('\n') : <Text dimColor>{placeholder}</Text>}
        </Text>
      </Box>
    </Box>
  );
}
