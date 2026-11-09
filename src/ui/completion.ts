import type { Skill } from '../agents/types.js';

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

/** whether `query`'s letters start the name's alphanumeric words, in order: `tdd` fits `test-driven-development`. */
function abbreviates(query: string, name: string): boolean {
  let at = 0;
  for (const [initial] of name.match(/[a-z0-9]+/g) ?? [])
    if (initial === query[at]) at++;
  return at === query.length;
}

type Ranked = { name: string; aliases?: string[] };

/**
 * an exact name or alias first, then names that start with the query, then spell names that contain
 * it or that it abbreviates. Witch's commands skip the last two, so a stray word can't run `/restart`.
 */
export function rankCommands<C extends Ranked, S extends Ranked>(
  query: string,
  commands: readonly C[],
  spells: readonly S[],
): (C | S)[] {
  const typed = query.toLowerCase();
  const spell = new Set<C | S>(spells);
  return tiered<C | S>(
    [...commands, ...spells],
    [
      ({ name, aliases = [] }) =>
        [name, ...aliases].some((each) => each.toLowerCase() === typed),
      ({ name }) => name.toLowerCase().startsWith(typed),
      (item) => spell.has(item) && item.name.toLowerCase().includes(typed),
      (item) => spell.has(item) && abbreviates(typed, item.name.toLowerCase()),
    ],
  );
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
