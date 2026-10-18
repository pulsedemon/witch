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

/** `display` wrapped to `width`, with a cell after the last character for the cursor. */
const wrap = (display: string, width: number) =>
  wrapAnsi(`${display} `, width, { hard: true, trim: false }).split('\n');

/** Ghostty sends Cmd+← and Cmd+→ as Ctrl+A and Ctrl+E, and Cmd+Delete as Ctrl+U. */
const ctrlSteps: Partial<Record<string, Step>> = {
  a: 'home',
  e: 'end',
};

/** Ghostty sends Option+← and Option+→ as Esc B and Esc F. */
const optionSteps: Partial<Record<string, Step>> = {
  b: 'wordLeft',
  f: 'wordRight',
};

/** where the wrapped row holding the character before `cursor` starts, so Cmd+Delete clears one row a press. */
function rowStart(
  value: string,
  cursor: number,
  width: number,
  secret: boolean,
): number {
  const [start, end] = lineAt(value, cursor);
  const before = visible(value.slice(start, cursor), secret).length;
  let row = 0;
  for (const line of wrap(visible(value.slice(start, end), secret), width)) {
    const next = row + stripAnsi(line).length;
    if (before <= next) break;
    row = next;
  }
  // a row that starts inside an expanded tab takes the whole tab
  return boundaries(value, start, cursor).findLast(
    (stop) => visible(value.slice(start, stop), secret).length <= row,
  )!;
}

/** the rows an input holding `value` fills at `width`. */
export function inputRows(value: string, width: number): number {
  return wrap(visible(value), width).length;
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
  const display = visible(state.value, secret);
  const cursor = visible(state.value.slice(0, state.cursor), secret).length;
  const wrapped = wrap(display, width);
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
  const edit = (action: Edit) => replace(editInput(current.current, action));
  useImperativeHandle(ref, () => ({ set: replace }));
  useEffect(() => {
    onChange?.(current.current.value, current.current.cursor);
  }, []);

  usePaste((text) => edit({ type: 'insert', text }), { isActive: active });
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
      if (key.ctrl) {
        const type = ctrlSteps[input];
        if (type) edit({ type });
        else if (input === 'u') {
          const { value, cursor } = current.current;
          edit({
            type: 'backspaceRow',
            start: rowStart(value, cursor, width, secret),
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
        if (key.shift && multiline) edit({ type: 'insert', text: '\n' });
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
      else if (input) {
        // control bytes sharing a read, as a held Cmd+Delete's can, arrive as text: Ink splits out only 0x7f, 0x08 and 0x03
        const text = input.replace(/(?![\t\n\r])\p{Cc}/gu, '');
        if (text) edit({ type: 'insert', text });
      }
    },
    { isActive: active },
  );

  return (
    <Box ref={reference} width={width} height={height} overflow="hidden">
      <Text>
        {state.value ? lines.join('\n') : <Text dimColor>{placeholder}</Text>}
      </Text>
    </Box>
  );
}
