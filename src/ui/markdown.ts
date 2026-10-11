import { Marked, Renderer } from 'marked';
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
  renderer.list = ({ items, ordered, start }) =>
    `${items.map((item, index) => `${ordered ? `${Number(start) + index}.` : '•'} ${renderer.parser.parse(item.tokens).trim()}`).join('\n')}\n\n`;
  renderer.listitem = ({ tokens }) => renderer.parser.parse(tokens);
  renderer.checkbox = ({ checked }) => (checked ? '[x] ' : '[ ] ');
  renderer.table = ({ header, rows }) =>
    `${[header, ...rows].map((row) => row.map((cell) => renderer.parser.parseInline(cell.tokens)).join(' │ ')).join('\n')}\n\n`;
  return new Marked({ gfm: true })
    .parse(text, { renderer, async: false })
    .trimEnd();
}
