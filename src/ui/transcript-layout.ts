import wrapAnsi from 'wrap-ansi';
import stripAnsi from 'strip-ansi';
import type { DisplayItem } from '../core/state.js';
import { appendedDisplayText } from '../core/state.js';
import { prepareDiff } from './diff.js';
import { markdown, markdownAppend } from './markdown.js';
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
type Append =
  | ({ kind: 'tool' } & Pick<LinkedAppend, 'pending' | 'target'>)
  | { kind: 'assistant'; pending: string }
  | { kind: 'full-markdown' };

interface Row {
  text: string;
  anchor: Anchor;
}

interface Content {
  item: DisplayItem;
  title: string[];
  complete: string[];
  /** later appends share storage; each snapshot keeps its own boundary. */
  count: number;
  tail: string[];
  diff?: ReturnType<typeof prepareDiff>;
  images: readonly string[];
  append?: Append;
}

interface Block {
  content: Content;
  width: number;
  complete: Row[];
  lines: TextRows;
  row(index: number): Row | undefined;
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
  content: Content,
  width: number,
  complete: Row[],
  suffix: Row[],
): Block {
  const count = complete.length;
  const length = count + suffix.length;
  const row = (index: number) =>
    index < count ? complete[index] : suffix[index - count];
  return {
    content,
    width,
    complete,
    row,
    lines: textRows(length, (index) => row(index)?.text),
  };
}

/** anchors count source lines so resizing keeps the reading position. */
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

function prepare(
  item: DisplayItem,
  expansion: Expansion,
  graphics: Graphics | undefined,
  fullMarkdown = false,
): Content {
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
  const assistant =
    item.kind === 'assistant' && !fullMarkdown
      ? markdownAppend(item.text, item.cwd)
      : undefined;
  const body = tool ? '' : (assistant?.tail ?? markdown(item.text, item.cwd));
  const sources =
    item.kind === 'user'
      ? imagePaths(item.text)
      : tool && expanded
        ? (item.images ?? [])
        : [];
  const diff =
    tool && expanded && item.diff?.length
      ? prepareDiff(item.diff, item.cwd, expansion === 'full')
      : undefined;
  const complete = linked?.complete ?? assistant?.complete ?? [];
  const hasBody = linked ? linked.complete.length > 0 || !!linked.tail : !!body;
  return {
    item,
    title: title.split('\n'),
    complete,
    count: complete.length,
    tail: hasBody ? (linked?.tail ?? body).split('\n') : [],
    diff,
    images: sources,
    append:
      linked && !diff && (!graphics || !sources.length)
        ? { kind: 'tool', pending: linked.pending, target: linked.target }
        : item.kind === 'assistant'
          ? assistant
            ? { kind: 'assistant', pending: assistant.pending }
            : { kind: 'full-markdown' }
          : undefined,
  };
}

function ending(
  content: Content,
  width: number,
  first: number,
  graphics: Graphics | undefined,
): Row[] {
  const rendered = section(content.tail, width, false, first);
  const diff = content.diff?.(width) ?? [];
  const images = graphics
    ? content.images
        .map((source) => graphics.rows(source, content.item.cwd, width))
        .filter((rows) => rows.length)
    : [];
  const next = rendered.next;
  // row offsets preserve diff and image rows across resizes and when copying.
  return rendered.rows.concat(
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
}

function wrap(
  content: Content,
  width: number,
  graphics: Graphics | undefined,
): Block {
  const head = section(content.title, width, true, 0);
  const complete = section(
    content.complete.slice(0, content.count),
    width,
    false,
    head.next,
  );
  return block(
    content,
    width,
    head.rows.concat(complete.rows),
    ending(content, width, complete.next, graphics),
  );
}

function extend(
  previous: Block,
  item: DisplayItem,
  width: number,
  graphics: Graphics | undefined,
): Block | undefined {
  const before = previous.content.item;
  const tail = previous.content.append;
  if (
    !tail ||
    item.kind !== before.kind ||
    item.title !== before.title ||
    item.done !== before.done ||
    item.cwd !== before.cwd ||
    item.diff !== before.diff ||
    item.images !== before.images
  )
    return undefined;
  const appended = appendedDisplayText(before, item);
  if (appended === undefined) return undefined;
  if (tail.kind === 'full-markdown')
    return wrap(prepare(item, 'closed', undefined, true), width, graphics);
  const linked =
    tail.kind === 'tool'
      ? linkifyAppend(tail.pending + appended, item.cwd, tail.target)
      : undefined;
  const content = linked ?? markdownAppend(tail.pending + appended, item.cwd);
  if (!content)
    return wrap(prepare(item, 'closed', undefined, true), width, graphics);
  const source = previous.content;
  const count = source.count + content.complete.length;
  const prepared: Content = {
    ...source,
    item,
    count,
    tail: count > 0 || content.tail ? content.tail.split('\n') : [],
    append:
      tail.kind === 'tool'
        ? { kind: 'tool', pending: content.pending, target: linked?.target }
        : { kind: 'assistant', pending: content.pending },
  };
  for (const line of content.complete) source.complete.push(line);
  if (previous.width !== width) return wrap(prepared, width, graphics);
  const complete = section(
    content.complete,
    width,
    false,
    source.title.length + source.count,
  );
  // a large chunk can exceed the argument limit if spread into push().
  for (const row of complete.rows) previous.complete.push(row);
  return block(
    prepared,
    width,
    previous.complete,
    ending(prepared, width, complete.next, graphics),
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

  /** without `graphics`, images stay out of the transcript. */
  constructor(private readonly graphics?: Graphics) {}

  render(
    items: readonly DisplayItem[],
    width: number,
    expanded: ReadonlyMap<string, boolean>,
    full?: ReadonlySet<string>,
  ) {
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
        previous?.content.item === item
          ? previous.width === width
            ? previous
            : wrap(previous.content, width, this.graphics)
          : ((previous && extend(previous, item, width, this.graphics)) ??
            wrap(
              prepare(item, expansion, this.graphics),
              width,
              this.graphics,
            ));
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
