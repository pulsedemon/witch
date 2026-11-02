import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { errorMessage } from '../agents/stderr.js';
import {
  branchOf,
  exists,
  indexNote,
  main,
  notePath,
  printable,
} from './memory.js';
import type { Memory, MemoryScope } from './memory.js';

export interface MemoryConflict {
  paths: string[];
  diff: string;
}

/** an index with each non-blank line of `added` it lacks appended once, in its own line endings. */
function mergeLines(index: string, added: string): string {
  const eol = index.includes('\r\n') ? '\r\n' : '\n';
  const present = new Set(index.split(/\r?\n/));
  const missing = [...new Set(added.split(/\r?\n/))].filter(
    (line) => line.trim() && !present.has(line),
  );
  if (!missing.length) return index;
  let end = index.length;
  while (end > 0 && index[end - 1] === '\n') {
    end--;
    if (end > 0 && index[end - 1] === '\r') end--;
  }
  const kept = index.slice(0, end);
  return `${kept ? `${kept}${eol}` : ''}${missing.join(eol)}${eol}`;
}

/** git's conflict list uses generated names; file/directory messages retain their original paths. */
function mergeResult(output: Buffer): {
  tree: string;
  paths: string[];
  relocated: Map<string, string>;
} {
  const fields = output.toString('utf8').split('\0');
  const separator = fields.indexOf('', 1);
  const relocated = new Map<string, string>();
  for (let cursor = separator + 1; cursor < fields.length - 1;) {
    const count = Number(fields[cursor++]);
    if (fields[cursor + count] === 'CONFLICT (file/directory)')
      relocated.set(fields[cursor]!, fields[cursor + 1]!);
    cursor += count + 2;
  }
  return {
    tree: fields[0]!,
    paths: fields.slice(1, separator),
    relocated,
  };
}

/** one conversation's memory: a worktree of the shared bare repository on its own branch. ignore rules never apply, so no `.gitignore` or user excludes file can hide a note. */
export class Workspace {
  private readonly branch: string;

  constructor(
    readonly memory: Memory,
    readonly root: string,
    private readonly id: string,
  ) {
    this.branch = branchOf(id);
  }

  private git(
    args: readonly string[],
    options?: { env?: Record<string, string>; input?: string },
  ): Promise<string> {
    return this.memory.git(this.root, args, options);
  }

  private async latest(): Promise<string> {
    return (await this.git(['rev-parse', main])).trim();
  }

  private async isAncestor(
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
    const result = await this.memory.run(
      this.root,
      ['merge-base', '--is-ancestor', ancestor, descendant],
      { codes: [0, 1] },
    );
    return result.code === 0;
  }

  exists(): Promise<boolean> {
    return exists(join(this.root, '.git'));
  }

  async branchExists(): Promise<boolean> {
    const result = await this.memory.run(
      this.memory.root,
      ['rev-parse', '--verify', '--quiet', `refs/heads/${this.branch}`],
      { codes: [0, 1] },
    );
    return result.code === 0;
  }

  /** `--force` replaces a stale registration of this path; the short branch name keeps `HEAD` attached. */
  async ensureWorktree(): Promise<void> {
    if (await this.exists()) {
      if (await this.rebaseStopped()) await this.git(['rebase', '--abort']);
      return;
    }
    await this.memory.git(this.memory.root, [
      'worktree',
      'add',
      '--force',
      '--quiet',
      ...((await this.branchExists())
        ? [this.root, this.branch]
        : ['-b', this.branch, this.root, main]),
    ]);
  }

  /** reads the worktree's `.git` file instead of spawning git, since every turn checks twice. */
  async rebaseStopped(): Promise<boolean> {
    const gitfile = join(this.root, '.git');
    // like git, keep line breaks inside the path and trim only trailing ones
    const gitdir = /^gitdir: (.+?)[\r\n]*$/s.exec(
      await readFile(gitfile, 'utf8'),
    )?.[1];
    if (!gitdir) throw new Error(`Not a worktree's .git file: ${gitfile}`);
    const directory = resolve(this.root, gitdir);
    // a missing git directory fails like git would, instead of reading as no rebase
    await lstat(directory);
    return exists(join(directory, 'rebase-merge'));
  }

  /** reads a checkout's scope and creates its directories. */
  async scope(cwd: string): Promise<MemoryScope> {
    const paths = await this.memory.scopePaths(cwd);
    await this.prepare(paths);
    return paths;
  }

  /** creates both scope directories, which git drops once their last note goes. */
  async prepare(scope: MemoryScope): Promise<void> {
    for (const directory of [scope.global, scope.project])
      await mkdir(await this.checkedPath(directory, 'directory'), {
        recursive: true,
      });
  }

  /** the scope directories an agent is given, global first. */
  directories(scope: MemoryScope): string[] {
    return [scope.global, scope.project].map((path) => join(this.root, path));
  }

  async revision(): Promise<string> {
    return this.memory.resolve('HEAD', this.root);
  }

  async isDirty(): Promise<boolean> {
    // the user's status.showUntrackedFiles=no would hide new notes
    return (
      (
        await this.git([
          'status',
          '--porcelain',
          '--untracked-files=normal',
          '--ignored=matching',
        ])
      ).length > 0
    );
  }

  /** publishes anything left over, moves to `main`, takes in the notes keyed by the checkout's path, and returns the revision the turn starts from. */
  async begin(scope: MemoryScope): Promise<string> {
    if (await this.isDirty())
      throw new Error('Resolve pending memory before running another task');
    if ((await this.publish()) !== 'published')
      throw new Error(
        'Your memory changes conflict with another conversation. Keep yours or discard them.',
      );
    for (let attempt = 1; ; attempt++) {
      await this.git(['merge', '--ff-only', '--quiet', main]);
      await this.prepare(scope);
      const moved = await this.adopt(scope).catch(async (error: unknown) => {
        await this.discardPending().catch((rollback: unknown) => {
          throw new Error(
            `${errorMessage(error)}\n\nCould not discard the failed memory move: ${errorMessage(rollback)}`,
            { cause: error },
          );
        });
        throw error;
      });
      if (!moved || (await this.publish()) === 'published')
        return this.revision();
      // discarding this derived move loses no accepted notes
      await this.git(['reset', '--hard', '--quiet', main]);
      if (attempt === 5)
        throw new Error(
          'Moving project notes kept losing to other conversations',
        );
    }
  }

  /** begins outside a turn to take in the notes keyed by the checkout's path, unless pending or unpublished memory waits for settling. */
  async adoptCheckout(scope: MemoryScope): Promise<void> {
    if (!(await this.exists()) || (await this.isDirty())) return;
    if (await this.isAncestor('HEAD', main)) await this.begin(scope);
  }

  /** merges the notes keyed by a checkout's path into its origin's project as a commit of its own, and says whether that key held notes. */
  private async adopt({ project, checkout }: MemoryScope): Promise<boolean> {
    if (!checkout) return false;
    // the index matches HEAD here, since begin runs only on a clean worktree
    const files = (await this.git(['ls-files', '-z', '--', checkout]))
      .split('\0')
      .filter(Boolean);
    if (!files.length) return false;
    const notes = new Set(files.map((file) => posix.relative(checkout, file)));
    const directories = new Set<string>();
    for (const note of notes)
      for (let dir = posix.dirname(note); dir !== '.'; dir = posix.dirname(dir))
        directories.add(dir);
    const label = posix.basename(checkout).replace(/-[0-9a-f]{16}$/, '');
    const index = posix.join(checkout, indexNote);
    const renamed = new Map<string, string>();
    // the index merges last, so its lines can link where renamed notes went
    for (const file of files.sort((a, b) => +(a === index) - +(b === index))) {
      const source = await this.checkedPath(file);
      const content = await readFile(source);
      const note = posix.relative(checkout, file);
      if (file === index) {
        // one pass, so a rewritten link can't match another rename. it reads the `<…>` form this move writes too
        const text = content
          .toString()
          .replace(
            /\]\((?:<([^<>\n]*)>|((?:[^\s()<>]|\([^\s()<>]*\))+))/g,
            (link, angled?: string, bare?: string) => {
              const target = angled ?? bare!;
              let split = target.search(/[?#]/);
              let directory = '';
              let start = 0;
              let rewritten: string | undefined;
              // only a complete literal note can override the first suffix match
              while (split >= 0) {
                const note = posix.join(directory, target.slice(start, split));
                if (rewritten === undefined && notes.has(note)) {
                  const to = renamed.get(note);
                  rewritten =
                    to === undefined ? link : `](<${to}${target.slice(split)}>`;
                }
                const slash = target.indexOf('/', split);
                if (slash < 0) break;
                const next = posix.join(directory, target.slice(start, slash));
                if (!directories.has(next)) break;
                directory = next;
                start = slash + 1;
                split = target.slice(start).search(/[?#]/);
                if (split >= 0) split += start;
              }
              const literal =
                split < 0
                  ? posix.normalize(target)
                  : posix.normalize(target.slice(0, split + 1)) +
                    target.slice(split + 1);
              const direct = renamed.get(literal);
              if (direct !== undefined) return `](<${direct}>`;
              return notes.has(literal) ? link : (rewritten ?? link);
            },
          );
        const target = await this.checkedPath(posix.join(project, note));
        await writeFile(
          target,
          (await exists(target))
            ? mergeLines((await readFile(target)).toString(), text)
            : text,
        );
        await rm(source);
        continue;
      }
      const placed = await this.place(project, label, note, content);
      if (placed === undefined) continue;
      const target = await this.checkedPath(posix.join(project, placed));
      if (await exists(target)) await rm(source);
      else {
        await mkdir(dirname(target), { recursive: true });
        await rename(source, target);
      }
      if (placed !== note) renamed.set(note, placed);
    }
    await this.commit(
      `chore(memory): move ${checkout} notes to ${project}\n\nconversation: ${this.id}`,
    );
    return true;
  }

  /** where a checkout's note goes in the project: its own path, else a copy named for the checkout beside a different version, else under a directory named for it when a note and a directory share a name or the copy's name is too long. a note it can place nowhere stays. */
  private async place(
    project: string,
    label: string,
    note: string,
    content: Buffer,
  ): Promise<string | undefined> {
    for (const base of [note, posix.join(`(${label})`, note)]) {
      const { dir, name, ext } = posix.parse(base);
      try {
        for (let copy = 0; ; copy++) {
          const placed = copy
            ? posix.join(
                dir,
                `${name} (${label}${copy > 1 ? ` ${copy}` : ''})${ext}`,
              )
            : base;
          if (posix.basename(placed).length > 255)
            throw new Error(`Name too long: ${placed}`);
          const target = await this.checkedPath(posix.join(project, placed));
          if (
            !(await exists(target)) ||
            (await readFile(target)).equals(content)
          )
            return placed;
        }
      } catch (error) {
        // a path taken by a directory or a note, or too long, tries the next base. an OS error fails the move
        if ((error as NodeJS.ErrnoException).code) throw error;
      }
    }
    return undefined;
  }

  async publish(): Promise<'published' | MemoryConflict> {
    // git resolves main itself, sparing the usual case a process to read it first
    if (await this.isAncestor('HEAD', main)) return 'published';
    for (let attempt = 0; attempt < 50; attempt++) {
      const latest = await this.latest();
      // an idle worktree behind main stays where its last turn left it
      if (await this.isAncestor('HEAD', latest)) return 'published';
      if (!(await this.isAncestor(latest, 'HEAD'))) {
        // --merge overrides rebase.backend=apply, which would stop where rebaseStopped() doesn't look
        const rebase = await this.memory.run(
          this.root,
          ['rebase', '--merge', '--quiet', latest],
          { codes: [0, 1, 128] },
        );
        if (rebase.code !== 0) {
          if (!(await this.rebaseStopped()))
            throw new Error(rebase.stderr.trim() || 'Memory rebase failed');
          try {
            return await this.rebaseConflict();
          } finally {
            await this.git(['rebase', '--abort']);
          }
        }
      }
      const update = await this.memory.run(
        this.root,
        ['update-ref', main, 'HEAD', latest],
        { codes: [0, 1, 128] },
      );
      if (update.code === 0) return 'published';
      if ((await this.latest()) === latest)
        throw new Error(
          update.stderr.trim() || 'Memory could not be published to main',
        );
      await delay(10 + Math.random() * 40);
    }
    throw new Error('Memory publishing kept losing to other conversations');
  }

  async commit(message: string): Promise<void> {
    if (!(await this.isDirty())) return;
    const files = await this.git(['ls-files', '--cached', '--others', '-z']);
    for (const file of new Set(files.split('\0').filter(Boolean)))
      await this.checkedPath(file);
    await this.git(['add', '--all', '--force', '--', '.']);
    await this.git(['commit', '--quiet', '-m', message]);
  }

  /** the pending changes, with new files shown whole. */
  async diff(): Promise<string> {
    const tracked = await this.git([
      'diff',
      // a user's diff.external would otherwise replace the unified diff
      '--no-ext-diff',
      '--no-prefix',
      'HEAD',
      '--',
    ]);
    const untracked = (await this.git(['ls-files', '--others', '-z']))
      .split('\0')
      .filter(Boolean);
    const additions = await Promise.all(
      untracked.map(
        async (file) =>
          `New file: ${printable(file)}\n${await this.checkedPath(file).then(
            (path) => readFile(path, 'utf8'),
            (error: unknown) => printable(String(error)),
          )}`,
      ),
    );
    return [tracked, ...additions].filter(Boolean).join('\n\n');
  }

  /** the original branch can undo the commit that stopped replay. */
  private async rebaseConflict(): Promise<MemoryConflict> {
    const blocked = (await this.git(['rev-parse', 'REBASE_HEAD'])).trim();
    const replayed = await this.revision();
    const merged = await this.memory.run(
      this.root,
      [
        'merge-tree',
        '--write-tree',
        '--messages',
        '-z',
        '--name-only',
        `--merge-base=${blocked}^`,
        replayed,
        blocked,
      ],
      { codes: [0, 1] },
    );
    const { paths, relocated } = mergeResult(merged.stdout);
    return {
      paths: [...new Set(paths.map((path) => relocated.get(path) ?? path))],
      diff: await this.git([
        'diff',
        '--no-ext-diff',
        '--no-prefix',
        `${blocked}^`,
        blocked,
        '--',
      ]),
    };
  }

  /** `clean -ffdx` also removes repositories an agent created inside memory. */
  async discardPending(): Promise<void> {
    await this.git(['reset', '--hard', '--quiet']);
    await this.git(['clean', '-ffdx', '--quiet']);
  }

  /** my side wins each conflicting change; every other change from both sides merges. */
  async keepMine(): Promise<void> {
    const latest = await this.latest();
    const merged = await this.memory.run(
      this.root,
      [
        'merge-tree',
        '--write-tree',
        '-X',
        'ours',
        '--messages',
        '-z',
        '--name-only',
        'HEAD',
        latest,
      ],
      { codes: [0, 1] },
    );
    const { tree, paths, relocated } = mergeResult(merged.stdout);
    const base = (await this.git(['merge-base', 'HEAD', latest])).trim();
    const index = resolve(
      this.root,
      (
        await this.git([
          'rev-parse',
          '--git-path',
          `witch-index-${randomUUID()}`,
        ])
      ).trim(),
    );
    const env = { GIT_INDEX_FILE: index };
    let commit: string;
    try {
      await this.git(['read-tree', tree], { env });
      for (const path of paths)
        if (
          !relocated.has(path) &&
          (await this.has(base, path)) &&
          !(await this.has('HEAD', path))
        )
          await this.git(['update-index', '--force-remove', '--', path], {
            env,
          });
      for (const [renamed, original] of relocated)
        await this.git(
          [
            '--literal-pathspecs',
            'reset',
            '--quiet',
            'HEAD',
            '--',
            renamed,
            original,
          ],
          { env },
        );
      const written = (await this.git(['write-tree'], { env })).trim();
      const messages = await this.git([
        'log',
        '--format=%B',
        `${latest}..HEAD`,
        '--',
      ]);
      commit = (
        await this.git(['commit-tree', written, '-p', latest, '-F', '-'], {
          input: messages,
        })
      ).trim();
    } finally {
      await rm(index, { force: true });
    }
    await this.git(['reset', '--hard', '--quiet', commit]);
  }

  async discardMine(): Promise<void> {
    await this.git(['reset', '--hard', '--quiet', main]);
  }

  async prepareNote(path: string): Promise<string> {
    const file = await this.checkedPath(path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '', { flag: 'wx' }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    return file;
  }

  async restore(path: string, revision: string): Promise<void> {
    const file = this.path(path);
    const destination = await this.checkedPath(file);
    const content = await this.memory.readBytes(revision, file);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
    await this.commit(`chore(memory): restore ${file}`);
  }

  private async has(revision: string, path: string): Promise<boolean> {
    return !!(await this.git(['ls-tree', '-z', revision, '--', path])).length;
  }

  private path(path: string): string {
    return notePath(relative(this.root, resolve(this.root, path)));
  }

  private async checkedPath(
    path: string,
    kind: 'file' | 'directory' = 'file',
  ): Promise<string> {
    const parts = this.path(path).split(sep).filter(Boolean);
    let current = this.root;
    for (let index = 0; index <= parts.length; index++) {
      if (index > 0) current = join(current, parts[index - 1]!);
      const stat = await lstat(current).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return undefined;
      });
      if (!stat) break;
      const directory = index < parts.length || kind === 'directory';
      if (directory ? !stat.isDirectory() : !stat.isFile())
        throw new Error(
          `Memory path must be a regular ${directory ? 'directory' : 'file'}: ${current}`,
        );
    }
    return join(this.root, ...parts);
  }
}
