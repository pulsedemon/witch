import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { tokenize } from '@alcalzone/ansi-tokenize';
import ansiEscapes from 'ansi-escapes';
import LinkifyIt from 'linkify-it';

const urls = new LinkifyIt();
// a bare name starts only at the start of a run of name characters, which keeps long runs of dashes or dots linear
const files =
  /(?<![\w/])(?:["'`]((?:\.{0,2}\/|~\/|[\w@.-]+\/)[^\n"'`]+)["'`]|(?:\.{1,2}\/|~\/|\/[\w.@-]+\/)[^\s<>"'`[\]()]+)|(?<![\w/@.-])(?:[\w@.-]+\/)*\.?[\w@-]+(?:\.[\w@-]+)*\.[a-zA-Z][a-zA-Z\d]{0,12}(?::\d+(?::\d+)?)?/gu;

export function linkTarget(target: string, cwd: string): string {
  if (/^https?:\/\//i.test(target)) return target;
  if (target.startsWith('vscode://file/')) return target;
  if (target.startsWith('file://'))
    target = decodeURIComponent(new URL(target).pathname);
  const location = /:(\d+)(?::(\d+))?$/.exec(target);
  const file = location ? target.slice(0, location.index) : target;
  const path = file.startsWith('~/')
    ? resolve(homedir(), file.slice(2))
    : resolve(cwd, file);
  return `vscode://file${path.split('/').map(encodeURIComponent).join('/')}${location?.[0] ?? ''}`;
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
  if (
    [...url].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return text;
  return ansiEscapes.link(text, url);
}

function fileLinks(text: string, cwd: string): string {
  return text.replace(files, (match: string, quoted: string | undefined) => {
    if (quoted) return match[0] + hyperlink(quoted, quoted, cwd) + match.at(-1);
    const path = match.replace(/[.,;!?]+$/, '');
    return hyperlink(path, path, cwd) + match.slice(path.length);
  });
}

export function markdownLink(
  text: string,
  target: string,
  cwd: string,
): string {
  if (!/^[a-z][a-z\d+.-]*:/i.test(target)) {
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
      !!match[1] ||
      match[0].includes('/') ||
      /\.(?:[cm]?[jt]sx?|py|sh|md|rs|go|rb|pl|cc|c|h|java|cs|swift|txt|json|toml|ya?ml|csv|xml|ini|env|lock|html|css|sql|log)(?::\d+(?::\d+)?)?$/i.test(
        match[0],
      ),
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

export function linkify(text: string, cwd: string): string {
  let output = '';
  let buffer = '';
  let target: string | undefined;
  const flush = () => {
    // linkify-it rescans the rest of its input after every match, and no link spans a newline
    output += target
      ? hyperlink(buffer, target, cwd)
      : buffer
          .split('\n')
          .map((line) => bareLinks(line, cwd))
          .join('\n');
    buffer = '';
  };
  for (const token of tokenize(text)) {
    if (token.type === 'ansi' && token.code.startsWith('\u001b]8;')) {
      flush();
      const separator = token.code.indexOf(';', 4);
      const terminator = token.code.endsWith('\u001b\\') ? 2 : 1;
      target = token.code.slice(separator + 1, -terminator) || undefined;
    } else if (token.type === 'char') buffer += token.value;
    else if (token.type === 'control' && /^(\n|\t|\r)$/.test(token.code))
      buffer += token.code;
  }
  flush();
  return output;
}
