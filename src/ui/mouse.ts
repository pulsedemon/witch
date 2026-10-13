import { EventEmitter } from 'node:events';
import { useEffect } from 'react';
import { useStdin } from 'ink';

/** button reports with SGR coordinates. Without motion tracking, Shift+drag still selects text natively. */
export const captureMouse = '\u001b[?1000h\u001b[?1006h';
export const releaseMouse = '\u001b[?1006l\u001b[?1000l';

// eslint-disable-next-line no-control-regex
const report = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
// eslint-disable-next-line no-control-regex
const partial = /\u001b\[<[\d;]*$/;

export interface Click {
  /** zero-based cell. */
  column: number;
  row: number;
}

interface Source {
  setEncoding(encoding: 'utf8'): unknown;
  setRawMode(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  ref(): unknown;
  unref(): unknown;
}

/**
 * the stdin Ink reads, with mouse reports taken out: a left press emits `click` and a wheel step emits `wheel` with
 * the rows to scroll, -1 up and 1 down. Ink drops any report that reaches it, so nothing leaks into the composer.
 */
export class MouseInput extends EventEmitter {
  readonly isTTY = true;
  private text = '';
  /** the start of a report the next read completes. */
  private pending = '';

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
    const events: [string, unknown][] = [];
    this.text += data.replace(
      report,
      (_, code: string, x: string, y: string, kind: string) => {
        // without the Shift, Alt and Ctrl bits; Ghostty reports Cmd+click as a plain click
        const button = Number(code) & ~0b11100;
        if (button === 64 || button === 65)
          events.push(['wheel', button === 64 ? -1 : 1]);
        else if (button === 0 && kind === 'M')
          events.push(['click', { column: Number(x) - 1, row: Number(y) - 1 }]);
        return '';
      },
    );
    if (this.text) this.emit('readable');
    for (const [name, value] of events) this.emit(name, value);
  }
}

/** runs `handler` for each wheel step. Outside a MouseInput the wheel never turns. */
export function useWheel(handler: (rows: number) => void): void {
  const { stdin } = useStdin();
  useEffect(() => {
    stdin.on('wheel', handler);
    return () => {
      stdin.off('wheel', handler);
    };
  }, [stdin, handler]);
}
