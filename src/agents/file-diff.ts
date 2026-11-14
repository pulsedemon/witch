import type { FileDiff, Hunk } from './types.js';

/** a new or deleted file as one hunk of all its lines, since both agents report those as content. */
export function wholeFile(
  path: string,
  kind: 'add' | 'delete',
  content: string,
): FileDiff {
  if (!content) return { path, kind, hunks: [] };

  const marker = kind === 'add' ? '+' : '-';

  const lines = content.replace(/\n$/, '').split('\n');

  return {
    path,
    kind,
    hunks: [
      {
        oldStart: kind === 'add' ? 0 : 1,
        newStart: kind === 'add' ? 1 : 0,
        lines: lines.map((line) => marker + line),
      },
    ],
  };
}

/** lines a unified diff adds and removes; only lines inside a hunk count, so file headers stay out. */
export function diffLines(diff: string): { added: number; removed: number } {
  let added = 0;

  let removed = 0;

  let hunk = false;

  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) hunk = true;
    else if (line.startsWith('diff ')) hunk = false;
    else if (hunk && line.startsWith('+')) added++;
    else if (hunk && line.startsWith('-')) removed++;
  }

  return { added, removed };
}

/** the hunks of a Codex update's diff, which has no file headers and can end with a move's note. */
export function hunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];

  for (const line of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);

    if (header)
      hunks.push({
        oldStart: Number(header[1]),
        newStart: Number(header[2]),
        lines: [],
      });
    else if (/^[ +-]/.test(line)) hunks.at(-1)?.lines.push(line);
  }

  return hunks;
}
