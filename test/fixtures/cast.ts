import { tokenize } from '@alcalzone/ansi-tokenize';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { castTitle } from '../../src/ui/status/cast.js';

const channels = (code: string, prefix: string) =>
  code.startsWith(prefix) && code.endsWith('m')
    ? code.slice(prefix.length, -1).split(';').map(Number)
    : undefined;

export const foreground = (code: string): number[] | undefined =>
  channels(code, '\u001b[38;2;');

/** a settled heading: the bare title, carrying its canonical styling. */
export const isFinal = (line: string) =>
  stripAnsi(line).trim() === '✦ Spell' && line.includes(castTitle());

/** the highest channel sum of a truecolor foreground or background in effect over any cell from `from` on. */
export function brightest(row: string, from: number): number {
  const sum = (color: number[]) =>
    color.reduce((total, value) => total + value, 0);

  let [column, fg, bg, most] = [0, 0, 0, 0];

  for (const token of tokenize(row)) {
    if (token.type === 'ansi') {
      const front = foreground(token.code);
      const back = channels(token.code, '\u001b[48;2;');

      if (front) fg = sum(front);
      else if (back) bg = sum(back);
      else if (token.code === '\u001b[39m') fg = 0;
      else if (token.code === '\u001b[49m') bg = 0;

      continue;
    }

    if (token.type !== 'char') continue;

    // a space shows only its background
    if (column >= from) most = Math.max(most, bg, token.value === ' ' ? 0 : fg);

    column += stringWidth(token.value);
  }

  return most;
}
