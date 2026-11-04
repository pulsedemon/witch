import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { errorMessage } from '../agents/stderr.js';
import { present } from '../persistence/directories.js';
import type { Ledger } from '../persistence/directories.js';
import { unlessGone } from '../persistence/json.js';
import type { MoveReport } from './move-repair.js';
import { statusArgs, statusEnv } from './repository.js';
import type { Run } from './repository.js';

interface Registration {
  name: string;
  /** where the registration points now, which is gone for a worktree that moved */
  registered: string;
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
export const worktreeList = (run: Run, cwd: string) =>
  listWorktrees(run, cwd).catch(() => undefined);

async function registrations(common: string): Promise<Registration[]> {
  const names = (await unlessGone(readdir(join(common, 'worktrees')))) ?? [];
  const found: Registration[] = [];
  for (const name of names) {
    const admin = join(common, 'worktrees', name);
    const gitdir = await unlessGone(readFile(join(admin, 'gitdir'), 'utf8'));
    // a registration removed whole while this read is gone; one left without its gitdir can't be checked
    if (gitdir === undefined && !(await present(admin))) continue;
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
  const text = await unlessGone(readFile(join(worktree, '.git'), 'utf8')).catch(
    (error: unknown) => {
      // a .git directory is a checkout of its own, which names no admin directory
      if ((error as NodeJS.ErrnoException).code === 'EISDIR') return undefined;
      throw error;
    },
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
    if (path && (await present(path))) return true;
  }
  return false;
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
    const target = (await present(registered))
      ? registered
      : destination && (await present(destination))
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
      !(await present(old)) &&
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
 * checks and repairs the worktree links of `main`'s repository and of every main checkout the ledger knows, where each
 * now sits; one that's gone while a worktree of it remains is reported unresolved.
 */
export async function repairRepositories(
  ledger: Ledger,
  main: string | undefined,
  map: (path: string) => string | undefined,
  report: MoveReport,
  run: Run,
  preview: boolean,
): Promise<void> {
  const mains = new Set<string>();
  if (main) mains.add(main);
  for (const entry of ledger.entries) {
    const known = entry.main && map(entry.main);
    if (known) mains.add(known);
  }
  for (const repository of mains)
    await (async () => {
      if (await present(repository))
        await repairWorktrees(repository, map, report, run, preview);
      else if (await leftWorktree(ledger, repository, map))
        report.unresolved.push({
          path: repository,
          conversations: 0,
          worktree: false,
        });
    })().catch((error: unknown) =>
      report.blocked.push({
        path: repository,
        reason: errorMessage(error),
        repository,
      }),
    );
}
