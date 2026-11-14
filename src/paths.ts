import { homedir } from 'node:os';

import { resolve } from 'node:path';

/** a path as a terminal types or drops it, where a backslash escapes the next character. */
export function unescapePath(path: string): string {
  return path.replace(/\\(.)/g, '$1');
}

export function resolveFile(path: string, cwd: string): string {
  return resolve(cwd, path.startsWith('~/') ? homedir() + path.slice(1) : path);
}

/** `path` itself or a path under it. */
export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? root : `${root}/`);
}
