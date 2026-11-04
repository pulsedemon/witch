import { readFile, readdir, stat } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve as resolvePath,
} from 'node:path';
import { errorMessage } from '../agents/stderr.js';
import type { Memory } from '../memory/memory.js';
import { projectKey } from '../memory/memory.js';
import {
  adoptIdentity,
  findMoves,
  identify,
  sameIdentity,
  mapper,
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
  Move,
  Owner,
} from '../persistence/directories.js';
import { replaceFile } from '../persistence/json.js';
import {
  stopPreviousProcess,
  stopPreviousShell,
} from '../persistence/process.js';
import { LockedElsewhere } from '../persistence/store.js';
import type { StateStore } from '../persistence/store.js';
import { quote } from '../shell.js';
import { runCommand } from './command.js';
import { statusArgs, statusEnv } from './repository.js';
import type { Run } from './repository.js';
import { conversationRecordSchema, displayUpdateSchema } from './state.js';
import type { ConversationRecord } from './state.js';

export interface MoveReport {
  repaired: Array<Move & { conversations: number; worktrees: number }>;
  /** `repository` names the main checkout whose worktree links couldn't be checked or repaired, or that a recorded checkout's Git reaches instead of its own. */
  blocked: Array<{ path: string; reason: string; repository?: string }>;
  unresolved: Array<{ path: string; conversations: number; worktree: boolean }>;
  suspended: Array<Move & { conversations: number }>;
}

interface Registration {
  name: string;
  /** where the registration points now, which is gone for a worktree that moved */
  registered: string;
}

/** whether a path exists; a failure to look, such as a parent without permission, throws. */
const exists = async (path: string) => (await identify(path)) !== undefined;

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

/** the paths `git worktree list` registers for `cwd`'s repository, main checkout first. */
export async function listWorktrees(run: Run, cwd: string): Promise<string[]> {
  const { stdout } = await run(
    'git',
    ['worktree', 'list', '--porcelain', '-z'],
    { cwd, timeout: 60_000 },
  );
  return stdout
    .split('\0')
    .flatMap((line) =>
      line.startsWith('worktree ') ? [line.slice('worktree '.length)] : [],
    );
}

/** the worktree list, or undefined where Git can't list them, such as outside a repository. */
const worktreeList = (run: Run, cwd: string) =>
  listWorktrees(run, cwd).catch(() => undefined);

/** undefined for a file that's gone; one that can't be read throws, so its caller reports it rather than skipping it. */
const unlessGone = <T>(read: Promise<T>): Promise<T | undefined> =>
  read.catch((error: unknown) => {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  });

async function registrations(common: string): Promise<Registration[]> {
  const names = (await unlessGone(readdir(join(common, 'worktrees')))) ?? [];
  const found: Registration[] = [];
  for (const name of names) {
    const admin = join(common, 'worktrees', name);
    const gitdir = await unlessGone(readFile(join(admin, 'gitdir'), 'utf8'));
    // a registration removed whole while this read is gone; one left without its gitdir can't be checked
    if (gitdir === undefined && !(await exists(admin))) continue;
    if (!gitdir?.trim())
      throw new Error(
        `${admin} names no worktree; run git worktree prune in ${dirname(common)}`,
      );
    // Git may write it relative to the registration's own directory
    found.push({
      name,
      registered: dirname(resolvePath(admin, gitdir.trim())),
    });
  }
  return found;
}

/** the admin directory a worktree's `.git` file names, `<common>/worktrees/<name>`, which Git may write relative to it. */
async function namedAdmin(worktree: string): Promise<string | undefined> {
  const text = await readFile(join(worktree, '.git'), 'utf8').catch(
    () => undefined,
  );
  return text?.startsWith('gitdir: ')
    ? resolvePath(worktree, text.slice(8).trim())
    : undefined;
}

/** whether a worktree of a main checkout that can't be found is still there, broken until its main is recovered. */
async function leftWorktree(
  ledger: Ledger,
  main: string,
  map: (path: string) => string | undefined,
): Promise<boolean> {
  for (const entry of ledger.entries) {
    if (entry.path === entry.main || !entry.main || map(entry.main) !== main)
      continue;
    const path = map(entry.path);
    if (path && (await exists(path))) return true;
  }
  return false;
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

const compatible = async (
  memory: Memory,
  record: ConversationRecord,
  from: string,
  to: string,
) => {
  const delivered = Object.values(record.sessions).flatMap(
    ({ deliveredProject }) => (deliveredProject ? [deliveredProject] : []),
  );
  if (!delivered.length) return true;
  const project = (await memory.scopePaths(to)).project;
  const top = await memory.pathScope(to);
  // a path-keyed project's key changes with the path, so the old path's key counts too
  const rest = top && to.slice(top.length);
  const old =
    rest !== undefined && from.endsWith(rest)
      ? projectKey(from.slice(0, from.length - rest.length))
      : undefined;
  return delivered.every((key) => key === project || key === old);
};

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
  if (declared)
    report.blocked.push(
      ...unreadable.map(({ file, error }) => ({ path: file, reason: error })),
    );
  const listed = await worktreeList(run, cwd);
  const seeds = [cwd, ...(listed ?? [])];

  if (declared) {
    const problem = await (async () => {
      if (!isAbsolute(declared.from))
        return 'Choose an absolute saved directory to recover';
      if (await exists(declared.from))
        return 'The source directory still exists';
      for (const record of records) {
        if (!within(record.cwd, declared.from)) continue;
        const target = declared.to + record.cwd.slice(declared.from.length);
        const checkAt = await memory.scopePaths(target).then(
          () => target,
          () => declared.to,
        );
        if (!(await compatible(memory, record, record.cwd, checkAt)))
          return `The saved project memory scope of ${record.title} differs from ${declared.to}`;
      }
      return undefined;
    })();
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

  const found = await change(async (ledger) => {
    // record cwds, where the ledger already took them included, Git-backed entries and ones holding a seed are worth
    // finding
    const { map } = await mapper(ledger);
    const used = (entry: DirectoryEntry) =>
      entry.main !== undefined ||
      seeds.some((seed) => within(seed, entry.path)) ||
      records.some(
        (saved) =>
          within(saved.cwd, entry.path) ||
          within(map(saved.cwd, savedBefore(saved)) ?? '', entry.path),
      );
    const moves = await findMoves(
      ledger.entries.filter(used),
      seeds,
      (entry, error) =>
        report.blocked.push({
          path: entry.path,
          reason: `Couldn't look for where it went: ${errorMessage(error)}`,
        }),
    );
    const copy = declared && (await identify(declared.to));
    if (declared && !copy)
      report.blocked.push({
        path: declared.to,
        reason: 'The destination directory is gone',
      });
    const vouched = declared && copy && { path: declared.to, ...copy };
    if (declared && vouched)
      moves.push({
        ...declared,
        device: vouched.device,
        inode: vouched.inode,
      });
    // read under the ledger lock, so prompts added while repair waited for it count as before the move
    const promptsSize =
      (await unlessGone(stat(join(store.root, 'prompts.jsonl'))))?.size ?? 0;
    await resolve(ledger, moves, promptsSize);
    // a declared move is a copy, so the directories under it have new identities the user vouches for
    if (declared && vouched) {
      for (const entry of [...ledger.entries]) {
        if (!within(entry.path, declared.from)) continue;
        const path = declared.to + entry.path.slice(declared.from.length);
        const identity = await identify(path);
        if (!identity) continue;
        Object.assign(entry, identity);
        relocate(ledger, entry, path);
      }
      // the copy itself, so a stand-in put there later is never taken for it
      if (
        !ledger.entries.some(
          (entry) =>
            entry.path === vouched.path && sameIdentity(entry, vouched),
        )
      ) {
        ledger.entries.push(vouched);
        relocate(ledger, vouched, vouched.path);
      }
    }
    return moves;
  });

  const { ledger, resolved } = await change(async (ledger) => {
    // the identities as resolved, before record() takes in what sits at a path whose recorded directory is gone, and
    // when, since a move recorded after this is one the conversations this repair rewrites haven't followed yet
    const resolved: Snapshot = {
      ledger: structuredClone(ledger),
      at: new Date().toISOString(),
    };
    const { map } = await mapper(ledger);
    const mains = new Set<string>();
    if (listed?.[0]) mains.add(listed[0]);
    for (const entry of ledger.entries) {
      const main = entry.main && map(entry.main);
      if (main) mains.add(main);
    }
    for (const main of mains)
      await (async () => {
        if (await exists(main))
          await repairWorktrees(main, map, report, run, preview);
        else if (await leftWorktree(ledger, main, map))
          report.unresolved.push({
            path: main,
            conversations: 0,
            worktree: false,
          });
      })().catch((error: unknown) =>
        report.blocked.push({
          path: main,
          reason: errorMessage(error),
          repository: main,
        }),
      );
    if (!preview) await record(ledger, cwd, seeds, records, run, report);
    return { ledger, resolved };
  });

  const { map, suspended } = await mapper(ledger);
  const tally: Tally = { repaired: [], suspended: [], unresolved: [] };
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
      const destination = [
        ...resolved.ledger.entries,
        ...found.map(({ to, device, inode }) => ({ path: to, device, inode })),
      ]
        .filter(({ path }) => within(target, path))
        .sort((a, b) => b.path.length - a.path.length)[0] ?? {
        path: target,
        ...current,
      };
      if (!(await compatible(memory, saved, saved.cwd, target))) {
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

  summarize(report, found, ledger, tally);
  return report;
}

/** checks every registration of `main`'s repository, then repairs its links when a main checkout or worktree moved. */
async function repairWorktrees(
  main: string,
  map: (path: string) => string | undefined,
  report: MoveReport,
  run: Run,
  preview: boolean,
) {
  const common = (
    await run(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: main, timeout: 60_000 },
    )
  ).stdout.trim();
  const moved: string[] = [];
  const checked: string[] = [];
  let needed = false;
  const problems: Array<{ path: string; reason: string }> = [];
  for (const { name, registered } of await registrations(common)) {
    const destination = map(registered);
    const target = (await exists(registered))
      ? registered
      : destination && (await exists(destination))
        ? destination
        : undefined;
    if (!target) {
      report.unresolved.push({
        path: registered,
        conversations: 0,
        worktree: true,
      });
      continue;
    }
    if (target !== registered) {
      moved.push(target);
      needed = true;
    }
    checked.push(target);
    const admin = await namedAdmin(target);
    const expected = join(common, 'worktrees', name);
    if (admin === expected) continue;
    // a .git naming the old common directory is this repository's only while nothing else sits there
    const old = admin && dirname(dirname(admin));
    if (
      admin &&
      basename(admin) === name &&
      old !== undefined &&
      !(await exists(old)) &&
      map(old) === common
    ) {
      needed = true;
      continue;
    }
    problems.push({
      path: target,
      reason: `its .git names ${admin ?? 'no repository'}, not ${expected}`,
    });
  }
  for (const problem of problems)
    report.blocked.push({ ...problem, repository: main });
  if (problems.length || !needed || preview) return;
  await run('git', ['worktree', 'repair', ...moved], {
    cwd: main,
    timeout: 60_000,
  });
  for (const path of checked)
    await (async () =>
      run('git', [...statusArgs, '--ignore-submodules=dirty'], {
        cwd: path,
        timeout: 60_000,
        env: await statusEnv(run, path),
      }))().catch((error: unknown) =>
      report.blocked.push({
        path,
        reason: errorMessage(error),
        repository: main,
      }),
    );
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
  /** the entry for what's at `path` now, or undefined while the one recorded there still exists elsewhere. */
  const upsert = async (path: string, identity: Identity) => {
    const entry = ledger.entries.find((known) => known.path === path);
    if (!entry) {
      ledger.entries.push({ path, ...identity });
      return ledger.entries.at(-1);
    }
    return (await adoptIdentity(entry, identity)) ? entry : undefined;
  };
  const paths = new Set([cwd, ...seeds, ...records.map(({ cwd }) => cwd)]);
  const lists = new Map<string, string[]>();
  for (const path of paths) {
    const identity = await identify(path).catch(() => undefined);
    if (!identity) continue;
    // every worktree of a repository lists the same registrations
    const list =
      [...lists.values()].find((other) => other.includes(path)) ??
      (await worktreeList(run, path));
    const main = list?.[0];
    if (main && !lists.has(main)) lists.set(main, list);
    // a recorded main that Git no longer reaches means this directory's Git now belongs to another repository
    const known = ledger.entries.find((entry) => entry.path === path);
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
    ledger.entries = ledger.entries.filter(
      (entry) =>
        entry.main !== main ||
        list.includes(entry.path) ||
        records.some(({ cwd: saved }) => within(saved, entry.path)),
    );
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
        // a path the mapping relied on that changed while this waited for the lock or the stops leaves it for the next start
        const { map } = await mapper(resolved.ledger);
        if (
          map(saved.cwd, savedBefore(saved)) !== target ||
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

/** the ledger as move resolution left it, and when that was. */
interface Snapshot {
  ledger: Ledger;
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
