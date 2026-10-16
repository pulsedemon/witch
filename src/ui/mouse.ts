import { EventEmitter } from 'node:events';
import { useEffect } from 'react';
import { useStdin } from 'ink';

/** button reports, and motion while a button is held, with SGR coordinates. Shift+drag still selects text natively. */
export const captureMouse = '\u001b[?1002h\u001b[?1006h';
export const releaseMouse = '\u001b[?1006l\u001b[?1002l';

// eslint-disable-next-line no-control-regex
const report = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
// eslint-disable-next-line no-control-regex
const partial = /\u001b\[<[\d;]*$/;

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
 * a release with no drag or wheel step since its press emits `click`, and a wheel step emits `wheel` with the rows to
 * scroll, -1 up and 1 down. Ink drops any report that reaches it, so nothing leaks into the composer.
 */
export class MouseInput extends EventEmitter {
  readonly isTTY = true;
  private text = '';
  /** the start of a report the next read completes. */
  private pending = '';
  /** whether the left button is down and has neither moved nor scrolled what is under it. */
  private pressed = false;

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
    this.source.setRawMode(mode);
  }

  ref(): void {
    this.source.ref();
  }

  unref(): void {
    this.source.unref();
  }

  private receive(chunk: string): void {
    let data = this.pending + chunk;
    this.pending = partial.exec(data)?.[0] ?? '';
    data = data.slice(0, data.length - this.pending.length);
    const events: (
      ['wheel', number] | ['pointer', Pointer, Cell] | ['click']
    )[] = [];
    this.text += data.replace(
      report,
      (_, code: string, x: string, y: string, kind: string) => {
        // without the Shift, Alt and Ctrl bits; Ghostty reports Cmd+click as a plain click
        const button = Number(code) & ~0b11100;
        const cell = { column: Number(x) - 1, row: Number(y) - 1 };
        if (button === 64 || button === 65) {
          this.pressed = false;
          events.push(['wheel', button === 64 ? -1 : 1]);
        } else if (button === 0 && kind === 'M') {
          this.pressed = true;
          events.push(['pointer', 'press', cell]);
        } else if (button === 32) {
          // held motion is reported only on reaching a new cell, so a drag has left the press cell
          this.pressed = false;
          events.push(['pointer', 'drag', cell]);
        } else if (button === 0) {
          if (this.pressed) events.push(['click']);
          this.pressed = false;
          events.push(['pointer', 'release', cell]);
        }
        return '';
      },
    );
    if (this.text) this.emit('readable');
    for (const [name, ...values] of events) this.emit(name, ...values);
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

/** runs `handler` for each wheel step. Outside a MouseInput the wheel never turns. */
export function useWheel(handler: (rows: number) => void): void {
  useMouse('wheel', handler);
}

/** runs `handler` for each left press, drag and release. Outside a MouseInput none arrive. */
export function usePointer(
  handler: (pointer: Pointer, cell: Cell) => void,
): void {
  useMouse('pointer', handler);
}
