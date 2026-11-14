import { execFile } from 'node:child_process';

import { constants } from 'node:fs';

import { lstat, realpath, stat } from 'node:fs/promises';

import { basename, dirname, join } from 'node:path';

import { promisify } from 'node:util';

import { z } from 'zod';

import { errorMessage } from '../errors.js';

import { within } from '../paths.js';

import { readJson, unlessGone, writeJson } from './json.js';

import { openLocked } from './lock.js';

const execute = promisify(execFile);

const identitySchema = z.object({
  device: z.string(),
  inode: z.string(),
  birthtimeNs: z.string().optional(),
});

const entrySchema = identitySchema.extend({
  path: z.string(),
  main: z.string().optional(),
  slot: z.number().int().positive().optional(),
});

const moveSchema = identitySchema.extend({
  from: z.string(),
  to: z.string(),
  prompts: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
});

const ledgerSchema = z.object({
  version: z.literal(1),
  entries: z.array(entrySchema),
  moves: z.array(moveSchema),
});

export type Identity = z.infer<typeof identitySchema>;

/** `main` is the main checkout of a Git-backed entry, its own path for a main checkout; `slot` is a worktree's `--spawn` index. */
export type DirectoryEntry = z.infer<typeof entrySchema>;

export interface Move {
  from: string;
  to: string;
}

/**
 * a move with the identity of the directory that moved, the size of `prompts.jsonl` when it was recorded, and when that
 * was: the clock's time, but always after the move recorded before it.
 */
export type LedgerMove = z.infer<typeof moveSchema>;

export interface Ledger {
  entries: DirectoryEntry[];
  moves: LedgerMove[];
}

const ledgerFile = (root: string) => join(root, 'directories.json');

/** when a conversation that takes its cwd now is dated from: every move recorded later is dated after it, whatever the clock reads. */
export const newestMoveTime = (ledger: Ledger): string =>
  new Date(ledger.moves.at(-1)?.at ?? 0).toISOString();

/** whether a path exists; a failure to look, such as a parent without permission, throws. */
export const present = async (path: string) =>
  (await identify(path)) !== undefined;

export function sameIdentity(a: Identity, b: Identity | undefined): boolean {
  return (
    a.device === b?.device &&
    a.inode === b.inode &&
    // macOS timestamp restoration can backdate creation; a reused inode is newer
    (a.birthtimeNs === undefined ||
      (b.birthtimeNs !== undefined &&
        BigInt(b.birthtimeNs) <= BigInt(a.birthtimeNs)))
  );
}

/** undefined for a path that's gone. */
export async function identify(path: string): Promise<Identity | undefined> {
  const found = await unlessGone(stat(path, { bigint: true }));

  return (
    found && {
      device: String(found.dev),
      inode: String(found.ino),
      birthtimeNs: String(found.birthtimeNs),
    }
  );
}

/** accept a case change only while its identity survives and no symlink redirects the path. */
export async function caseDestination(
  path: string,
  expected: Identity,
): Promise<string | undefined> {
  const destination = await realpath(path);

  if (destination === path || destination.toLowerCase() !== path.toLowerCase())
    return undefined;

  for (
    let from = path, to = destination;
    from !== to;
    from = dirname(from), to = dirname(to)
  )
    if ((await lstat(from)).isSymbolicLink()) return undefined;

  return sameIdentity(expected, await identify(destination))
    ? destination
    : undefined;
}

/**
 * takes in what's at an entry's path now, unless the directory it records still exists elsewhere: that one moved, and
 * the next repair records the move rather than this taking its stand-in. says whether it did.
 */
export async function adoptIdentity(
  entry: DirectoryEntry,
  identity: Identity,
): Promise<boolean> {
  // a lookup that fails leaves the recorded directory as it was, since it may still exist where it can't be seen
  if (!sameIdentity(entry, identity) && (await locate(entry).catch(() => true)))
    return false;

  // its repository and slot described the directory that was here
  if (!sameIdentity(entry, identity)) {
    delete entry.main;

    delete entry.slot;
  }

  entry.device = identity.device;

  entry.inode = identity.inode;

  entry.birthtimeNs = identity.birthtimeNs;

  return true;
}

/**
 * where a directory is now, which macOS resolves by device and inode under /.vol; undefined once it's gone. one it
 * can't reach, such as under a parent without permission, throws. node's realpath can't read /.vol, so sh does.
 */
async function locate(identity: Identity): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;

  const handle = `/.vol/${identity.device}/${identity.inode}`;

  if (!(await identify(handle))) return undefined;

  const { stdout } = await execute('/bin/sh', [
    '-c',
    'CDPATH= cd -P "$1" && pwd -P',
    'witch-locate',
    handle,
  ]);

  const path = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;

  return sameIdentity(identity, await identify(path)) ? path : undefined;
}

export async function readLedger(root: string): Promise<Ledger> {
  const ledger = await readJson(ledgerFile(root), ledgerSchema).catch(
    (error: unknown) => {
      throw new Error(`${ledgerFile(root)}: ${errorMessage(error)}`, {
        cause: error,
      });
    },
  );

  return { entries: ledger?.entries ?? [], moves: ledger?.moves ?? [] };
}

/** read, change and write the ledger while holding its lock, which every Witch on this state directory shares. */
export async function updateLedger<T>(
  root: string,
  change: (ledger: Ledger) => Promise<T>,
): Promise<T> {
  const lock = await openLocked(
    join(root, 'directories.lock'),
    constants.O_CREAT | constants.O_RDWR,
    { mode: 0o600 },
  );

  try {
    const ledger = await readLedger(root);

    const result = await change(ledger);

    // checked as it's read, so a change the reader would refuse never lands
    const checked = ledgerSchema.parse({ version: 1, ...ledger });

    await writeJson(ledgerFile(root), checked);

    return result;
  } finally {
    await lock.close();
  }
}

type Source = 'gone' | 'back' | 'reused';

/** what a move's source holds now. a lookup failure counts as the moved directory, so the chain stops there. */
async function sourceOf(move: LedgerMove): Promise<Source> {
  try {
    const found = await identify(move.from);

    if (!found) return 'gone';

    if (!sameIdentity(move, found)) return 'reused';

    return (await caseDestination(move.from, move)) ? 'gone' : 'back';
  } catch {
    return 'back';
  }
}

/** a ledger's moves, read against the filesystem as it was when `mapper` built this. */
export interface Mapping {
  map(path: string, owner?: Owner): string | undefined;

  /**
   * whether what `map(path, owner)` relied on still holds: the sources its chain consulted, and each known directory
   * holding `path` still at, or still missing from, where its own chain puts it.
   */
  unchanged(path: string, owner?: Owner): Promise<boolean>;
  suspended: Move[];
}

/** the owner of a mapped path: which moves it predates, and whether it follows one past a path another directory took. */
export interface Owner {
  predates(move: LedgerMove): boolean;
  throughReused: boolean;
}

/**
 * maps old paths through the ledger's moves. each step takes the most specific move recorded after the last one applied
 * whose `from` holds the path. of equals, a chain under way takes the next, since the directory it followed there left
 * first. the first step takes only moves the path's `owner` predates, the first of equals; with no owner, the latest. a
 * `from` holding the moved directory again, or one that can't be looked at, stops the chain there; one holding another
 * directory stops it with nothing, unless the owner follows it `throughReused`.
 */
export async function mapper(ledger: Ledger): Promise<Mapping> {
  const sources: Source[] = await Promise.all(ledger.moves.map(sourceOf));

  // each move's index under its source, in the order recorded
  const bySource = new Map<string, number[]>();

  for (const [index, { from }] of ledger.moves.entries()) {
    const bucket = bySource.get(from);

    if (bucket) bucket.push(index);
    else bySource.set(from, [index]);
  }

  // past the first hop, where a chain ends depends only on where it stands, the last move and passing reused paths
  const followed = new Map<string, string | undefined>();

  const raw = (
    path: string,
    owner?: Owner,
    consulted?: number[],
  ): string | undefined => {
    const through = owner?.throughReused ? 1 : 0;

    const visited: string[] = [];

    let result: string | undefined;

    // an older move from where this one landed was another directory's
    for (let current = path, last = -1; ;) {
      const key = `${last}\0${through}\0${current}`;

      if (last >= 0) {
        if (!consulted && followed.has(key)) {
          result = followed.get(key);

          break;
        }

        visited.push(key);
      }

      let chosen = -1;

      // the most specific source first: the path itself, then each parent
      for (const prefix of prefixes(current)) {
        const bucket = bySource.get(prefix);

        if (!bucket) continue;

        const found =
          last >= 0
            ? firstPassing(bucket, (index) => index > last)
            : owner
              ? // a move out of the path before its owner was there was an earlier occupant's
                firstPassing(bucket, (index) =>
                  owner.predates(ledger.moves[index]!),
                )
              : bucket.at(-1);

        if (found !== undefined) {
          chosen = found;

          break;
        }
      }

      if (chosen >= 0) consulted?.push(chosen);

      const move = ledger.moves[chosen];

      const source = sources[chosen];

      if (!move || source === 'back') {
        result = current;

        break;
      }

      if (source === 'reused' && !owner?.throughReused) {
        result = undefined;

        break;
      }

      last = chosen;

      current = move.to + current.slice(move.from.length);
    }

    for (const key of visited) followed.set(key, result);

    return result;
  };

  const byPath = new Map(ledger.entries.map((entry) => [entry.path, entry]));

  // a known directory carried by a parent's move that isn't where the move would put it hasn't moved with it
  const stranded: string[] = [];

  for (const entry of ledger.entries) {
    const target = raw(entry.path);

    if (
      target !== undefined &&
      target !== entry.path &&
      !sameIdentity(entry, await identify(target).catch(() => entry))
    )
      stranded.push(entry.path);
  }

  return {
    map(path, owner) {
      if (stranded.some((root) => within(path, root))) return undefined;

      return raw(path, owner);
    },
    async unchanged(path, owner) {
      const consulted: number[] = [];

      raw(path, owner, consulted);

      for (const prefix of prefixes(path)) {
        const entry = byPath.get(prefix);

        if (!entry) continue;

        const target = raw(entry.path, undefined, consulted);

        if (target === undefined || target === entry.path) continue;

        const missing = !sameIdentity(
          entry,
          await identify(target).catch(() => entry),
        );

        if (missing !== stranded.includes(entry.path)) return false;
      }

      for (const index of new Set(consulted))
        if ((await sourceOf(ledger.moves[index]!)) !== sources[index])
          return false;

      return true;
    },
    suspended: ledger.moves.filter((_, index) => sources[index] === 'reused'),
  };
}

/** the paths the ledger's moves carried `path` from, newest first, that `mapper` still maps to it. */
export async function formerPaths(
  ledger: Ledger,
  path: string,
): Promise<string[]> {
  const paths = new Set<string>();

  let current = path;

  for (const { from, to } of ledger.moves.toReversed())
    if (within(current, to))
      paths.add((current = from + current.slice(to.length)));

  paths.delete(path);

  const { map } = await mapper(ledger);

  return [...paths].filter((former) => map(former) === path);
}

/** every path `path` is within, itself first and `/` last, at each separator however many it repeats. */
export function* prefixes(path: string): Generator<string> {
  yield path;

  for (
    let at = path.lastIndexOf('/');
    at > 0;
    at = path.lastIndexOf('/', at - 1)
  )
    yield path.slice(0, at);

  yield '/';
}

/**
 * the first index in a bucket that passes a test that stays true from there on: moves are recorded in order, so a
 * later index, prompt boundary or recording time is never smaller.
 */
function firstPassing(
  bucket: readonly number[],
  passes: (index: number) => boolean,
): number | undefined {
  let low = 0;

  let high = bucket.length;

  while (low < high) {
    const middle = (low + high) >> 1;

    if (passes(bucket[middle]!)) high = middle;
    else low = middle + 1;
  }

  return bucket[low];
}

/** paths under `move.from` mapped through it. */
const through = (path: string, { from, to }: Move) =>
  within(path, from) ? to + path.slice(from.length) : path;

/**
 * where missing entries went: seeds, then siblings of a resolved move that hold their identity, then on macOS each one's
 * own identity. an entry carried along by a resolved move gets no move of its own.
 */
export async function findMoves(
  entries: readonly DirectoryEntry[],
  seeds: readonly string[],
  unreachable: (entry: DirectoryEntry, error: unknown) => void = () => {},
): Promise<Array<Move & Identity>> {
  // an entry that can't be looked at stays put, and so do its records, which report why
  const missing: DirectoryEntry[] = [];

  const cases = new Map<DirectoryEntry, string>();

  for (const entry of entries) {
    if (!sameIdentity(entry, await identify(entry.path).catch(() => entry)))
      missing.push(entry);
    else {
      const destination = await caseDestination(entry.path, entry).catch(
        () => undefined,
      );

      if (destination) {
        cases.set(entry, destination);

        missing.push(entry);
      }
    }
  }

  const look = (path: string) => identify(path).catch(() => undefined);

  const moves: Array<Move & Identity> = [];

  const carried = async (entry: DirectoryEntry) => {
    for (const move of moves) {
      if (!within(entry.path, move.from) || entry.path === move.from) continue;

      const target = through(entry.path, move);

      if (
        sameIdentity(entry, await look(target)) &&
        !(await caseDestination(target, entry).catch(() => true))
      )
        return true;
    }

    return false;
  };

  const beside = new Map<string, Move[]>();

  const settle = (entry: DirectoryEntry, to: string) => {
    missing.splice(missing.indexOf(entry), 1);

    const move = {
      from: entry.path,
      to,
      device: entry.device,
      inode: entry.inode,
      birthtimeNs: entry.birthtimeNs,
    };

    moves.push(move);

    const parent = dirname(move.from);

    const there = beside.get(parent);

    if (there) there.push(move);
    else beside.set(parent, [move]);
  };

  // the real path, as locate gives, so a symlink or a name differing only in case at the candidate isn't recorded
  const sibling = async (entry: DirectoryEntry) => {
    const name = basename(entry.path);

    const tried = new Set<string>();

    for (const move of beside.get(dirname(entry.path)) ?? []) {
      const moved = basename(move.from);

      const candidates = [join(dirname(move.to), name)];

      if (name.startsWith(moved))
        candidates.push(
          join(dirname(move.to), basename(move.to) + name.slice(moved.length)),
        );

      for (const candidate of candidates) {
        if (tried.has(candidate)) continue;

        tried.add(candidate);

        if (sameIdentity(entry, await look(candidate)))
          return realpath(candidate).catch(() => undefined);
      }
    }

    return undefined;
  };

  const seeded = await Promise.all(
    seeds.map(async (seed) => {
      const identity = await look(seed);

      return {
        seed: identity
          ? ((await caseDestination(seed, identity).catch(() => undefined)) ??
            seed)
          : seed,
        identity,
      };
    }),
  );

  for (const entry of [...missing]) {
    if (cases.has(entry)) continue;

    const seed = seeded.find(({ identity }) => sameIdentity(entry, identity));

    if (seed && seed.seed !== entry.path) settle(entry, seed.seed);
  }

  // parents first, so their children are carried rather than moved
  missing.sort((a, b) => a.path.length - b.path.length);

  for (const entry of [...missing]) {
    if (await carried(entry)) {
      missing.splice(missing.indexOf(entry), 1);

      continue;
    }

    // a sibling settles with a stat, saving locate's shell for the first entry under each moved parent
    const found =
      cases.get(entry) ??
      (await sibling(entry)) ??
      (await locate(entry).catch((error: unknown) => {
        unreachable(entry, error);

        return undefined;
      }));

    if (found && found !== entry.path) settle(entry, found);
  }

  for (let progress = true; progress;) {
    progress = false;

    for (const entry of [...missing]) {
      if (await carried(entry)) {
        missing.splice(missing.indexOf(entry), 1);

        progress = true;

        continue;
      }

      const found = await sibling(entry);

      if (found) {
        settle(entry, found);

        progress = true;
      }
    }
  }

  return inOrder(moves);
}

/**
 * one pass's moves in an order they could have happened: a move out of a path before any move into it, which the
 * mapper relies on. a cycle, such as two directories swapped, keeps the order it was found in.
 */
function inOrder(
  moves: ReadonlyArray<Move & Identity>,
): Array<Move & Identity> {
  const rest = [...moves];

  const ordered: Array<Move & Identity> = [];

  const after = (move: Move, other: Move) =>
    within(move.to, other.from) || within(other.from, move.to);

  while (rest.length) {
    const ready = rest.findIndex(
      (move) => !rest.some((other) => other !== move && after(move, other)),
    );

    ordered.push(...rest.splice(Math.max(ready, 0), 1));
  }

  return ordered;
}

/**
 * the ledger's entries by path, by the `main` each names and under each of `sources`, kept current as relocations
 * move them, so a batch of relocations never rescans the ledger. `finish` drops the entries they displaced.
 */
function entryIndex(ledger: Ledger, sources: readonly string[] = []) {
  const holding = new Map(
    sources.map((source) => [source, new Set<DirectoryEntry>()]),
  );

  const dropped = new Set<DirectoryEntry>();

  const add = (
    index: Map<string, Set<DirectoryEntry>>,
    key: string,
    entry: DirectoryEntry,
  ) => {
    const there = index.get(key);

    if (there) there.add(entry);
    else index.set(key, new Set([entry]));
  };

  const shortest = sources.reduce(
    (length, source) => Math.min(length, source.length),
    Infinity,
  );

  const place = (entry: DirectoryEntry, keep: boolean) => {
    for (const prefix of prefixes(entry.path)) {
      if (prefix.length < shortest) break;

      if (keep) holding.get(prefix)?.add(entry);
      else holding.get(prefix)?.delete(entry);
    }
  };

  for (const entry of ledger.entries) place(entry, true);

  // built when first needed, so a move that carries nothing skips them
  let lookups:
    | {
        order: Map<DirectoryEntry, number>;
        at: Map<string, Set<DirectoryEntry>>;
        naming: Map<string, Set<DirectoryEntry>>;
      }
    | undefined;

  const lookup = () => {
    if (lookups) return lookups;

    lookups = { order: new Map(), at: new Map(), naming: new Map() };

    for (const [index, entry] of ledger.entries.entries()) {
      lookups.order.set(entry, index);

      add(lookups.at, entry.path, entry);

      if (entry.main !== undefined) add(lookups.naming, entry.main, entry);
    }

    return lookups;
  };

  return {
    /** the entries within `source`, one of `sources`, in ledger order. */
    under: (source: string) =>
      [...(holding.get(source) ?? [])].sort((a, b) => {
        const { order } = lookup();

        return order.get(a)! - order.get(b)!;
      }),
    relocate(relocations: ReadonlyArray<readonly [DirectoryEntry, string]>) {
      if (!relocations.length) return;

      const { at, naming } = lookup();

      const renamed = new Map<string, string>();

      for (const [entry, path] of relocations) {
        if (dropped.has(entry)) continue;

        for (const other of at.get(path) ?? [])
          if (other !== entry) {
            dropped.add(other);

            place(other, false);
          }

        at.get(entry.path)?.delete(entry);

        at.set(path, new Set([entry]));

        place(entry, false);

        renamed.set(entry.path, path);

        entry.path = path;

        place(entry, true);
      }

      // read before any is renamed, so a `main` moves one step however the relocations chain
      const references = [...renamed].map(
        ([from, to]) => [[...(naming.get(from) ?? [])], to] as const,
      );

      for (const [entries, to] of references)
        for (const entry of entries) {
          naming.get(entry.main!)?.delete(entry);

          entry.main = to;

          add(naming, to, entry);
        }
    },
    finish() {
      if (dropped.size)
        ledger.entries = ledger.entries.filter((entry) => !dropped.has(entry));
    },
  };
}

/**
 * puts each entry at its path, in order, with each `main` naming it. any other entry there is dropped with its
 * repository and slot: it described a directory gone from there, or the same one recorded before a declared copy. one
 * dropped by an earlier relocation stays dropped.
 */
export function relocate(
  ledger: Ledger,
  relocations: ReadonlyArray<readonly [DirectoryEntry, string]>,
): void {
  const index = entryIndex(ledger);

  index.relocate(relocations);

  index.finish();
}

/**
 * appends each move unless it's already the newest move of its directory, then moves every entry, and each `main`
 * naming it, whose directory now sits where the move puts it.
 */
export async function resolve(
  ledger: Ledger,
  moves: ReadonlyArray<Move & Identity>,
  prompts: number,
): Promise<void> {
  const key = ({ device, inode, birthtimeNs }: Identity) =>
    `${device}\0${inode}\0${birthtimeNs ?? ''}`;

  const newest = new Map(ledger.moves.map((move) => [key(move), move]));

  const entries = entryIndex(
    ledger,
    moves.map(({ from }) => from),
  );

  for (const move of moves) {
    const last = newest.get(key(move));

    // moves are searched by recording time, which a clock stepping back mustn't reorder or tie
    if (last?.from !== move.from || last.to !== move.to) {
      const recorded = {
        ...move,
        prompts,
        at: Math.max(Date.now(), (ledger.moves.at(-1)?.at ?? -1) + 1),
      };

      ledger.moves.push(recorded);

      newest.set(key(move), recorded);
    }

    const carried: Array<[DirectoryEntry, string]> = [];

    for (const entry of entries.under(move.from)) {
      const target = through(entry.path, move);

      if (
        sameIdentity(entry, await identify(target).catch(() => undefined)) &&
        !(await caseDestination(target, entry).catch(() => true))
      )
        carried.push([entry, target]);
    }

    entries.relocate(carried);
  }

  entries.finish();
}
