import { EventEmitter } from 'node:events';
import { useEffect } from 'react';
import { useStdin } from 'ink';

/** button reports and all motion, with SGR coordinates. Shift+drag still selects text natively. */
export const captureMouse = '\u001b[?1003h\u001b[?1006h';
export const releaseMouse = '\u001b[?1006l\u001b[?1003l';
/** how long after a press another on its cell still counts with it, as a double or triple click. */
const repeatWithin = 500;
// eslint-disable-next-line no-control-regex
const report = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
// reject each Escape run once to keep non-mouse input linear
// eslint-disable-next-line no-control-regex
const partial = /(?<!\u001b)\u001b+\[?$|\u001b\[<[\d;]*$/;

export interface Cell {
  /** zero-based cell. */
  column: number;
  row: number;
}

/** what the left button did at a cell: went down, moved there held, or came up. */
export type Pointer = 'press' | 'drag' | 'release';

interface Source {
  setEncoding(encoding: 'utf8'): unknown;

  setRawMode(mode: boolean): unknown;

  on(event: 'data', listener: (chunk: string) => void): unknown;

  ref(): unknown;

  unref(): unknown;
}

/**
 * the stdin Ink reads, with mouse reports taken out: the left button emits `pointer` with what it did and the cell,
 * and for a press how many presses in a row its cell has now had, each within 500 ms of the last, which clicked,
 * with no drag or wheel step between. a release on its press's cell with no drag or wheel step between emits `click` with that
 * count, and a wheel step emits `wheel` with the rows to scroll, -1 up and 1 down. any other report, such as motion with no button or another button held,
 * emits `hover` with the cell. ambiguous escape prefixes wait 20 ms for mouse input before reaching Ink;
 * slower early fragments can reach Ink as keys.
 */
export class MouseInput extends EventEmitter {
  readonly isTTY = true;
  private text = '';
  private pending = '';
  private escapeTimer: ReturnType<typeof setTimeout> | undefined;
  /** the cell the left button went down on, until it moves or scrolls what is under it. */
  private pressed: Cell | undefined;
  private lastPress: { cell: Cell; at: number; count: number } | undefined;

  constructor(private readonly source: Source) {
    super();
    source.setEncoding('utf8');
    source.on('data', (chunk) => this.receive(chunk));
  }

  read(): string | null {
    const text = this.text;
    this.text = '';

    return text || null;
  }

  /** the source already decodes UTF-8. */
  setEncoding(): void {}

  setRawMode(mode: boolean): void {
    if (!mode) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = undefined;
      this.pending = '';
    }

    this.source.setRawMode(mode);
  }

  ref(): void {
    this.source.ref();
  }

  unref(): void {
    this.source.unref();
  }

  private receive(chunk: string): void {
    clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
    let data = this.pending + chunk;
    this.pending = partial.exec(data)?.[0] ?? '';

    if (this.pending && !this.pending.includes('<')) {
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = undefined;
        this.text += this.pending;
        this.pending = '';
        this.emit('readable');
      }, 20);

      this.escapeTimer.unref();
    }

    data = data.slice(0, data.length - this.pending.length);
    let end = 0;

    for (const match of data.matchAll(report)) {
      this.text += data.slice(end, match.index);
      end = match.index + match[0].length;

      // the keys before a report reach Ink first, so a Cmd+C after a drag in the same read copies what it selected
      if (this.text) this.emit('readable');

      const [, code, x, y, kind] = match;
      // without the Shift, Alt and Ctrl bits; Ghostty reports Cmd+click as a plain click
      const button = Number(code) & ~0b11100;
      const cell = { column: Number(x) - 1, row: Number(y) - 1 };

      if (button === 64 || button === 65) {
        this.pressed = undefined;
        this.lastPress = undefined;
        this.emit('wheel', button === 64 ? -1 : 1);
      } else if (button === 0 && kind === 'M') {
        const at = performance.now();
        const last = this.lastPress;

        // a press still down when the next arrives lost its release, and never clicked
        const count =
          last &&
          !this.pressed &&
          last.cell.column === cell.column &&
          last.cell.row === cell.row &&
          at - last.at <= repeatWithin
            ? last.count + 1
            : 1;

        this.lastPress = { cell, at, count };
        this.pressed = cell;
        this.emit('pointer', 'press', cell, count);
      } else if (button === 32) {
        // held motion is reported only on reaching a new cell, so a drag has left the press cell
        this.pressed = undefined;
        this.lastPress = undefined;
        this.emit('pointer', 'drag', cell);
      } else if (button === 0) {
        // held motion reports every cell it reaches, so a release elsewhere follows reports that went missing
        if (
          this.pressed?.column === cell.column &&
          this.pressed.row === cell.row
        )
          this.emit('click', this.lastPress?.count ?? 1);
        // a press that never clicked starts no double click
        else this.lastPress = undefined;

        this.pressed = undefined;
        this.emit('pointer', 'release', cell);
      } else this.emit('hover', cell);
    }

    this.text += data.slice(end);

    if (this.text) this.emit('readable');
  }
}

function useMouse<T extends unknown[]>(
  event: string,
  handler: (...values: T) => void,
) {
  const { stdin } = useStdin();

  useEffect(() => {
    stdin.on(event, handler);

    return () => {
      stdin.off(event, handler);
    };
  }, [stdin, event, handler]);
}

/** runs `handler` for each wheel step. outside a MouseInput the wheel never turns. */
export function useWheel(handler: (rows: number) => void): void {
  useMouse('wheel', handler);
}

export function useClick(handler: () => void): void {
  useMouse('click', handler);
}

/** runs `handler` for each report that is not the left button's or the wheel's, such as motion with no button held. */
export function useHover(handler: () => void): void {
  useMouse('hover', handler);
}

/** runs `handler` for each left press, drag and release, a press with its count. outside a MouseInput none arrive. */
export function usePointer(
  handler: (pointer: Pointer, cell: Cell, presses?: number) => void,
): void {
  useMouse('pointer', handler);
}
