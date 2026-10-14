import { Chalk } from 'chalk';

/** truecolor, since the accent is a hex violet. */
export const colors = new Chalk({ level: 3 });

/** witch violet, the one accent. Other color marks warnings and errors, and the status line keeps the colors of `~/.claude/statusline.sh`. */
export const accent = '#a855f7';
export const accentDim = '#5b21b6';

/** caps labels joined by raw white pipes. */
export function piped(parts: readonly string[]): string {
  return parts.join(` ${colors.whiteBright('|')} `);
}
