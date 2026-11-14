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

      return wrapLines(line, width, trim).map((text) => {
        const plain = stripAnsi(text);
        const start = trim ? source.indexOf(plain, offset) : offset;

        offset = start + plain.length;

        return { text, offset: start };
      });
    });
}

/** cursor columns and transcript anchors depend on tab expansion and NFC normalization. */
export function normalizeText(text: string): string {
  return wrapAnsi(text, Infinity, { trim: false });
}
