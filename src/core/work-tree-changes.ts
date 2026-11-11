import { copyFile, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { delimiter, join, relative, sep } from 'node:path';
import { hunks, wholeFile } from '../agents/file-diff.js';
import type { FileDiff } from '../agents/types.js';
import { execute, statusEnv } from './repository.js';
import type { Run } from './repository.js';

export interface Changes {
  files: FileDiff[];
  /** changed files left unlisted because they match a `HEAD` that other commits moved. */
  withHead: number;
  /** files past the hundredth. */
  more: number;
}

interface Baseline {
  tree: string;
  head?: string;
  /** when the snapshot began, in seconds, before its `HEAD` was read. */
  at: number;
}

interface Checkout {
  top: string;
  /** the repository's own index, which each snapshot copies. */
  index: string;
  env: NodeJS.ProcessEnv;
}

interface Entry {
  status: string;
  oldMode: string;
  newMode: string;
  old: string;
  new: string;
  path: string;
}

const timeout = 10_000;
/** the name reads list every changed or tracked file, which can be long. */
const listBuffer = 64 * 1024 * 1024;
const lineBudget = 400;
/** a line counts once more against the budget for each this many characters, which bounds a row whatever its lines hold. */
const lineWidth = 200;
const fileBudget = 100;
const gitlink = '160000';

/**
 * hooks and the split index would write under the repository's Git directories, and the user's diff and stat settings
 * would change what a snapshot stores or how a patch parses.
 */
const options = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'core.splitIndex=false',
  '-c',
  'core.safecrlf=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'diff.suppressBlankEmpty=false',
  '--no-optional-locks',
];
const treeDiff = [
  'diff',
  '--no-renames',
  '--no-relative',
  '--ignore-submodules=none',
  '-z',
];

/** what a file's lines take from a row's budget. */
function cost(file: FileDiff): number {
  let total = 0;
  for (const hunk of file.hunks)
    for (const line of hunk.lines)
      total +=
        (line[0] === ' ' ? 0 : 1) + Math.floor((line.length - 1) / lineWidth);
  return total;
}

const exitCode = (error: unknown) => (error as { code?: unknown }).code;

function firstLine(error: unknown): string {
  const { stderr } = error as { stderr?: unknown };
  const text =
    typeof stderr === 'string' && stderr.trim()
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return text.trim().split('\n')[0]!;
}

const fields = (output: string) => output.split('\0').slice(0, -1);

/**
 * what changed in a checkout between two looks, read from Git trees built in `directory` so that the repository's own
 * index, refs and objects stay unwritten. each checkout keeps one baseline, which only `read` and `absorb` move, so
 * a change shows on the next `read` whatever ran in between.
 */
export class WorkTreeChanges {
  private readonly baselines = new Map<string, Baseline>();
  private chain: Promise<unknown> = Promise.resolve();

  /** `directory` holds the index copy and the objects; it is created on first use. */
  constructor(
    private readonly directory: string,
    private readonly run: Run = execute,
  ) {}

  /** takes a baseline unless one is held for `cwd`'s checkout. */
  watch(cwd: string): Promise<void> {
    return this.queue(async () => {
      const checkout = await this.checkout(cwd);
      if (checkout && !this.baselines.has(checkout.top))
        this.baselines.set(checkout.top, await this.snapshot(checkout));
    });
  }

  /** takes the files a tool reported itself into the baseline, so the next `read` doesn't show them again. */
  absorb(cwd: string, paths: readonly string[]): Promise<void> {
    return this.queue(async () => {
      const checkout = await this.checkout(cwd);
      const baseline = checkout && this.baselines.get(checkout.top);
      if (!baseline) return;
      const inside = paths
        .map((path) => relative(checkout.top, path))
        .filter(
          (path) => path && path !== '..' && !path.startsWith(`..${sep}`),
        );
      if (!inside.length) return;
      const snapshot = await this.snapshot(checkout);
      const git = (...args: string[]) => this.git(checkout, args);
      await rm(checkout.env.GIT_INDEX_FILE!, { force: true });
      await git('read-tree', baseline.tree);
      for (const path of inside) {
        const [entry] = fields(
          await git(
            '--literal-pathspecs',
            'ls-tree',
            '-z',
            '--full-tree',
            snapshot.tree,
            '--',
            path,
          ),
        );
        const [mode, type, id] = entry?.split('\t')[0]!.split(' ') ?? [];
        if (type === 'blob')
          await git(
            'update-index',
            '--add',
            // a path the baseline holds as a file can be a directory by now, or the reverse
            '--replace',
            '--cacheinfo',
            `${mode},${id},${path}`,
          );
        else await git('update-index', '--force-remove', '--', path);
      }
      const tree = (await git('write-tree')).trim();
      this.baselines.set(checkout.top, { ...baseline, tree });
    });
  }

  /** what changed since the baseline; no files when nothing did, there was no baseline, or `cwd` is outside a repository. */
  read(cwd: string): Promise<Changes> {
    return this.queue(async () => {
      const none: Changes = { files: [], withHead: 0, more: 0 };
      const checkout = await this.checkout(cwd);
      if (!checkout) return none;
      const baseline = this.baselines.get(checkout.top);
      const snapshot = await this.snapshot(checkout);
      if (!baseline) {
        this.baselines.set(checkout.top, snapshot);
        return none;
      }
      const list = (...args: string[]) =>
        this.git(checkout, [...treeDiff, ...args], listBuffer);
      const raw = fields(
        await list('--raw', '--no-abbrev', baseline.tree, snapshot.tree),
      );
      let entries: Entry[] = [];
      for (let index = 0; index + 1 < raw.length; index += 2) {
        const [oldMode, newMode, old, id, status] = raw[index]!.slice(1).split(
          ' ',
        ) as [string, string, string, string, string];
        entries.push({
          status,
          oldMode,
          newMode,
          old,
          new: id,
          path: raw[index + 1]!,
        });
      }
      let withHead = 0;
      if (
        baseline.head !== snapshot.head &&
        !(await this.localCommits(checkout, baseline, snapshot.head))
      ) {
        const dirty = new Set(
          fields(await list('--name-only', snapshot.head!, snapshot.tree)),
        );
        const changed = entries.length;
        entries = entries.filter(({ path }) => dirty.has(path));
        withHead = changed - entries.length;
      }
      const shown = entries.slice(0, fileBudget);
      // counting reads each file's content, so only the files a row can list are counted
      const counts = new Map<string, FileDiff['unshown']>();
      if (shown.length)
        for (const row of fields(
          await this.git(checkout, [
            '--literal-pathspecs',
            ...treeDiff,
            '--numstat',
            baseline.tree,
            snapshot.tree,
            '--',
            ...shown.map(({ path }) => path),
          ]),
        )) {
          const [added, removed, ...path] = row.split('\t') as [
            string,
            string,
            ...string[],
          ];
          counts.set(
            path.join('\t'),
            added === '-'
              ? 'binary'
              : { added: Number(added), removed: Number(removed) },
          );
        }
      const files: FileDiff[] = [];
      let budget = lineBudget;
      for (const entry of shown) {
        const file = await this.file(
          checkout,
          entry,
          counts.get(entry.path),
          budget,
        );
        budget -= cost(file);
        files.push(file);
      }
      this.baselines.set(checkout.top, snapshot);
      return { files, withHead, more: entries.length - shown.length };
    });
  }

  /** whether only commits made since the baseline moved `HEAD`, judged by their dates. */
  private async localCommits(
    checkout: Checkout,
    baseline: Baseline,
    head: string | undefined,
  ): Promise<boolean> {
    if (!baseline.head || !head) return true;
    try {
      await this.git(checkout, [
        'merge-base',
        '--is-ancestor',
        baseline.head,
        head,
      ]);
    } catch (error) {
      if (exitCode(error) === 1) return false;
      throw error;
    }
    // `--before` includes its own second, and a commit made in the baseline's second is new
    const older = await this.git(checkout, [
      'rev-list',
      '--count',
      `--before=${baseline.at - 1}`,
      `${baseline.head}..${head}`,
    ]);
    return Number(older) === 0;
  }

  /** one changed file, with its lines when they fit `budget` and Git can show them as text. */
  private async file(
    checkout: Checkout,
    entry: Entry,
    count: FileDiff['unshown'],
    budget: number,
  ): Promise<FileDiff> {
    const kind =
      entry.status === 'A' ? 'add' : entry.status === 'D' ? 'delete' : 'update';
    const file = { path: join(checkout.top, entry.path), kind } as const;
    const lines = typeof count === 'object' ? count.added + count.removed : 0;
    const unshown = {
      ...file,
      hunks: [],
      ...(count ? { unshown: count } : {}),
    };
    if (
      count === 'binary' ||
      entry.status === 'T' ||
      entry.oldMode === gitlink ||
      entry.newMode === gitlink ||
      lines > budget
    )
      return unshown;
    // a mode change alone
    if (kind === 'update' && entry.old === entry.new)
      return { ...file, hunks: [] };
    try {
      const shown: FileDiff =
        kind === 'update'
          ? {
              ...file,
              hunks: hunks(
                await this.git(checkout, [
                  'diff',
                  '--no-color',
                  '--no-ext-diff',
                  '--no-textconv',
                  '-U3',
                  entry.old,
                  entry.new,
                ]),
              ),
            }
          : wholeFile(
              file.path,
              kind,
              await this.git(checkout, [
                'cat-file',
                'blob',
                kind === 'add' ? entry.new : entry.old,
              ]),
            );
      // Git can count lines by the path's attributes in a blob it then calls binary without them
      return (shown.hunks.length || !lines) && cost(shown) <= budget
        ? shown
        : unshown;
    } catch {
      // a blob Git can't hand over, one line past the output buffer for instance, keeps its file listed
      return unshown;
    }
  }

  /** settles once every operation asked for so far has finished, after which none of them writes `directory`. */
  settled(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  /** `cwd`'s checkout and the environment its Git calls run in, or nothing outside a repository. */
  private async checkout(cwd: string): Promise<Checkout | undefined> {
    const plain = { ...process.env, LC_ALL: 'C' };
    let top: string;
    try {
      top = (
        await this.run('git', [...options, 'rev-parse', '--show-toplevel'], {
          cwd,
          timeout,
          env: plain,
        })
      ).stdout.trimEnd();
    } catch (error) {
      const { stderr } = error as { stderr?: unknown };
      if (
        exitCode(error) === 128 &&
        typeof stderr === 'string' &&
        stderr.includes('not a git repository')
      )
        return undefined;
      throw error;
    }
    const env = { ...(await statusEnv(this.run, top)), LC_ALL: 'C' };
    const [index, objects] = (
      await this.run(
        'git',
        [
          ...options,
          'rev-parse',
          '--path-format=absolute',
          '--git-path',
          'index',
          '--git-path',
          'objects',
        ],
        { cwd: top, timeout, env },
      )
    ).stdout.split('\n') as [string, string];
    const store = join(this.directory, 'objects');
    await mkdir(store, { recursive: true });
    // a state directory can sit inside the checkout, and a snapshot must not take in its own storage
    await writeFile(join(this.directory, '.gitignore'), '*\n');
    const inherited = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    return {
      top,
      index,
      env: {
        ...env,
        GIT_INDEX_FILE: join(this.directory, 'index'),
        GIT_OBJECT_DIRECTORY: store,
        // quoted, since the list splits at a bare `:`
        GIT_ALTERNATE_OBJECT_DIRECTORIES:
          `"${objects.replace(/[\\"]/g, '\\$&')}"` +
          (inherited ? delimiter + inherited : ''),
      },
    };
  }

  /** the checkout as a tree: what the repository's index tracks plus untracked files that aren't ignored. */
  private async snapshot(checkout: Checkout): Promise<Baseline> {
    const at = Math.floor(Date.now() / 1000);
    let head: string | undefined;
    try {
      head = (
        await this.git(checkout, [
          'rev-parse',
          '-q',
          '--verify',
          'HEAD^{commit}',
        ])
      ).trim();
    } catch (error) {
      if (exitCode(error) !== 1) throw error;
    }
    const copy = checkout.env.GIT_INDEX_FILE!;
    await rm(copy, { force: true });
    try {
      const { atime, mtime } = await stat(checkout.index);
      await copyFile(checkout.index, copy);
      // Git rechecks an entry as old as its index, which catches an edit made in the second the index was written
      await utimes(copy, atime, mtime);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // `add` asks a nested repository the index tracks whether it changed, which can run a filter that repository's
    // own config names, so each stays out of the add and keeps the commit the index holds
    const tracked = fields(
      await this.git(checkout, ['ls-files', '-s', '-z'], listBuffer),
    )
      .filter((entry) => entry.startsWith(gitlink))
      .map(
        (entry) =>
          `:(top,exclude,literal)${entry.slice(entry.indexOf('\t') + 1)}`,
      );
    await this.git(checkout, [
      'add',
      '-A',
      ...(tracked.length ? ['--', ':(top)', ...tracked] : []),
    ]);
    return {
      tree: (await this.git(checkout, ['write-tree'])).trim(),
      head,
      at,
    };
  }

  private async git(
    checkout: Checkout,
    args: string[],
    maxBuffer?: number,
  ): Promise<string> {
    const { stdout } = await this.run('git', [...options, ...args], {
      cwd: checkout.top,
      timeout,
      env: checkout.env,
      ...(maxBuffer ? { maxBuffer } : {}),
    });
    return stdout;
  }

  /** one operation at a time, since they share the index copy, and a failed one leaves its baseline as it was. */
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation);
    this.chain = result.catch(() => undefined);
    return result.catch((error: unknown) => {
      throw new Error(`Couldn't read file changes: ${firstLine(error)}`);
    });
  }
}
