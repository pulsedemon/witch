import stringWidth from 'string-width';

const escape =
  // eslint-disable-next-line no-control-regex
  /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\]([^\u0007\u001b]*)(?:\u0007|\u001b\\)|[^[\]])/y;
// eslint-disable-next-line no-control-regex
const unfinished = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*(?:\u001b)?)?$/;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Witch draws only these links; open would launch a file for a bare path
const openable = /^(?:https?|vscode):\/\//i;

/**
 * the link each cell of the terminal shows, kept by replaying what is written to it, so a click opens the link
 * under it. It follows the cursor movement and erasing Ink's frames use, and ignores styles.
 */
export class Screen {
  private cells: (string | undefined)[][] = [];
  private columns = 0;
  private rows = 0;
  private x = 0;
  private y = 0;
  private link: string | undefined;
  private pending = '';

  constructor(private readonly size: { columns: number; rows: number }) {}

  write(data: string): void {
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
      if (match?.[2]) this.control(match[1]!, match[2]);
      else if (match?.[3]?.startsWith('8;')) {
        const target = match[3].slice(match[3].indexOf(';', 2) + 1);
        this.link = openable.test(target) ? target : undefined;
      }
    }
    this.print(data.slice(text));
  }

  /** the link at a zero-based cell. */
  linkAt(column: number, row: number): string | undefined {
    return this.cells[row]?.[column];
  }

  private row(): (string | undefined)[] {
    return new Array<string | undefined>(this.columns).fill(undefined);
  }

  /** printable ASCII takes one cell a character, which spares most of a frame the grapheme and width lookups. */
  private print(text: string): void {
    for (const [run] of text.matchAll(/[ -~]+|[^ -~]+/g)) {
      if (/^[ -~]/.test(run)) {
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
          const width = stringWidth(segment);
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

/** `stream`, with what Ink writes to it replayed into `screen` as well. */
export function recorded(
  stream: NodeJS.WriteStream,
  screen: Screen,
): NodeJS.WriteStream {
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  return new Proxy(stream, {
    get(target, key) {
      if (key === 'write')
        return (chunk: string, ...rest: unknown[]) => {
          screen.write(chunk);
          return write(chunk, ...rest);
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
