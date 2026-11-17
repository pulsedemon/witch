import { tokenize } from '@alcalzone/ansi-tokenize';
import LinkifyIt, { type Match } from 'linkify-it';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { present } from '../persistence/directories.js';
import { resolveFile, unescapePath } from '../paths.js';
import { imageFile } from './transcript/images.js';
import { colors } from './theme.js';

const urls = new LinkifyIt();

/** whether linkify-it's hostname pattern would try both readings of each `xn--` label in `text`, doubling its work with every one. */
function backtracks(text: string): boolean {
  return (text.match(/xn--/gi)?.length ?? 0) > 4;
}

// the tokenizer passes a lone escape or control byte through as text, where it can rejoin the bytes around a dropped sequence into a new one
const controls = /(?![\n\t\r])\p{Cc}/u;

// filename boundaries prevent suffix links and keep long runs of name characters linear.
// an unquoted path reads as a terminal drops it: a backslash escapes the next character, and a macOS screenshot name's U+202F doesn't end it.
// a quoted path starting with a name keeps spaces only up to a file extension, so a quoted sentence opening with `Pause/resume` stays text
const files =
  /(?<![\p{L}\p{M}\p{N}_+%,/])(?:["'`]((?:\.{0,2}\/|~\/)[^\n"'`]+|[\p{L}\p{M}\p{N}_@.+%,-]+\/(?:[^\s"'`]+|[^\n"'`]*\.[a-zA-Z][a-zA-Z\d]{0,12}(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?))["'`]|(?:\.{1,2}\/|~\/|\/[\p{L}\p{M}\p{N}_.@+%,-]+\/)(?:\\.|[^\s<>"'`[\]():\\]|\u202f)+(?::\d+(?::\d+)?)?)|(?<![\p{L}\p{M}\p{N}_/@.+%,-])(?:[\p{L}\p{M}\p{N}_@.+%,-]+\/)*\.?[\p{L}\p{M}\p{N}_@+%,-]+(?:\.[\p{L}\p{M}\p{N}_@+%,-]+)*\.[a-zA-Z][a-zA-Z\d]{0,12}(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?(?![\p{L}\p{M}\p{N}_/@+%-]|[.,]+[\p{L}\p{M}\p{N}_/@+%-])/gu;

// a name with no directory links only with one of these extensions, so `e.g.` and `foo.bar` stay text
const sourceFile =
  /\.(?:[cm]?[jt]sx?|py|sh|md|rs|go|rb|pl|cc|c|h|java|cs|swift|txt|json|toml|ya?ml|csv|xml|ini|env|lock|html|css|sql|log)(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?$/i;

// links drawn for a name with no directory, which a click looks up in shared memory when the cwd lacks it
const bareNames = new Set<string>();

export function linkTarget(target: string, cwd: string): string {
  if (/^https?:\/\//i.test(target)) return target;

  if (target.startsWith('vscode://file/')) return target;

  if (target.startsWith('file://'))
    target = decodeURIComponent(new URL(target).pathname);

  // Codex writes a location as `#L12C4` as well as `:12:4`
  const location =
    /:(\d+)(?::(\d+))?$/.exec(target) ?? /#L(\d+)(?:C(\d+))?$/.exec(target);

  const file = location ? target.slice(0, location.index) : target;
  const path = resolveFile(file, cwd);

  // the system's default viewer opens an image, which has no line to go to
  if (imageFile.test(path)) return pathToFileURL(path).href;

  const suffix = location
    ? `:${location[1]}${location[2] ? `:${location[2]}` : ''}`
    : '';

  return `vscode://file${path.split('/').map(encodeURIComponent).join('/')}${suffix}`;
}

/** what a click on a drawn link opens, or the notice it shows when the file isn't there or isn't an image. */
export async function clickTarget(
  url: string,
  memory: () => Promise<string[]>,
): Promise<{ open: string } | { notice: string }> {
  const target = await located(url, memory);

  if (!('open' in target) || !target.open.startsWith('file://')) return target;

  // open follows a symlink and picks the app by the real file's type, so a `.png` link to a script would run it
  const path = fileURLToPath(target.open);
  const real = await realpath(path);

  return imageFile.test(real) && (await stat(real)).isFile()
    ? { open: pathToFileURL(real).href }
    : { notice: `${path} is not an image file` };
}

async function located(
  url: string,
  memory: () => Promise<string[]>,
): Promise<{ open: string } | { notice: string }> {
  const file = /^vscode:\/\/file(\/.*?)((?::\d+){0,2})$/.exec(url);

  const path = file
    ? decodeURIComponent(file[1]!)
    : url.startsWith('file://')
      ? fileURLToPath(url)
      : undefined;

  if (path === undefined) return { open: url };

  if (await present(path)) return { open: url };

  if (!bareNames.has(url)) return { notice: `No file at ${path}` };

  const name = basename(path);
  const notes: string[] = [];

  for (const directory of await memory())
    if (await present(join(directory, name))) notes.push(join(directory, name));

  if (notes.length === 1)
    return { open: linkTarget(notes[0]! + (file?.[2] ?? ''), '/') };

  return {
    notice: notes.length
      ? `${name} is in both memory scopes:\n${notes.join('\n')}`
      : `No ${name} in ${dirname(path)} or shared memory`,
  };
}

export function hyperlink(text: string, target: string, cwd: string): string {
  if (
    /^[a-z][a-z\d+.-]*:/i.test(target) &&
    !/^(https?:|file:|vscode:)/i.test(target) &&
    !/:\d+(?::\d+)?$/.test(target)
  )
    return text;

  let url: string;

  try {
    url = linkTarget(target, cwd);
  } catch {
    return text;
  }

  if (/\p{Cc}/u.test(url)) return text;

  if (!target.includes('/')) bareNames.add(url);

  // keep underlining inside each line's link so clipped rows still open.
  // ansi-escapes adds tmux passthrough that Ink drops, so emit OSC 8 directly.
  return text
    .split('\n')
    .map(
      (line) =>
        `\u001b]8;;${url}\u0007${colors.underline(line)}\u001b]8;;\u0007`,
    )
    .join('\n');
}

function fileLinks(text: string, cwd: string): string {
  return text.replace(files, (match: string, quoted: string | undefined) => {
    if (quoted) return match[0] + hyperlink(quoted, quoted, cwd) + match.at(-1);

    const path = match.replace(/[.,;!?]+$/, '');

    if (!path.includes('/') && !sourceFile.test(path)) return match;

    return hyperlink(path, unescapePath(path), cwd) + match.slice(path.length);
  });
}

export function markdownLink(
  text: string,
  target: string,
  cwd: string,
): string {
  if (!/^[a-z][a-z\d+.-]*:/i.test(target)) {
    // a heading anchor is no part of the file; only a `#L12` location after a file is kept
    const hash = target.indexOf('#');

    if (!target || hash === 0) return text;

    if (hash > 0 && !/^#L\d+(?:C\d+)?$/.test(target.slice(hash)))
      target = target.slice(0, hash);

    try {
      target = decodeURIComponent(target);
    } catch {
      return text;
    }
  }

  return hyperlink(text, target, cwd);
}

// a file reference outranks every link but these
const webLink = /^(?:https?:\/\/|www\.)/i;

/** how many characters of sentence punctuation end `text`, which linkify-it keeps in a link when a closing quote or paren follows. */
function sentenceEnd(text: string): number {
  let length = 0;

  // counted from the end, since a regex anchored there retries from every punctuation character in a long link
  while ('.,;!?'.includes(text[text.length - 1 - length] ?? ' ')) length++;

  return length;
}

/**
 * linkify-it's matches with no raw double quote, which no URL holds.
 * linkify-it pairs quotes inside a path, so minified JSON would join a URL to the keys after it.
 */
function webMatches(
  text: string,
): Pick<Match, 'index' | 'lastIndex' | 'text' | 'url'>[] {
  const matches = urls.match(text) ?? [];

  if (!matches.some((match) => match.text.includes('"'))) return matches;

  const result: ReturnType<typeof webMatches> = [];
  let start = 0;

  for (const segment of text.split('"')) {
    for (const match of urls.match(segment) ?? [])
      result.push({
        index: start + match.index,
        lastIndex: start + match.lastIndex,
        text: match.text,
        url: match.url,
      });

    start += segment.length + 1;
  }

  return result;
}

function bareLinks(text: string, cwd: string): string {
  // a skipped URL must not become a file link; no link crosses a newline.
  if (backtracks(text))
    return text
      .split('\n')
      .map((line) => (backtracks(line) ? line : bareLinks(line, cwd)))
      .join('\n');

  let output = '';
  let offset = 0;

  const sourceFiles = [...text.matchAll(files)].filter(
    (match) =>
      !!match[1] || match[0].includes('/') || sourceFile.test(match[0]),
  );

  let fileIndex = 0;

  for (const match of webMatches(text)) {
    if (match.index < offset) continue;

    while (
      sourceFiles[fileIndex] &&
      sourceFiles[fileIndex]!.index + sourceFiles[fileIndex]![0].length <=
        match.index
    )
      fileIndex++;

    const source = sourceFiles[fileIndex];

    if (!webLink.test(match.text) && source && source.index < match.lastIndex) {
      output +=
        fileLinks(text.slice(offset, source.index), cwd) +
        fileLinks(source[0], cwd);

      offset = source.index + source[0].length;

      continue;
    }

    output += fileLinks(text.slice(offset, match.index), cwd);
    const punctuation = sentenceEnd(match.text);

    output += hyperlink(
      match.text.slice(0, match.text.length - punctuation),
      match.url.slice(0, match.url.length - punctuation),
      cwd,
    );

    offset = match.lastIndex - punctuation;
  }

  return output + fileLinks(text.slice(offset), cwd);
}

interface Piece {
  text: string;
  /** drawn as it is, without a search for links. */
  plain: boolean;
}

// linkify-it rescans suffixes, and wrapping repeats each target per row.
const pieceSize = 2000;
// the characters linkify-it reads no link across. `\s` is not the same set: it has U+FEFF, which a link can hold
const separator = /[\p{Z}\p{Cc}]/u;

/**
 * cap linkify-it inputs to avoid rescanning long suffixes after each match.
 * prefer line and whitespace boundaries; an escaped character or U+202F is inside a dropped path.
 */
function pieces(text: string): Piece[] {
  const result: Piece[] = [];

  for (let start = 0; start < text.length;) {
    let end = Math.min(start + pieceSize, text.length);
    let plain = false;

    const after = (separator: RegExp) => {
      let cut = end;

      while (
        cut > start &&
        (!separator.test(text[cut - 1]!) || text[cut - 2] === '\\')
      )
        cut--;

      return cut;
    };

    if (end < text.length) {
      // U+FEFF is whitespace to JavaScript and no separator to linkify-it, which reads it inside a link
      let boundary = [/\n/, /(?![\u202f\ufeff])\s/]
        .map(after)
        .find((cut) => cut > start);

      if (!boundary) {
        const markup = after(/[<>"]/);

        // quotes and angle brackets can belong to a URL's paired path.
        if (markup > start && !urls.pretest(text.slice(start, markup)))
          boundary = markup;
      }

      if (boundary) end = boundary;
      else ({ end, plain } = unbroken(text, start, end));
    }

    if (!plain)
      for (; start + pieceSize < end; start += pieceSize)
        result.push({ text: text.slice(start, start + pieceSize), plain });

    result.push({ text: text.slice(start, end), plain });
    start = end;
  }

  return result;
}

/**
 * keep an overlong run with a possible link plain, so no fragment becomes a target.
 * scan its boundary once, including when no link is possible and it can be split.
 */
function unbroken(
  text: string,
  start: number,
  end: number,
): { end: number; plain: boolean } {
  // a newline after a backslash is no boundary to `pieces`, and no link crosses it, so each line is decided alone
  const line = text.slice(start, end).lastIndexOf('\n') + 1;

  if (line) return { end: start + line, plain: false };

  const boundary = new RegExp(separator, 'gu');
  boundary.lastIndex = end;
  const stop = boundary.exec(text)?.index ?? text.length;

  return {
    end: stop,
    plain: stop > end && urls.pretest(text.slice(start, stop)),
  };
}

function linked(text: string, cwd: string, target?: string) {
  let output = '';
  let buffer = '';

  const flush = () => {
    output += target
      ? hyperlink(buffer, target, cwd)
      : pieces(buffer)
          .map((piece) =>
            piece.plain ? piece.text : bareLinks(piece.text, cwd),
          )
          .join('');

    buffer = '';
  };

  for (const token of tokenize(text)) {
    if (token.type === 'ansi' && token.code.startsWith('\u001b]8;')) {
      flush();
      const separator = token.code.indexOf(';', 4);
      const terminator = token.code.endsWith('\u001b\\') ? 2 : 1;
      target = token.code.slice(separator + 1, -terminator) || undefined;
    } else if (token.type === 'char' && !controls.test(token.value))
      buffer += token.value;
  }

  flush();

  return { text: output, target };
}

export function linkify(text: string, cwd: string): string {
  return linked(text, cwd).text;
}

function oscEnd(text: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    const char = text[index];

    if (char === '\u0007' || char === '\u009c') return index + 1;

    if (char === '\u001b' && text[index + 1] === '\\') return index + 2;
  }

  return -1;
}

/** a later delimiter can make the tokenizer consume an earlier OSC and its following lines. */
function completeLinesEnd(text: string): number {
  let complete = 0;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (char === '\n') complete = index + 1;

    if ((char !== '\u001b' && char !== '\u009b') || text[index + 1] !== ']')
      continue;

    const start = text.startsWith(']8;', index + 1)
      ? text.indexOf(';', index + 4)
      : index + 1;

    if (start < 0) return complete;

    const end = oscEnd(text, start + 1);

    if (end < 0) return complete;

    index = end - 1;
  }

  return complete;
}

export interface LinkedAppend {
  complete: string[];
  tail: string;
  pending: string;
  target?: string;
}

/** retain raw text until later bytes can no longer change its rendered lines. */
export function linkifyAppend(
  text: string,
  cwd: string,
  target?: string,
): LinkedAppend {
  const end = completeLinesEnd(text);
  let complete: string[] = [];

  if (end) {
    const prefix = linked(text.slice(0, end), cwd, target);
    complete = prefix.text.split('\n');
    complete.pop();
    target = prefix.target;
  }

  const pending = text.slice(end);

  return { complete, tail: linked(pending, cwd, target).text, pending, target };
}

/** agent-written text with no escapes or links. strip-ansi can't stand in, since removing one sequence can join its neighbours into another. */
export function plain(text: string): string {
  return tokenize(text)
    .map((token) =>
      token.type === 'char' && !controls.test(token.value) ? token.value : '',
    )
    .join('');
}

/** `plain` text for a single row, where a line break would start another: every whitespace run becomes a space. */
export function oneLine(text: string): string {
  return plain(text).replace(/\s+/g, ' ');
}
