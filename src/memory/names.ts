import { posix } from 'node:path';

/** a full refname, so a note named `main` at the worktree root can't make a revision ambiguous. */
export const main = 'refs/heads/main';
export const branches = 'conversations/';
/** the branch a conversation's memory worktree is on. */
export const branchOf = (id: string) => `${branches}${id}`;
/** the note that indexes the rest of its scope. */
export const indexNote = 'MEMORY.md';

/** a note path relative to the memory root, refusing one that leaves the root or enters `.git`. */
export function notePath(path: string): string {
  const file = posix.normalize(path);
  const [top] = file.split('/');

  if (top === '..' || top === '.git')
    throw new Error('Memory path is outside the note directories');

  return file;
}

/** a note name is agent-written; without control characters it can't carry a terminal escape, such as an OSC 8 link, or a line break into text Witch writes around it. */
export function printable(path: string): string {
  return path.replace(/\p{Cc}/gu, '');
}
