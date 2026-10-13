import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Ref } from 'react';
import { Box, Text, measureElement, useCursor, useInput, usePaste } from 'ink';
import type { DOMElement } from 'ink';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { editInput, initialInput } from './input-buffer.js';
import type { Edit, InputBuffer } from './input-buffer.js';
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
        key.ctrl ||
        key.meta ||
        key.super ||
        key.escape ||
        key.tab ||
        key.pageUp ||
        key.pageDown
      )
        return;
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
      else if (input) edit({ type: 'insert', text: input });
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
