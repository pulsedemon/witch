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

// a raw quote, or a JSON escape other than `\/` with what it escapes. a lone backslash before any other character can belong to a query, as in `?q=\d+`.
// `\/` is no break: `https:\/\/host\/path` would link the host alone
const breaks = /"|\\+(?:u[\da-fA-F]{4}|["bfnrt])|\\{2,}/gu;

interface FileMatch {
  index: number;
  lastIndex: number;
  text: string;
  path: string;
  json: boolean;
}

interface FileContext {
  containers: number;
  key: boolean;
  member: boolean;
  needsDelimiter: boolean;
  pending?: { opener: '[' | '{'; depth: number };
}

function jsonBreaks(text: string, nested: boolean) {
  const result: { index: number; length: number }[] = [];
  const width = nested ? 2 : 1;

  for (const match of text.matchAll(/"|(\\+)(u[\da-fA-F]{4}|["bfnrt])?/gu)) {
    const slashes = match[1]?.length ?? 0;
    const escaped = match[2];

    if (slashes === 1 && !escaped) continue;

    const literal = slashes >= width && slashes % (width * 2) < width;

    result.push({
      index: match.index,
      length: literal && escaped !== '"' ? slashes : match[0].length,
    });
  }

  return result;
}

const jsonPrimitive =
  /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[\s,}\]]|$)/u;

function startsContainer(opener: '[' | '{', next: string) {
  return opener === '{'
    ? /^["}]/u.test(next)
    : /^["\]]/u.test(next) || jsonPrimitive.test(next);
}

/** only complete encoded JSON selects another escape level; bracketed prose does not. */
function nestedContainer(text: string) {
  if (!/^"(?:\s|\\[nrt])*[{[]/u.test(text)) return false;

  try {
    JSON.parse(JSON.parse(text) as string);

    return true;
  } catch {
    return false;
  }
}

/** preserve a prefix's file targets by keeping the following line available as lookahead. */
function fileSections(text: string, boundary: number, previous?: FileContext) {
  const sections: { start: number; end: number; json: boolean }[] = [];
  const quotedFile = new RegExp(files.source, 'uy');
  let start = 0;

  let { containers, key, member, pending, needsDelimiter } = previous ?? {
    containers: 0,
    key: false,
    member: false,
    needsDelimiter: false,
    pending: undefined,
  };

  for (let index = 0; index < boundary; index++) {
    const char = text[index]!;

    if (/\s/u.test(char)) continue;

    needsDelimiter = false;

    if (pending) {
      if (pending.opener === '[' && (char === '[' || char === '{')) {
        pending = { opener: char, depth: pending.depth + 1 };

        continue;
      }

      if (startsContainer(pending.opener, text.slice(index)))
        containers += pending.depth;

      pending = undefined;
    }

    if (char === '\\') {
      if (text[index + 1] !== '\n') index++;

      continue;
    }

    if (char === "'" || char === '`') {
      quotedFile.lastIndex = index;
      const quoted = quotedFile.exec(text);

      if (quoted?.[1]) {
        index += quoted[0].length - 1;
        key = false;
        member = false;

        continue;
      }
    }

    if (char !== '"') {
      if (char === '{' || char === '[') pending = { opener: char, depth: 1 };
      else if (char === '}' || char === ']')
        containers = Math.max(0, containers - 1);
      else if (containers > 0 && char !== ',' && char !== ':') {
        const primitive = jsonPrimitive.exec(text.slice(index));

        if (primitive) index += primitive[0].length - 1;
        else containers = 0;
      }

      member = key && char === ':';
      key = false;

      continue;
    }

    let end = index + 1;

    for (; end < text.length && text[end] !== '"' && text[end] !== '\n'; end++)
      if (text[end] === '\\' && text[end + 1] !== '\n') end++;

    const stop = text[end] === '"' ? end + 1 : Math.min(end, text.length);

    if (text[end] === '"' && !/^\s*(?:[:,}\]]|$)/u.test(text.slice(stop))) {
      containers = 0;
      member = false;
    }

    const nested = nestedContainer(text.slice(index, stop));
    const json = containers > 0 || member || nested;

    if (json) {
      const separators = jsonBreaks(text.slice(index, stop), nested);

      if (separators.some((match) => text[index + match.index] === '\\')) {
        sections.push({ start, end: index, json: false });
        let from = index;

        for (const match of separators) {
          const before = index + match.index;
          sections.push({ start: from, end: before, json: true });
          from = before + match.length;
        }

        sections.push({ start: from, end: stop, json: true });
        start = stop;
      }
    }

    key = text[end] === '"';
    needsDelimiter = key && (containers > 0 || member) && !nested;
    member = false;
    index = stop - 1;
  }

  sections.push({ start, end: boundary, json: false });

  return {
    sections,
    context: { containers, key, member, pending, needsDelimiter },
  };
}

function fileCandidates(
  text: string,
  offset: number,
  json: boolean,
): FileMatch[] {
  const matches: FileMatch[] = [];

  for (const match of text.matchAll(files)) {
    const quoted = match[1];
    const label = quoted ?? match[0].replace(/[.,;!?]+$/, '');

    if (!quoted && !label.includes('/') && !sourceFile.test(label)) continue;

    const index = offset + match.index + (quoted ? 1 : 0);

    matches.push({
      index,
      lastIndex: index + label.length,
      text: label,
      path: quoted || json ? label : unescapePath(label),
      json,
    });
  }

  return matches;
}

function fileMatches(
  text: string,
  pieces: readonly Piece[],
  following: string,
  previous?: FileContext,
) {
  const { sections, context } = fileSections(
    text + following,
    text.length,
    previous,
  );

  let sectionIndex = 0;
  let offset = 0;

  const matches = pieces.map((piece) => {
    const matches: FileMatch[] = [];
    const end = offset + piece.text.length;

    while (sections[sectionIndex] && sections[sectionIndex]!.end <= offset)
      sectionIndex++;

    for (
      let index = sectionIndex;
      !piece.plain && index < sections.length;
      index++
    ) {
      const section = sections[index]!;

      if (section.start >= end) break;

      const start = Math.max(offset, section.start);
      const chunk = text.slice(start, Math.min(end, section.end));
      matches.push(...fileCandidates(chunk, start - offset, section.json));
    }

    offset = end;

    return matches;
  });

  return { matches, context };
}

/**
 * linkify-it's matches with no raw double quote and no JSON escape but `\/`, which end a URL written in JSON.
 * linkify-it pairs quotes inside a path, so minified JSON would join a URL to the keys after it.
 */
function webMatches(
  text: string,
): Pick<Match, 'index' | 'lastIndex' | 'text' | 'url'>[] {
  const result: ReturnType<typeof webMatches> = [];
  let start = 0;

  for (const stop of [...text.matchAll(breaks), undefined]) {
    const end = stop?.index ?? text.length;

    for (const match of urls.match(text.slice(start, end)) ?? [])
      result.push({
        index: start + match.index,
        lastIndex: start + match.lastIndex,
        text: match.text,
        url: match.url,
      });

    start = end + (stop?.[0].length ?? 0);
  }

  return result;
}

/** recover uncovered file references without replacing a winning URL's neighboring web links. */
function outsideWebLinks(
  text: string,
  sources: FileMatch[],
  links: ReturnType<typeof webMatches>,
) {
  let index = 0;

  return sources.flatMap((source) => {
    while (links[index] && links[index]!.lastIndex <= source.index) index++;

    let end = index;
    let explicit = false;

    for (; links[end] && links[end]!.index < source.lastIndex; end++)
      explicit ||= webLink.test(links[end]!.text);

    if (!explicit) return [source];

    let start = source.index;
    const matches: FileMatch[] = [];

    for (let next = index; next < end; next++) {
      const link = links[next]!;

      if (
        !webLink.test(link.text) &&
        !link.text.includes('/') &&
        sourceFile.test(
          link.text.slice(0, link.text.length - sentenceEnd(link.text)),
        )
      )
        continue;

      matches.push(
        ...fileCandidates(
          text.slice(start, Math.max(start, link.index)),
          start,
          source.json,
        ),
      );

      start = Math.max(start, link.lastIndex);
    }

    if (start < source.lastIndex)
      matches.push(
        ...fileCandidates(
          text.slice(start, source.lastIndex),
          start,
          source.json,
        ),
      );

    return matches;
  });
}

function bareLinks(
  text: string,
  cwd: string,
  sourceFiles: FileMatch[],
): string {
  // a skipped URL must not become a file link; no link crosses a newline.
  if (backtracks(text)) {
    let start = 0;
    let index = 0;

    return text
      .split('\n')
      .map((line) => {
        const end = start + line.length;
        const matches: FileMatch[] = [];

        while (sourceFiles[index] && sourceFiles[index]!.lastIndex <= end) {
          const match = sourceFiles[index++]!;

          if (match.index >= start)
            matches.push({
              ...match,
              index: match.index - start,
              lastIndex: match.lastIndex - start,
            });
        }

        start = end + 1;

        return backtracks(line) ? line : bareLinks(line, cwd, matches);
      })
      .join('\n');
  }

  const links = webMatches(text);
  sourceFiles = outsideWebLinks(text, sourceFiles, links);
  let output = '';
  let offset = 0;
  let fileIndex = 0;

  const emitFiles = (end: number) => {
    while (sourceFiles[fileIndex] && sourceFiles[fileIndex]!.lastIndex <= end) {
      const source = sourceFiles[fileIndex++]!;

      if (source.index < offset) continue;

      output +=
        text.slice(offset, source.index) +
        hyperlink(source.text, source.path, cwd);

      offset = source.lastIndex;
    }
  };

  for (const match of links) {
    if (match.index < offset) continue;

    emitFiles(match.index);

    while (sourceFiles[fileIndex] && sourceFiles[fileIndex]!.index < offset)
      fileIndex++;

    const source = sourceFiles[fileIndex];

    if (
      !webLink.test(match.text) &&
      source &&
      source.index >= offset &&
      source.index < match.lastIndex
    ) {
      output +=
        text.slice(offset, source.index) +
        hyperlink(source.text, source.path, cwd);

      offset = source.lastIndex;
      fileIndex++;

      continue;
    }

    output += text.slice(offset, match.index);
    const punctuation = sentenceEnd(match.text);

    output += hyperlink(
      match.text.slice(0, match.text.length - punctuation),
      match.url.slice(0, match.url.length - punctuation),
      cwd,
    );

    offset = match.lastIndex - punctuation;
  }

  emitFiles(text.length);

  return output + text.slice(offset);
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
  let run: UnbrokenRun | undefined;

  for (let start = 0; start < text.length;) {
    let end = Math.min(start + pieceSize, text.length);
    let guarded = false;

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
        // a raw quote ends every link, but an angle bracket can belong to a URL's paired path
        const quote = after(/"/);

        if (quote > start) boundary = quote;
        else {
          const markup = after(/[<>]/);

          if (markup > start && !urls.pretest(text.slice(start, markup)))
            boundary = markup;
        }
      }

      if (boundary) end = boundary;
      else ({ end, guarded, run } = unbroken(text, start, end, run));
    }

    if (guarded) result.push(...cutAfterQuotes(text, start, end));
    else {
      for (; start + pieceSize < end; start += pieceSize)
        result.push({
          text: text.slice(start, start + pieceSize),
          plain: false,
        });

      result.push({ text: text.slice(start, end), plain: false });
    }

    start = end;
  }

  return result;
}

interface UnbrokenRun {
  end: number;
  web: boolean;
}

/** reuse a run's boundary and URL check when a file-aligned cut leaves its suffix for the next piece. */
function unbroken(
  text: string,
  start: number,
  end: number,
  run?: UnbrokenRun,
): { end: number; guarded: boolean; run?: UnbrokenRun } {
  // a newline after a backslash is no boundary to `pieces`, and no link crosses it, so each line is decided alone
  const line = text.slice(start, end).lastIndexOf('\n') + 1;

  if (line) return { end: start + line, guarded: false };

  if (!run || start >= run.end) {
    const boundary = new RegExp(separator, 'gu');
    boundary.lastIndex = end;
    const stop = boundary.exec(text)?.index ?? text.length;

    run = {
      end: stop,
      web: stop > end && urls.pretest(text.slice(start, stop)),
    };
  }

  const stop = run.end;
  let guarded = stop > end && run.web;

  if (stop > end && !guarded)
    for (const match of text.slice(start, stop).matchAll(files)) {
      if (match.index >= end - start)
        return { end: start + match.index, guarded: false, run };

      if (match.index + match[0].length > end - start) {
        if (match.index > 0)
          return { end: start + match.index, guarded: false, run };

        guarded = true;

        break;
      }
    }

  return {
    end: stop,
    guarded,
    run,
  };
}

/**
 * an overlong run with a possible link, cut after quotes into pieces that can be searched.
 * a quote ends every web link, escaped or not; a stretch with no quote past one piece stays plain.
 * a dropped path that escapes a quote can link in fragments.
 */
function cutAfterQuotes(text: string, start: number, stop: number): Piece[] {
  const result: Piece[] = [];

  while (start < stop) {
    let end = Math.min(start + pieceSize, stop);
    let plain = false;

    if (end < stop) {
      const before = text.slice(start, end).lastIndexOf('"') + 1;

      if (before) end = start + before;
      else {
        const after = text.slice(end, stop).indexOf('"') + 1;
        end = after ? end + after : stop;
        plain = true;
      }
    }

    result.push({ text: text.slice(start, end), plain });
    start = end;
  }

  return result;
}

function linked(
  text: string,
  cwd: string,
  target?: string,
  previous?: FileContext,
  following = '',
) {
  const chunks: (Piece & { target?: string })[] = [];
  let visible = '';
  let buffer = '';
  let line = { text: '', target };
  let firstLine: string | undefined;

  const flush = () => {
    visible += buffer;

    chunks.push(
      ...(target ? [{ text: buffer, plain: true, target }] : pieces(buffer)),
    );

    buffer = '';
  };

  for (const token of tokenize(text)) {
    line.text += token.type === 'char' ? token.value : token.code;

    if (token.type === 'ansi' && token.code.startsWith('\u001b]8;')) {
      flush();
      const separator = token.code.indexOf(';', 4);
      const terminator = token.code.endsWith('\u001b\\') ? 2 : 1;
      target = token.code.slice(separator + 1, -terminator) || undefined;
    } else if (token.type === 'char' && !controls.test(token.value)) {
      buffer += token.value;
      const newline = token.value.lastIndexOf('\n');

      if (newline >= 0) {
        firstLine ??= line.text.slice(
          0,
          line.text.length - token.value.length + newline + 1,
        );

        line = { text: token.value.slice(newline + 1), target };
      }
    }
  }

  flush();

  const { matches, context } = fileMatches(
    visible,
    chunks,
    following,
    previous,
  );

  const output = chunks
    .map((piece, index) =>
      piece.target
        ? hyperlink(piece.text, piece.target, cwd)
        : piece.plain
          ? piece.text
          : bareLinks(piece.text, cwd, matches[index]!),
    )
    .join('');

  return { text: output, target, context, visible, line, firstLine };
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

/** retain raw line offsets without counting newlines inside OSC sequences. */
function appendBoundary(text: string) {
  let complete = 0;
  let lastQuoteLine = 0;
  let quotedLine = 0;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (char === '"') lastQuoteLine = complete;

    if (char === '\n') {
      complete = index + 1;
      quotedLine = lastQuoteLine;
    }

    if ((char !== '\u001b' && char !== '\u009b') || text[index + 1] !== ']')
      continue;

    const start = text.startsWith(']8;', index + 1)
      ? text.indexOf(';', index + 4)
      : index + 1;

    if (start < 0) return { end: complete, quotedLine, oscStart: index };

    const end = oscEnd(text, start + 1);

    if (end < 0) return { end: complete, quotedLine, oscStart: index };

    index = end - 1;
  }

  return { end: complete, quotedLine, oscStart: undefined };
}

function incompleteStyle(raw: string, visible: string): boolean {
  const escape = Math.max(
    raw.lastIndexOf('\u001b['),
    raw.lastIndexOf('\u009b['),
  );

  return (
    escape >= 0 &&
    /^[\d;]*$/u.test(raw.slice(escape + 2)) &&
    /^\s*\[[\d;]*$/u.test(visible)
  );
}

export interface LinkedAppend {
  complete: string[];
  tail: string;
  pending: string;
  target?: string;
  context?: FileContext;
  /** cache both interpretations so split escapes can revise the quote without revisiting blank lines. */
  provisional?: {
    renderedPrefix: string;
    line: { text: string; target?: string };
    quoted: { json: string; terminal: string };
    mode: 'json' | 'terminal';
    context: FileContext;
    tailLines: number;
  };
  /** replace the unsettled suffix, promoting only lines that later bytes cannot remove. */
  provisionalUpdate?: { replace: number; complete: string[]; tail: string[] };
}

/** append a new chunk, retaining raw text until later bytes cannot change its rendered lines. */
export function linkifyAppend(
  text: string,
  cwd: string,
  previous?: LinkedAppend,
): LinkedAppend {
  if (previous?.provisional) {
    const { renderedPrefix, line, quoted, context, tailLines } =
      previous.provisional;

    const raw = line.text + text;
    const suffix = linked(raw, cwd, line.target, context);
    const blank = /^\s*$/u.test(suffix.visible);
    const incomplete = incompleteStyle(suffix.line.text, suffix.visible);

    if (blank || incomplete) {
      const mode = blank ? 'json' : 'terminal';
      const lines = suffix.text.split('\n');
      const tail = lines.pop()!;

      return {
        ...previous,
        complete: [],
        pending: previous.pending + text,
        tail: quoted[mode] + '\n' + renderedPrefix + suffix.text,
        provisional: {
          ...previous.provisional,
          renderedPrefix:
            renderedPrefix +
            suffix.text.slice(0, suffix.text.lastIndexOf('\n') + 1),
          line: suffix.line,
          mode,
          tailLines: 1,
        },
        provisionalUpdate: {
          replace: tailLines,
          complete: lines,
          tail: [tail],
        },
      };
    }

    const boundary = appendBoundary(raw);

    if (
      boundary.oscStart !== undefined &&
      /^\s*$/u.test(
        linked(raw.slice(0, boundary.oscStart), cwd, line.target, context)
          .visible,
      )
    ) {
      const prefix = linked(
        raw.slice(0, boundary.end),
        cwd,
        line.target,
        context,
      );

      const rendered = prefix.text.slice(0, prefix.text.lastIndexOf('\n') + 1);
      const tail = suffix.text.slice(rendered.length).split('\n');

      return {
        ...previous,
        complete: [],
        pending: previous.pending + text,
        tail: quoted.json + '\n' + renderedPrefix + suffix.text,
        provisional: {
          ...previous.provisional,
          renderedPrefix: renderedPrefix + rendered,
          line: { text: raw.slice(boundary.end), target: prefix.target },
          mode: 'json',
          tailLines: tail.length,
        },
        provisionalUpdate: {
          replace: tailLines,
          complete: prefix.text.split('\n').slice(0, -1),
          tail,
        },
      };
    }
  }

  text = (previous?.pending ?? '') + text;
  let { target, context } = previous ?? {};
  const boundary = appendBoundary(text);
  let end = boundary.end;
  let complete: string[] = [];
  let provisional = false;

  if (end) {
    let prefix = linked(text.slice(0, end), cwd, target, context);
    const trailing = text.slice(end);
    const following = plain(trailing);

    const unsettled =
      /^\s*$/u.test(following) ||
      incompleteStyle(trailing, following) ||
      (boundary.oscStart !== undefined &&
        /^\s*$/u.test(plain(text.slice(end, boundary.oscStart))));

    if (prefix.context.needsDelimiter && unsettled) {
      provisional = true;
      end = boundary.quotedLine;
      const raw = text.slice(0, end);
      const following = prefix.visible.slice(plain(raw).length);
      prefix = linked(raw, cwd, target, context, following);
    } else if (prefix.context.needsDelimiter) {
      prefix = linked(text.slice(0, end), cwd, target, context, following);
    }

    if (end) {
      complete = prefix.text.split('\n');
      complete.pop();
      target = prefix.target;
      context = prefix.context;
    }
  }

  const pending = text.slice(end);
  const suffix = linked(pending, cwd, target, context);

  const stableEnd =
    boundary.oscStart === undefined ? pending.length : boundary.end - end;

  const stable =
    provisional && stableEnd < pending.length
      ? linked(pending.slice(0, stableEnd), cwd, target, context)
      : suffix;

  let cache: LinkedAppend['provisional'];

  if (
    provisional &&
    stable.context.needsDelimiter &&
    /^\s*$/u.test(stable.visible.slice(stable.visible.lastIndexOf('\n') + 1))
  ) {
    const first = stable.text.indexOf('\n');

    const alternative = linked(
      stable.firstLine! + '\u001b[',
      cwd,
      target,
      context,
    ).text;

    cache = {
      renderedPrefix: stable.text.slice(
        first + 1,
        stable.text.lastIndexOf('\n') + 1,
      ),
      line:
        stable === suffix
          ? suffix.line
          : { text: pending.slice(stableEnd), target: stable.target },
      quoted: {
        json: stable.text.slice(0, first),
        terminal: alternative.slice(0, alternative.indexOf('\n')),
      },
      mode: 'json',
      context: stable.context,
      tailLines:
        stable === suffix
          ? 1
          : suffix.text.slice(stable.text.length).split('\n').length,
    };
  }

  return {
    complete,
    tail: suffix.text,
    pending,
    target,
    context,
    provisional: cache,
  };
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
