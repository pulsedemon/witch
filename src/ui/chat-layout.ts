import { piped } from './theme.js';
import { wrapLines } from './wrap.js';

export const commandWindowRows = 4;

export function chatLayout(
  height: number,
  width: number,
  controls: { working: boolean; pending: boolean; list: number; hints: number },
) {
  const transcript = Math.min(2, Math.max(0, height - 1));
  let remaining = Math.max(0, height - transcript - 1);
  const take = (wanted: number) => {
    const rows = Math.min(wanted, remaining);
    remaining -= rows;
    return rows;
  };
  const activity = take(Number(controls.working));
  const pending = take(Number(controls.pending));
  const border = width >= 5 && remaining >= 2;
  const borderRows = take(border ? 2 : 0);
  const minimumList = controls.list ? 1 : controls.hints;
  const hints = take(minimumList);
  const commands = take(commandWindowRows);
  const gap = take(1);
  const list =
    hints + (controls.list ? take(Math.min(8, controls.list) - hints) : 0);
  const composer = Math.max(1, Math.min(Math.floor(height / 2), remaining + 1));
  return {
    minimumRows:
      2 +
      1 +
      2 +
      commandWindowRows +
      1 +
      Number(controls.working) +
      Number(controls.pending) +
      minimumList,
    transcript,
    activity,
    pending,
    border,
    commands,
    gap,
    list,
    composer,
    content: height - borderRows - activity - pending - commands - gap - list,
  };
}

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
