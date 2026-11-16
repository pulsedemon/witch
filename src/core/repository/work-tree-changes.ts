import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { hunks, wholeFile } from '../../agents/file-diff.js';
import { errorMessage } from '../../errors.js';
import { unlessGone } from '../../persistence/json.js';
import type { FileDiff } from '../../agents/types.js';
import { statusEnv } from './repository.js';
import { execute } from './work-tree-git.js';
import type { GitRun } from './work-tree-git.js';

export interface Changes {
  files: FileDiff[];
  /** changed files left unlisted because they match other commits at a moved `HEAD` or a newly observed merge head. */
  withHead: number;
  /** files past the hundredth. */
  more: number;
}

interface Baseline {
  tree: string;
  head?: string;
  mergeHeads: string[];
  /** when the snapshot began, in seconds, before its `HEAD` was read. */
  at: number;
}

interface Checkout {
  top: string;
  index: string;
  mergeHeadPath: string;
  env: NodeJS.ProcessEnv;
  state: SnapshotState;
}

interface TreeEntry {
  mode: string;
  id: string;
}

interface FileState {
  signature: string;
  directory: boolean;
}

interface SnapshotState {
  identity: string;
  directory: string;
  hashLength: number;
  baseline?: Baseline;
  latest?: Baseline;
  source?: string;
  configuration?: string;
  tracked: Map<string, TreeEntry & { skipped: boolean; unmerged: boolean }>;
  entries: Map<string, TreeEntry>;
  metadata: Map<string, FileState | undefined>;
  attributes: Map<string, string>;
  objectsChanged: boolean;
  swept?: string;
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

/** what a failed Git call says went wrong, in one line. */
function cause(error: unknown): string {
  const { stderr, killed } = error as { stderr?: unknown; killed?: unknown };

  // a command stopped at its time limit has said nothing of it
  if (killed) return 'Git timed out';

  const text =
    typeof stderr === 'string' && stderr.trim() ? stderr : errorMessage(error);

  const lines = text.trim().split('\n');

  // Git prints its warnings before the line that says what failed
  return lines.find((line) => /^(?:fatal|error):/.test(line)) ?? lines[0]!;
}

const fields = (output: string) => output.split('\0').slice(0, -1);
/** Git's complaint about a nested repository with no commit, which `add` can't take and a snapshot does without. */
const unborn = /^error: '(.*)' does not have a commit checked out$/;
/** the line newer Gits print after their complaint about any path they couldn't add. */
const unindexed = /^error: unable to index file '(.*)'$/;

/**
 * what changed in a checkout between two looks, read from Git trees built in `directory` so that the repository's own
 * index, refs and objects stay unwritten. each checkout keeps one baseline, which only `read` and `absorb` move, so
 * a change shows on the next `read` whatever ran in between.
 */
export class WorkTreeChanges {
  private readonly checkouts = new Map<string, SnapshotState>();
  private nextCheckout = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly closing = new AbortController();
  private readonly run: GitRun;

  /** `directory` holds the index copy and the objects; it is created on first use. */
  constructor(
    private readonly directory: string,
    run: GitRun = execute,
  ) {
    const { signal } = this.closing;

    this.run = (command, args, options) =>
      run(command, args, { ...options, signal });
  }

  /** stops the Git call in flight and fails every operation queued behind it, so an exit doesn't wait for them. */
  close(): void {
    this.closing.abort();
  }

  /** takes a baseline unless one is held for `cwd`'s checkout. */
  watch(cwd: string): Promise<void> {
    return this.queue(async () => {
      const checkout = await this.checkout(cwd);

      if (checkout && !checkout.state.baseline) {
        const baseline = await this.snapshot(checkout);
        await this.reclaim(checkout);
        checkout.state.baseline = baseline;
      }
    });
  }

  /** takes the files a tool reported itself into the baseline, so the next `read` doesn't show them again. */
  absorb(cwd: string, paths: readonly string[]): Promise<void> {
    return this.queue(async () => {
      const checkout = await this.checkout(cwd);
      const baseline = checkout?.state.baseline;

      if (!baseline) return;

      const inside = new Set(
        paths
          .map((path) => relative(checkout.top, path))
          .filter(
            (path) => path && path !== '..' && !path.startsWith(`..${sep}`),
          ),
      );

      if (!inside.size) return;

      await this.snapshot(checkout);

      const absorption = {
        ...checkout,
        env: {
          ...checkout.env,
          GIT_INDEX_FILE: join(checkout.state.directory, 'absorb-index'),
        },
      };

      const zero = '0'.repeat(checkout.state.hashLength);
      const input = [...inside].map((path) => `0 ${zero}\t${path}\0`);

      for (const [path, entry] of checkout.state.entries) {
        if (entry.mode !== gitlink && inside.has(path))
          input.push(`${entry.mode} ${entry.id}\t${path}\0`);
      }

      checkout.state.objectsChanged = true;
      await rm(absorption.env.GIT_INDEX_FILE, { force: true });
      await this.git(absorption, ['read-tree', baseline.tree]);

      await this.git(
        absorption,
        ['update-index', '-z', '--index-info'],
        undefined,
        input.join(''),
      );

      const tree = (await this.git(absorption, ['write-tree'])).trim();
      await this.reclaim(checkout, tree);
      checkout.state.baseline = { ...baseline, tree };
    });
  }

  /** what changed since the baseline; no files when nothing did, there was no baseline, or `cwd` is outside a repository. */
  read(cwd: string): Promise<Changes> {
    return this.queue(async () => {
      const none: Changes = { files: [], withHead: 0, more: 0 };
      const checkout = await this.checkout(cwd);

      if (!checkout) return none;

      const baseline = checkout.state.baseline;
      const snapshot = await this.snapshot(checkout);

      if (!baseline) {
        await this.reclaim(checkout);
        checkout.state.baseline = snapshot;

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

      for (const head of snapshot.mergeHeads) {
        if (
          baseline.mergeHeads.includes(head) ||
          (await this.localCommits(checkout, baseline, head))
        )
          continue;

        const dirty = new Set(
          fields(await list('--name-only', head, snapshot.tree)),
        );

        const changed = entries.length;

        entries = entries.filter(
          ({ path }) =>
            checkout.state.tracked.get(path)?.unmerged || dirty.has(path),
        );

        withHead += changed - entries.length;
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

      await this.reclaim(checkout);
      checkout.state.baseline = snapshot;

      return { files, withHead, more: entries.length - shown.length };
    });
  }

  /** whether `head` descends from the baseline through only new commits, judged by their dates. */
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
                  // the user's setting could join distant hunks with every line between them
                  '--inter-hunk-context=0',
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

  /** settles once every operation asked for so far has finished; a Git call that `close` stopped may still be exiting. */
  settled(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  /** `cwd`'s checkout and the environment its Git calls run in, or nothing outside a repository. */
  private async checkout(cwd: string): Promise<Checkout | undefined> {
    const plain = { ...process.env, LC_ALL: 'C' };
    let top: string;

    try {
      const { stdout } = await this.run(
        'git',
        [...options, 'rev-parse', '--show-toplevel'],
        { cwd, timeout, env: plain },
      );

      // only Git's own newline goes: a directory's name can end in a space
      top = stdout.replace(/\n$/, '');
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

    // one call each: a directory's name can hold a newline, so two paths in one output can't be told apart
    const path = async (name: string) =>
      (
        await this.run(
          'git',
          [
            ...options,
            'rev-parse',
            '--path-format=absolute',
            '--git-path',
            name,
          ],
          { cwd: top, timeout, env },
        )
      ).stdout.replace(/\n$/, '');

    const [index, objects, mergeHeadPath] = await Promise.all([
      path('index'),
      path('objects'),
      path('MERGE_HEAD'),
    ]);

    const objectDirectory = await stat(objects, { bigint: true });
    const identity = `${index}\0${objects}\0${objectDirectory.dev}:${objectDirectory.ino}`;
    let state = this.checkouts.get(top);

    if (state?.identity !== identity) {
      if (!this.checkouts.size) {
        await mkdir(this.directory, { recursive: true });
        // storage inside the checkout must stay out of its own snapshots.
        await writeFile(join(this.directory, '.gitignore'), '*\n');
      }

      state = {
        identity,
        directory: join(this.directory, String(this.nextCheckout++)),
        hashLength:
          (
            await this.run(
              'git',
              [...options, 'rev-parse', '--show-object-format'],
              { cwd: top, timeout, env },
            )
          ).stdout.trim() === 'sha256'
            ? 64
            : 40,
        tracked: new Map(),
        entries: new Map(),
        metadata: new Map(),
        attributes: new Map(),
        objectsChanged: false,
      };

      await mkdir(join(state.directory, 'objects'), { recursive: true });
      this.checkouts.set(top, state);
    }

    const store = join(state.directory, 'objects');
    const inherited = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;

    return {
      top,
      index,
      mergeHeadPath,
      state,
      env: {
        ...env,
        GIT_INDEX_FILE: join(state.directory, 'index'),
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
    try {
      return await this.refresh(checkout);
    } catch (error) {
      checkout.state.source = undefined;
      checkout.state.metadata.clear();

      throw error;
    }
  }

  private async refresh(checkout: Checkout): Promise<Baseline> {
    const { state } = checkout;
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

    const mergeHeads = (
      (await unlessGone(readFile(checkout.mergeHeadPath, 'utf8'))) ?? ''
    )
      .split('\n')
      .filter(Boolean);

    const original = {
      ...checkout,
      env: { ...checkout.env, GIT_INDEX_FILE: checkout.index },
    };

    const source =
      (await this.fileState(checkout.index))?.signature ?? 'missing';

    let reset = state.source !== source;

    if (reset) {
      const tracked: SnapshotState['tracked'] = new Map();

      for (const row of fields(
        await this.git(original, ['ls-files', '-s', '-t', '-z'], listBuffer),
      )) {
        const tab = row.indexOf('\t');

        const [status, mode, id, stage] = row.slice(0, tab).split(' ') as [
          string,
          string,
          string,
          string,
        ];

        const path = row.slice(tab + 1);

        // a gitlink in any merge stage must keep nested filters out of the snapshot.
        if (tracked.get(path)?.mode !== gitlink)
          tracked.set(path, {
            mode,
            id,
            skipped: status === 'S',
            unmerged: stage !== '0',
          });
      }

      state.tracked = tracked;
    }

    const discovered = new Set(
      fields(
        await this.git(
          original,
          ['ls-files', '--others', '--exclude-standard', '-z'],
          listBuffer,
        ),
      ).map((path) => path.replace(/\/$/, '')),
    );

    const excluded = new Set(
      [...state.entries.keys()].filter(
        (path) => !state.tracked.has(path) && !discovered.has(path),
      ),
    );

    const paths = new Set([
      ...state.tracked.keys(),
      ...state.entries.keys(),
      ...discovered,
    ]);

    const configuration = await this.git(
      checkout,
      ['config', '--null', '--list'],
      listBuffer,
    );

    const attributes = new Map([...paths].map((path) => [path, '']));

    if (paths.size) {
      const rows = fields(
        await this.git(
          original,
          ['check-attr', '--all', '-z', '--stdin'],
          listBuffer,
          `${[...paths].join('\0')}\0`,
        ),
      );

      for (let index = 0; index + 2 < rows.length; index += 3) {
        const path = rows[index]!;

        attributes.set(
          path,
          `${attributes.get(path) ?? ''}${rows[index + 1]}\0${rows[index + 2]}\0`,
        );
      }
    }

    reset ||=
      state.configuration !== configuration ||
      [...state.attributes].some(
        ([path, value]) => paths.has(path) && attributes.get(path) !== value,
      );

    let entries = state.entries;

    if (reset) {
      await this.resetIndex(checkout);
      entries = state.tracked;
    }

    const metadata = new Map<string, FileState | undefined>();
    const selected = new Set<string>();
    const parents = new Map<string, boolean>();

    for (const path of paths) {
      this.closing.signal.throwIfAborted();
      let contained = true;

      for (
        let parent = dirname(path);
        parent !== '.';
        parent = dirname(parent)
      ) {
        let directory = parents.get(parent);

        if (directory === undefined) {
          directory =
            (await this.fileState(join(checkout.top, parent)))?.directory ??
            false;

          parents.set(parent, directory);
        }

        if (!directory) {
          contained = false;

          break;
        }
      }

      const current = contained
        ? await this.fileState(join(checkout.top, path))
        : undefined;

      metadata.set(path, current);

      if (
        state.tracked.get(path)?.mode === gitlink ||
        state.tracked.get(path)?.skipped ||
        excluded.has(path)
      )
        continue;

      if (
        reset ||
        (discovered.has(path) && !entries.has(path)) ||
        !state.metadata.has(path) ||
        state.metadata.get(path)?.signature !== current?.signature ||
        entries.get(path)?.mode === gitlink
      )
        selected.add(path);
    }

    const unmerged = [...selected].some(
      (path) => state.tracked.get(path)?.unmerged,
    );

    let changed = reset || unmerged;

    if (unmerged) {
      state.objectsChanged = true;

      if (!reset) await this.resetIndex(checkout);

      await this.add(checkout);
    } else {
      const remove = new Set(excluded);
      const files: string[] = [];
      const directories: string[] = [];
      const input: string[] = [];
      const zero = '0'.repeat(state.hashLength);

      for (const path of selected) {
        const current = metadata.get(path);
        const entry = entries.get(path);

        const nested =
          current?.directory &&
          (await this.fileState(join(checkout.top, path, '.git')));

        if (!current || (current.directory && !nested)) {
          if (entry) remove.add(path);

          continue;
        }

        // conversion must see the real index's content, including its CRLF decisions.
        const originalEntry = state.tracked.get(path);

        if (originalEntry)
          input.push(`${originalEntry.mode} ${originalEntry.id}\t${path}\0`);
        else if (entry) remove.add(path);

        (current.directory ? directories : files).push(path);
      }

      const indexInput =
        [...remove].map((path) => `0 ${zero}\t${path}\0`).join('') +
        input.join('');

      changed ||= Boolean(
        indexInput.length || files.length || directories.length,
      );

      if (changed) state.objectsChanged = true;

      if (indexInput.length)
        await this.git(
          checkout,
          ['update-index', '-z', '--index-info'],
          undefined,
          indexInput,
        );

      if (files.length)
        await this.git(
          checkout,
          ['update-index', '--add', '--remove', '--replace', '-z', '--stdin'],
          undefined,
          `${files.join('\0')}\0`,
        );

      await this.add(checkout, directories);
    }

    const tree =
      changed || !state.latest
        ? (await this.git(checkout, ['write-tree'])).trim()
        : state.latest.tree;

    if (tree !== state.latest?.tree)
      state.entries = await this.treeEntries(checkout, tree);

    for (const path of selected) {
      const before = metadata.get(path);

      if (
        before &&
        before.signature !==
          (await this.fileState(join(checkout.top, path)))?.signature
      )
        metadata.delete(path);
    }

    state.source = source;
    state.configuration = configuration;
    state.attributes = attributes;
    state.metadata = metadata;
    state.latest = { tree, head, mergeHeads, at };

    return state.latest;
  }

  private async resetIndex(checkout: Checkout): Promise<void> {
    const copy = checkout.env.GIT_INDEX_FILE!;
    await rm(copy, { force: true });

    try {
      const { atime, mtime } = await stat(checkout.index);
      await copyFile(checkout.index, copy);
      await utimes(copy, atime, mtime);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async fileState(path: string): Promise<FileState | undefined> {
    try {
      const data = await lstat(path, { bigint: true });

      return {
        signature: [
          data.dev,
          data.ino,
          data.mode,
          data.size,
          data.mtimeNs,
          data.ctimeNs,
        ].join(':'),
        directory: data.isDirectory(),
      };
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

  private async treeEntries(
    checkout: Checkout,
    tree: string,
  ): Promise<Map<string, TreeEntry>> {
    return new Map(
      fields(
        await this.git(
          checkout,
          ['ls-tree', '-r', '-z', '--full-tree', tree],
          listBuffer,
        ),
      ).map((row) => {
        const tab = row.indexOf('\t');

        const [mode, , id] = row.slice(0, tab).split(' ') as [
          string,
          string,
          string,
        ];

        return [row.slice(tab + 1), { mode, id }];
      }),
    );
  }

  private async add(checkout: Checkout, paths?: string[]): Promise<void> {
    if (paths?.length === 0) return;

    const excluded = paths
      ? []
      : [...checkout.state.tracked]
          .filter(([, entry]) => entry.mode === gitlink)
          .map(([path]) => `:(top,exclude,literal)${path}`);

    try {
      await this.git(
        checkout,
        [
          ...(paths ? ['--literal-pathspecs'] : []),
          'add',
          '-A',
          '--ignore-errors',
          ...(paths
            ? ['--pathspec-from-file=-', '--pathspec-file-nul']
            : excluded.length
              ? ['--', ':(top)', ...excluded]
              : []),
        ],
        undefined,
        paths ? `${paths.join('\0')}\0` : undefined,
      );
    } catch (error) {
      if (exitCode(error) !== 1) throw error;

      const lines = String((error as { stderr?: unknown }).stderr).split('\n');

      const nested = new Set(
        lines.flatMap((line) => unborn.exec(line)?.slice(1) ?? []),
      );

      const said = lines.filter((line) => {
        const path = unindexed.exec(line)?.[1];

        return !unborn.test(line) && (path === undefined || !nested.has(path));
      });

      if (said.some((line) => line.startsWith('error:')))
        throw Object.assign(error as object, { stderr: said.join('\n') });
    }
  }

  private async reclaim(checkout: Checkout, proposed?: string): Promise<void> {
    const { state } = checkout;

    const roots = [
      ...new Set(
        [state.baseline?.tree, state.latest?.tree, proposed].filter(
          (tree): tree is string => tree !== undefined,
        ),
      ),
    ].sort();

    const key = roots.join('\n');

    if (state.swept === key && !state.objectsChanged) return;

    const reachable = new Set(
      (
        await this.git(
          checkout,
          ['rev-list', '--objects', '--no-object-names', ...roots],
          listBuffer,
        )
      )
        .trim()
        .split('\n'),
    );

    const directory = checkout.env.GIT_OBJECT_DIRECTORY!;
    const objectName = new RegExp(`^[0-9a-f]{${state.hashLength - 2}}$`);
    const directories = await readdir(directory, { withFileTypes: true });
    const loose: string[] = [];

    for (const fanout of directories) {
      if (!fanout.isDirectory() || !/^[0-9a-f]{2}$/.test(fanout.name)) continue;

      for (const file of await readdir(join(directory, fanout.name), {
        withFileTypes: true,
      })) {
        this.closing.signal.throwIfAborted();

        if (!file.isFile() || !objectName.test(file.name)) continue;

        const path = join(directory, fanout.name, file.name);

        if (reachable.has(fanout.name + file.name)) loose.push(path);
        else await unlink(path);
      }
    }

    if (
      directories.some((entry) => entry.name === 'pack' && entry.isDirectory())
    ) {
      const packDirectory = join(directory, 'pack');

      const packName = new RegExp(
        `^pack-([0-9a-f]{${state.hashLength}})\\.(?:pack|idx|rev|bitmap)$`,
      );

      const previous = (await readdir(packDirectory)).filter((name) =>
        packName.test(name),
      );

      if (previous.some((name) => name.endsWith('.pack'))) {
        const stored = await this.git(
          {
            ...checkout,
            env: { ...checkout.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: '' },
          },
          [
            'cat-file',
            '--batch-all-objects',
            '--batch-check=%(objectname)',
            '--unordered',
          ],
          listBuffer,
        );

        if (
          stored
            .trim()
            .split('\n')
            .some((id) => !reachable.has(id))
        ) {
          const ids = new Set(
            (
              await this.git(
                checkout,
                [
                  'pack-objects',
                  '--revs',
                  '--local',
                  '--non-empty',
                  '--window=0',
                  join(packDirectory, 'pack'),
                ],
                listBuffer,
                `${roots.join('\n')}\n`,
              )
            )
              .trim()
              .split('\n'),
          );

          for (const name of previous)
            if (!ids.has(packName.exec(name)![1]!))
              await unlink(join(packDirectory, name));

          for (const path of loose) await unlink(path);
        }
      }
    }

    state.swept = key;
    state.objectsChanged = false;
  }

  private async git(
    checkout: Checkout,
    args: string[],
    maxBuffer?: number,
    input?: string,
  ): Promise<string> {
    const { stdout } = await this.run('git', [...options, ...args], {
      cwd: checkout.top,
      timeout,
      env: checkout.env,
      ...(maxBuffer ? { maxBuffer } : {}),
      ...(input === undefined ? {} : { input }),
    });

    return stdout;
  }

  /** one operation at a time, since they share the index copy, and a failed one leaves its baseline as it was. */
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(() => {
      this.closing.signal.throwIfAborted();

      return operation();
    });

    this.chain = result.catch(() => undefined);

    return result.catch((error: unknown) => {
      throw new Error(`Couldn't read file changes: ${cause(error)}`, {
        cause: error,
      });
    });
  }
}
