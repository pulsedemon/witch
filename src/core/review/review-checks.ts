import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { decodeHTMLStrict } from 'entities';
import { unlessGone } from '../../persistence/json.js';
import type { TargetSnapshot } from './review-files.js';

const execute = promisify(execFile);

export interface CheckFailure {
  file: string;
  line: number;
  message: string;
}

/** the files a cited range's bracket walk understands; other languages' comments and closers would miscount. */
const scripts = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

const banned = [
  'great point',
  'good catch',
  'happy to',
  'clever trick',
  'might be worth considering',
  'the interesting part is',
  "it's worth noting that",
  'let me know if',
];

const identifier = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*(\(\))?$/;
const citation = /^([^\s:`]+):(\d+)(?:-(\d+))?$/;

type Fail = (line: number, message: string) => void;

/** link anchors, cited ranges, quoted identifiers and the fixed writing rules in each markdown target, before any reviewer reads it. */
export async function checkTargets(
  cwd: string,
  snapshot: TargetSnapshot,
): Promise<CheckFailure[]> {
  const repository = await repositoryOf(cwd);

  const cache = new Map<string, Promise<string | undefined>>(
    Object.entries(snapshot.canonical).map(([path, text]) => [
      path,
      Promise.resolve(text),
    ]),
  );

  for (const [file, text] of Object.entries(snapshot.texts))
    cache.set(resolve(cwd, file), Promise.resolve(text));

  const local = (path: string) => {
    let text = cache.get(path);

    if (!text) cache.set(path, (text = readText(path)));

    return text;
  };

  const failures: CheckFailure[] = [];

  for (const [file, text] of Object.entries(snapshot.texts)) {
    if (extname(file) !== '.md') continue;

    const path = resolve(cwd, file);
    const lines = text.split('\n');
    const prose = proseLines(lines);

    for (const [index, line] of lines.entries()) {
      const visible = prose[index];

      if (visible === undefined) continue;

      const fail: Fail = (number, message) =>
        failures.push({ file, line: number, message });

      const number = index + 1;
      const parts = segments(visible);

      const cite = (
        shown: string,
        content: string,
        start: number,
        end: number,
        name: string | undefined,
      ): void => {
        if (!checkRange(shown, content, start, end, fail, number)) return;

        if (name)
          checkIdentifier(name, shown, content, start, end, fail, number);
      };

      for (const link of links(parts)) {
        const target = resolveLink(link.target, path, repository);

        if (!target) continue;

        const shown =
          'revision' in target ? target.path : relative(cwd, target.path);

        let content: string;

        if ('revision' in target) {
          const read = await show(cwd, target.revision, target.path);

          if (!read) continue;

          if ('missing' in read) {
            fail(number, `link target ${shown} does not exist`);

            continue;
          }

          content = read.text;
        } else {
          const read = await local(target.path);

          if (read === undefined) {
            if (!(await isDirectory(target.path)))
              fail(number, `link target ${shown} does not exist`);

            continue;
          }

          content = read;
        }

        // an empty fragment and #top go to the top of any page
        if (!link.anchor || link.anchor.toLowerCase() === 'top') continue;

        const range = /^L(\d+)(?:-L(\d+))?$/.exec(link.anchor);

        if (range) {
          const start = Number(range[1]);
          const end = Number(range[2] ?? range[1]);
          cite(shown, content, start, end, quoted(link.text));
        } else if (
          extname(target.path) === '.md' &&
          !anchors(content).has(link.anchor)
        )
          fail(number, `no heading in ${shown} has the anchor #${link.anchor}`);
      }

      for (const [position, part] of parts.entries()) {
        const cited = part.code ? citation.exec(part.text) : null;

        if (!cited) continue;

        const target = resolve(cwd, cited[1]!);
        const content = await local(target);

        if (content === undefined) continue;

        const start = Number(cited[2]);
        const end = Number(cited[3] ?? cited[2]);
        const shown = relative(cwd, target);
        cite(shown, content, start, end, citedName(parts, position));
      }

      if (!/^\s*>/.test(line)) checkWriting(writable(parts), fail, number);
    }
  }

  return failures;
}

/** each line's prose with its HTML comments blanked; undefined where nothing visible is left: fenced code, front matter, comments and blank lines. indented lines stay prose, since nested list items use them. */
function proseLines(lines: readonly string[]): (string | undefined)[] {
  const prose: (string | undefined)[] = [];
  let fence: { mark: string; length: number; depth: number } | undefined;
  let front = lines[0] === '---' && lines.indexOf('---', 1) !== -1;
  let comment = false;

  for (const [index, line] of lines.entries()) {
    if (front) {
      prose.push(undefined);

      if (index > 0 && line === '---') front = false;

      continue;
    }

    let text = line;

    if (comment) {
      const close = line.indexOf('-->');

      if (close === -1) {
        prose.push(undefined);

        continue;
      }

      comment = false;
      text = ' '.repeat(close + 3) + line.slice(close + 3);
    } else {
      // a fence can sit in a blockquote, and ends when its quote does
      const quote = /^(?:\s*>)*/.exec(line)![0];
      const depth = quote.split('>').length - 1;
      const rest = line.slice(quote.length);
      // a backtick fence's info string has no backticks, so ```x``` is a code span
      const opening = /^\s*(`{3,}(?!.*`)|~{3,})/.exec(rest);

      if (fence && depth < fence.depth) fence = undefined;

      if (fence) {
        prose.push(undefined);

        if (
          opening?.[1]![0] === fence.mark &&
          opening[1].length >= fence.length &&
          !rest.slice(opening[0].length).trim()
        )
          fence = undefined;

        continue;
      }

      if (opening) {
        fence = { mark: opening[1]![0]!, length: opening[1]!.length, depth };
        prose.push(undefined);

        continue;
      }
    }

    // a code span or a tag can quote a comment delimiter, so only a comment segment opens one
    let visible = '';

    for (const part of segments(text)) {
      if (!part.html || !part.raw.startsWith('<!--')) visible += part.raw;
      else {
        visible += ' '.repeat(part.raw.length);

        if (!part.raw.endsWith('-->')) comment = true;
      }
    }

    prose.push(visible.trim() ? visible : undefined);
  }

  return prose;
}

interface Segment {
  code: boolean;
  /** a code span's content, or the text between spans. */
  text: string;
  /** the segment as written, ticks included. */
  raw: string;
  /** an HTML comment or tag, whose backticks open no code span. */
  html?: true;
}

/** splits a line into code spans and the text between them, by CommonMark's equal-length backtick runs. */
function segments(line: string): Segment[] {
  const parts: Segment[] = [];
  let text = '';
  let index = 0;

  const flush = () => {
    if (text) parts.push({ code: false, text, raw: text });

    text = '';
  };

  const html =
    /<!--.*?(?:-->|$)|<\/?[a-z][a-z0-9-]*(?:\s+[a-z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/iy;

  while (index < line.length) {
    // an HTML comment or tag that starts first keeps its backticks
    html.lastIndex = index;
    const raw = line[index] === '<' ? html.exec(line) : null;

    if (raw) {
      flush();
      parts.push({ code: false, text: raw[0], raw: raw[0], html: true });
      index += raw[0].length;

      continue;
    }

    if (line[index] !== '`' || escaped(line, index)) {
      text += line[index++];

      continue;
    }

    let run = 0;

    while (line[index + run] === '`') run++;

    let close = index + run;
    let found = -1;

    while (close < line.length) {
      if (line[close] !== '`') {
        close++;

        continue;
      }

      let length = 0;

      while (line[close + length] === '`') length++;

      if (length === run) {
        found = close;

        break;
      }

      close += length;
    }

    if (found === -1) {
      text += line.slice(index, index + run);
      index += run;

      continue;
    }

    flush();
    const inner = line.slice(index + run, found);

    parts.push({
      code: true,
      text:
        inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ')
          ? inner.slice(1, -1)
          : inner,
      raw: line.slice(index, found + run),
    });

    index = found + run;
  }

  flush();

  return parts;
}

/** whether an odd run of backslashes escapes the character at `index`. */
function escaped(line: string, index: number): boolean {
  let at = index;

  while (line[at - 1] === '\\') at--;

  return (index - at) % 2 === 1;
}

interface Link {
  /** the link text as written, code ticks included. */
  text: string;
  target: string;
  anchor?: string;
}

/** inline links in prose outside code spans; a link's text may hold a code span. */
function links(parts: readonly Segment[]): Link[] {
  // code spans and HTML tags are masked so brackets in them start no link, and offsets still map onto the line
  const masked = parts
    .map((part) =>
      part.code || part.html ? part.raw.replace(/[^`]/g, 'x') : part.raw,
    )
    .join('');

  const raw = parts.map((part) => part.raw).join('');
  const found: Link[] = [];

  for (const match of masked.matchAll(
    /\[([^\]]*)\]\(\s*<?((?:[^()\s>]|\([^()\s]*\))*)>?(?:\s+"[^"]*")?\s*\)/dg,
  )) {
    if (escaped(masked, match.index)) continue;

    const start = match.index + 1;
    // masking hides an angle-bracketed destination, which reads as a tag, so it comes from the line
    const [from, to] = match.indices![2]!;

    const whole = decodeHTMLStrict(
      raw.slice(from, to).replace(/^<(.*)>$/, '$1'),
    );

    const hash = whole.indexOf('#');

    found.push({
      text: raw.slice(start, start + match[1]!.length),
      target: hash === -1 ? whole : whole.slice(0, hash),
      ...(hash === -1 ? {} : { anchor: decode(whole.slice(hash + 1)) }),
    });
  }

  return found;
}

/** a link's file, or undefined when it isn't one this check reads: another site, another repository, or another scheme. */
function resolveLink(
  target: string,
  from: string,
  repository: Repository,
): { path: string } | { revision: string; path: string } | undefined {
  const blob =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/([^?#]+)/.exec(
      target,
    );

  if (blob)
    return repository.slug?.toLowerCase() ===
      `${blob[1]}/${blob[2]}`.toLowerCase()
      ? { revision: blob[3]!, path: decode(blob[4]!) }
      : undefined;

  if (/^[a-z][\w+.-]*:|^\/\//i.test(target)) return;

  const path = decode(target.replace(/\?.*$/, ''));

  if (!path) return { path: from };

  return {
    path: path.startsWith('/')
      ? join(repository.root, path)
      : resolve(dirname(from), path),
  };
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** a link text that is exactly one quoted identifier. */
function quoted(text: string): string | undefined {
  const name = /^`([^`]+)`$/.exec(text)?.[1];

  return name && identifier.test(name) ? name : undefined;
}

/** the identifier quoted just before a citation, as `` `name` at `path:12` ``, `` `name` in `path:12` `` or `` `name` (`path:12`) ``. */
function citedName(
  parts: readonly Segment[],
  position: number,
): string | undefined {
  const between = parts[position - 1];
  const name = parts[position - 2];

  if (!between || between.code || !name?.code) return;

  if (!/^\s+(?:at|in)\s+$|^\s+\($/.test(between.text)) return;

  return identifier.test(name.text) ? name.text : undefined;
}

function checkIdentifier(
  name: string,
  shown: string,
  text: string,
  start: number,
  end: number,
  fail: Fail,
  line: number,
): void {
  const word = name.replace(/\(\)$/, '').split('.').pop()!;

  const cited = text
    .split('\n')
    .slice(start - 1, end)
    .join('\n');

  if (
    !new RegExp(`(?<![\\w$])${word.replace(/\$/g, '\\$')}(?![\\w$])`).test(
      cited,
    )
  )
    fail(line, `\`${name}\` does not appear at ${shown}:${span(start, end)}`);
}

function span(start: number, end: number): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

/** false when the range is reversed, starts before line 1 or runs past the file's end, so nothing else about it can be checked. */
function checkRange(
  shown: string,
  text: string,
  start: number,
  end: number,
  fail: Fail,
  line: number,
): boolean {
  const count = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

  if (start < 1 || end < start) {
    fail(line, `${shown}:${span(start, end)} is not a line range`);

    return false;
  }

  if (end > count) {
    fail(
      line,
      `${shown}:${span(start, end)} is past the end of ${shown} (${count} lines)`,
    );

    return false;
  }

  if (start === end || !scripts.has(extname(shown))) return true;

  const open = openBlock(text, start, end);

  if (open !== undefined)
    fail(
      line,
      open === 'never'
        ? `range ends at line ${end}, but a block it opens never closes`
        : `range ends at line ${end}, but a block it opens closes at line ${open}`,
    );

  return true;
}

/**
 * where a block the range opens closes, when the range ends inside it. lexing starts at line 1 so string, comment and
 * regex state carries into the range; depth counts from the range's first line, ignoring closers of earlier blocks.
 */
function openBlock(
  text: string,
  start: number,
  end: number,
): number | 'never' | undefined {
  let depth = 0;
  let line = 1;
  let state: 'code' | 'line' | 'block' | 'regex' | "'" | '"' | '`' = 'code';
  let klass = false;
  // the last significant character and word in code, which decide whether a `/` starts a regex
  let previous = '';
  let word = '';
  let gap = false;

  const settled = () =>
    line < end ? false : depth === 0 ? (line === end ? 'ok' : line) : false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    const next = text[index + 1];

    if (char === '\n') {
      const done = settled();

      if (done === 'ok') return;

      if (done) return done;

      if (state !== 'block' && state !== '`') state = 'code';

      klass = false;
      gap = true;
      line++;

      continue;
    }

    if (state === 'line') continue;

    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code';
        index++;
      }

      continue;
    }

    if (state === 'regex') {
      if (char === '\\') index++;
      else if (char === '[') klass = true;
      else if (char === ']') klass = false;
      else if (char === '/' && !klass) {
        state = 'code';
        previous = 'x';
      }

      continue;
    }

    if (state !== 'code') {
      if (char === '\\') index++;
      else if (char === state) {
        state = 'code';
        previous = 'x';
      }

      continue;
    }

    if (char === '/' && next === '/') {
      state = 'line';

      continue;
    }

    if (char === '/' && next === '*') {
      state = 'block';
      index++;

      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      state = char;

      continue;
    }

    if (
      char === '/' &&
      next !== '>' &&
      previous !== '<' &&
      (previous === '' ||
        '(,=:[!&|?{};'.includes(previous) ||
        (previous === '>' && text[before(text, index) - 1] === '=') ||
        word === 'return')
    ) {
      state = 'regex';
      klass = false;

      continue;
    }

    if (/\s/.test(char)) {
      gap = true;

      continue;
    }

    word = /[\w$]/.test(char)
      ? !gap && /[\w$]/.test(previous)
        ? word + char
        : char
      : '';

    gap = false;
    previous = char;

    if (line < start) continue;

    if (char === '{' || char === '(' || char === '[') depth++;
    else if ((char === '}' || char === ')' || char === ']') && depth > 0)
      depth--;
  }

  const done = settled();

  if (done === 'ok') return;

  return done || 'never';
}

/** the index of the last non-space character before `index`. */
function before(text: string, index: number): number {
  let at = index - 1;

  while (at >= 0 && /\s/.test(text[at]!)) at--;

  return at;
}

/** GitHub's heading anchors, plus HTML id and name attributes, from a markdown file's prose. */
function anchors(text: string): Set<string> {
  const prose = proseLines(text.split('\n'));
  const headings = new Set<string>();
  const ids = new Set<string>();
  const counts = new Map<string, number>();

  // github-slugger numbers a repeat past every anchor already taken, including a heading that reads like a numbered one
  const add = (heading: string) => {
    const base = slug(heading);
    let anchor = base;

    while (headings.has(anchor)) {
      const seen = (counts.get(base) ?? 0) + 1;
      counts.set(base, seen);
      anchor = `${base}-${seen}`;
    }

    headings.add(anchor);
  };

  for (const [index, line] of prose.entries()) {
    if (line === undefined) continue;

    const atx = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);

    if (atx) add(atx[1]!);

    const above = prose[index - 1];

    if (
      /^ {0,3}(=+|-+)\s*$/.test(line) &&
      above &&
      !/^ {0,3}(#|[-*+]\s|\d+[.)]\s|>)/.test(above)
    )
      add(above.trim());

    for (const part of segments(line))
      if (part.html)
        for (const match of part.raw.matchAll(
          /\s(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
        ))
          ids.add(decodeHTMLStrict(match[1] ?? match[2] ?? match[3]!));
  }

  return new Set([...headings, ...ids]);
}

/** GitHub's slug of a heading's rendered text, where a code span's markdown syntax and character references stay as text. */
function slug(heading: string): string {
  const code: string[] = [];

  return segments(heading)
    .map((part) =>
      part.code ? `\uE000${code.push(part.text) - 1}\uE001` : part.raw,
    )
    .join('')
    .trim()
    .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\*/g, '')
    .replace(
      /(?<![\p{L}\p{N}_])(_+)(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_])/gu,
      '$2',
    )
    .replace(/&[#\w]+;/g, (reference) => decodeHTMLStrict(reference))
    .replace(/\uE000(\d+)\uE001/g, (_, index: string) => code[Number(index)]!)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s/g, '-');
}

/** the prose a writing rule reads: no code spans, HTML tags, link targets, bare URLs or autolinks. */
function writable(parts: readonly Segment[]): string {
  return parts
    .map((part) => (part.code || part.html ? ' ' : part.text))
    .join('')
    .replace(/<[a-z][\w+.-]*:[^>\s]*>/gi, ' ')
    .replace(/\]\((?:[^()]|\([^()]*\))*\)/g, ']')
    .replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, ' ');
}

function checkWriting(text: string, fail: Fail, line: number): void {
  if (text.includes('—')) fail(line, 'em dash in prose');

  for (const match of text.matchAll(/(?<![\w-])(PRs?|CI|AI)(?![\w-])/g))
    fail(line, `uppercase ${match[1]} in prose`);

  const lower = text.replace(/’/g, "'").toLowerCase();

  for (const phrase of banned)
    if (new RegExp(`(?<![\\w'])${phrase}(?![\\w'])`).test(lower))
      fail(line, `banned phrase "${phrase}"`);
}

interface Repository {
  root: string;
  /** `owner/name` of a GitHub `origin`. */
  slug?: string;
}

export async function repositoryOf(cwd: string): Promise<Repository> {
  const git = (...args: string[]) =>
    execute('git', ['-C', cwd, ...args]).then(
      ({ stdout }) => stdout.trim(),
      (error: { stderr?: unknown }) => {
        // with no repository, root-relative links resolve from cwd; with no origin, blob links go unchecked
        if (/not a git repository|No such remote/.test(String(error.stderr)))
          return undefined;

        throw error;
      },
    );

  const [root, origin] = await Promise.all([
    git('rev-parse', '--show-toplevel'),
    git('remote', 'get-url', 'origin'),
  ]);

  const match =
    origin && /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(origin);

  return {
    root: root ?? cwd,
    ...(match ? { slug: `${match[1]}/${match[2]}` } : {}),
  };
}

/** a file at a revision; `missing` when the revision lacks the path, undefined when the revision can't be read. */
async function show(
  cwd: string,
  revision: string,
  path: string,
): Promise<{ text: string } | { missing: true } | undefined> {
  try {
    const { stdout } = await execute(
      'git',
      ['-C', cwd, 'show', '--end-of-options', `${revision}:${path}`],
      { maxBuffer: 64 * 1024 * 1024 },
    );

    return { text: stdout };
  } catch (error) {
    return /does not exist in|exists on disk, but not in/.test(
      String((error as { stderr?: unknown }).stderr ?? ''),
    )
      ? { missing: true }
      : undefined;
  }
}

/** undefined for a missing path or a directory; other read failures throw, so no check passes unread. */
async function readText(path: string): Promise<string | undefined> {
  if (!(await unlessGone(stat(path)))?.isFile()) return;

  return unlessGone(readFile(path, 'utf8'));
}

async function isDirectory(path: string): Promise<boolean> {
  return (await unlessGone(stat(path)))?.isDirectory() ?? false;
}
