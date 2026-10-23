import wrapAnsi from 'wrap-ansi';
import stripAnsi from 'strip-ansi';
import type { DisplayItem } from '../core/state.js';
import { appendedDisplayText } from '../core/state.js';
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
type TextRows = Pick<readonly string[], 'length' | 'at' | 'slice'>;

interface Row {
  text: string;
  anchor: Anchor;
}

interface Block {
  item: DisplayItem;
  headRows: number;
  complete: Row[];
  lines: TextRows;
  row(index: number): Row | undefined;
  tail?: { line: number } & Pick<LinkedAppend, 'pending' | 'target'>;
}

function textRows(
  length: number,
  read: (index: number) => string | undefined,
): TextRows {
  const relative = (index: number) => {
    const integer = Math.trunc(index) || 0;
    return integer < 0 ? length + integer : integer;
  };
  return {
    length,
    at(index) {
      const row = relative(index);
      return row >= 0 && row < length ? read(row) : undefined;
    },
    slice(start = 0, end = length) {
      const result: string[] = [];
      const last = Math.min(length, Math.max(0, relative(end)));
      for (let row = Math.max(0, relative(start)); row < last; row++)
        result.push(read(row)!);
      return result;
    },
  };
}

/** capture the completed prefix's length so later appends cannot change an earlier frame. */
function block(
  item: DisplayItem,
  headRows: number,
  complete: Row[],
  suffix: Row[],
  tail?: Block['tail'],
): Block {
  const count = complete.length;
  const length = count + suffix.length;
  const row = (index: number) =>
    index < count ? complete[index] : suffix[index - count];
  return {
    item,
    headRows,
    complete,
    row,
    lines: textRows(length, (index) => row(index)?.text),
    tail,
  };
}

/** anchors count source lines so resizing keeps the selected text. */
function section(
  text: readonly string[],
  width: number,
  trim: boolean,
  first: number,
) {
  const rows: Row[] = [];
  let sourceLine = first;
  for (const line of text) {
    const source = trim
      ? stripAnsi(wrapAnsi(line, Infinity, { trim: false }))
      : undefined;
    let offset = 0;
    for (const row of wrapAnsi(line, width, { hard: true, trim }).split('\n')) {
      const plain = stripAnsi(row);
      if (source !== undefined) offset = source.indexOf(plain, offset);
      rows.push({ text: row, anchor: { line: sourceLine, offset } });
      offset += plain.length;
    }
    sourceLine++;
  }
  return { rows, next: sourceLine };
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
  // row offsets preserve diff and image rows across resizes and when copying.
  const suffix = rendered.rows.concat(
    diff.concat(images).flatMap((rows, index) =>
      rows.map((text, offset) => ({
        text,
        anchor: { line: next + index, offset },
      })),
    ),
    {
      text: '',
      anchor: { line: next + diff.length + images.length, offset: 0 },
    },
  );
  return block(
    item,
    head.rows.length,
    head.rows.concat(complete.rows),
    suffix,
    linked && !diff.length && !images.length
      ? { line: complete.next, pending: linked.pending, target: linked.target }
      : undefined,
  );
}

function extend(
  previous: Block,
  item: DisplayItem,
  width: number,
): Block | undefined {
  const before = previous.item;
  const tail = previous.tail;
  if (
    !tail ||
    item.kind !== 'tool' ||
    item.title !== before.title ||
    item.done !== before.done ||
    item.cwd !== before.cwd ||
    item.diff !== before.diff ||
    item.images !== before.images
  )
    return undefined;
  const appended = appendedDisplayText(before, item);
  if (appended === undefined) return undefined;
  const linked = linkifyAppend(tail.pending + appended, item.cwd, tail.target);
  const complete = section(linked.complete, width, false, tail.line);
  const hasBody =
    previous.complete.length > previous.headRows ||
    linked.complete.length > 0 ||
    !!linked.tail;
  const rendered = section(
    hasBody ? linked.tail.split('\n') : [],
    width,
    false,
    complete.next,
  );
  // a large chunk can exceed the argument limit if spread into push().
  for (const row of complete.rows) previous.complete.push(row);
  return block(
    item,
    previous.headRows,
    previous.complete,
    rendered.rows.concat({
      text: '',
      anchor: { line: rendered.next, offset: 0 },
    }),
    { line: complete.next, pending: linked.pending, target: linked.target },
  );
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
    let length = 0;
    const blocks: TextRows[] = [];
    const starts = new Map<string, number>();
    const rendered = new Map<string, Block>();
    const cache = new Map<string, Map<Expansion, Block>>();
    for (const item of items) {
      const expansion = !isExpanded(item, expanded)
        ? 'closed'
        : full?.has(item.id)
          ? 'full'
          : 'preview';
      const variants = this.cache.get(item.id) ?? new Map<Expansion, Block>();
      const previous = variants.get(expansion);
      const current =
        previous?.item === item
          ? previous
          : ((previous && extend(previous, item, width)) ??
            build(item, width, expansion, this.graphics));
      variants.set(expansion, current);
      cache.set(item.id, variants);
      starts.set(item.id, length);
      length += current.lines.length;
      blocks.push(current.lines);
      rendered.set(item.id, current);
    }
    this.cache = cache;
    const positions = [...starts];
    const positionAt = (row: number) => {
      let low = 0;
      let high = positions.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (positions[middle]![1] <= row) low = middle + 1;
        else high = middle;
      }
      return positions[low - 1];
    };
    return {
      lines: textRows(length, (row) => {
        const [item, start] = positionAt(row)!;
        return rendered.get(item)!.row(row - start)?.text;
      }),
      blocks,
      starts,
      anchorAt(row: number): ScrollAnchor | undefined {
        const entry = positionAt(row);
        if (!entry) return undefined;
        const [item, start] = entry;
        return {
          item,
          ...(rendered.get(item)!.row(row - start)?.anchor ?? {
            line: 0,
            offset: 0,
          }),
        };
      },
      rowOf(anchor: ScrollAnchor): number {
        const start = starts.get(anchor.item) ?? 0;
        const current = rendered.get(anchor.item);
        if (!current) return start;
        let low = 0;
        let high = current.lines.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (current.row(middle)!.anchor.line <= anchor.line) low = middle + 1;
          else high = middle;
        }
        for (let index = low - 1; index >= 0; index--) {
          const row = current.row(index)!.anchor;
          if (row.line !== anchor.line) break;
          if (
            row.offset === anchor.offset ||
            (row.offset >= 0 && row.offset < anchor.offset)
          )
            return start + index;
        }
        return start;
      },
    };
  }
}
