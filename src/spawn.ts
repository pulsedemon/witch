import { lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { errorMessage } from './errors.js';
import { within } from './paths.js';
import { runCommand } from './core/command.js';
import { planDirectories } from './core/merged.js';
import type { Run } from './core/repository.js';
import { describeMoves, repairMoves, savedBefore } from './core/move-repair.js';
import { listWorktrees } from './core/worktree-repair.js';
import { Memory, memoryRepository } from './memory/memory.js';
import {
  adoptIdentity,
  identify,
  mapper,
  present,
  readLedger,
  sameIdentity,
  updateLedger,
} from './persistence/directories.js';
import { unlessGone } from './persistence/json.js';
import { StateStore } from './persistence/store.js';
import { oneLine } from './ui/links.js';

interface Spawned {
  path: string;
  /** false for a path that isn't a registered worktree on disk, which gets no install or tab. */
  slot: boolean;
  created: boolean;
  opened: boolean;
  error?: string;
}

// paths arrive as argv, so a space or quote in one never becomes script text
const openTabs = `on run argv
  tell application "Ghostty"
    set destination to missing value
    if (count of windows) > 0 then set destination to front window
    repeat with directory in argv
      set surface to new surface configuration
      set initial working directory of surface to contents of directory
      set initial input of surface to "witch" & return
      if destination is missing value then
        set destination to new window with configuration surface
      else
        new tab in destination with configuration surface
      end if
    end repeat
  end tell
end run`;

const failure = (error: unknown) => oneLine(errorMessage(error)).trim();

/** adds to a slot's error, since its copies, session check, install and tab can each fail. */
const report = (spawned: Spawned, message: string) => {
  spawned.error = [spawned.error, message].filter(Boolean).join(', ');
};

/**
 * the end of a failed command's own output, which says why. execFile's message repeats the command line, which for
 * osascript is the whole script.
 */
function commandFailure(command: string, error: unknown): string {
  const { stdout, stderr, killed } = error as {
    stdout?: unknown;
    stderr?: unknown;
    killed?: unknown;
  };

  const output = [stdout, stderr]
    .filter((text) => typeof text === 'string')
    .join('\n')
    .trim()
    .split('\n')
    .slice(-20)
    .join('\n');

  if (!output) return failure(error);

  return `${command} ${killed === true ? 'timed out' : 'failed'}: ${oneLine(output)}`;
}

/**
 * clones an ignored file or directory of the main checkout into a new worktree, leaving out what its copy would act on
 * as the original: a Godot `.godot`, where a project's tooling can mark the main checkout's running engine, a worktree
 * or submodule, whose `.git` file names a git directory the copy doesn't own, and a virtualenv, whose scripts run the
 * main checkout's interpreter. a nested clone with its own `.git` directory comes along. the merge cleanup's plans and
 * ledgers stay with their checkout.
 */
async function seed(
  run: Run,
  main: string,
  worktree: string,
  path: string,
): Promise<void> {
  const source = join(main, path).replace(/\/$/, '');

  const target = join(worktree, path).replace(/\/$/, '');

  const plans = [...planDirectories.plans, planDirectories.ledgers].map(
    (plan) => join(main, plan),
  );

  // a failed look reads as nothing to leave behind, so an ignored link into an unreadable directory is still copied
  const left = async (directory: string) =>
    basename(directory) === '.godot' ||
    !!(await stat(join(directory, '.git')).catch(() => undefined))?.isFile() ||
    !!(await stat(join(directory, 'pyvenv.cfg')).catch(() => undefined));

  // deleted since the listing; any other failure to look is reported
  const listed = await unlessGone(lstat(source));

  if (!listed) return;

  // lstat, since a symlink the upstream tracks would carry the copy outside the worktree
  const placed = await lstat(target).catch(() => undefined);

  if (placed) {
    // the upstream tracks something in this directory, so its other contents go in one by one
    if (path.endsWith('/') && placed.isDirectory()) {
      const failed: string[] = [];

      for (const entry of await readdir(source, { withFileTypes: true }))
        await seed(
          run,
          main,
          worktree,
          `${path}${entry.name}${entry.isDirectory() ? '/' : ''}`,
        ).catch((error: unknown) => {
          failed.push(commandFailure('copy', error));
        });

      if (failed.length) throw new Error(failed.join(', '));
    }

    return;
  }

  if (plans.some((plan) => within(source, plan))) return;

  // git lists what sits inside a partly tracked directory on its own
  for (
    let directory = source;
    directory !== main;
    directory = dirname(directory)
  )
    if (await left(directory)) return;

  let parent = dirname(target);

  while (!(await lstat(parent).catch(() => undefined)))
    parent = dirname(parent);

  const [real, root] = [await realpath(parent), await realpath(worktree)];

  if (!within(real, root))
    throw new Error(`${path} would land outside the worktree, at ${real}`);

  await mkdir(dirname(target), { recursive: true });

  // node's copyFile can't clone on macOS, so cp -c does, and dependencies and assets cost no space until a copy changes
  const copy = run('cp', ['-c', '-R', source, target], {
    cwd: main,
    timeout: 0,
  });

  if (!path.endsWith('/')) {
    await copy;

    return;
  }

  // a failed copy still leaves what it got through, so the paths seed leaves out are removed from it either way
  await copy.finally(async () => {
    const found = await run(
      'find',
      [
        source,
        '-mindepth',
        '1',
        '(',
        '-name',
        '.godot',
        '-o',
        '-name',
        '.git',
        '-type',
        'f',
        '-o',
        '-name',
        'pyvenv.cfg',
        ')',
        '-prune',
        '-print0',
      ],
      { cwd: main, timeout: 60_000 },
    ).catch(async (error: unknown) => {
      await rm(target, { recursive: true, force: true });

      throw error;
    });

    const leftovers = found.stdout
      .split('\0')
      .filter(Boolean)
      .map((match) => (basename(match) === '.godot' ? match : dirname(match)));

    const stuck: string[] = [];

    for (const leftover of [...leftovers, ...plans])
      if (leftover.startsWith(`${source}/`))
        await rm(join(target, relative(source, leftover)), {
          recursive: true,
          force: true,
        }).catch((error: unknown) => {
          stuck.push(failure(error));
        });

    if (stuck.length) throw new Error(`left in the copy: ${stuck.join(', ')}`);
  });
}

/**
 * fetches the main worktree's upstream and fills slots 1 to `count` with worktrees detached at it: the registered
 * worktree `slots` names, wherever it moved, else a new `<main>-<i>`, or `<main>-<i>-2` and on when another slot holds
 * that name. a new one gets copies of the main checkout's ignored files and directories, except what `seed` leaves
 * behind, then loses any copy its own rules don't ignore. in each one where `live` finds no session, runs `pnpm install`
 * if it has a `pnpm-lock.yaml` and opens a Ghostty tab. never removes or moves a worktree.
 */
export async function spawnWorktrees(
  cwd: string,
  count: number,
  {
    run,
    live,
    slots = new Map(),
  }: {
    run: Run;
    live(path: string): Promise<boolean>;
    slots?: ReadonlyMap<number, string>;
  },
): Promise<{ base: string; slots: Spawned[] }> {
  const git = async (directory: string, ...args: string[]) =>
    (await run('git', args, { cwd: directory, timeout: 60_000 })).stdout;

  const registered = await listWorktrees(run, cwd);

  const main = registered[0]!;

  const branch = await git(main, 'rev-parse', '--symbolic-full-name', 'HEAD');

  if (branch.trim() === 'HEAD')
    throw new Error(
      `${main} is detached; switch it to the branch worktrees should start from.`,
    );

  const [ref, base, remote] = (
    await git(
      main,
      'for-each-ref',
      '--format=%(upstream)%00%(upstream:short)%00%(upstream:remotename)',
      branch.trim(),
    )
  )
    .trim()
    .split('\0');

  if (!ref || !base || !remote)
    throw new Error(`${main} has no upstream branch to start worktrees from.`);

  // a signal would detach git from the terminal, where ssh asks for a passphrase, and a timeout would kill it mid-prompt
  await run('git', ['fetch', remote], { cwd: main, timeout: 0 });

  const listing = await run(
    'git',
    [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '-z',
    ],
    { cwd: main, timeout: 60_000 },
  );

  const local = listing.stdout.split('\0').filter(Boolean);

  // git exits 0 when it can't read a directory, and says so only on stderr
  const unread = oneLine(listing.stderr ?? '').trim();

  const results: Spawned[] = [];

  const held = new Set(slots.values());

  for (let index = 1; index <= count; index++) {
    let path = slots.get(index);

    for (let copy = 1; !path; copy++) {
      const candidate = `${main}-${index}${copy > 1 ? `-${copy}` : ''}`;

      if (!held.has(candidate)) path = candidate;
    }

    held.add(path);

    const spawned: Spawned = {
      path,
      slot: false,
      created: false,
      opened: false,
    };

    results.push(spawned);

    if (!registered.includes(spawned.path)) {
      try {
        await git(main, 'worktree', 'add', '--detach', spawned.path, ref);

        spawned.created = true;
      } catch (error) {
        spawned.error = failure(error);

        continue;
      }

      if (unread) report(spawned, `ignored files may be missing: ${unread}`);

      for (const path of local)
        await seed(run, main, spawned.path, path).catch((error: unknown) => {
          report(spawned, commandFailure('copy', error));
        });

      // the worktree's ignore rules are the upstream's, so a copy they don't cover, such as a secret, could get committed.
      // a new worktree has nothing untracked of its own
      try {
        const removed: string[] = [];

        // removing a copied .gitignore uncovers what it ignored, so the listing repeats until it's empty
        for (;;) {
          const unignored = (
            await git(
              spawned.path,
              'ls-files',
              '--others',
              '--exclude-standard',
              '-z',
            )
          )
            .split('\0')
            .filter(Boolean);

          if (!unignored.length) break;

          // a nested clone is listed as its directory
          for (const path of unignored)
            await rm(join(spawned.path, path), {
              recursive: true,
              force: true,
            });

          removed.push(...unignored);
        }

        if (removed.length)
          report(
            spawned,
            `removed copies the worktree doesn't ignore: ${removed.join(', ')}`,
          );
      } catch (error) {
        report(
          spawned,
          `copies the worktree doesn't ignore may remain: ${commandFailure('ls-files', error)}`,
        );
      }
    }

    try {
      if (await present(spawned.path)) spawned.slot = true;
      else
        report(spawned, 'registered but missing; start Witch where it moved');
    } catch (error) {
      report(spawned, failure(error));
    }
  }

  const idle = async (spawned: Spawned) => {
    try {
      return !(await live(spawned.path));
    } catch (error) {
      report(spawned, failure(error));

      return false;
    }
  };

  const installed: Spawned[] = [];

  for (const spawned of results) {
    if (!spawned.slot || !(await idle(spawned))) continue;

    installed.push(spawned);

    const locked = await present(join(spawned.path, 'pnpm-lock.yaml')).catch(
      (error: unknown) => {
        report(spawned, failure(error));

        return false;
      },
    );

    if (locked)
      await run('pnpm', ['install', '--frozen-lockfile'], {
        cwd: spawned.path,
        timeout: 300_000,
      }).catch((error: unknown) => {
        report(spawned, commandFailure('pnpm install', error));
      });
  }

  // asked again, since a session can open in a slot while a later one installs
  const awaiting: Spawned[] = [];

  for (const spawned of installed)
    if (await idle(spawned)) awaiting.push(spawned);

  if (awaiting.length)
    // no timeout, since the first Apple Events permission prompt waits for the user
    await run(
      'osascript',
      ['-e', openTabs, ...awaiting.map(({ path }) => path)],
      {
        cwd: main,
        timeout: 0,
      },
    ).then(
      () => {
        for (const spawned of awaiting) spawned.opened = true;
      },
      (error: unknown) => {
        const reason = commandFailure('osascript', error);

        for (const spawned of awaiting) report(spawned, reason);
      },
    );

  return { base, slots: results };
}

/**
 * whether a conversation the store holds open has its `cwd` at or under the path, read on every query. one without a
 * readable record, or an unreadable ledger, rejects the query, since its session could be anywhere.
 */
export function sessionsIn(
  stateRoot: string,
): (path: string) => Promise<boolean> {
  return async (path) => {
    const store = await StateStore.open(stateRoot);

    const ids = [...(await store.openConversations()).keys()];

    const { records, unreadable } = await store.records(ids);

    // a new conversation locks before its first save
    if (records.length < ids.length)
      throw new Error(
        `cannot determine session ownership: ${unreadable.map((entry) => entry.file).join(', ') || 'a conversation is still saving its first record'}`,
      );

    const real = await realpath(path);

    // a session left in a directory that has since moved still holds it
    const { map } = await mapper(await readLedger(stateRoot));

    return records.some((record) =>
      [record.cwd, map(record.cwd, savedBefore(record))].some(
        (held) => held && within(held, real),
      ),
    );
  };
}

function describe({ path, slot, created, opened, error }: Spawned): string {
  if (!slot) return `${path}: ${error}`;

  return [
    `${path}: ${created ? 'created' : 'exists'}`,
    ...(error ? [error] : []),
    ...(opened ? ['opened'] : error ? [] : ['already open']),
  ].join(', ');
}

/**
 * repairs moved directories first, so a moved main checkout reuses its worktrees wherever they are, then spawns. a cwd
 * whose Git a move broke is repaired only when the ledger knows it, so a directory outside any repository still exits
 * with Git's error, or the ledger's when that can't be read, and leaves no state behind.
 */
export async function runSpawn(
  cwd: string,
  count: number,
  stateRoot: string,
  run: Run = runCommand,
): Promise<number> {
  try {
    await listWorktrees(run, cwd).catch(async (error: unknown) => {
      const identity = await identify(cwd);

      const { entries } = await readLedger(stateRoot);

      if (!entries.some((entry) => sameIdentity(entry, identity))) throw error;
    });

    const store = await StateStore.open(stateRoot);

    const memory = new Memory(memoryRepository(stateRoot));

    // spawning without a repair would open worktrees whose registrations nothing checked
    const repaired = await repairMoves(store, memory, cwd, { run });

    const notice = describeMoves(repaired, stateRoot);

    if (notice) process.stdout.write(`${notice}\n`);

    const list = await listWorktrees(run, cwd);

    const main = list[0]!;

    if (repaired.blocked.some(({ repository }) => repository === main))
      return 1;

    const { entries } = await readLedger(stateRoot);

    const slots = new Map(
      entries.flatMap(({ path, main: owner, slot }) =>
        owner === main && slot !== undefined && list.includes(path)
          ? [[slot, path] as const]
          : [],
      ),
    );

    const { base, slots: spawned } = await spawnWorktrees(cwd, count, {
      run,
      live: sessionsIn(stateRoot),
      slots,
    });

    const recorded = await updateLedger(stateRoot, async ({ entries }) => {
      for (const [index, result] of spawned.entries()) {
        if (!result.slot) continue;

        const identity = await identify(result.path);

        if (!identity) continue;

        let entry = entries.find((known) => known.path === result.path);

        if (!entry) entries.push((entry = { path: result.path, ...identity }));
        else if (!(await adoptIdentity(entry, identity))) continue;

        Object.assign(entry, { main, slot: index + 1 });
      }
    }).then(
      () => true,
      (error: unknown) => {
        process.stdout.write(
          `Could not record the worktrees: ${failure(error)}\n`,
        );

        return false;
      },
    );

    process.stdout.write(
      `${[`Worktrees start at ${base}.`, ...spawned.map(describe)].join('\n')}\n`,
    );

    return recorded && !spawned.some(({ error }) => error) ? 0 : 1;
  } catch (error) {
    process.stderr.write(`witch: ${failure(error)}\n`);

    return 1;
  }
}
