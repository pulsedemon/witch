import { piped } from './theme.js';
import { wrapLines } from './wrap.js';

export const commandWindowRows = 4;
const transcriptReserve = 2;
const composerReserve = 1;
const borderReserve = 2;
const gapReserve = 1;

export function chatLayout(
  height: number,
  width: number,
  controls: {
    working: boolean;
    pending: boolean;
    message: boolean;
    list: number;
    hints: number;
  },
) {
  const transcript = Math.min(
    transcriptReserve,
    Math.max(0, height - composerReserve),
  );

  let remaining = Math.max(0, height - transcript - composerReserve);

  const take = (wanted: number) => {
    const rows = Math.min(wanted, remaining);
    remaining -= rows;

    return rows;
  };

  const activity = take(Number(controls.working));
  const pending = take(Number(controls.pending));
  const border = width >= 6 && remaining >= borderReserve;
  const borderRows = take(border ? borderReserve : 0);
  const minimumList = controls.list ? 1 : controls.hints;
  const hints = take(minimumList);
  const commands = take(commandWindowRows);
  const gap = take(gapReserve);

  const list =
    hints + (controls.list ? take(Math.min(8, controls.list) - hints) : 0);

  const composer = Math.max(
    composerReserve,
    Math.min(Math.floor(height / 2), remaining + composerReserve),
  );

  // the agent's latest message takes a row only when the composer's limit leaves one
  const message = remaining >= composer ? take(Number(controls.message)) : 0;

  return {
    minimumRows:
      transcriptReserve +
      composerReserve +
      borderReserve +
      commandWindowRows +
      gapReserve +
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
    message,
    composer,
    content:
      height -
      borderRows -
      activity -
      pending -
      commands -
      gap -
      list -
      message,
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
