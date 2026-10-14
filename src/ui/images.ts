import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// the start of the Kitty protocol's row/column diacritics; a placeholder's diacritic gives its row in the image
const diacritics = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346,
  0x034a, 0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363,
  0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369,
].map((code) => String.fromCodePoint(code));
const placeholder = '\u{10EEEE}';
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const imageFile = /\.(?:png|jpe?g|gif|webp|heic|tiff?|bmp)$/i;
// a quoted path, or a run where a backslash escapes a space; macOS screenshot names hold an unescaped U+202F
const pathToken = /"([^"\n]+)"|'([^'\n]+)'|((?:\\.|[^ \t\r\n\\"'])+)/g;

/** image paths a message names, unescaped, as typed or dropped into the composer. */
export function imagePaths(text: string): string[] {
  return [...text.matchAll(pathToken)]
    .map(
      ([, double, single, bare]) =>
        double ?? single ?? bare!.replace(/\\(.)/g, '$1'),
    )
    .filter((path) => imageFile.test(path));
}

interface Image {
  id: number;
  width: number;
  height: number;
  /** the `c,r` its virtual placement has, once placed. */
  placed?: string;
}

/**
 * draws images inline with Kitty Unicode placeholders: each image is sent once, then shown by text rows that
 * scroll and clip with the transcript. the terminal fits the image into its rows, keeping its aspect ratio.
 */
export class Graphics {
  private images = new Map<string, Image | undefined>();
  private next = 1;

  constructor(private readonly write: (data: string) => void) {}

  /** the placeholder rows for `source`, a path or `data:` URL, at most `columns` wide; none when it can't load. */
  rows(source: string, cwd: string, columns: number): string[] {
    const key = source.startsWith('data:')
      ? source
      : resolve(cwd, source.replace(/^~(?=\/)/, homedir()));
    if (!this.images.has(key)) this.images.set(key, this.load(key));
    const image = this.images.get(key);
    if (!image || columns < 1) return [];
    // a cell is about twice as tall as wide, and a small image keeps about 8 pixels a column
    const aspect = image.height / image.width / 2;
    const widest = Math.min(columns, Math.ceil(image.width / 8));
    const rows = Math.max(
      1,
      Math.min(diacritics.length, Math.round(widest * aspect)),
    );
    const cells = Math.max(1, Math.min(widest, Math.round(rows / aspect)));
    const size = `${cells},${rows}`;
    if (image.placed !== size) {
      // one placement an image, which a new size replaces
      this.write(
        `\u001b_Ga=p,U=1,i=${image.id},p=1,c=${cells},r=${rows},q=2\u001b\\`,
      );
      image.placed = size;
    }
    const color = `\u001b[38;2;${(image.id >> 16) & 255};${(image.id >> 8) & 255};${image.id & 255}m`;
    return diacritics
      .slice(0, rows)
      .map(
        (row) =>
          `${color}${placeholder}${row}${diacritics[0]}${placeholder.repeat(cells - 1)}\u001b[39m`,
      );
  }

  /** frees the images this instance sent; the terminal keeps them until then, even after the alternate screen. */
  release(): void {
    for (const image of this.images.values())
      if (image) this.write(`\u001b_Ga=d,d=I,i=${image.id},q=2\u001b\\`);
    this.images.clear();
  }

  private load(key: string): Image | undefined {
    let data: Buffer;
    let width: number;
    let height: number;
    try {
      data = key.startsWith('data:')
        ? Buffer.from(key.slice(key.indexOf(',') + 1), 'base64')
        : readFileSync(key);
      // the terminal decodes only PNG
      if (!data.subarray(0, 4).equals(pngSignature)) data = toPng(data);
      // a truncated file throws here rather than in a render
      width = data.readUInt32BE(16);
      height = data.readUInt32BE(20);
    } catch {
      return undefined;
    }
    if (!width || !height) return undefined;
    const image = { id: this.next++, width, height };
    const encoded = data.toString('base64');
    for (let start = 0; start < encoded.length; start += 4096) {
      const more = start + 4096 < encoded.length ? 1 : 0;
      const keys = start ? '' : `a=t,f=100,t=d,i=${image.id},q=2,`;
      this.write(
        `\u001b_G${keys}m=${more};${encoded.slice(start, start + 4096)}\u001b\\`,
      );
    }
    return image;
  }
}

function toPng(data: Buffer): Buffer {
  const directory = mkdtempSync(join(tmpdir(), 'witch-image-'));
  try {
    const input = join(directory, 'input');
    const output = join(directory, 'output.png');
    writeFileSync(input, data);
    execFileSync(
      '/usr/bin/sips',
      ['-s', 'format', 'png', input, '--out', output],
      {
        stdio: 'ignore',
      },
    );
    return readFileSync(output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
