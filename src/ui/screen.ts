import stringWidth from 'string-width';
import { imageFile } from './images.js';

const escape =
  // eslint-disable-next-line no-control-regex
  /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\]([^\u0007\u001b]*)(?:\u0007|\u001b\\)|[^[\]])/y;
// eslint-disable-next-line no-control-regex
const unfinished = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*(?:\u001b)?)?$/;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// keycaps keep their ASCII base and marks together so they occupy two cells.
const keycap = /[0-9#*]\uFE0F?\u20E3/;
const textRuns = new RegExp(
  `${keycap.source}|(?:(?!${keycap.source})[ -~])+|[^ -~]+`,
  'g',
);
// Witch draws only these links. open would launch an app or script a file URL names, so a file must be an image,
// with no query or fragment to hide its real extension
const openable = (target: string) =>
  /^(?:https?|vscode):\/\//i.test(target) ||
  (/^file:\/\/\/[^?#]*$/i.test(target) && imageFile.test(target));

/** replays cursor movement and erasing so links track what the terminal actually shows. */
export class Screen {
  private cells: (string | undefined)[][] = [];
  private widths = new Map<string, number>();
  private columns = 0;
  private rows = 0;
  private x = 0;
  private y = 0;
  private link: string | undefined;
  private pending = '';
  /** the cell the pointer is over, from the last report that named one. */
  private pointer: { column: number; row: number } | undefined;
  /** mouse reporting starts the terminal on the arrow. */
  private shape: 'default' | 'pointer' = 'default';

  constructor(private readonly size: { columns: number; rows: number }) {}

  /** replays `data`, returning the pointer's shape change as `point` does. */
  write(data: string): string {
    // a tty that reports no size is drawn at 80x24, Ink's last fallback; Ink redraws the whole screen after a resize
    const columns = this.size.columns || 80;
    const rows = this.size.rows || 24;
    if (columns !== this.columns || rows !== this.rows) {
      this.columns = columns;
      this.rows = rows;
      this.cells = Array.from({ length: this.rows }, () => this.row());
      this.x = Math.min(this.x, this.columns - 1);
      this.y = Math.min(this.y, this.rows - 1);
    }
    data = this.pending + data;
    this.pending = unfinished.exec(data)?.[0] ?? '';
    data = data.slice(0, data.length - this.pending.length);
    let text = 0;
    for (let index = 0; index < data.length;) {
      if (data[index] !== '\u001b') {
        index++;
        continue;
      }
      this.print(data.slice(text, index));
      escape.lastIndex = index;
      const match = escape.exec(data);
      // a lone escape prints nothing
      index = match ? escape.lastIndex : index + 1;
      text = index;
      if (match?.[2] && match[2] !== 'm') this.control(match[1]!, match[2]);
      else if (match?.[3]?.startsWith('8;')) {
        const target = match[3].slice(match[3].indexOf(';', 2) + 1);
        this.link = openable(target) ? target : undefined;
      }
    }
    this.print(data.slice(text));
    return this.reshape();
  }

  /** the link at a zero-based cell. */
  linkAt(column: number, row: number): string | undefined {
    return this.cells[row]?.[column];
  }

  /** records the cell the pointer is over, returning OSC 22 when that turns the pointer into a hand or back, else ''. */
  point(column: number, row: number): string {
    this.pointer = { column, row };
    return this.reshape();
  }

  private reshape(): string {
    const shape =
      this.pointer && this.linkAt(this.pointer.column, this.pointer.row)
        ? 'pointer'
        : 'default';
    // OSC 22 inside an unfinished sequence would corrupt it, so the write that finishes it makes the change
    if (this.pending || shape === this.shape) return '';
    this.shape = shape;
    return `\u001b]22;${shape}\u0007`;
  }

  private row(): (string | undefined)[] {
    return new Array<string | undefined>(this.columns).fill(undefined);
  }

  /** batches printable ASCII to avoid grapheme iteration for ordinary text. */
  private print(text: string): void {
    for (const [run] of text.matchAll(textRuns)) {
      if (/^[ -~]+$/.test(run)) {
        for (let start = 0; start < run.length;) {
          if (this.x >= this.columns) this.wrap();
          const count = Math.min(run.length - start, this.columns - this.x);
          this.cells[this.y]!.fill(this.link, this.x, this.x + count);
          this.x += count;
          start += count;
        }
        continue;
      }
      for (const { segment } of graphemes.segment(run)) {
        if (segment === '\n' || segment === '\r\n') {
          // the terminal's output processing adds the carriage return
          this.x = 0;
          this.lineFeed();
        } else if (segment === '\r') this.x = 0;
        else if (segment === '\b') this.x = Math.max(0, this.x - 1);
        else {
          let width = this.widths.get(segment);
          if (width === undefined) {
            width = stringWidth(segment);
            this.widths.set(segment, width);
          }
          if (!width) continue;
          if (this.x + width > this.columns) this.wrap();
          this.cells[this.y]!.fill(this.link, this.x, this.x + width);
          this.x += width;
        }
      }
    }
  }

  private wrap(): void {
    this.x = 0;
    this.lineFeed();
  }

  private lineFeed(): void {
    if (this.y < this.rows - 1) this.y++;
    else {
      this.cells.shift();
      this.cells.push(this.row());
    }
  }

  private control(parameters: string, final: string): void {
    // private modes such as cursor visibility move nothing
    if (/^[<=>?]/.test(parameters)) return;
    const [first = 0, second = 0] = parameters.split(';').map(Number);
    const count = first || 1;
    const column = (value: number) =>
      Math.max(0, Math.min(this.columns - 1, value));
    const row = (value: number) => Math.max(0, Math.min(this.rows - 1, value));
    switch (final) {
      case 'A':
        this.y = row(this.y - count);
        break;
      case 'B':
        this.y = row(this.y + count);
        break;
      case 'C':
        this.x = column(this.x + count);
        break;
      case 'D':
        this.x = column(Math.min(this.x, this.columns - 1) - count);
        break;
      case 'E':
      case 'F':
        this.y = row(this.y + (final === 'E' ? count : -count));
        this.x = 0;
        break;
      case 'G':
        this.x = column(count - 1);
        break;
      case 'd':
        this.y = row(count - 1);
        break;
      case 'H':
      case 'f':
        this.y = row(count - 1);
        this.x = column((second || 1) - 1);
        break;
      case 'J':
        if (first === 0) {
          this.erase(this.y, this.x, this.columns);
          for (let line = this.y + 1; line < this.rows; line++)
            this.cells[line] = this.row();
        } else if (first === 1) {
          for (let line = 0; line < this.y; line++)
            this.cells[line] = this.row();
          this.erase(this.y, 0, this.x + 1);
        } else this.cells = Array.from({ length: this.rows }, () => this.row());
        break;
      case 'K':
        if (first === 0) this.erase(this.y, this.x, this.columns);
        else if (first === 1) this.erase(this.y, 0, this.x + 1);
        else this.erase(this.y, 0, this.columns);
        break;
    }
  }

  private erase(line: number, start: number, end: number): void {
    this.cells[line]!.fill(undefined, start, end);
  }
}

/** `stream`, with what Ink writes to it replayed into `screen` as well, each write followed by the pointer shape change it makes. */
export function recorded(
  stream: NodeJS.WriteStream,
  screen: Screen,
): NodeJS.WriteStream {
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  return new Proxy(stream, {
    get(target, key) {
      if (key === 'write')
        return (chunk: string, ...rest: unknown[]) =>
          write(chunk + screen.write(chunk), ...rest);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
