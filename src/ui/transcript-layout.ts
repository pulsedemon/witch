import wrapAnsi from 'wrap-ansi';
import stripAnsi from 'strip-ansi';
import type { DisplayItem } from '../core/state.js';
import { diffRows } from './diff.js';
import { markdown } from './markdown.js';
import { accent, colors } from './theme.js';
import type { Graphics } from './images.js';
import { imagePaths } from './images.js';
import { linkify, linkifyAppend } from './links.js';
import type { LinkedAppend } from './links.js';

export interface ScrollAnchor {
  item: string;
  line: number;
  offset: number;
}

type Anchor = Omit<ScrollAnchor, 'item'>;
type Expansion = 'closed' | 'preview' | 'full';

interface Block {
  /** the item this block was built from; a block is reused as is only for that object. */
  item: DisplayItem;
  headRows: number;
  lines: string[];
  anchors: Anchor[];
  tail?: { row: number; line: number } & Pick<
    LinkedAppend,
    'pending' | 'target'
  >;
}

/** anchors count source lines so resizing keeps the selected text. */
function section(
  text: readonly string[],
  width: number,
  trim: boolean,
  first: number,
) {
  const lines: string[] = [];
  const anchors: Anchor[] = [];
  let sourceLine = first;
  for (const line of text) {
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

function build(
  item: DisplayItem,
  width: number,
  expansion: Expansion,
  graphics: Graphics | undefined,
): Block {
  const tool = item.kind === 'tool';
  const expanded = expansion !== 'closed';
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
  const linked =
    tool && expanded ? linkifyAppend(item.text, item.cwd) : undefined;
  const body = tool ? '' : markdown(item.text, item.cwd);
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
      ? diffRows(item.diff, width, item.cwd, expansion === 'full')
      : [];
  const head = section(title.split('\n'), width, true, 0);
  const complete = section(linked?.complete ?? [], width, false, head.next);
  const hasBody = linked ? linked.complete.length > 0 || !!linked.tail : !!body;
  const rendered = section(
    hasBody ? (linked?.tail ?? body).split('\n') : [],
    width,
    false,
    complete.next,
  );
  const next = rendered.next;
  // concat, since spreading a long log into push() exceeds the argument limit
  const lines = head.lines.concat(
    complete.lines,
    rendered.lines,
    diff.flat(),
    images.flat(),
    '',
  );
  const anchors = head.anchors.concat(
    complete.anchors,
    rendered.anchors,
    // row offsets preserve each diff line or image across resizes and separate copied diff rows
    diff
      .concat(images)
      .flatMap((rows, index) =>
        rows.map((_, row) => ({ line: next + index, offset: row })),
      ),
    { line: next + diff.length + images.length, offset: 0 },
  );
  return {
    item,
    headRows: head.lines.length,
    lines,
    anchors,
    // output grows above the diff and images, so a block with either is rebuilt whole
    tail:
      linked && !diff.length && !images.length
        ? {
            row: head.lines.length + complete.lines.length,
            line: complete.next,
            pending: linked.pending,
            target: linked.target,
          }
        : undefined,
  };
}

function extend(
  block: Block,
  item: DisplayItem,
  width: number,
): Block | undefined {
  const previous = block.item;
  const tail = block.tail;
  if (
    !tail ||
    item.kind !== 'tool' ||
    item.title !== previous.title ||
    item.done !== previous.done ||
    item.cwd !== previous.cwd ||
    item.diff !== previous.diff ||
    item.images !== previous.images ||
    !item.text.startsWith(previous.text)
  )
    return undefined;
  const linked = linkifyAppend(
    tail.pending + item.text.slice(previous.text.length),
    item.cwd,
    tail.target,
  );
  const complete = section(linked.complete, width, false, tail.line);
  const hasBody =
    tail.row > block.headRows || linked.complete.length > 0 || !!linked.tail;
  const rendered = section(
    hasBody ? linked.tail.split('\n') : [],
    width,
    false,
    complete.next,
  );
  return {
    item,
    headRows: block.headRows,
    lines: block.lines
      .slice(0, tail.row)
      .concat(complete.lines, rendered.lines, ''),
    anchors: block.anchors
      .slice(0, tail.row)
      .concat(complete.anchors, rendered.anchors, {
        line: rendered.next,
        offset: 0,
      }),
    tail: {
      row: tail.row + complete.lines.length,
      line: complete.next,
      pending: linked.pending,
      target: linked.target,
    },
  };
}

/** a later diff must not reverse the user's explicit open or closed choice. */
export function isExpanded(
  item: DisplayItem,
  choices: ReadonlyMap<string, boolean>,
): boolean {
  // only `/` already ends in a separator
  const root = item.cwd.endsWith('/') ? item.cwd : `${item.cwd}/`;
  const inside = (path: string | undefined) =>
    path === item.cwd || !!path?.startsWith(root);
  return (
    choices.get(item.id) ??
    (!!item.shell ||
      !!item.diff?.some((file) => inside(file.path) || inside(file.movePath)))
  );
}

export class TranscriptLayout {
  /** blocks by item id, then by expanded state, all at `width`. */
  private cache = new Map<string, Map<Expansion, Block>>();
  private width = 0;

  /** without `graphics`, images stay out of the transcript. */
  constructor(private readonly graphics?: Graphics) {}

  render(
    items: readonly DisplayItem[],
    width: number,
    expanded: ReadonlyMap<string, boolean>,
    full?: ReadonlySet<string>,
  ) {
    if (width !== this.width) this.cache = new Map();
    this.width = width;
    const lines: string[] = [];
    const blocks: string[][] = [];
    const starts = new Map<string, number>();
    const rendered = new Map<string, Block>();
    // entries for items no longer shown fall away with the old cache
    const cache = new Map<string, Map<Expansion, Block>>();
    for (const item of items) {
      const expansion = !isExpanded(item, expanded)
        ? 'closed'
        : full?.has(item.id)
          ? 'full'
          : 'preview';
      const variants = this.cache.get(item.id) ?? new Map<Expansion, Block>();
      const previous = variants.get(expansion);
      const block =
        previous?.item === item
          ? previous
          : ((previous && extend(previous, item, width)) ??
            build(item, width, expansion, this.graphics));
      variants.set(expansion, block);
      cache.set(item.id, variants);
      starts.set(item.id, lines.length);
      for (const line of block.lines) lines.push(line);
      blocks.push(block.lines);
      rendered.set(item.id, block);
    }
    this.cache = cache;
    const positions = [...starts];
    return {
      lines,
      blocks,
      starts,
      anchorAt(row: number): ScrollAnchor | undefined {
        let low = 0;
        let high = positions.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (positions[middle]![1] <= row) low = middle + 1;
          else high = middle;
        }
        const entry = positions[low - 1];
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
              (row) =>
                row.line === anchor.line &&
                (row.offset === anchor.offset ||
                  (row.offset >= 0 && row.offset < anchor.offset)),
            ) ?? 0;
        return start + Math.max(0, offset);
      },
    };
  }
}
