import wrapAnsi from 'wrap-ansi';
import stripAnsi from 'strip-ansi';
import type { DisplayItem } from '../core/state.js';
import { colors, markdown } from './markdown.js';
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

/** the tail of a body that can grow, unless an earlier link would carry into it. */
function tailOf(
  item: DisplayItem,
  anchors: Anchor[],
  bodyRow: number,
): Block['tail'] {
  const start = item.text.lastIndexOf('\n') + 1;
  if (linkOpen(item.text.slice(0, start))) return undefined;
  const line = anchors.at(-2)!.line;
  const row = anchors.findIndex(
    (anchor, index) => index >= bodyRow && anchor.line === line,
  );
  return { row, line, start };
}

function build(item: DisplayItem, width: number, expanded: boolean): Block {
  const tool = item.kind === 'tool';
  const title =
    item.kind === 'user'
      ? colors.cyan('You')
      : item.kind === 'assistant'
        ? colors.green(item.title ?? 'Assistant')
        : tool
          ? colors.yellow(
              `${expanded ? '−' : '+'} ${item.done ? '✓' : '…'} ${linkify(item.title ?? 'Tool', item.cwd)}`,
            )
          : colors.dim('Notice');
  const body =
    tool && !expanded
      ? ''
      : tool
        ? linkify(item.text, item.cwd)
        : markdown(item.text, item.cwd);
  const head = section(title, width, true, 0);
  // concat, since spreading a long log into push() exceeds the argument limit
  const rendered = body ? section(body, width, false, head.next) : undefined;
  const lines = head.lines.concat(rendered?.lines ?? [], '');
  const anchors = head.anchors.concat(rendered?.anchors ?? [], {
    line: rendered?.next ?? head.next,
    offset: 0,
  });
  return {
    item,
    lines,
    anchors,
    tail: tool && body ? tailOf(item, anchors, head.lines.length) : undefined,
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

export class TranscriptLayout {
  /** blocks by item id, then by width and expanded state. */
  private cache = new Map<string, Map<string, Block>>();

  render(
    items: readonly DisplayItem[],
    width: number,
    expanded: ReadonlySet<string>,
  ) {
    const lines: string[] = [];
    const blocks: string[][] = [];
    const starts = new Map<string, number>();
    const rendered = new Map<string, Block>();
    // entries for items no longer shown fall away with the old cache
    const cache = new Map<string, Map<string, Block>>();
    for (const item of items) {
      const open = expanded.has(item.id);
      const key = `${width}/${open}`;
      const variants = new Map(this.cache.get(item.id));
      const previous = variants.get(key);
      const block =
        previous?.item === item
          ? previous
          : ((previous && extend(previous, item, width)) ??
            build(item, width, open));
      variants.set(key, block);
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
