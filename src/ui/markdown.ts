import { Marked, Renderer } from 'marked';
import type { Token } from 'marked';
import { Chalk } from 'chalk';
import stripAnsi from 'strip-ansi';
import { markdownLink, linkify } from './links.js';

export const colors = new Chalk({ level: 1 });

export function markdown(text: string, cwd: string): string {
  const renderer = new Renderer();
  renderer.text = (token) =>
    'tokens' in token && token.tokens
      ? renderer.parser.parseInline(token.tokens)
      : linkify(token.text, cwd);
  renderer.paragraph = ({ tokens }) =>
    `${renderer.parser.parseInline(tokens)}\n\n`;
  renderer.heading = ({ tokens }) =>
    `${colors.bold(renderer.parser.parseInline(tokens))}\n\n`;
  renderer.strong = ({ tokens }) =>
    colors.bold(renderer.parser.parseInline(tokens));
  renderer.em = ({ tokens }) =>
    colors.italic(renderer.parser.parseInline(tokens));
  renderer.del = ({ tokens }) =>
    colors.strikethrough(renderer.parser.parseInline(tokens));
  renderer.codespan = ({ text }) =>
    colors.cyan(linkify(`\`${text}\``, cwd).slice(1, -1));
  renderer.code = ({ text }) => `${linkify(text, cwd)}\n\n`;
  renderer.link = ({ href, tokens }) =>
    markdownLink(stripAnsi(renderer.parser.parseInline(tokens)), href, cwd);
  renderer.image = ({ href, text }) =>
    markdownLink(`[${text || 'Image'}]`, href, cwd);
  renderer.br = () => '\n';
  renderer.hr = () => '────────\n';
  renderer.html = ({ text }) => linkify(text, cwd);
  renderer.blockquote = ({ tokens }) =>
    `${renderer.parser
      .parse(tokens)
      .trimEnd()
      .split('\n')
      .map((line) => `│ ${line}`)
      .join('\n')}\n\n`;
  /** each block of an item on its own line, with a checkbox kept on the line it marks. */
  const item = (tokens: Token[]) => {
    const blocks: string[] = [];
    let checkbox = '';
    for (const token of tokens) {
      if (token.type === 'space') continue;
      if (token.type === 'checkbox') {
        checkbox = token.checked ? '[x] ' : '[ ] ';
        continue;
      }
      blocks.push(checkbox + renderer.parser.parse([token]).trim());
      checkbox = '';
    }
    if (checkbox) blocks.push(checkbox.trimEnd());
    return blocks.join('\n');
  };
  renderer.list = ({ items, ordered, start }) =>
    `${items
      .map((entry, index) => {
        const bullet = ordered ? `${Number(start) + index}.` : '•';
        return `${bullet} ${item(entry.tokens).replaceAll('\n', `\n${' '.repeat(bullet.length + 1)}`)}`;
      })
      .join('\n')}\n\n`;
  renderer.table = ({ header, rows }) =>
    `${[header, ...rows].map((row) => row.map((cell) => renderer.parser.parseInline(cell.tokens)).join(' │ ')).join('\n')}\n\n`;
  return new Marked({ gfm: true })
    .parse(text, { renderer, async: false })
    .trimEnd();
}
