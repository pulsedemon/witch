import type { FileDiff } from './types.js';

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
