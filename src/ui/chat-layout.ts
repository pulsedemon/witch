import { piped } from './theme.js';

import { wrapLines } from './wrap.js';

export const minimumColumns = 30;

export const minimumRows = 24;

export const commandWindowRows = 4;

export function toolHintLines(width: number, hint?: string): string[] {
  return [
    piped([
      '↑/↓ TOOLS',
      'ENTER TOGGLE',
      'TAB COMPOSE',
      'END LIVE OUTPUT',
      'ESC LEAVE TOOLS',
    ]),
    ...(hint ? [hint] : []),
  ].flatMap((line) => wrapLines(line, width));
}
