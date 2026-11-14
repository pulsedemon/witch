import stripAnsi from 'strip-ansi';
import type { InputBuffer } from './input-buffer.js';
import { normalizeText, wrapLines } from '../wrap.js';

export const visible = (value: string, secret = false) =>
  normalizeText(stripAnsi(secret ? value.replace(/[^\n]/gu, '•') : value));

/** text that ends the buffer needs a cell after its last character for the cursor. */
export const wrap = (display: string, width: number, last = true) =>
  wrapLines(last ? `${display} ` : display, width);

/**
 * with `shell`, a leading `!` is drawn in a column of its own, as Claude Code and Codex draw shell mode, and kept out of
 * the text beside it, so no cursor or edit reaches it.
 */
export function split(
  { value, cursor }: InputBuffer,
  width: number,
  shell: boolean,
) {
  return shell && value.startsWith('!')
    ? {
        mark: '!',
        width: width > 2 ? width - 2 : width,
        text: { value: value.slice(1), cursor: Math.max(0, cursor - 1) },
      }
    : { mark: '', width, text: { value, cursor } };
}

/** the rows an input holding `value` fills at `width`. */
export function inputRows(value: string, width: number, shell = false): number {
  const drawn = split({ value, cursor: 0 }, width, shell);

  return wrap(visible(drawn.text.value), drawn.width).length;
}
