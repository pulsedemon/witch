import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { errorMessage } from '../agents/stderr.js';
import { readJson, writeJson } from './json.js';
import { openLocked } from './lock.js';

const execute = promisify(execFile);

const identitySchema = z.object({ device: z.string(), inode: z.string() });
const entrySchema = identitySchema.extend({
  path: z.string(),
  main: z.string().optional(),
  slot: z.number().int().positive().optional(),
});
const moveSchema = identitySchema.extend({
  from: z.string(),
  to: z.string(),
  prompts: z.number().int().nonnegative(),
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
/** a move with the identity of the directory that moved, and the size of `prompts.jsonl` when it was recorded. */
export type LedgerMove = z.infer<typeof moveSchema>;
export interface Ledger {
  entries: DirectoryEntry[];
  moves: LedgerMove[];
}

const ledgerFile = (root: string) => join(root, 'directories.json');

/** `path` itself or a path under it. */
export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? root : `${root}/`);
}

export function sameIdentity(a: Identity, b: Identity | undefined): boolean {
  return a.device === b?.device && a.inode === b.inode;
}

/** undefined for a path that's gone. */
export async function identify(path: string): Promise<Identity | undefined> {
  try {
    const { dev, ino } = await stat(path, { bigint: true });
    return { device: String(dev), inode: String(ino) };
  } catch (error) {
    if (
      ['ENOENT', 'ENOTDIR'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      return undefined;
    throw error;
  }
}

/** where a directory is now, which macOS resolves by device and inode under /.vol. node's realpath can't read /.vol, so sh does. */
export async function locate(identity: Identity): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await execute('/bin/sh', [
      '-c',
      'CDPATH= cd -P "/.vol/$1/$2" && pwd -P',
      'witch-locate',
      identity.device,
      identity.inode,
    ]);
    const path = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
    return sameIdentity(identity, await identify(path)) ? path : undefined;
  } catch {
    return undefined;
  }
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
    await writeJson(ledgerFile(root), { version: 1, ...ledger });
    return result;
  } finally {
    await lock.close();
  }
}

type Source = 'gone' | 'back' | 'reused';

/**
 * maps old paths through the ledger's moves. each step takes the most specific move whose `from` holds the path, of
 * equals the first recorded after `offset`, else the latest, and a move applies once. a `from` holding the moved
 * directory again, or one that can't be looked at, stops the chain there; one holding another directory stops it with
 * nothing, unless `offset` predates the move.
 */
export async function mapper(ledger: Ledger): Promise<{
  map(path: string, offset?: number): string | undefined;
  suspended: Move[];
}> {
  const sources: Source[] = await Promise.all(
    ledger.moves.map(async (move) => {
      const found = await identify(move.from).catch(() => move);
      if (!found) return 'gone';
      return sameIdentity(move, found) ? 'back' : 'reused';
    }),
  );
  const raw = (path: string, offset?: number): string | undefined => {
    const applied = new Set<number>();
    for (let current = path; ;) {
      let chosen = -1;
      for (const [index, move] of ledger.moves.entries()) {
        if (applied.has(index) || !within(current, move.from)) continue;
        const best = ledger.moves[chosen];
        if (
          !best ||
          move.from.length > best.from.length ||
          (move.from.length === best.from.length &&
            !(offset !== undefined && offset < best.prompts))
        )
          chosen = index;
      }
      if (chosen < 0) return current;
      const move = ledger.moves[chosen]!;
      const source = sources[chosen]!;
      if (source === 'back') return current;
      if (
        source === 'reused' &&
        !(offset !== undefined && offset < move.prompts)
      )
        return undefined;
      applied.add(chosen);
      current = move.to + current.slice(move.from.length);
    }
  };
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
    map(path, offset) {
      if (stranded.some((root) => within(path, root))) return undefined;
      return raw(path, offset);
    },
    suspended: ledger.moves.filter((_, index) => sources[index] === 'reused'),
  };
}

/** paths under `move.from` mapped through it. */
const through = (path: string, { from, to }: Move) =>
  within(path, from) ? to + path.slice(from.length) : path;

/**
 * where missing entries went: seeds, then on macOS each one's own identity, then siblings of a resolved move that hold
 * their identity. an entry carried along by a resolved move gets no move of its own.
 */
export async function findMoves(
  entries: readonly DirectoryEntry[],
  seeds: readonly string[],
): Promise<Array<Move & Identity>> {
  // an entry that can't be looked at stays put, and so do its records, which report why
  const missing: DirectoryEntry[] = [];
  for (const entry of entries)
    if (!sameIdentity(entry, await identify(entry.path).catch(() => entry)))
      missing.push(entry);
  const look = (path: string) => identify(path).catch(() => undefined);
  const moves: Array<Move & Identity> = [];
  const carried = async (entry: DirectoryEntry) => {
    for (const move of moves) {
      if (!within(entry.path, move.from) || entry.path === move.from) continue;
      if (sameIdentity(entry, await look(through(entry.path, move))))
        return true;
    }
    return false;
  };
  const settle = (entry: DirectoryEntry, to: string) => {
    missing.splice(missing.indexOf(entry), 1);
    moves.push({
      from: entry.path,
      to,
      device: entry.device,
      inode: entry.inode,
    });
  };
  const seeded = await Promise.all(
    seeds.map(async (seed) => ({ seed, identity: await look(seed) })),
  );
  for (const entry of [...missing]) {
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
    const found = await locate(entry);
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
      for (const move of [...moves]) {
        const candidates: string[] = [];
        if (dirname(entry.path) === dirname(move.from)) {
          const name = basename(entry.path);
          const moved = basename(move.from);
          candidates.push(join(dirname(move.to), name));
          if (name.startsWith(moved))
            candidates.push(
              join(
                dirname(move.to),
                basename(move.to) + name.slice(moved.length),
              ),
            );
        }
        const found = await (async () => {
          for (const candidate of candidates)
            if (sameIdentity(entry, await look(candidate))) return candidate;
          return undefined;
        })();
        if (found) {
          settle(entry, found);
          progress = true;
          break;
        }
      }
    }
  }
  return moves;
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
  for (const move of moves) {
    const newest = ledger.moves.findLast((known) => sameIdentity(known, move));
    if (newest?.from !== move.from || newest.to !== move.to)
      ledger.moves.push({ ...move, prompts });
    for (const entry of ledger.entries) {
      if (!within(entry.path, move.from)) continue;
      const target = through(entry.path, move);
      if (!sameIdentity(entry, await identify(target).catch(() => undefined)))
        continue;
      for (const other of ledger.entries)
        if (other.main === entry.path) other.main = target;
      entry.path = target;
    }
  }
}
