import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { errorMessage } from '../agents/stderr.js';
import type { Memory } from '../memory/memory.js';
import { projectKey } from '../memory/memory.js';
import {
  findMoves,
  identify,
  mapper,
  readLedger,
  resolve,
  updateLedger,
  within,
} from '../persistence/directories.js';
import type {
  DirectoryEntry,
  Identity,
  Ledger,
  Move,
} from '../persistence/directories.js';
import { replaceFile } from '../persistence/json.js';
import { identifyProcesses, sameProcess } from '../persistence/process.js';
import { LockedElsewhere } from '../persistence/store.js';
import type { StateStore } from '../persistence/store.js';
import { quote } from '../shell.js';
import { runCommand } from './command.js';
import type { Run } from './repository.js';
import { conversationRecordSchema, displayUpdateSchema } from './state.js';
import type { ConversationRecord } from './state.js';

export interface MoveReport {
  repaired: Array<Move & { conversations: number; worktrees: number }>;
  /** `repository` names the main checkout whose worktree links couldn't be checked or repaired. */
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
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      ['ENOENT', 'ENOTDIR'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      return false;
    throw error;
  }
}

/**
 * rewrites history lines whose `cwd` the mapping changes and leaves every other byte alone, including torn, foreign
 * and CRLF lines.
 */
export function rewriteLines(
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

/** the worktree list's paths, main checkout first, or undefined where Git can't list them. */
async function worktreeList(run: Run, cwd: string) {
  try {
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
  } catch {
    return undefined;
  }
}

async function registrations(common: string): Promise<Registration[]> {
  const names = await readdir(join(common, 'worktrees')).catch(() => []);
  const found: Registration[] = [];
  for (const name of names) {
    const gitdir = await readFile(
      join(common, 'worktrees', name, 'gitdir'),
      'utf8',
    ).catch(() => undefined);
    if (gitdir) found.push({ name, registered: dirname(gitdir.trim()) });
  }
  return found;
}

/** the common Git directory a worktree's `.git` file names, from `gitdir: <common>/worktrees/<name>`. */
async function namedAdmin(worktree: string): Promise<string | undefined> {
  const text = await readFile(join(worktree, '.git'), 'utf8').catch(
    () => undefined,
  );
  return text?.startsWith('gitdir: ') ? text.slice(8).trim() : undefined;
}

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
  const path = await memory.pathScope(to);
  // a path-keyed project's key changes with the path, so the old path's key counts too
  const rest = path && to.slice(path.top.length);
  const old =
    path && rest !== undefined && from.endsWith(rest)
      ? projectKey(from.slice(0, from.length - rest.length))
      : undefined;
  return delivered.every((key) => key === project || key === old);
};

/**
 * finds where known directories went, repairs the Git links of their worktrees and rewrites the conversations saved
 * in them. `declared` is a move the user asserts, checked before anything is written; `preview` writes nothing.
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
  const promptsSize =
    (await stat(join(store.root, 'prompts.jsonl')).catch(() => undefined))
      ?.size ?? 0;

  if (declared) {
    const problem = await (async () => {
      if (!isAbsolute(declared.from))
        return 'Choose an absolute saved directory to recover.';
      if (await exists(declared.from))
        return `The source directory still exists: ${declared.from}`;
      for (const record of records) {
        if (!within(record.cwd, declared.from)) continue;
        const target = declared.to + record.cwd.slice(declared.from.length);
        const checkAt = await memory.scopePaths(target).then(
          () => target,
          () => declared.to,
        );
        if (!(await compatible(memory, record, record.cwd, checkAt)))
          return `The saved project memory scope of ${record.title} differs from ${declared.to}.`;
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

  // record cwds and Git-backed entries are worth finding; anything else stays unlocated
  const used = (entry: DirectoryEntry) =>
    entry.main !== undefined ||
    records.some(({ cwd: saved }) => within(saved, entry.path));
  const found = await change(async (ledger) => {
    const moves = await findMoves(ledger.entries.filter(used), seeds);
    if (declared) {
      const identity = (await identify(declared.to))!;
      moves.push({ ...declared, ...identity });
    }
    await resolve(ledger, moves, promptsSize);
    // a declared move is a copy, so the directories under it have new identities the user vouches for
    if (declared)
      for (const entry of ledger.entries) {
        if (!within(entry.path, declared.from)) continue;
        const path = declared.to + entry.path.slice(declared.from.length);
        const identity = await identify(path);
        if (!identity) continue;
        for (const other of ledger.entries)
          if (other.main === entry.path) other.main = path;
        Object.assign(entry, { path }, identity);
      }
    return moves;
  });

  const ledger = await change(async (ledger) => {
    const { map } = await mapper(ledger);
    const mains = new Set<string>();
    if (listed?.[0]) mains.add(listed[0]);
    for (const entry of ledger.entries)
      if (entry.main) {
        const main = map(entry.main);
        if (main && (await exists(main))) mains.add(main);
      }
    for (const main of mains)
      await repairWorktrees(main, map, report, run, preview).catch(
        (error: unknown) =>
          report.blocked.push({
            path: main,
            reason: errorMessage(error),
            repository: main,
          }),
      );
    if (!preview) await record(ledger, cwd, seeds, records, run, report);
    return ledger;
  });

  const { map, suspended } = await mapper(ledger);
  const counts = new Map<string, number>();
  const count = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const saved of records) {
    try {
      const target = map(saved.cwd);
      if (target === undefined) {
        const move = suspended.find(({ from }) => within(saved.cwd, from));
        if (move) count(`suspended:${move.from}`);
        else count(`unresolved:${saved.cwd}`);
        continue;
      }
      if (!(await exists(target))) {
        count(`unresolved:${saved.cwd}`);
        continue;
      }
      if (target === saved.cwd) continue;
      if (!(await compatible(memory, saved, saved.cwd, target))) {
        report.blocked.push({
          path: saved.cwd,
          reason: `${saved.title}'s saved project memory scope differs from ${target}`,
        });
        continue;
      }
      const repaired = preview || (await rewrite(store, saved, target, report));
      if (repaired) count(`repaired:${saved.cwd}->${target}`);
    } catch (error) {
      report.blocked.push({
        path: saved.cwd,
        reason: `Could not inspect it: ${errorMessage(error)}`,
      });
    }
  }

  summarize(report, found, ledger, counts);
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
  for (const { registered } of await registrations(common))
    await run('git', ['status', '--porcelain'], {
      cwd: registered,
      timeout: 60_000,
    }).catch((error: unknown) =>
      report.blocked.push({
        path: registered,
        reason: errorMessage(error),
        repository: main,
      }),
    );
}

/** records the identities of `cwd`, the seeds and every present record cwd, with each worktree's main and slot. */
async function record(
  ledger: Ledger,
  cwd: string,
  seeds: readonly string[],
  records: readonly ConversationRecord[],
  run: Run,
  report: MoveReport,
) {
  const upsert = (path: string, identity: Identity) => {
    let entry = ledger.entries.find((known) => known.path === path);
    if (!entry) {
      entry = { path, ...identity };
      ledger.entries.push(entry);
    }
    entry.device = identity.device;
    entry.inode = identity.inode;
    return entry;
  };
  const paths = new Set([cwd, ...seeds, ...records.map(({ cwd }) => cwd)]);
  const lists = new Map<string, string[]>();
  for (const path of paths) {
    const identity = await identify(path).catch(() => undefined);
    if (!identity) continue;
    const list = await worktreeList(run, path);
    const main = list?.[0];
    if (main && !lists.has(main)) lists.set(main, list);
    // a recorded main that Git no longer reaches means this directory's Git now belongs to another repository
    const known = ledger.entries.find((entry) => entry.path === path);
    if (path === cwd && known?.main && main && known.main !== main) {
      report.blocked.push({
        path,
        reason: `its Git reaches ${main}, not its recorded main checkout ${known.main}`,
        repository: main,
      });
      continue;
    }
    if (!list?.includes(path)) upsert(path, identity);
  }
  for (const [main, list] of lists) {
    for (const path of list) {
      const identity = await identify(path);
      if (!identity) continue;
      upsert(path, identity).main = main;
    }
    const registered = ledger.entries.filter(
      (entry) => entry.main === main && list.includes(entry.path),
    );
    for (const entry of registered) {
      const slot = /^-(\d+)$/.exec(entry.path.slice(main.length))?.[1];
      if (
        entry.slot === undefined &&
        entry.path !== main &&
        slot &&
        !registered.some((other) => other.slot === Number(slot))
      )
        entry.slot = Number(slot);
    }
    // a worktree Git no longer lists, with no conversation in it, is gone for good
    ledger.entries = ledger.entries.filter(
      (entry) =>
        entry.main !== main ||
        list.includes(entry.path) ||
        records.some(({ cwd: saved }) => within(saved, entry.path)),
    );
  }
}

/** rewrites one conversation's history and record under its lock, or says why it can't. */
async function rewrite(
  store: StateStore,
  saved: ConversationRecord,
  target: string,
  report: MoveReport,
): Promise<boolean> {
  try {
    return (
      (await store.repairRecord(saved.id, async (raw, directory) => {
        const current = conversationRecordSchema.parse(raw);
        if (current.cwd !== saved.cwd) return undefined;
        const identities = [
          current.process,
          current.usageProcess,
          current.answerProcess,
          current.shell,
        ].filter((identity) => identity !== undefined);
        const running = await identifyProcesses(
          identities.map(({ pid }) => pid),
        );
        if (
          identities.some((identity) =>
            sameProcess(running.get(identity.pid), identity),
          )
        ) {
          report.blocked.push({
            path: saved.cwd,
            reason: `${saved.title} has a native process or shell still running`,
          });
          return undefined;
        }
        const history = join(directory, 'history.jsonl');
        const times = await stat(history).catch(() => undefined);
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
        return { ...raw, cwd: target };
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

/** one line per repaired main checkout, with its worktrees' moves folded in, and the counts of the rest. */
function summarize(
  report: MoveReport,
  found: readonly Move[],
  ledger: Ledger,
  counts: Map<string, number>,
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
  for (const [key, conversations] of counts) {
    const [kind, rest] = [
      key.slice(0, key.indexOf(':')),
      key.slice(key.indexOf(':') + 1),
    ];
    if (kind === 'repaired') {
      const [from, to] = rest.split('->') as [string, string];
      const move = found
        .filter((known) => within(from, known.from))
        .sort((a, b) => b.from.length - a.from.length)[0];
      line(move ? owner(move) : { from, to }).conversations += conversations;
    } else if (kind === 'suspended') {
      const move = ledger.moves.findLast(({ from }) => from === rest)!;
      report.suspended.push({ from: move.from, to: move.to, conversations });
    } else
      report.unresolved.push({ path: rest, conversations, worktree: false });
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
        `Couldn't find where ${path} went${worktree ? ', a worktree that moved or was deleted' : `, with ${conversations} conversation(s)`}. Start Witch in its new location, or from there preview recovery with:\nwitch --state-dir ${quote(root)} --recover-directory ${quote(path)}`,
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
