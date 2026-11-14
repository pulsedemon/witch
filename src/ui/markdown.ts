import { decodeHTMLStrict } from 'entities';
import { Marked, Parser, Renderer } from 'marked';
import type { Token } from 'marked';
import stripAnsi from 'strip-ansi';
import { markdownLink, linkify, plain } from './links.js';
import { accent, colors } from './theme.js';

function terminalRenderer(cwd: string, hrefs: string | null): Renderer {
  const renderer = new Renderer();

  const link = (label: string, href: string) =>
    hrefs === null && !/^(?:[a-z][a-z\d+.-]*:(?!\d)|\/|~\/)/i.test(href)
      ? label
      : markdownLink(label, href, hrefs ?? cwd);

  renderer.text = (token) =>
    'tokens' in token && token.tokens
      ? renderer.parser.parseInline(token.tokens)
      : linkify(decodeHTMLStrict(token.text), cwd);

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

  renderer.codespan = ({ text }) => {
    // the backticks let a path with spaces link whole; a URL can swallow the closing one, so anything else links bare
    const quoted = linkify(`\`${text}\``, cwd);

    return colors.hex(accent)(
      quoted.startsWith('`\u001b]8;') && quoted.endsWith('`')
        ? quoted.slice(1, -1)
        : linkify(text, cwd),
    );
  };

  renderer.code = ({ text }) => `${linkify(text, cwd)}\n\n`;

  renderer.link = ({ href, tokens }) =>
    link(
      stripAnsi(renderer.parser.parseInline(tokens)),
      decodeHTMLStrict(href),
    );

  renderer.image = ({ href, text }) =>
    link(`[${plain(decodeHTMLStrict(text) || 'Image')}]`, href);

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

      const block = renderer.parser.parse([token]);

      // code keeps its leading indentation; other blocks can start with the spaces left by a tab after the bullet
      blocks.push(
        checkbox + (token.type === 'code' ? block.trimEnd() : block.trim()),
      );

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

  return renderer;
}

/** relative link and image targets resolve against `hrefs`, and stay text when it is null. */
export function markdown(
  text: string,
  cwd: string,
  hrefs: string | null = cwd,
): string {
  return new Marked({ gfm: true })
    .parse(text, { renderer: terminalRenderer(cwd, hrefs), async: false })
    .trimEnd();
}

interface MarkdownAppend {
  complete: string[];
  tail: string;
  pending: string;
}

/** undefined requires a full-message render because the suffix can change earlier blocks. */
export function markdownAppend(
  text: string,
  cwd: string,
): MarkdownAppend | undefined {
  const marked = new Marked({ gfm: true });

  const tokens = marked.lexer(text);

  let context = Object.keys(tokens.links).length > 0;

  void marked.walkTokens(tokens, (token) => {
    if (token.type === 'html') context = true;

    // Marked copies accumulated visitor results per token; keep that array empty.
    return [];
  });

  if (context || tokens.map((token) => token.raw).join('') !== text)
    return undefined;

  const parser = new Parser({ renderer: terminalRenderer(cwd, cwd) });

  const rendered = tokens.map((token) => parser.parse([token]));

  // the last block can become empty, so retain its preceding visible block for trimEnd().
  const last = tokens.findLastIndex((token) => token.type !== 'space');

  const retained = Math.max(
    0,
    rendered.findLastIndex(
      (output, index) => index < last && output.trimEnd().length > 0,
    ),
  );

  // a later setext underline can merge several tokens until the preceding blank line.
  const boundary =
    tokens.findLastIndex(
      (token, index) => index < retained && /\n[ \t]*\n[ \t]*$/.test(token.raw),
    ) + 1;

  const complete = rendered.slice(0, boundary).join('');

  const consumed = tokens
    .slice(0, boundary)
    .reduce((length, token) => length + token.raw.length, 0);

  return {
    complete: complete ? complete.slice(0, -1).split('\n') : [],
    tail: rendered.slice(boundary).join('').trimEnd(),
    pending: text.slice(consumed),
  };
}
