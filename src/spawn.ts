import { lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { errorMessage } from './agents/stderr.js';
import { runCommand } from './core/command.js';
import { planDirectories } from './core/merged.js';
import type { Run } from './core/repository.js';
import { exists } from './memory/memory.js';
import { StateStore } from './persistence/store.js';
import { oneLine } from './ui/links.js';

export interface Spawned {
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
  const left = async (directory: string) =>
    basename(directory) === '.godot' ||
    !!(await stat(join(directory, '.git')).catch(() => undefined))?.isFile() ||
    (await exists(join(directory, 'pyvenv.cfg')));
  // deleted since the listing; any other failure to look is reported
  const listed = await lstat(source).catch((error: unknown) => {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  });
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
  if (plans.some((plan) => `${source}/`.startsWith(`${plan}/`))) return;
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
  if (real !== root && !real.startsWith(root + sep))
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
 * fetches the main worktree's upstream and makes `<main>-1` to `<main>-<count>` worktrees detached at it, copying the
 * main checkout's ignored files and directories into each new one, except what `seed` leaves behind, then removing and
 * reporting any copy the new one's own rules don't ignore. in each one where `live` finds no session, runs `pnpm install` if it has a
 * `pnpm-lock.yaml` and opens a Ghostty tab. never removes or moves a worktree.
 */
export async function spawnWorktrees(
  cwd: string,
  count: number,
  { run, live }: { run: Run; live(path: string): Promise<boolean> },
): Promise<{ base: string; slots: Spawned[] }> {
  const git = async (directory: string, ...args: string[]) =>
    (await run('git', args, { cwd: directory, timeout: 60_000 })).stdout;
  const registered = (await git(cwd, 'worktree', 'list', '--porcelain', '-z'))
    .split('\0')
    .flatMap((line) =>
      line.startsWith('worktree ') ? [line.slice('worktree '.length)] : [],
    );
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
  const slots: Spawned[] = [];
  for (let index = 1; index <= count; index++) {
    const spawned: Spawned = {
      path: `${main}-${index}`,
      slot: false,
      created: false,
      opened: false,
    };
    slots.push(spawned);
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
    if (await exists(spawned.path)) spawned.slot = true;
    else spawned.error = 'registered but missing; run git worktree prune';
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
  for (const spawned of slots) {
    if (!spawned.slot || !(await idle(spawned))) continue;
    installed.push(spawned);
    if (await exists(join(spawned.path, 'pnpm-lock.yaml')))
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
  return { base, slots };
}

/**
 * whether a conversation the store holds open has its `cwd` at or under the path, read on every query. one without a
 * readable record rejects the query, since its session could be anywhere.
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
    return records.some(
      ({ cwd }) => cwd === real || cwd.startsWith(real + sep),
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

export async function runSpawn(
  cwd: string,
  count: number,
  stateRoot: string,
  run: Run = runCommand,
): Promise<number> {
  try {
    const { base, slots } = await spawnWorktrees(cwd, count, {
      run,
      live: sessionsIn(stateRoot),
    });
    process.stdout.write(
      `${[`Worktrees start at ${base}.`, ...slots.map(describe)].join('\n')}\n`,
    );
    return slots.some(({ error }) => error) ? 1 : 0;
  } catch (error) {
    process.stderr.write(`witch: ${failure(error)}\n`);
    return 1;
  }
}
