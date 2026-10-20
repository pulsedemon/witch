import wrapAnsi from 'wrap-ansi';
import stripAnsi from 'strip-ansi';
import type { DisplayItem } from '../core/state.js';
import { diffRows } from './diff.js';
import { markdown } from './markdown.js';
import { accent, colors } from './theme.js';
import type { Graphics } from './images.js';
import { imagePaths } from './images.js';
import { linkify } from './links.js';

export interface ScrollAnchor {
  item: string;
  line: number;
  offset: number;
}

type Anchor = Omit<ScrollAnchor, 'item'>;

interface Block {
  /** the item this block was built from; a block is reused as is only for that object. */
  item: DisplayItem;
  lines: string[];
  anchors: Anchor[];
  /** where the last body line starts, for an expanded tool whose output can grow. */
  tail?: { row: number; line: number; start: number };
}

/** wraps each source line on its own, as wrap-ansi does, recording where every row starts. */
function section(text: string, width: number, trim: boolean, first: number) {
  const lines: string[] = [];
  const anchors: Anchor[] = [];
  let sourceLine = first;
  for (const line of text.split('\n')) {
    const source = trim
      ? stripAnsi(wrapAnsi(line, Infinity, { trim: false }))
      : undefined;
    let offset = 0;
    for (const row of wrapAnsi(line, width, { hard: true, trim }).split('\n')) {
      const plain = stripAnsi(row);
      if (source !== undefined) offset = source.indexOf(plain, offset);
      lines.push(row);
      anchors.push({ line: sourceLine, offset });
      offset += plain.length;
    }
    sourceLine++;
  }
  return { lines, anchors, next: sourceLine };
}

/** whether an OSC 8 link opened in `text` is still open at its end. */
function linkOpen(text: string): boolean {
  const targets = [
    // eslint-disable-next-line no-control-regex
    ...text.matchAll(/\u001b]8;[^;\u0007\u001b]*;([^\u0007\u001b]*)/g),
  ];
  return !!targets.at(-1)?.[1];
}

/** whether `text` ends inside an OSC string, which the tokenizer drops whole, newlines included. */
function oscOpen(text: string): boolean {
  const open = Math.max(
    text.lastIndexOf('\u001b]'),
    text.lastIndexOf('\u009b]'),
  );
  const close = Math.max(
    text.lastIndexOf('\u0007'),
    text.lastIndexOf('\u009c'),
    text.lastIndexOf('\u001b\\'),
  );
  return open > close;
}

/** the tail of a body that can grow, unless an earlier link or OSC string would carry into it. */
function tailOf(
  item: DisplayItem,
  anchors: Anchor[],
  bodyRow: number,
): Block['tail'] {
  const start = item.text.lastIndexOf('\n') + 1;
  const prefix = item.text.slice(0, start);
  if (linkOpen(prefix) || oscOpen(prefix)) return undefined;
  const line = anchors.at(-2)!.line;
  const row = anchors.findIndex(
    (anchor, index) => index >= bodyRow && anchor.line === line,
  );
  return { row, line, start };
}

function build(
  item: DisplayItem,
  width: number,
  expanded: boolean,
  graphics: Graphics | undefined,
): Block {
  const tool = item.kind === 'tool';
  const title =
    item.kind === 'user'
      ? colors.hex(accent).bold('You')
      : item.kind === 'assistant'
        ? colors.whiteBright.bold(item.title ?? 'Assistant')
        : tool
          ? colors.dim(
              `${expanded ? '−' : '+'} ${item.done ? '✓' : '…'} ${linkify(item.title ?? 'Tool', item.cwd)}`,
            )
          : colors.dim('Notice');
  const body =
    tool && !expanded
      ? ''
      : tool
        ? linkify(item.text, item.cwd)
        : markdown(item.text, item.cwd);
  // a tool's images show with its output; a message shows the images it names
  const sources =
    item.kind === 'user'
      ? imagePaths(item.text)
      : tool && expanded
        ? (item.images ?? [])
        : [];
  const images = graphics
    ? sources
        .map((source) => graphics.rows(source, item.cwd, width))
        .filter((rows) => rows.length)
    : [];
  const diff =
    tool && expanded && item.diff?.length
      ? diffRows(item.diff, width, item.cwd)
      : [];
  const head = section(title, width, true, 0);
  // concat, since spreading a long log into push() exceeds the argument limit
  const rendered = body ? section(body, width, false, head.next) : undefined;
  const next = rendered?.next ?? head.next;
  const lines = head.lines.concat(
    rendered?.lines ?? [],
    diff.flat(),
    images.flat(),
    '',
  );
  const anchors = head.anchors.concat(
    rendered?.anchors ?? [],
    // a diff line's rows count from it, so a resize keeps the line, and copying breaks between them
    diff.flatMap((rows, index) =>
      rows.map((_, row) => ({ line: next + index, offset: row })),
    ),
    // keep each image's anchors together when a resize changes its row count
    images.flatMap((rows, index) =>
      rows.map((_, row) => ({
        line: next + diff.length + index,
        offset: row,
      })),
    ),
    { line: next + diff.length + images.length, offset: 0 },
  );
  return {
    item,
    lines,
    anchors,
    // output grows above the diff and images, so a block with either is rebuilt whole
    tail:
      tool && body && !diff.length && !images.length
        ? tailOf(item, anchors, head.lines.length)
        : undefined,
  };
}

/** re-renders only the last body line onward when a tool's output grew and nothing else changed. */
function extend(
  block: Block,
  item: DisplayItem,
  width: number,
): Block | undefined {
  const previous = block.item;
  if (
    !block.tail ||
    item.kind !== 'tool' ||
    item.title !== previous.title ||
    item.done !== previous.done ||
    item.cwd !== previous.cwd ||
    item.diff !== previous.diff ||
    !item.text.startsWith(previous.text)
  )
    return undefined;
  const rendered = section(
    linkify(item.text.slice(block.tail.start), item.cwd),
    width,
    false,
    block.tail.line,
  );
  const lines = [
    ...block.lines.slice(0, block.tail.row),
    ...rendered.lines,
    '',
  ];
  const anchors = [
    ...block.anchors.slice(0, block.tail.row),
    ...rendered.anchors,
    { line: rendered.next, offset: 0 },
  ];
  return {
    item,
    lines,
    anchors,
    tail: tailOf(item, anchors, block.tail.row),
  };
}

/** a `!` command, or a change to a file under the row's cwd, shows expanded until toggled. */
function opens(item: DisplayItem): boolean {
  // only `/` already ends in a separator
  const root = item.cwd.endsWith('/') ? item.cwd : `${item.cwd}/`;
  const inside = (path: string | undefined) =>
    path === item.cwd || !!path?.startsWith(root);
  return (
    !!item.shell ||
    !!item.diff?.some((file) => inside(file.path) || inside(file.movePath))
  );
}

export class TranscriptLayout {
  /** blocks by item id, then by expanded state, all at `width`. */
  private cache = new Map<string, Map<boolean, Block>>();
  private width = 0;

  /** without `graphics`, images stay out of the transcript. */
  constructor(private readonly graphics?: Graphics) {}

  render(
    items: readonly DisplayItem[],
    width: number,
    expanded: ReadonlySet<string>,
  ) {
    if (width !== this.width) this.cache = new Map();
    this.width = width;
    const lines: string[] = [];
    const blocks: string[][] = [];
    const starts = new Map<string, number>();
    const rendered = new Map<string, Block>();
    // entries for items no longer shown fall away with the old cache
    const cache = new Map<string, Map<boolean, Block>>();
    for (const item of items) {
      const open = expanded.has(item.id) !== opens(item);
      const variants = this.cache.get(item.id) ?? new Map<boolean, Block>();
      const previous = variants.get(open);
      const block =
        previous?.item === item
          ? previous
          : ((previous && extend(previous, item, width)) ??
            build(item, width, open, this.graphics));
      variants.set(open, block);
      cache.set(item.id, variants);
      starts.set(item.id, lines.length);
      for (const line of block.lines) lines.push(line);
      blocks.push(block.lines);
      rendered.set(item.id, block);
    }
    this.cache = cache;
    return {
      lines,
      blocks,
      starts,
      anchorAt(row: number): ScrollAnchor | undefined {
        const entry = [...starts].findLast(([, start]) => start <= row);
        if (!entry) return undefined;
        const [item, start] = entry;
        return {
          item,
          ...(rendered.get(item)!.anchors[row - start] ?? {
            line: 0,
            offset: 0,
          }),
        };
      },
      rowOf(anchor: ScrollAnchor): number {
        const start = starts.get(anchor.item) ?? 0;
        const offset =
          rendered
            .get(anchor.item)
            ?.anchors.findLastIndex(
              (row) => row.line === anchor.line && row.offset <= anchor.offset,
            ) ?? 0;
        return start + Math.max(0, offset);
      },
    };
  }
}
