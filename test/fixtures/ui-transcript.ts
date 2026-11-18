import { createElement } from 'react';
import type { Coordinator } from '../../src/core/coordinator.js';
import { App } from '../../src/ui/App.js';
import { show } from './ui.js';

/** the transcript must overflow for scroll tests. */
export const long = {
  id: 'long',
  kind: 'assistant' as const,
  text: Array.from({ length: 300 }, (_, n) => `row ${n + 1}`).join('\n'),
  cwd: '/work',
};

export const first = (ui: { text(): string }) =>
  Number(/row (\d+)/.exec(ui.text())?.[1]);

export const wheelUp = '\u001b[<64;10;10M';
export const CMD_C = '\u001b[99;9u';
export const CTRL_SHIFT_A = '\u001b[97;6u';
export const SHIFT_LEFT = '\u001b[1;2D';
export const SHIFT_RIGHT = '\u001b[1;2C';
export const SHIFT_UP = '\u001b[1;2A';
export const SHIFT_DOWN = '\u001b[1;2B';

/** App at 60 by 24 unless sized, with each text it copies. */
export function mounted(app: Coordinator, columns = 60, rows = 24) {
  const copied: string[] = [];

  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      copy: (text: string) => copied.push(text),
    }),
    columns,
    rows,
  );

  return { ui, copied };
}
