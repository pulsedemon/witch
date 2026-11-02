import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { resolveFile, unescapePath } from '../paths.js';
import type { ConversationStore } from '../persistence/store.js';

export const markerPattern = /\[Image #(\d+)\]/g;
// Claude Code's extensions, which are also the types Claude's API accepts
const imageName = /\.(?:png|jpe?g|gif|webp)$/i;
// a quoted path, or one where a backslash escapes the next character, then ASCII whitespace; `\s` would split at the U+202F in screenshot names
const token =
  /(?:"([^"\n]+)"|'([^'\n]+)'|((?:\\.|[^ \t\r\n\\"'])+))(?:[ \t\r\n]+|$)/gy;
const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const largestSide = 2000;
// Claude's per-image limit, which applies to the base64 encoding
const largestEncoded = 5 * 1024 * 1024;

/** the absolute paths a paste lists when every one names a readable image; a terminal drop arrives as such a paste. */
export function imagePaste(text: string): string[] | undefined {
  const trimmed = text.trim();
  const matches = [...trimmed.matchAll(token)];
  const last = matches.at(-1);
  const listed =
    last && last.index + last[0].length === trimmed.length
      ? matches.map(([, double, single, bare]) =>
          imagePath(double ?? single ?? unescapePath(bare!)),
        )
      : undefined;
  if (listed?.every((path) => path !== undefined)) return listed;
  // a raw path with unescaped spaces, tried second so a dropped `a\ b.png` never names a literal backslash
  const whole = imagePath(trimmed);
  return whole === undefined ? undefined : [whole];
}

function imagePath(written: string): string | undefined {
  if (!written.startsWith('~/') && !isAbsolute(written)) return;
  const path = resolveFile(written, '/');
  if (!imageName.test(path)) return;
  try {
    accessSync(path, constants.R_OK);
    if (statSync(path).isFile()) return path;
  } catch {
    return;
  }
}

/** the images pasted in this process, each sent as the marker that names it. */
export class Attachments {
  private readonly images = new Map<
    number,
    { data: Buffer; saved: Map<string, Promise<string>> }
  >();
  private next = 1;
  private conversions = new AbortController();

  /** takes the bytes now, since a dragged screenshot thumbnail's file can be gone before the prompt is sent. */
  attach(path: string): string {
    const id = this.next++;
    this.images.set(id, { data: readFileSync(path), saved: new Map() });
    return `[Image #${id}]`;
  }

  /** the registered images `text` names, in order, each once. */
  resolve(text: string): number[] {
    const ids = [...text.matchAll(markerPattern)].map(([, id]) => Number(id));
    return [...new Set(ids)].filter((id) => this.images.has(id));
  }

  /** saves each image into the conversation once, and a delivery after a failed one tries again. */
  prepare(ids: readonly number[], store: ConversationStore): Promise<string[]> {
    return Promise.all(
      ids.map((id) => {
        const { data, saved } = this.images.get(id)!;
        let saving = saved.get(store.directory);
        if (!saving) {
          saving = encode(data, this.conversions.signal).then(
            ({ bytes, extension }) => store.saveImage(bytes, extension),
          );
          saved.set(store.directory, saving);
          void saving.catch(() => saved.delete(store.directory));
        }
        return saving;
      }),
    );
  }

  /** stops running conversions, so an interrupt or shutdown never waits on `sips`. */
  cancel(): void {
    this.conversions.abort();
    this.conversions = new AbortController();
  }
}

/** a PNG within Claude's limits goes as it is; anything else is converted to a JPEG of at most 2,000 px a side. */
async function encode(
  data: Buffer,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; extension: 'png' | 'jpg' }> {
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(pngSignature) &&
    data.toString('latin1', 12, 16) === 'IHDR' &&
    data.readUInt32BE(16) <= largestSide &&
    data.readUInt32BE(20) <= largestSide &&
    Math.ceil(data.length / 3) * 4 <= largestEncoded
  )
    return { bytes: data, extension: 'png' };
  const directory = await mkdtemp(join(tmpdir(), 'witch-attachment-'));
  try {
    const input = join(directory, 'input');
    const output = join(directory, 'output.jpg');
    await writeFile(input, data);
    const size = await sips(
      ['-g', 'pixelWidth', '-g', 'pixelHeight', input],
      signal,
    );
    const sides = [...size.matchAll(/pixel(?:Width|Height): (\d+)/g)];
    // `-Z` enlarges a smaller image too
    const fit = sides.some(([, side]) => Number(side) > largestSide)
      ? ['-Z', String(largestSide)]
      : [];
    await sips(
      ['-s', 'format', 'jpeg', ...fit, input, '--out', output],
      signal,
    );
    return { bytes: await readFile(output), extension: 'jpg' };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function sips(args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('/usr/bin/sips', args, { signal }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );
}
