import { tokenize } from '@alcalzone/ansi-tokenize';
import LinkifyIt from 'linkify-it';
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
  return (text.match(/xn--/gi)?.length ?? 0) > 10;
}

function webLinks(text: string) {
  return backtracks(text) ? [] : (urls.match(text) ?? []);
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

function bareLinks(text: string, cwd: string): string {
  let output = '';
  let offset = 0;

  const sourceFiles = [...text.matchAll(files)].filter(
    (match) =>
      !!match[1] || match[0].includes('/') || sourceFile.test(match[0]),
  );

  let fileIndex = 0;

  for (const match of webLinks(text)) {
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
  /** set when the piece is not searched for links: the address the whole piece links to, or null to draw it as plain text. */
  url?: string | null;
}

// the longest link drawn past the cap, about the longest request line web servers accept. wrapping repeats a link's address on every row, so its cost grows with the square of this
const longestLink = 8192;

/**
 * cap linkify-it inputs to avoid rescanning long suffixes after each match.
 * prefer boundaries that keep links, quoted paths and dropped paths whole; an escaped character or U+202F is inside a dropped path.
 */
function pieces(text: string): Piece[] {
  const result: Piece[] = [];

  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 2000, text.length);
    let url: Piece['url'];

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
      const boundary = [/\n/, /(?!\u202f)[\s<>]/, /"/]
        .map(after)
        .find((cut) => cut > start);

      if (boundary) end = boundary;
      else ({ end, url } = unbroken(text, start, end));
    }

    result.push({ text: text.slice(start, end), url });
    start = end;
  }

  return result;
}

// linkify-it reads these pairs as part of a link's path only when both ends are present
const closing: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  "'": "'",
  '"': '"',
};

// the longest start of a web link before its path: a scheme, a user name and password, a hostname and a port
const longestAuthority = 8 + 51 + 253 + 6;
// whether a link's path, or its end, comes within that length of its scheme
const authority = new RegExp(`^[^/?#]{0,${longestAuthority}}(?:[/?#]|$)`);
// linkify-it leaves this punctuation out of a link only when nothing follows it
const dangling = /^[-.,;!?]*$/;

/**
 * whether a link that linkify-it ended at `stop`, in text read up to `read`, can be longer in the whole text.
 * measuring a link scans up to `limit`, so this rules out the links that scan would only confirm.
 */
function cutShort(
  text: string,
  stop: number,
  read: number,
  limit: number,
): boolean {
  if (dangling.test(text.slice(stop, read))) return true;

  const closer = closing[text[stop]!];

  if (!closer) return false;

  // a paired part holds no whitespace, so one that meets whitespace before its closing end is not part of the link
  const inside = text.slice(stop + 1, limit);
  const close = inside.indexOf(closer);

  return !/\s/.test(close < 0 ? inside : inside.slice(0, close));
}

/** the piece as plain text to the next whitespace after `at`, which is the one thing linkify-it reads no link across. */
function plainRun(text: string, at: number): { end: number; url: null } {
  const boundary = /\s/g;
  boundary.lastIndex = at;

  return { end: boundary.exec(text)?.index ?? text.length, url: null };
}

/**
 * where a piece with no boundary to cut at ends: before the first web link that can run past the cap, or after it when it starts the piece.
 * that link is measured from its start alone, since linkify-it's search of a long piece rescans it for each scheme inside.
 * when its whole length cannot be established the run stays plain text, so no part of it links to a shorter address.
 */
function unbroken(
  text: string,
  start: number,
  end: number,
): Pick<Piece, 'url'> & { end: number } {
  // read past the cap so a link that starts just before it is recognized
  const read = Math.min(end + longestAuthority, text.length);
  const window = text.slice(start, read);

  if (backtracks(window)) return plainRun(text, end);

  for (const link of urls.match(window) ?? []) {
    const from = start + link.index;
    const stop = start + link.lastIndex;

    if (from >= end) break;

    if (
      !webLink.test(link.raw) ||
      (stop <= end && !cutShort(text, stop, read, from + longestLink))
    )
      continue;

    if (link.index) return { end: from };

    // one character more than a link may have, so a longer one measures as too long
    const rest = text.slice(from, from + longestLink + 1);
    // a `www.` link has no scheme of its own, so it is measured as the `//` form of the `http://` address linkify-it gives it
    const scheme = link.url.slice(0, -link.raw.length);
    const afterScheme = scheme ? 0 : link.schema.length;

    // linkify-it's work on a hostname grows with its length for each `xn--` label, so one longer than any real one is not measured
    if (
      backtracks(rest) ||
      !authority.test(rest.slice(scheme ? 0 : afterScheme + 2))
    )
      return plainRun(text, end);

    const length =
      afterScheme +
      urls.testSchemaAt(rest, scheme ? '//' : link.schema, afterScheme);

    const measured = from + length;
    const restEnd = from + rest.length;

    // where the measured text ended can cut the link short as the read can, and no later text is looked at to rule that out
    const unknown =
      restEnd < text.length &&
      (dangling.test(text.slice(measured, restEnd)) ||
        text[measured]! in closing);

    if (length > longestLink || unknown)
      return plainRun(text, Math.max(end, measured));

    const linkEnd = measured - sentenceEnd(rest.slice(0, length));

    if (linkEnd > end)
      return { end: linkEnd, url: scheme + text.slice(from, linkEnd) };
  }

  return { end };
}

function linked(text: string, cwd: string, target?: string) {
  let output = '';
  let buffer = '';

  const flush = () => {
    output += target
      ? hyperlink(buffer, target, cwd)
      : pieces(buffer)
          .map((piece) =>
            piece.url === undefined
              ? bareLinks(piece.text, cwd)
              : piece.url === null
                ? piece.text
                : hyperlink(piece.text, piece.url, cwd),
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
