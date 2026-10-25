import wrapAnsi from 'wrap-ansi';

export function wrapLines(text: string, width: number, trim = false): string[] {
  return wrapAnsi(text, width, { hard: true, trim }).split('\n');
}

/** cursor columns and transcript anchors depend on tab expansion and NFC normalization. */
export function normalizeText(text: string): string {
  return wrapAnsi(text, Infinity, { trim: false });
}
