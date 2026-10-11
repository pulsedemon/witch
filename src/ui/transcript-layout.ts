import wrapAnsi from 'wrap-ansi';
import type { DisplayItem } from '../core/state.js';
import { colors, markdown } from './markdown.js';
import { linkify } from './links.js';

export interface ScrollAnchor {
  item: string;
  line: number;
}

interface Block {
  lines: string[];
  sourceLines: number[];
}

export class TranscriptLayout {
  private readonly cache = new WeakMap<DisplayItem, Map<string, Block>>();

  render(
    items: readonly DisplayItem[],
    width: number,
    expanded: ReadonlySet<string>,
  ) {
    const lines: string[] = [];
    const blocks: string[][] = [];
    const starts = new Map<string, number>();
    const rendered = new Map<string, Block>();
    for (const item of items) {
      const key = `${width}/${expanded.has(item.id)}`;
      let cached = this.cache.get(item);
      if (!cached) {
        cached = new Map();
        this.cache.set(item, cached);
      }
      let block = cached.get(key);
      if (!block) {
        const tool = item.kind === 'tool';
        const title =
          item.kind === 'user'
            ? colors.cyan('You')
            : item.kind === 'assistant'
              ? colors.green(item.title ?? 'Assistant')
              : tool
                ? colors.yellow(
                    `${expanded.has(item.id) ? '−' : '+'} ${item.done ? '✓' : '…'} ${linkify(item.title ?? 'Tool', item.cwd)}`,
                  )
                : colors.dim('Notice');
        const body =
          tool && !expanded.has(item.id)
            ? ''
            : tool
              ? linkify(item.text, item.cwd)
              : markdown(item.text, item.cwd);
        const blockLines = [
          ...wrapAnsi(title, width, { hard: true }).split('\n'),
          ...(body
            ? wrapAnsi(body, width, { hard: true, trim: false }).split('\n')
            : []),
          '',
        ];
        const sourceLines: number[] = [];
        let sourceLine = 0;
        for (const [section, trim] of [
          [title, true],
          ...(body ? [[body, false] as const] : []),
          ['', false],
        ] as const) {
          for (const line of section.split('\n')) {
            const count = wrapAnsi(line, width, { hard: true, trim }).split(
              '\n',
            ).length;
            sourceLines.push(...Array<number>(count).fill(sourceLine++));
          }
        }
        block = { lines: blockLines, sourceLines };
        cached.set(key, block);
      }
      starts.set(item.id, lines.length);
      lines.push(...block.lines);
      blocks.push(block.lines);
      rendered.set(item.id, block);
    }
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
          line: rendered.get(item)!.sourceLines[row - start] ?? 0,
        };
      },
      rowOf(anchor: ScrollAnchor): number {
        const start = starts.get(anchor.item) ?? 0;
        const offset =
          rendered.get(anchor.item)?.sourceLines.indexOf(anchor.line) ?? 0;
        return start + Math.max(0, offset);
      },
    };
  }
}
