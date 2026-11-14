import { readFile, readdir } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
} from 'node:path';
import { errorMessage } from '../errors.js';
import {
  caseDestination,
  identify,
  present,
  sameIdentity,
} from '../persistence/directories.js';
import type { Ledger } from '../persistence/directories.js';
import { replaceFile, unlessGone } from '../persistence/json.js';
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

/** the admin directory a worktree's `.git` file names, `<common>/worktrees/<name>`, which Git may write relative to `base`. */
async function namedAdmin(
  worktree: string,
  base = worktree,
): Promise<string | undefined> {
  const text = await unlessGone(readFile(join(worktree, '.git'), 'utf8')).catch(
    (error: unknown) => {
      // a .git directory is a checkout of its own, which names no admin directory
      if ((error as NodeJS.ErrnoException).code === 'EISDIR') return undefined;
      throw error;
    },
  );
  return text?.startsWith('gitdir: ')
    ? resolvePath(base, text.slice(8).trim())
    : undefined;
}

async function actualCase(path: string): Promise<string> {
  const identity = await identify(path);
  return (identity && (await caseDestination(path, identity))) ?? path;
}

/** defer link repairs until every registration passes ownership checks; Git accepts these stale aliases unchanged. */
async function linkRepair(
  file: string,
  prefix: string,
  base: string,
  target: string,
) {
  const before = await readFile(file, 'utf8');
  if (!before.startsWith(prefix)) return undefined;
  const value = before.slice(prefix.length).trim();
  const named = resolvePath(base, value);
  // Git 2.45 lists a relative reverse link literally and marks its worktree prunable
  const absoluteReverse = prefix === '' && !isAbsolute(value);
  if (named === target && !absoluteReverse) return undefined;
  const identity = await identify(target);
  if (
    !identity ||
    !sameIdentity(identity, await identify(named)) ||
    (named !== target && (await caseDestination(named, identity)) !== target)
  )
    return undefined;
  const after = `${prefix}${absoluteReverse || isAbsolute(value) ? target : relative(base, target)}\n`;
  return async () => {
    if (
      (await readFile(file, 'utf8')) !== before ||
      !sameIdentity(identity, await identify(target)) ||
      !sameIdentity(identity, await identify(named)) ||
      (named !== target && (await caseDestination(named, identity)) !== target)
    )
      throw new Error(`${file} changed while its link repair was waiting`);
    await replaceFile(file, after);
  };
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
  const common = await actualCase(
    (
      await run(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: main, timeout: 60_000 },
      )
    ).stdout.trim(),
  );
  const moved: string[] = [];
  const checked: string[] = [];
  const linkRepairs: Array<() => Promise<void>> = [];
  let needed = false;
  const problems: Array<{ path: string; reason: string }> = [];
  for (const { name, registered } of await registrations(common)) {
    const destination = map(registered);
    const existing = await present(registered);
    const target = existing
      ? await actualCase(registered)
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
    if (target !== registered && !existing) {
      moved.push(target);
      needed = true;
    }
    checked.push(target);
    const admin = await namedAdmin(target);
    const expected = join(common, 'worktrees', name);
    // a .git naming the old common directory is this repository's only while nothing else sits there
    const ours = async (named: string | undefined) => {
      if (named === expected) return true;
      const identity = await identify(expected);
      if (
        named &&
        identity &&
        (await present(named)) &&
        (await caseDestination(named, identity)) === expected
      )
        return true;
      const old = named && dirname(dirname(named));
      if (
        !named ||
        basename(named) !== name ||
        !old ||
        (await present(old)) ||
        map(old) !== common
      )
        return false;
      needed = true;
      return true;
    };
    // a link Git wrote relative still names its admin from where the worktree was registered
    if (
      !(await ours(admin)) &&
      !(
        target !== registered &&
        (await ours(await namedAdmin(target, registered)))
      )
    ) {
      problems.push({
        path: target,
        reason: `its .git names ${admin ?? 'no repository'}, not ${expected}`,
      });
      continue;
    }
    // the reverse link's target is the .git file; check it before replacing that file's inode
    for (const repair of [
      await linkRepair(
        join(expected, 'gitdir'),
        '',
        expected,
        join(target, '.git'),
      ),
      await linkRepair(join(target, '.git'), 'gitdir: ', target, expected),
    ])
      if (repair) linkRepairs.push(repair);
  }
  for (const problem of problems)
    report.blocked.push({ ...problem, repository: main });
  if (problems.length || (!needed && !linkRepairs.length) || preview) return;
  for (const repair of linkRepairs) await repair();
  if (needed)
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
  const visited = new Set<string>();
  for (let repository of mains)
    await (async () => {
      repository = await actualCase(repository);
      if (visited.has(repository)) return;
      visited.add(repository);
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
