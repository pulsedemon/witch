import { useEffect, useRef, useState } from 'react';
import { Box, Text, measureElement, useCursor, useInput, usePaste } from 'ink';
import type { DOMElement } from 'ink';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { editInput } from './input-buffer.js';
import type { Edit, InputBuffer } from './input-buffer.js';
import { linkify } from './links.js';

interface Props {
  width: number;
  height: number;
  cwd: string;
  active: boolean;
  secret?: boolean;
  multiline?: boolean;
  placeholder?: string;
  initialValue?: string;
  onChange?(value: string): void;
  onSubmit(value: string): boolean;
}

export function Input({
  width,
  height,
  cwd,
  active,
  secret = false,
  multiline = true,
  placeholder = 'Ask the agent, or type /help',
  initialValue = '',
  onChange,
  onSubmit,
}: Props) {
  const [state, setState] = useState<InputBuffer>({
    value: initialValue,
    cursor: initialValue.length,
  });
  const reference = useRef<DOMElement>(null);
  const [origin, setOrigin] = useState<{ x: number; y: number }>();
  const { setCursorPosition } = useCursor();
  const visible = (value: string) =>
    wrapAnsi(
      linkify(secret ? value.replace(/[^\n]/gu, '•') : value, cwd),
      Infinity,
      { trim: false },
    );
  const display = visible(state.value);
  const value = stripAnsi(display);
  const cursor = stripAnsi(visible(state.value.slice(0, state.cursor))).length;
  const wrapped = wrapAnsi(`${display} `, width, {
    hard: true,
    trim: false,
  }).split('\n');
  let consumed = 0;
  let row = 0;
  let column = 0;
  for (const [index, line] of wrapped.entries()) {
    const plain = stripAnsi(line);
    const end = consumed + plain.length;
    if (
      cursor < end ||
      (cursor === end && value[end] === '\n') ||
      index === wrapped.length - 1
    ) {
      row = index;
      column = stringWidth(plain.slice(0, cursor - consumed));
      break;
    }
    consumed = end + (value[end] === '\n' ? 1 : 0);
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

  const edit = (action: Edit) => {
    const next = editInput(state, action);
    setState(next);
    onChange?.(next.value);
  };

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
        else if (onSubmit(state.value)) {
          setState({ value: '', cursor: 0 });
          onChange?.('');
        }
      } else if (key.leftArrow) edit({ type: 'left' });
      else if (key.rightArrow) edit({ type: 'right' });
      else if (key.upArrow && multiline) edit({ type: 'up' });
      else if (key.downArrow && multiline) edit({ type: 'down' });
      else if (key.home) edit({ type: 'home' });
      else if (key.end) edit({ type: 'end' });
      else if (key.backspace) edit({ type: 'backspace' });
      else if (key.delete) edit({ type: 'delete' });
      else if (input && !key.upArrow && !key.downArrow)
        edit({ type: 'insert', text: input });
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
