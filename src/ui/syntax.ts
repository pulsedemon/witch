import { basename, extname } from 'node:path';
import { all, createLowlight } from 'lowlight';
import { syntax, storage } from './theme.js';

const lowlight = createLowlight(all);
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// `@types/hast` isn't a direct dependency, and pnpm doesn't hoist it
type Root = ReturnType<typeof lowlight.highlight>;
type Node = Root['children'][number];

export interface Span {
  text: string;
  color?: string;
}

/** files Claude Code knows by name, whatever follows a dot. */
const names = new Map([
  ['Dockerfile', 'dockerfile'],
  ['Makefile', 'makefile'],
  ['Rakefile', 'ruby'],
  ['Gemfile', 'ruby'],
  ['CMakeLists', 'cmake'],
]);

/** keywords Claude Code colors as storage, as Monokai does. */
const declarations = new Set([
  'const',
  'let',
  'var',
  'function',
  'class',
  'type',
  'interface',
  'enum',
  'namespace',
  'module',
  'def',
  'fn',
  'func',
  'struct',
  'trait',
  'impl',
]);

/** what a shebang names, in the order Claude Code looks for it, with the language it reads as. */
const interpreters = [
  ['bash', 'bash'],
  ['/sh', 'bash'],
  ['python', 'python'],
  ['node', 'javascript'],
  ['ruby', 'ruby'],
  ['perl', 'perl'],
] as const;

/** the language Claude Code reads a file as: by its name, then its extension, then a shebang or XML or PHP opening. */
export function languageOf(
  path: string,
  first: string | undefined,
): string | undefined {
  const name = basename(path);
  const candidates = [names.get(name.split('.')[0]!), extname(path).slice(1)];
  const line = first?.replace(/^\uFEFF/, '');
  if (line?.startsWith('#!'))
    candidates.push(
      interpreters.find(([interpreter]) => line.includes(interpreter))?.[1],
    );
  else if (line?.startsWith('<?php')) candidates.push('php');
  else if (line?.startsWith('<?xml')) candidates.push('xml');
  return candidates.find(
    (candidate) => candidate && lowlight.registered(candidate),
  );
}

/**
 * `line` in its colored runs, plain when highlight.js fails on it or its runs don't spell the line whole: a grammar
 * without the `u` flag can split an emoji, which then draws as two U+FFFD, or a keycap, whose marks a copy drops, and the
 * CSS ones turn U+2028 into a line break.
 */
function spansOf(line: string, language: string): Span[] {
  const spans: Span[] = [];
  const walk = (nodes: readonly Node[], scope?: string) => {
    for (const node of nodes)
      if (node.type === 'element') {
        const name = node.properties.className;
        walk(
          node.children,
          Array.isArray(name)
            ? String(name[0]).slice('hljs-'.length)
            : undefined,
        );
      } else if (node.type === 'text')
        spans.push({
          text: node.value,
          color:
            scope === 'keyword' && declarations.has(node.value.trim())
              ? storage
              : syntax.get(scope ?? ''),
        });
  };
  try {
    // a deep enough nesting overflows the stack
    walk(lowlight.highlight(language, line).children);
  } catch {
    return [{ text: line }];
  }
  const starts = new Set(
    Array.from(graphemes.segment(line), ({ index }) => index),
  );
  let at = 0;
  for (const { text } of spans) {
    if (!starts.has(at) || !line.startsWith(text, at)) return [{ text: line }];
    at += text.length;
  }
  return at === line.length ? spans : [{ text: line }];
}

/**
 * a file's `lines`, each read alone as Claude Code reads them, in their colored runs. past the budget, a line over 256
 * characters draws plain: it costs its length squared, as highlight.js can take quadratic time on it. unlike Claude
 * Code's, the budget spans the file, so many hunks can't add up, and counts the indent, since Witch doesn't cut long
 * lines and grammars such as Nix's are quadratic in it.
 */
export function syntaxSpans(
  lines: readonly string[],
  language: string | undefined,
): Span[][] {
  let spent = 0;
  return lines.map((line) => {
    const cost = line.length > 256 ? line.length ** 2 : 0;
    spent += cost;
    return !language || (cost && spent > 16_000_000)
      ? [{ text: line }]
      : spansOf(line, language);
  });
}
