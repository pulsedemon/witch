import { Chalk } from 'chalk';

/** truecolor, since the accent is a hex violet. */
export const colors = new Chalk({ level: 3 });

/** witch violet, the accent. potion green marks shell mode, other color marks warnings and errors, and the status line keeps the colors of `~/.claude/statusline.sh`. */
export const accent = '#a855f7';
export const accentDim = '#5b21b6';
/** potion green, the composer's border while a `!` command is drafted. */
export const potion = '#a3e635';

/** caps labels joined by raw white pipes. */
export function piped(parts: readonly string[]): string {
  return parts.join(` ${colors.whiteBright('|')} `);
}
