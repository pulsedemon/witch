import { basename, extname } from 'node:path';
import { all, createLowlight } from 'lowlight';
import { syntax, storage } from './theme.js';

const lowlight = createLowlight(all);
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

/** `line` in its colored runs, plain when highlight.js gives up on it or, in a grammar without the `u` flag, ends a run inside an emoji. */
function spansOf(line: string, language: string): Span[] {
  let tree: Root;
  try {
    tree = lowlight.highlight(language, line);
  } catch {
    return [{ text: line }];
  }
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
  walk(tree.children);
  return spans.every(({ text }) => text.isWellFormed())
    ? spans
    : [{ text: line }];
}

/**
 * a hunk's `lines`, each read alone as Claude Code reads them, in their colored runs. past its budget, a line over 256
 * characters draws plain: it costs its length squared, as highlight.js can take quadratic time on it. unlike Claude
 * Code, the indent counts, since Witch doesn't cut long lines and grammars such as Nix's are quadratic in the indent.
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
