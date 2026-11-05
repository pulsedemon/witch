import stripAnsi from 'strip-ansi';
import wrapAnsi from 'wrap-ansi';
import type { DisplayItem } from '../core/state.js';
import { appendedDisplayText } from '../core/state.js';
import { prepareDiff } from './diff.js';
import { markdown, markdownAppend } from './markdown.js';
import { accent, colors } from './theme.js';
import { castTitle } from './cast.js';
import type { Graphics } from './images.js';
import { hyperlink, linkify, linkifyAppend, plain } from './links.js';
import type { LinkedAppend } from './links.js';
import { normalizeText, wrapLines } from './wrap.js';

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
  singleLine: boolean;
  complete: string[];
  tail: string[];
  diff?: ReturnType<typeof prepareDiff>;
  images: readonly string[];
  append?: Append;
}

interface Viewport {
  width: number;
}

interface Block {
  content: Content;
  viewport: Viewport;
  complete: Row[];
  lines: TextRows;
  row(index: number): Row | undefined;
  /** an image it names had no rows yet. */
  missing: boolean;
  /** the image version it was built for. */
  loads?: number;
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
  viewport: Viewport,
  complete: Row[],
  suffix: Row[],
  missing: boolean,
): Block {
  const count = complete.length;
  const length = count + suffix.length;
  const row = (index: number) =>
    index < count ? complete[index] : suffix[index - count];
  return {
    content,
    viewport,
    complete,
    row,
    lines: textRows(length, (index) => row(index)?.text),
    missing,
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
    const source = trim ? stripAnsi(normalizeText(line)) : undefined;
    let offset = 0;
    for (const row of wrapLines(line, width, trim)) {
      const plain = stripAnsi(row);
      if (source !== undefined) offset = source.indexOf(plain, offset);
      rows.push({ text: row, anchor: { line: sourceLine, offset } });
      offset += plain.length;
    }
    sourceLine++;
  }
  return { rows, next: sourceLine };
}

/** a tool's title, with the path it shows linked whole from the field it came from. */
function linkedTitle(title: string, path: string | undefined, cwd: string) {
  // `toolTitle` puts the path two spaces after the name, which can contain the same text
  const separator = path ? title.indexOf(`  ${path}`) : -1;
  if (!path || separator < 0) return linkify(title, cwd);
  const start = separator + 2;
  return (
    linkify(title.slice(0, start), cwd) +
    hyperlink(plain(path), path, cwd) +
    linkify(title.slice(start + path.length), cwd)
  );
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
              `${expanded ? '−' : '+'} ${item.done ? (item.failed ? colors.red('✗') : '✓') : '…'} ${linkedTitle((expanded && item.expandedTitle) || (item.title ?? 'Tool'), item.path, item.cwd)}`,
            )
          : item.cast
            ? castTitle()
            : colors.dim('Notice');
  const linked =
    tool && expanded ? linkifyAppend(item.text, item.cwd) : undefined;
  const assistant =
    item.kind === 'assistant' && !fullMarkdown
      ? markdownAppend(item.text, item.cwd)
      : undefined;
  const body = tool ? '' : (assistant?.tail ?? markdown(item.text, item.cwd));
  const sources =
    item.kind === 'user' || (tool && expanded) ? (item.images ?? []) : [];
  const diff =
    tool && expanded && item.diff?.length
      ? prepareDiff(item.diff, item.cwd, expansion === 'full')
      : undefined;
  const complete = linked?.complete ?? assistant?.complete ?? [];
  const hasBody = linked ? linked.complete.length > 0 || !!linked.tail : !!body;
  // a one-line notice needs no heading to read as one
  const headless =
    item.kind === 'notice' && !item.cast && !item.text.includes('\n');
  return {
    item,
    title: headless ? [] : title.split('\n'),
    singleLine: tool && !expanded && !!item.singleLine,
    complete,
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
): { rows: Row[]; missing: boolean } {
  const rendered = section(content.tail, width, false, first);
  const diff = content.diff?.(width) ?? [];
  const images = graphics
    ? content.images.map((source) =>
        graphics.rows(source, content.item.cwd, width),
      )
    : [];
  const next = rendered.next;
  // row offsets preserve diff and image rows across resizes and when copying, and an image without rows yet
  // keeps its line, so the images after it keep theirs when it loads.
  const ended = rendered.rows.concat(
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
  return { rows: ended, missing: images.some((rows) => !rows.length) };
}

function wrap(
  content: Content,
  viewport: Viewport,
  graphics: Graphics | undefined,
): Block {
  const { width } = viewport;
  const head = section(content.title, width, true, 0);
  if (content.singleLine && head.rows.length > 1) {
    const first =
      width > 1
        ? wrapAnsi(content.title.join(' '), width - 1, {
            hard: true,
            trim: true,
            wordWrap: false,
          }).split('\n')[0]!
        : '';
    head.rows = [
      { text: `${first}${colors.dim('…')}`, anchor: { line: 0, offset: 0 } },
    ];
  }
  const complete = section(content.complete, width, false, head.next);
  const end = ending(content, width, complete.next, graphics);
  return block(
    content,
    viewport,
    head.rows.concat(complete.rows),
    end.rows,
    end.missing,
  );
}

function extend(
  previous: Block,
  item: DisplayItem,
  viewport: Viewport,
  graphics: Graphics | undefined,
): Block | undefined {
  const before = previous.content.item;
  const tail = previous.content.append;
  if (
    !tail ||
    item.kind !== before.kind ||
    item.title !== before.title ||
    item.expandedTitle !== before.expandedTitle ||
    item.singleLine !== before.singleLine ||
    item.done !== before.done ||
    item.cwd !== before.cwd ||
    item.diff !== before.diff ||
    item.images !== before.images
  )
    return undefined;
  const appended = appendedDisplayText(before, item);
  if (appended === undefined) return undefined;
  if (tail.kind === 'full-markdown')
    return wrap(prepare(item, 'closed', undefined, true), viewport, graphics);
  const linked =
    tail.kind === 'tool'
      ? linkifyAppend(tail.pending + appended, item.cwd, tail.target)
      : undefined;
  const content = linked ?? markdownAppend(tail.pending + appended, item.cwd);
  if (!content)
    return wrap(prepare(item, 'closed', undefined, true), viewport, graphics);
  const source = previous.content;
  const first = source.title.length + source.complete.length;
  const hasBody =
    source.complete.length > 0 || content.complete.length > 0 || !!content.tail;
  const prepared: Content = {
    ...source,
    item,
    tail: hasBody ? content.tail.split('\n') : [],
    append:
      tail.kind === 'tool'
        ? { kind: 'tool', pending: content.pending, target: linked?.target }
        : { kind: 'assistant', pending: content.pending },
  };
  for (const line of content.complete) source.complete.push(line);
  if (previous.viewport !== viewport) return wrap(prepared, viewport, graphics);
  const { width } = viewport;
  const complete = section(content.complete, width, false, first);
  // a large chunk can exceed the argument limit if spread into push().
  for (const row of complete.rows) previous.complete.push(row);
  const end = ending(prepared, width, complete.next, graphics);
  return block(prepared, viewport, previous.complete, end.rows, end.missing);
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

const unchosen: ReadonlyMap<string, boolean> = new Map();

/** a finished agent tool call that may share a row with its neighbors. */
function groupable(item: DisplayItem): boolean {
  return (
    item.kind === 'tool' &&
    !!item.done &&
    !item.failed &&
    // agent tool rows are `<activity>/<agent>/<native id>`; familiar and brew rows, saved ones too, are bare UUIDs
    item.id.includes('/') &&
    !isExpanded(item, unchosen)
  );
}

/** a group's open state lives on its members, so it survives the group growing or merging with another. */
function groupOpen(
  members: readonly DisplayItem[],
  choices: ReadonlyMap<string, boolean>,
): boolean {
  return members.some(
    ({ id }) => choices.get(`open:${id}`) === true || choices.get(id) === true,
  );
}

/** the choices after opening or closing a group; closing also closes the members opened inside it. */
export function toggleGroup(
  members: readonly DisplayItem[],
  choices: ReadonlyMap<string, boolean>,
): Map<string, boolean> {
  const open = groupOpen(members, choices);
  const next = new Map(choices);
  for (const { id } of members) {
    next.set(`open:${id}`, !open);
    if (open) next.set(id, false);
  }
  return next;
}

export class TranscriptLayout {
  private cache = new Map<string, Map<Expansion, Block>>();
  private viewport: Viewport = { width: 0 };

  /** without `graphics`, images stay out of the transcript. */
  constructor(private readonly graphics?: Graphics) {}

  /** `loads` is the image version to draw for; App passes it so that the React Compiler's memo of this call follows it. */
  render(
    items: readonly DisplayItem[],
    width: number,
    expanded: ReadonlyMap<string, boolean>,
    full?: ReadonlySet<string>,
    loads = this.graphics?.version,
  ) {
    // reopening a variant at an older width must restore its terminal image placement.
    if (this.viewport.width !== width) this.viewport = { width };
    const viewport = this.viewport;
    // two or more consecutive groupable tools show as one row, followed by them once it is open
    const shown: DisplayItem[] = [];
    const groups = new Map<string, readonly DisplayItem[]>();
    const owner = new Map<string, string>();
    for (let index = 0; index < items.length;) {
      let end = index;
      while (end < items.length && groupable(items[end]!)) end++;
      if (end - index < 2) {
        shown.push(items[index]!);
        index++;
        continue;
      }
      const members = items.slice(index, end);
      const first = members[0]!;
      const id = `tools:${first.id}`;
      groups.set(id, members);
      shown.push({
        id,
        kind: 'tool',
        title: `${members.length} tools`,
        text: '',
        cwd: first.cwd,
        done: true,
      });
      const open = groupOpen(members, expanded);
      for (const member of members) {
        owner.set(member.id, id);
        if (open) shown.push(member);
      }
      index = end;
    }
    let length = 0;
    const blocks: TextRows[] = [];
    const starts = new Map<string, number>();
    const rendered = new Map<string, Block>();
    const cache = new Map<string, Map<Expansion, Block>>();
    for (const item of shown) {
      const members = groups.get(item.id);
      const expansion = !(members
        ? groupOpen(members, expanded)
        : isExpanded(item, expanded))
        ? 'closed'
        : full?.has(item.id)
          ? 'full'
          : 'preview';
      const variants = this.cache.get(item.id) ?? new Map<Expansion, Block>();
      const previous = variants.get(expansion);
      const current =
        previous?.content.item === item
          ? previous.viewport === viewport &&
            (!previous.missing || previous.loads === loads)
            ? previous
            : wrap(previous.content, viewport, this.graphics)
          : ((previous && extend(previous, item, viewport, this.graphics)) ??
            wrap(
              prepare(item, expansion, this.graphics),
              viewport,
              this.graphics,
            ));
      if (current !== previous) current.loads = loads;
      variants.set(expansion, current);
      cache.set(item.id, variants);
      starts.set(item.id, length);
      length += current.lines.length;
      blocks.push(current.lines);
      rendered.set(item.id, current);
    }
    // a collapsed group's members keep their blocks for when it opens again
    for (const id of owner.keys()) {
      const kept = this.cache.get(id);
      if (kept && !cache.has(id)) cache.set(id, kept);
    }
    this.cache = cache;
    const positions = [...starts];
    /** where an id that no longer shows leads: a collapsed member to its group, a former group to the one holding its first tool. */
    const shownAs = (id: string): string => {
      if (starts.has(id)) return id;
      const first = id.startsWith('tools:') ? id.slice('tools:'.length) : id;
      return owner.get(first) ?? (starts.has(first) ? first : id);
    };
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
      items: shown,
      shownAs,
      members: (id: string) => groups.get(id),
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
        const id = shownAs(anchor.item);
        if (id !== anchor.item) return starts.get(id) ?? 0;
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
