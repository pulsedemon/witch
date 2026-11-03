import { realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { errorMessage } from './agents/stderr.js';
import { runCommand } from './core/command.js';
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
 * fetches the main worktree's upstream and makes `<main>-1` to `<main>-<count>` worktrees detached at it, then installs
 * and opens a Ghostty tab in each one where `live` finds no session. never removes or moves a worktree.
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
  const slots: Spawned[] = [];
  for (let index = 1; index <= count; index++) {
    const spawned: Spawned = {
      path: `${main}-${index}`,
      slot: false,
      created: false,
      opened: false,
    };
    slots.push(spawned);
    if (!registered.includes(spawned.path))
      try {
        await git(main, 'worktree', 'add', '--detach', spawned.path, ref);
        spawned.created = true;
      } catch (error) {
        spawned.error = failure(error);
        continue;
      }
    if (await exists(spawned.path)) spawned.slot = true;
    else spawned.error = 'registered but missing; run git worktree prune';
  }
  const awaiting: Spawned[] = [];
  for (const spawned of slots) {
    if (!spawned.slot) continue;
    try {
      if (await live(spawned.path)) continue;
    } catch (error) {
      spawned.error = failure(error);
      continue;
    }
    awaiting.push(spawned);
    if (await exists(join(spawned.path, 'pnpm-lock.yaml')))
      await run('pnpm', ['install', '--frozen-lockfile'], {
        cwd: spawned.path,
        timeout: 300_000,
      }).catch((error: unknown) => {
        spawned.error = commandFailure('pnpm install', error);
      });
  }
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
        for (const spawned of awaiting)
          spawned.error = [spawned.error, reason].filter(Boolean).join(', ');
      },
    );
  return { base, slots };
}

/**
 * whether a conversation the store holds open has its `cwd` at or under the path. reads the open conversations once;
 * an unreadable one rejects every query, since its session could be anywhere.
 */
export function sessionsIn(
  stateRoot: string,
): (path: string) => Promise<boolean> {
  let cwds: Promise<string[]> | undefined;
  return async (path) => {
    cwds ??= (async () => {
      const store = await StateStore.open(stateRoot);
      const { records, unreadable } = await store.records([
        ...(await store.openConversations()).keys(),
      ]);
      if (unreadable.length)
        throw new Error(
          `cannot determine session ownership: ${unreadable.map((entry) => entry.file).join(', ')}`,
        );
      return records.map((record) => record.cwd);
    })();
    const open = await cwds;
    const real = await realpath(path);
    return open.some((cwd) => cwd === real || cwd.startsWith(real + sep));
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
