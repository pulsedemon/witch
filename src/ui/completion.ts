export type Token =
  | { kind: 'command'; query: string }
  /** `[start, end)` spans the whole token, `@` included. */
  | { kind: 'file'; query: string; start: number; end: number };

/** a command token is the whole draft; a file token is the whitespace-delimited `@` word holding the cursor. */
export function activeToken(value: string, cursor: number): Token | undefined {
  const command = /^\/(\S*)$/.exec(value);
  if (command) return { kind: 'command', query: command[1]! };
  let start = cursor;
  while (start > 0 && !/\s/.test(value[start - 1]!)) start--;
  if (value[start] !== '@' || cursor === start) return;
  let end = cursor;
  while (end < value.length && !/\s/.test(value[end]!)) end++;
  return { kind: 'file', query: value.slice(start + 1, cursor), start, end };
}

/** identifies a token by kind, position and text, so its list reopens once any of them changes. */
export function tokenKey(value: string, cursor: number): string | undefined {
  const token = activeToken(value, cursor);
  if (!token) return;
  return token.kind === 'command'
    ? `command:${value}`
    : `file:${token.start}:${value.slice(token.start, token.end)}`;
}

/** keeps input order within each tier. */
function tiered<T>(items: readonly T[], tiers: ((item: T) => boolean)[]): T[] {
  const ranked = new Set<T>();
  for (const tier of tiers)
    for (const item of items) if (tier(item)) ranked.add(item);
  return [...ranked];
}

/** an exact name or alias first, then names that start with the query. */
export function rankCommands<T extends { name: string; aliases?: string[] }>(
  query: string,
  items: readonly T[],
): T[] {
  const typed = query.toLowerCase();
  return tiered(items, [
    ({ name, aliases = [] }) =>
      [name, ...aliases].some((each) => each.toLowerCase() === typed),
    ({ name }) => name.toLowerCase().startsWith(typed),
  ]);
}

/** paths that start with the query, then paths that contain it. */
export function rankFiles(query: string, paths: readonly string[]): string[] {
  const typed = query.toLowerCase();
  return tiered(paths, [
    (path) => path.toLowerCase().startsWith(typed),
    (path) => path.toLowerCase().includes(typed),
  ]);
}

/** what the composer's open list offers: commands and skills, or files for the `@` token at `[start, end)`. */
export type CompletionList =
  | { kind: 'command'; items: Skill[] }
  | { kind: 'file'; start: number; end: number; items: string[] };
import type { Skill } from '../agents/types.js';
