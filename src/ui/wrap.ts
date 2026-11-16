import { tokenize } from '@alcalzone/ansi-tokenize';
import wrapAnsi from 'wrap-ansi';
import stripAnsi from 'strip-ansi';

export interface WrappedRow {
  text: string;
  /** negative offsets locate a diff prefix before its source text. */
  offset: number;
}

export type WrappedLines = readonly (readonly WrappedRow[])[];

export function wrapLines(text: string, width: number, trim = false): string[] {
  return wrapAnsi(text, width, { hard: true, trim }).split('\n');
}

export function wrapSourceLines(
  text: string,
  width: number,
  trim = false,
): WrappedRow[][] {
  return normalizeText(text)
    .split('\n')
    .map((line) => {
      const source = stripAnsi(line);
      let offset = 0;
      const rows = trim ? wrapLines(line, width, true) : wrapBody(line, width);

      return rows.map((text) => {
        const plain = stripAnsi(text);
        const start = source.indexOf(plain, offset);
        offset = start + plain.length;

        return { text, offset: start };
      });
    });
}

/** rows after a line's first text drop the spaces they broke at; indentation before that text stays. */
export function wrapBody(line: string, width: number): string[] {
  let started = false;

  return wrapLines(line, width).flatMap((row) => {
    if (!started) {
      started = /\S/u.test(stripAnsi(row));

      return [row];
    }

    let leading = true;

    const text = tokenize(row)
      .map((token) => {
        if (token.type !== 'char') return token.code;

        if (leading && token.value === ' ') return '';

        leading = false;

        return token.value;
      })
      .join('');

    return stripAnsi(text) ? [text] : [];
  });
}

/** cursor columns and transcript anchors depend on tab expansion and NFC normalization. */
export function normalizeText(text: string): string {
  return wrapAnsi(text, Infinity, { trim: false });
}
