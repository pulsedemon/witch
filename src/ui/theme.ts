import { Chalk } from 'chalk';

/** truecolor, since the accent is a hex violet. */
export const colors = new Chalk({ level: 3 });
/** witch violet, the accent. potion green marks shell mode, green and red mark diffs and Monokai colors their code, other color marks warnings and errors, and the status line keeps the colors of `~/.claude/statusline.sh`. */
export const accent = '#a855f7';
export const accentDim = '#5b21b6';
/** potion green, the composer's border while a `!` command is drafted. */
export const potion = '#a3e635';
/** Claude Code's dark diff backgrounds, behind added and removed rows. */
export const diffAdded = '#225c2b';
export const diffRemoved = '#7a2936';
/** Claude Code's dark backgrounds behind the words a changed row changed. */
export const diffAddedWord = '#38a660';
export const diffRemovedWord = '#b3596b';
/** Claude Code's dark colors for a changed row's number and marker. */
export const diffAddedMarker = '#50c850';
export const diffRemovedMarker = '#dc5a5a';

/** Claude Code's dark syntax colors, Monokai's, by highlight.js scope. */
export const syntax: ReadonlyMap<string, string> = new Map([
  ['keyword', '#f92672'],
  ['operator', '#f92672'],
  ['built_in', '#a6e22e'],
  ['type', '#a6e22e'],
  ['title', '#a6e22e'],
  ['attr', '#a6e22e'],
  ['attribute', '#a6e22e'],
  ['literal', '#be84ff'],
  ['number', '#be84ff'],
  ['symbol', '#be84ff'],
  ['string', '#e6db74'],
  ['regexp', '#e6db74'],
  ['params', '#fd971f'],
  ['comment', '#75715e'],
  ['meta', '#75715e'],
  ['variable', '#ffffff'],
  ['property', '#ffffff'],
  ['punctuation', '#f8f8f2'],
  ['subst', '#f8f8f2'],
]);

/** Monokai's storage cyan, which Claude Code gives keywords that declare, such as `const`. */
export const storage = '#66d9ef';

/** caps labels joined by raw white pipes. */
export function piped(parts: readonly string[]): string {
  return parts.join(` ${colors.whiteBright('|')} `);
}
