import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { errorMessage } from '../agents/stderr.js';
import type { Memory } from '../memory/memory.js';
import { projectKey } from '../memory/memory.js';
import {
  adoptIdentity,
  findMoves,
  identify,
  sameIdentity,
  mapper,
  prefixes,
  present,
  readLedger,
  relocate,
  resolve,
  updateLedger,
  within,
} from '../persistence/directories.js';
import type {
  DirectoryEntry,
  Identity,
  Ledger,
  Mapping,
  Move,
  Owner,
} from '../persistence/directories.js';
import { replaceFile, unlessGone } from '../persistence/json.js';
import {
  stopPreviousProcess,
  stopPreviousShell,
} from '../persistence/process.js';
import { LockedElsewhere } from '../persistence/store.js';
import type { StateStore } from '../persistence/store.js';
import { quote } from '../shell.js';
import { runCommand } from './command.js';
import type { Run } from './repository.js';
import { conversationRecordSchema, displayUpdateSchema } from './state.js';
import type { ConversationRecord } from './state.js';
import { repairRepositories, worktreeList } from './worktree-repair.js';

export interface MoveReport {
  repaired: Array<Move & { conversations: number; worktrees: number }>;
  /** `repository` names the main checkout whose worktree links couldn't be checked or repaired, or that a recorded checkout's Git reaches instead of its own. */
  blocked: Array<{ path: string; reason: string; repository?: string }>;
  unresolved: Array<{ path: string; conversations: number; worktree: boolean }>;
  suspended: Array<Move & { conversations: number }>;
}

/**
 * rewrites history lines whose `cwd` the mapping changes and leaves every other byte alone, including torn, foreign
 * and CRLF lines.
 */
function rewriteLines(
  content: Buffer,
  destination: (cwd: string) => string,
): { content: Buffer; count: number } {
  const parts: Buffer[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let count = 0;
  for (let start = 0; start < content.length;) {
    const newline = content.indexOf(10, start);
    const end = newline < 0 ? content.length : newline;
    const next = newline < 0 ? end : end + 1;
    const textEnd = content[end - 1] === 13 ? end - 1 : end;
    let line = content.subarray(start, next);
    try {
      const raw: unknown = JSON.parse(
        decoder.decode(content.subarray(start, textEnd)),
      );
      const checked = displayUpdateSchema.safeParse(raw);
      if (checked.success) {
        const cwd = destination(checked.data.cwd);
        if (cwd !== checked.data.cwd) {
          line = Buffer.concat([
            Buffer.from(
              JSON.stringify({ ...(raw as Record<string, unknown>), cwd }),
            ),
            content.subarray(textEnd, next),
          ]);
          count++;
        }
      }
    } catch {
      // a torn or unreadable line stays available for the store's existing recovery rules
    }
    parts.push(line);
    start = next;
  }
  return { content: count ? Buffer.concat(parts) : content, count };
}

/**
 * a record as the owner of its cwd: there since before a move was recorded, the directory that moved was its own. one
 * waiting at a path another directory took stays there.
 */
export const savedBefore = ({
  createdAt,
  cwdSince,
}: Pick<ConversationRecord, 'createdAt' | 'cwdSince'>): Owner => ({
  predates: (move) => Date.parse(cwdSince ?? createdAt) < move.at,
  throughReused: false,
});

/** the project key and path-keyed top at `to`, which Git discovery finds once per repair for every conversation going there. */
const scopeAt = async (memory: Memory, to: string) => ({
  project: (await memory.scopePaths(to)).project,
  top: await memory.pathScope(to),
});
type Scopes = Map<string, ReturnType<typeof scopeAt>>;

const compatible = async (
  memory: Memory,
  record: ConversationRecord,
  from: string,
  to: string,
  scopes: Scopes,
) => {
  const delivered = Object.values(record.sessions).flatMap(
    ({ deliveredProject }) => (deliveredProject ? [deliveredProject] : []),
  );
  if (!delivered.length) return true;
  if (!scopes.has(to)) scopes.set(to, scopeAt(memory, to));
  const { project, top } = await scopes.get(to)!;
  // a path-keyed project's key changes with the path, so the old path's key counts too
  const rest = top && to.slice(top.length);
  const old =
    rest !== undefined && from.endsWith(rest)
      ? projectKey(from.slice(0, from.length - rest.length))
      : undefined;
  return delivered.every((key) => key === project || key === old);
};

/** why a move the user declares can't be applied, found before anything is written. */
async function declaredProblem(
  declared: Move,
  records: readonly ConversationRecord[],
  memory: Memory,
  scopes: Scopes,
): Promise<string | undefined> {
  if (!isAbsolute(declared.from))
    return 'Choose an absolute saved directory to recover';
  if (await present(declared.from)) return 'The source directory still exists';
  for (const record of records) {
    if (!within(record.cwd, declared.from)) continue;
    const target = declared.to + record.cwd.slice(declared.from.length);
    const checkAt = await memory.scopePaths(target).then(
      () => target,
      () => declared.to,
    );
    if (!(await compatible(memory, record, record.cwd, checkAt, scopes)))
      return `The saved project memory scope of ${record.title} differs from ${declared.to}`;
  }
  return undefined;
}

/**
 * finds where the ledger's known directories went, adds a declared move, and records them in `ledger` with the size of
 * `prompts.jsonl` under `root`.
 */
async function recordMoves(
  ledger: Ledger,
  root: string,
  seeds: readonly string[],
  records: readonly ConversationRecord[],
  declared: Move | undefined,
  report: MoveReport,
): Promise<Array<Move & Identity>> {
  // entries worth finding: Git-backed ones, and ones holding a seed or a record cwd before or after the ledger maps
  // it. the holders are collected once, so the check stays linear in entries and records
  const { map } = await mapper(ledger);
  const held = new Set<string>();
  for (const path of [
    ...seeds,
    ...records.flatMap((saved) => [
      saved.cwd,
      map(saved.cwd, savedBefore(saved)),
    ]),
  ])
    if (path !== undefined)
      for (const prefix of prefixes(path)) held.add(prefix);
  const used = (entry: DirectoryEntry) =>
    entry.main !== undefined || held.has(entry.path);
  const moves = await findMoves(
    ledger.entries.filter(used),
    seeds,
    (entry, error) =>
      report.blocked.push({
        path: entry.path,
        reason: `Couldn't look for where it went: ${errorMessage(error)}`,
      }),
  );
  const copyIdentity = declared && (await identify(declared.to));
  if (declared && !copyIdentity)
    report.blocked.push({
      path: declared.to,
      reason: 'The destination directory is gone',
    });
  const vouched =
    declared && copyIdentity
      ? { path: declared.to, ...copyIdentity }
      : undefined;
  if (declared && vouched)
    moves.push({
      ...declared,
      device: vouched.device,
      inode: vouched.inode,
    });
  // read under the ledger lock, so prompts added while repair waited for it count as before the move
  const promptsSize =
    (await unlessGone(stat(join(root, 'prompts.jsonl'))))?.size ?? 0;
  await resolve(ledger, moves, promptsSize);
  // a declared move is a copy, so the directories under it have new identities the user vouches for
  if (declared && vouched) {
    const copied: Array<[DirectoryEntry, string]> = [];
    for (const entry of ledger.entries) {
      if (!within(entry.path, declared.from)) continue;
      const path = declared.to + entry.path.slice(declared.from.length);
      const identity = await identify(path);
      if (!identity) continue;
      Object.assign(entry, identity);
      copied.push([entry, path]);
    }
    relocate(ledger, copied);
    // the copy itself, so a stand-in put there later is never taken for it
    if (
      !ledger.entries.some(
        (entry) => entry.path === vouched.path && sameIdentity(entry, vouched),
      )
    ) {
      ledger.entries.push(vouched);
      relocate(ledger, [[vouched, vouched.path]]);
    }
  }
  return moves;
}

/**
 * finds where known directories went, repairs the Git links of their worktrees and rewrites the conversations saved
 * in them, stopping the native processes and `!` shells a crash left running there. `declared` is a move the user
 * asserts, checked before anything is written; `preview` writes nothing.
 */
export async function repairMoves(
  store: StateStore,
  memory: Memory,
  cwd: string,
  {
    declared,
    preview = false,
    run = runCommand,
  }: { declared?: Move; preview?: boolean; run?: Run } = {},
): Promise<MoveReport> {
  const report: MoveReport = {
    repaired: [],
    blocked: [],
    unresolved: [],
    suspended: [],
  };
  const { records, unreadable } = await store.records();
  const scopes: Scopes = new Map();
  if (declared)
    report.blocked.push(
      ...unreadable.map(({ file, error }) => ({ path: file, reason: error })),
    );
  const listed = await worktreeList(run, cwd);
  const seeds = [cwd, ...(listed ?? [])];

  if (declared) {
    const problem = await declaredProblem(declared, records, memory, scopes);
    if (problem) {
      report.blocked.push({ path: declared.from, reason: problem });
      return report;
    }
  }

  // a preview works on one copy of the ledger and never writes it
  let copy: Ledger | undefined;
  const change = async <T>(apply: (ledger: Ledger) => Promise<T>) =>
    preview
      ? apply((copy ??= await readLedger(store.root)))
      : updateLedger(store.root, apply);

  const found = await change((ledger) =>
    recordMoves(ledger, store.root, seeds, records, declared, report),
  );

  const { ledger, resolved } = await change(async (ledger) => {
    // the identities as resolved, before record() takes in what sits at a path whose recorded directory is gone, and
    // the newest move's time: every move recorded later is dated after it, so a conversation dated from this follows
    // those and none before, whatever the clock reads
    const copied = structuredClone(ledger);
    const resolved: Snapshot = {
      ledger: copied,
      mapping: await mapper(copied),
      at: new Date(ledger.moves.at(-1)?.at ?? Date.now()).toISOString(),
    };
    const { map } = await mapper(ledger);
    await repairRepositories(ledger, listed?.[0], map, report, run, preview);
    if (!preview) await record(ledger, cwd, seeds, records, run, report);
    return { ledger, resolved };
  });

  const tally = await repairConversations(store, memory, records, {
    ledger,
    found,
    resolved,
    scopes,
    preview,
    report,
  });
  summarize(report, found, ledger, tally);
  return report;
}

/** rewrites each conversation whose directory moved and tallies the outcomes for `summarize`; a blocked one goes to `report` directly. */
async function repairConversations(
  store: StateStore,
  memory: Memory,
  records: readonly ConversationRecord[],
  {
    ledger,
    found,
    resolved,
    scopes,
    preview,
    report,
  }: {
    ledger: Ledger;
    found: ReadonlyArray<Move & Identity>;
    resolved: Snapshot;
    scopes: Scopes;
    preview: boolean;
    report: MoveReport;
  },
): Promise<Tally> {
  const { map, suspended } = await mapper(ledger);
  const tally: Tally = { repaired: [], suspended: [], unresolved: [] };
  // each directory this repair resolved, by path, a ledger entry over a move found to the same place
  const resolvedPaths = new Map<string, Identity & { path: string }>();
  for (const known of [
    ...resolved.ledger.entries,
    ...found.map(({ to, device, inode }) => ({ path: to, device, inode })),
  ])
    if (!resolvedPaths.has(known.path)) resolvedPaths.set(known.path, known);
  for (const saved of records) {
    try {
      const target = map(saved.cwd, savedBefore(saved));
      if (target === undefined) {
        const move = suspended.find(({ from }) => within(saved.cwd, from));
        if (move) tally.suspended.push(move);
        else tally.unresolved.push(saved.cwd);
        continue;
      }
      const current = await identify(target);
      if (!current) {
        tally.unresolved.push(saved.cwd);
        continue;
      }
      if (target === saved.cwd) continue;
      // the nearest directory this repair resolved at or above the target, which a stand-in put there since won't match
      const destination = [...prefixes(target)].flatMap(
        (path) => resolvedPaths.get(path) ?? [],
      )[0] ?? { path: target, ...current };
      if (!(await compatible(memory, saved, saved.cwd, target, scopes))) {
        report.blocked.push({
          path: saved.cwd,
          reason: `${saved.title}'s saved project memory scope differs from ${target}`,
        });
        continue;
      }
      const repaired =
        preview ||
        (await rewrite(store, saved, target, destination, resolved, report));
      if (repaired) tally.repaired.push({ from: saved.cwd, to: target });
    } catch (error) {
      report.blocked.push({
        path: saved.cwd,
        reason: `Could not inspect it: ${errorMessage(error)}`,
      });
    }
  }
  return tally;
}

/**
 * records the identities of `cwd`, the seeds and every present record cwd, with each worktree's main and slot, except
 * where the directory recorded at a path still exists elsewhere.
 */
async function record(
  ledger: Ledger,
  cwd: string,
  seeds: readonly string[],
  records: readonly ConversationRecord[],
  run: Run,
  report: MoveReport,
) {
  // each path's entry is a map lookup rather than a scan of the entries
  const byPath = new Map(ledger.entries.map((entry) => [entry.path, entry]));
  /** the entry for what's at `path` now, or undefined while the one recorded there still exists elsewhere. */
  const upsert = async (path: string, identity: Identity) => {
    const entry = byPath.get(path);
    if (!entry) {
      const added: DirectoryEntry = { path, ...identity };
      ledger.entries.push(added);
      byPath.set(path, added);
      return added;
    }
    return (await adoptIdentity(entry, identity)) ? entry : undefined;
  };
  const paths = new Set([cwd, ...seeds, ...records.map(({ cwd }) => cwd)]);
  const lists = new Map<string, string[]>();
  // every worktree of a repository lists the same registrations
  const listing = new Map<string, string[]>();
  for (const path of paths) {
    const identity = await identify(path).catch(() => undefined);
    if (!identity) continue;
    const list = listing.get(path) ?? (await worktreeList(run, path));
    const main = list?.[0];
    if (main && !lists.has(main)) {
      lists.set(main, list);
      for (const listed of list) listing.set(listed, list);
    }
    // a recorded main that Git no longer reaches means this directory's Git now belongs to another repository
    const known = byPath.get(path);
    if (
      path === cwd &&
      known?.main &&
      main &&
      known.main !== main &&
      sameIdentity(known, identity)
    ) {
      report.blocked.push({
        path,
        reason: `its Git reaches ${main}, not its recorded main checkout ${known.main}`,
        repository: main,
      });
      continue;
    }
    if (!list?.includes(path)) await upsert(path, identity);
  }
  const holding = new Set(records.flatMap(({ cwd }) => [...prefixes(cwd)]));
  for (const [main, list] of lists) {
    for (const path of list) {
      // one that can't be looked at keeps its entry as it was
      const identity = await identify(path).catch(() => undefined);
      if (!identity) continue;
      const entry = await upsert(path, identity);
      if (entry) entry.main = main;
    }
    const registered = ledger.entries.filter(
      (entry) => entry.main === main && list.includes(entry.path),
    );
    for (const entry of registered) {
      const slot = entry.path.startsWith(main)
        ? /^-([1-9]\d{0,8})$/.exec(entry.path.slice(main.length))?.[1]
        : undefined;
      if (
        entry.slot === undefined &&
        slot &&
        !registered.some((other) => other.slot === Number(slot))
      )
        entry.slot = Number(slot);
    }
    // a worktree Git no longer lists, with no conversation in it, is gone for good, unless a blocked repository's list is stale
    if (report.blocked.some(({ repository }) => repository === main)) continue;
    ledger.entries = ledger.entries.filter((entry) => {
      const kept =
        entry.main !== main ||
        list.includes(entry.path) ||
        holding.has(entry.path);
      if (!kept) byPath.delete(entry.path);
      return kept;
    });
  }
}

/** rewrites one conversation's history and record under its lock, stopping native processes and `!` shells a crash left running, or says why it can't. */
async function rewrite(
  store: StateStore,
  saved: ConversationRecord,
  target: string,
  destination: Identity & { path: string },
  resolved: Snapshot,
  report: MoveReport,
): Promise<boolean> {
  try {
    return (
      (await store.repairRecord(saved.id, async (raw, directory) => {
        const current = conversationRecordSchema.parse(raw);
        if (current.cwd !== saved.cwd) return undefined;
        // holding the lock means no Witch has it open, so these are left from a crash, and claim would stop them too
        if (current.shell) await stopPreviousShell(current.shell);
        for (const identity of [
          current.process,
          current.usageProcess,
          current.answerProcess,
        ])
          if (identity) await stopPreviousProcess(identity);
        // the mapping as resolved must still give the target, and anything it relied on that changed while this waited
        // for the lock or the stops leaves the conversation for the next start
        const owner = savedBefore(saved);
        if (
          resolved.mapping.map(saved.cwd, owner) !== target ||
          !(await resolved.mapping.unchanged(saved.cwd, owner)) ||
          !sameIdentity(destination, await identify(destination.path))
        ) {
          report.blocked.push({
            path: saved.cwd,
            reason: `where it moved changed during the repair, so ${saved.title} waits for the next start`,
          });
          return undefined;
        }
        const history = join(directory, 'history.jsonl');
        const times = await unlessGone(stat(history));
        if (times) {
          const { content, count } = rewriteLines(
            await readFile(history),
            (cwd) =>
              within(cwd, saved.cwd)
                ? target + cwd.slice(saved.cwd.length)
                : cwd,
          );
          if (count) await replaceFile(history, content, times);
        }
        return { ...raw, cwd: target, cwdSince: resolved.at };
      })) === 'repaired'
    );
  } catch (error) {
    if (!(error instanceof LockedElsewhere)) throw error;
    report.blocked.push({
      path: saved.cwd,
      reason: `${saved.title} is open in another Witch`,
    });
    return false;
  }
}

/** the ledger as move resolution left it, its moves as the filesystem read then, and its newest move's time. */
interface Snapshot {
  ledger: Ledger;
  mapping: Mapping;
  at: string;
}

/** the conversations each outcome left, before they're grouped into report lines. */
interface Tally {
  repaired: Move[];
  suspended: Move[];
  unresolved: string[];
}

/** one line per repaired main checkout, with its worktrees' moves folded in, and the counts of the rest. */
function summarize(
  report: MoveReport,
  found: readonly Move[],
  ledger: Ledger,
  tally: Tally,
) {
  const lines = new Map<
    string,
    Move & { conversations: number; worktrees: number }
  >();
  const line = (move: Move) => {
    const key = `${move.from}\0${move.to}`;
    let known = lines.get(key);
    if (!known) {
      known = { from: move.from, to: move.to, conversations: 0, worktrees: 0 };
      lines.set(key, known);
    }
    return known;
  };
  // a worktree whose main checkout moved too counts on its repository's line
  const mainOf = (move: Move) =>
    ledger.entries.find((entry) => entry.path === move.to)?.main;
  const owner = (move: Move) => {
    const main = mainOf(move);
    return (main !== move.to && found.find(({ to }) => to === main)) || move;
  };
  for (const move of found) {
    const known = line(owner(move));
    const main = mainOf(move);
    if (main !== undefined && main !== move.to) known.worktrees++;
  }
  for (const { from, to } of tally.repaired) {
    const move = found
      .filter((known) => within(from, known.from))
      .sort((a, b) => b.from.length - a.from.length)[0];
    line(move ? owner(move) : { from, to }).conversations++;
  }
  for (const move of new Set(tally.suspended))
    report.suspended.push({
      from: move.from,
      to: move.to,
      conversations: tally.suspended.filter((other) => other === move).length,
    });
  for (const path of new Set(tally.unresolved)) {
    const conversations = tally.unresolved.filter(
      (other) => other === path,
    ).length;
    // a missing worktree that held conversations is one directory to recover
    const worktree = report.unresolved.find((row) => row.path === path);
    if (worktree) worktree.conversations = conversations;
    else report.unresolved.push({ path, conversations, worktree: false });
  }
  report.repaired.push(...lines.values());
}

export function describeMoves(
  report: MoveReport,
  root: string,
  preview = false,
): string | undefined {
  const lines = [
    ...report.repaired.map(
      ({ from, to, conversations, worktrees }) =>
        `${preview ? 'Would repair' : 'Repaired'} the move of ${from} to ${to}: ${conversations} conversation(s), ${worktrees} worktree(s).`,
    ),
    ...report.blocked.map(
      ({ path, reason }) => `Couldn't repair ${path}: ${reason}.`,
    ),
    ...report.suspended.map(
      ({ from, conversations }) =>
        `${from} holds another directory now, so ${conversations} conversation(s) saved there before it moved stay listed there.`,
    ),
    ...report.unresolved.map(
      ({ path, conversations, worktree }) =>
        `Couldn't find where ${path} went${worktree ? ', a worktree that moved or was deleted' : ''}${conversations ? `, with ${conversations} conversation(s)` : ''}. Start Witch in its new location, or from there preview recovery with:\nwitch --state-dir ${quote(root)} --recover-directory ${quote(path)}`,
    ),
  ];
  if (!lines.length) return undefined;
  if (preview) lines.push('Preview only. Repeat with --apply to repair.');
  return lines.join('\n');
}

/** the startup notice for moved directories, or the reason they couldn't be checked. */
export async function startupMoves(
  store: StateStore,
  memory: Memory,
  cwd: string,
): Promise<string | undefined> {
  return repairMoves(store, memory, cwd).then(
    (report) => describeMoves(report, store.root),
    (error: unknown) =>
      `Could not inspect moved directories: ${errorMessage(error)}`,
  );
}
