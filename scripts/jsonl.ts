import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** a missing file or directory reads as the fallback; any other failure stops the run. */
export function absent<T>(fallback: T): (error: NodeJS.ErrnoException) => T {
  return (error) => {
    if (error.code === 'ENOENT') return fallback;

    throw error;
  };
}

export async function* jsonl(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, {
    recursive: true,
    withFileTypes: true,
  }).catch(absent([])))
    if (entry.isFile() && entry.name.endsWith('.jsonl'))
      yield join(entry.parentPath, entry.name);
}

/**
 * parses one wanted JSONL row; only the last may be malformed, since a running agent can be mid-write. unwanted
 * rows aren't checked.
 */
class Rows<T> {
  private malformed?: number;
  private number = 0;

  constructor(
    private readonly file: string,
    private readonly wanted: (line: string) => boolean,
  ) {}

  parse(line: string): T | undefined {
    this.number++;

    if (!line) return;

    if (this.malformed)
      throw new Error(`${this.file}:${this.malformed}: malformed JSON row`);

    if (!this.wanted(line)) return;

    try {
      return JSON.parse(line) as T;
    } catch {
      this.malformed = this.number;
    }
  }
}

/**
 * streams a log's rows, parsing only lines `wanted` accepts; some Codex rollouts exceed the maximum string
 * length. rows end at `\n` only, since `readline` also breaks at a U+2028 inside a row's text.
 */
export async function* lines<T>(
  file: string,
  wanted: (line: string) => boolean = () => true,
): AsyncGenerator<T> {
  const parsed = new Rows<T>(file, wanted);
  // a row's pieces, joined once at its newline, so a row spanning many chunks isn't rescanned
  let pieces: string[] = [];

  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    const text = chunk as string;
    let start = 0;

    for (
      let end = text.indexOf('\n');
      end !== -1;
      end = text.indexOf('\n', start)
    ) {
      pieces.push(text.slice(start, end));
      const row = parsed.parse(pieces.join(''));
      pieces = [];

      if (row) yield row;

      start = end + 1;
    }

    pieces.push(text.slice(start));
  }

  const row = parsed.parse(pieces.join(''));

  if (row) yield row;
}
