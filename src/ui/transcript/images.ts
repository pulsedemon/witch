import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { convertImage, startsLikePng } from '../../core/attachments.js';
import { resolveFile } from '../../paths.js';

// the start of the Kitty protocol's row/column diacritics; a placeholder's diacritic gives its row in the image
const diacritics = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346,
  0x034a, 0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363,
  0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369,
].map((code) => String.fromCodePoint(code));

export const placeholder = '\u{10EEEE}';
// read whole into memory and sent to the terminal in one transmission
const largestFile = 64 * 1024 * 1024;
const retryDelay = 2_000;
// a PNG's closing IEND chunk, which a file cut short lacks
const pngEnd = Buffer.from('0000000049454e44ae426082', 'hex');
export const imageFile = /\.(?:png|jpe?g|gif|webp|heic|tiff?|bmp)$/i;

interface Image {
  id: number;
  width: number;
  height: number;
  /** the file URL a click on its rows opens. */
  link: string;
  /** the `c,r` its virtual placement has, once placed. */
  placed?: string;
  /** what its file's stat read when it loaded; a `data:` image has none. */
  stamp?: string;
  /** a check of its file against `stamp` is queued and hasn't started. */
  checkQueued?: boolean;
}

/** a key's image, its load waiting or running, or its failure, which may be retried from `retry`. */
type Entry = Image | 'queued' | { retry: number };

/**
 * draws images inline with Kitty Unicode placeholders: each image is sent once, and again when its file changes,
 * then shown by text rows that scroll and clip with the transcript. the terminal fits the image into its rows,
 * keeping its aspect ratio.
 */
export class Graphics {
  private entries = new Map<string, Entry>();
  private next = 1;
  private loads = 0;
  private readonly listeners = new Set<() => void>();
  // one load at a time holds one image's memory and one sips process, and none finishes inside the render that asked for it
  private queue = Promise.resolve();
  private controller = new AbortController();
  /** holds the files a click opens for `data:` images, which have none of their own. */
  private readonly directory = join(tmpdir(), `witch-images-${randomUUID()}`);

  constructor(private readonly write: (data: string) => void) {}

  /** counts the images loaded, so it changes whenever more rows can be drawn or a path's rows change. */
  get version(): number {
    return this.loads;
  }

  /** hears each load that finishes, whether it loaded, failed, found its file unchanged or was dropped by `release`. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  };

  /**
   * the placeholder rows for `source`, a path or `data:` URL, at most `columns` wide; none until it first loads, or
   * when that load fails. a loaded path's file is checked again in the background: a changed file loads again, and
   * one that can't load keeps the rows it had.
   */
  rows(source: string, cwd: string, columns: number): string[] {
    const key = entryKey(source, cwd);
    const image = this.entries.get(key);

    if (
      image === undefined ||
      (image !== 'queued' && 'retry' in image && Date.now() >= image.retry)
    ) {
      this.entries.set(key, 'queued');
      const { signal } = this.controller;
      this.queue = this.queue.then(() => this.load(key, signal));

      return [];
    }

    if (image === 'queued' || 'retry' in image) return [];

    if (image.stamp !== undefined && !image.checkQueued) {
      image.checkQueued = true;
      const { signal } = this.controller;
      this.queue = this.queue.then(() => this.load(key, signal));
    }

    if (columns < 1) return [];

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

    // not underlined like a text link, since the terminal would draw the underline across the image
    return diacritics
      .slice(0, rows)
      .map(
        (row) =>
          `\u001b]8;;${image.link}\u0007${color}${placeholder}${row}${diacritics[0]}${placeholder.repeat(cells - 1)}\u001b[39m\u001b]8;;\u0007`,
      );
  }

  /** names the image loaded for `source`, so it changes when a changed file's image replaces it; none until one loads. */
  id(source: string, cwd: string): number | undefined {
    const image = this.entries.get(entryKey(source, cwd));

    return typeof image === 'object' && 'id' in image ? image.id : undefined;
  }

  /**
   * frees the images this instance sent; the terminal keeps them until then, even after the alternate screen.
   * it also stops the running conversion and drops queued loads, so none writes to the restored terminal.
   */
  release(): void {
    this.controller.abort();
    this.controller = new AbortController();

    for (const image of this.entries.values())
      if (image !== 'queued' && 'id' in image)
        this.write(`\u001b_Ga=d,d=I,i=${image.id},q=2\u001b\\`);

    this.entries.clear();
    // synchronous, since a forced quit exits right after
    rmSync(this.directory, { recursive: true, force: true });
  }

  /** writes the file a `data:` image's rows link to, which exists only once a click needs it. */
  async save(link: string): Promise<void> {
    const { signal } = this.controller;

    for (const [key, image] of this.entries)
      if (
        key.startsWith('data:') &&
        image !== 'queued' &&
        'id' in image &&
        image.link === link
      ) {
        const loaded = await decode(key, signal);

        if (!loaded || loaded === 'unchanged') return;

        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeFile(fileURLToPath(link), loaded.data, { signal });
      }
  }

  /** loads `key`, or when it has an image, loads it again only if its file changed since. */
  private async load(key: string, signal: AbortSignal): Promise<void> {
    if (!signal.aborted) {
      // read here, since a check queued before this one may have replaced the image
      const entry = this.entries.get(key);

      const shown =
        typeof entry === 'object' && 'id' in entry ? entry : undefined;

      // cleared before the file is read, so a view during the read queues a check of what the file holds after it
      if (shown) shown.checkQueued = false;

      const loaded = await decode(key, signal, shown?.stamp).catch(
        () => undefined,
      );

      // a release since it began has restored the terminal, so the load writes and records nothing
      if (!signal.aborted) {
        if (loaded && loaded !== 'unchanged') {
          const id = this.next++;

          const file = key.startsWith('data:')
            ? join(this.directory, `${id}.png`)
            : key;

          const image: Image = {
            id,
            link: pathToFileURL(file).href,
            stamp: loaded.stamp,
            ...loaded.size,
          };

          const encoded = loaded.data.toString('base64');

          for (let start = 0; start < encoded.length; start += 4096) {
            const more = start + 4096 < encoded.length ? 1 : 0;
            const keys = start ? '' : `a=t,f=100,t=d,i=${image.id},q=2,`;

            this.write(
              `\u001b_G${keys}m=${more};${encoded.slice(start, start + 4096)}\u001b\\`,
            );
          }

          if (shown) this.write(`\u001b_Ga=d,d=I,i=${shown.id},q=2\u001b\\`);

          this.entries.set(key, image);
          this.loads++;
        } else if (!loaded && !shown)
          // a shown image stays when its changed file can't load, as while it is being written
          this.entries.set(key, {
            // a file can be written after a message names it; a data URL can't change
            retry: key.startsWith('data:') ? Infinity : Date.now() + retryDelay,
          });
      }
    }

    for (const listener of this.listeners) listener();
  }
}

const entryKey = (source: string, cwd: string) =>
  source.startsWith('data:') ? source : resolveFile(source, cwd);

/**
 * the PNG data for a path or `data:` URL, its size and its file's stamp; none when it isn't an image, and
 * `'unchanged'` when its file still reads `stamp`.
 */
async function decode(key: string, signal: AbortSignal, stamp?: string) {
  let data: Buffer;
  let read: string | undefined;

  if (key.startsWith('data:'))
    data = Buffer.from(key.slice(key.indexOf(',') + 1), 'base64');
  else {
    // reading a FIFO named like an image would never finish, stalling every later load and keeping Witch from exiting
    const file = await stat(key);

    if (!file.isFile() || file.size > largestFile) return undefined;

    // an atomic replace can keep the time and size, but not the inode
    read = `${file.mtimeMs}:${file.size}:${file.ino}`;

    if (read === stamp) return 'unchanged' as const;

    data = await readFile(key, { signal });
  }

  // the terminal decodes only PNG, and draws nothing for one cut short, which the conversion refuses
  if (!startsLikePng(data) || !data.subarray(-pngEnd.length).equals(pngEnd))
    data = await convertImage(data, 'png', signal);

  // a truncated conversion throws here, failing its load
  const size = { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };

  return size.width && size.height ? { data, size, stamp: read } : undefined;
}
