import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { tokenize } from '@alcalzone/ansi-tokenize';
import ansiEscapes from 'ansi-escapes';
import LinkifyIt from 'linkify-it';

const urls = new LinkifyIt();
// the tokenizer passes a lone escape or control byte through as text, where it can rejoin the bytes around a dropped sequence into a new one
const controls = /(?![\n\t\r])\p{Cc}/u;
// a bare name starts only at the start of a run of name characters, which keeps long runs of dashes or dots linear
const files =
  /(?<![\w/])(?:["'`]((?:\.{0,2}\/|~\/|[\w@.-]+\/)[^\n"'`]+)["'`]|(?:\.{1,2}\/|~\/|\/[\w.@-]+\/)[^\s<>"'`[\]():]+(?::\d+(?::\d+)?)?)|(?<![\w/@.-])(?:[\w@.-]+\/)*\.?[\w@-]+(?:\.[\w@-]+)*\.[a-zA-Z][a-zA-Z\d]{0,12}(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?/gu;
// a name with no directory links only with one of these extensions, so `e.g.` and `foo.bar` stay text
const sourceFile =
  /\.(?:[cm]?[jt]sx?|py|sh|md|rs|go|rb|pl|cc|c|h|java|cs|swift|txt|json|toml|ya?ml|csv|xml|ini|env|lock|html|css|sql|log)(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?$/i;

export function linkTarget(target: string, cwd: string): string {
  if (/^https?:\/\//i.test(target)) return target;
  if (target.startsWith('vscode://file/')) return target;
  if (target.startsWith('file://'))
    target = decodeURIComponent(new URL(target).pathname);
  // Codex writes a location as `#L12C4` as well as `:12:4`
  const location =
    /:(\d+)(?::(\d+))?$/.exec(target) ?? /#L(\d+)(?:C(\d+))?$/.exec(target);
  const file = location ? target.slice(0, location.index) : target;
  const path = file.startsWith('~/')
    ? resolve(homedir(), file.slice(2))
    : resolve(cwd, file);
  const suffix = location
    ? `:${location[1]}${location[2] ? `:${location[2]}` : ''}`
    : '';
  return `vscode://file${path.split('/').map(encodeURIComponent).join('/')}${suffix}`;
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
  return ansiEscapes.link(text, url);
}

function fileLinks(text: string, cwd: string): string {
  return text.replace(files, (match: string, quoted: string | undefined) => {
    if (quoted) return match[0] + hyperlink(quoted, quoted, cwd) + match.at(-1);
    const path = match.replace(/[.,;!?]+$/, '');
    if (!path.includes('/') && !sourceFile.test(path)) return match;
    return hyperlink(path, path, cwd) + match.slice(path.length);
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

function bareLinks(text: string, cwd: string): string {
  let output = '';
  let offset = 0;
  const sourceFiles = [...text.matchAll(files)].filter(
    (match) =>
      !!match[1] || match[0].includes('/') || sourceFile.test(match[0]),
  );
  let fileIndex = 0;
  for (const match of urls.match(text) ?? []) {
    if (match.index < offset) continue;
    while (
      sourceFiles[fileIndex] &&
      sourceFiles[fileIndex]!.index + sourceFiles[fileIndex]![0].length <=
        match.index
    )
      fileIndex++;
    const source = sourceFiles[fileIndex];
    if (
      !/^(?:https?:\/\/|www\.)/i.test(match.text) &&
      source &&
      source.index < match.lastIndex
    ) {
      output +=
        fileLinks(text.slice(offset, source.index), cwd) +
        fileLinks(source[0], cwd);
      offset = source.index + source[0].length;
      continue;
    }
    output += fileLinks(text.slice(offset, match.index), cwd);
    output += hyperlink(match.text, match.url, cwd);
    offset = match.lastIndex;
  }
  return output + fileLinks(text.slice(offset), cwd);
}

/**
 * linkify-it rescans the rest of its input after every match, so it gets 2000 characters at most, cut after a newline, which ends every link,
 * else after whitespace, `<` or `>`, which end a URL, else after the `"` that separates minified JSON values. A run with none of them is cut where it reaches the limit.
 */
function pieces(text: string): string[] {
  const result: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 2000, text.length);
    const after = (separator: RegExp) => {
      let cut = end;
      while (cut > start && !separator.test(text[cut - 1]!)) cut--;
      return cut;
    };
    if (end < text.length)
      end = [/\n/, /[\s<>]/, /"/].map(after).find((cut) => cut > start) ?? end;
    result.push(text.slice(start, end));
    start = end;
  }
  return result;
}

export function linkify(text: string, cwd: string): string {
  let output = '';
  let buffer = '';
  let target: string | undefined;
  const flush = () => {
    output += target
      ? hyperlink(buffer, target, cwd)
      : pieces(buffer)
          .map((piece) => bareLinks(piece, cwd))
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
  return output;
}

/** agent-written text with no escapes or links. strip-ansi can't stand in, since removing one sequence can join its neighbours into another. */
export function plain(text: string): string {
  return tokenize(text)
    .map((token) =>
      token.type === 'char' && !controls.test(token.value) ? token.value : '',
    )
    .join('');
}
