import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { exists, main, notePath } from './memory.js';
import type { Memory, MemoryScope } from './memory.js';

/** one conversation's memory: a worktree of the shared bare repository on its own branch. Ignore rules never apply, so no `.gitignore` or user excludes file can hide a note. */
export class Workspace {
  private readonly branch: string;

  constructor(
    private readonly memory: Memory,
    readonly root: string,
    id: string,
  ) {
    this.branch = `conversations/${id}`;
  }

  private git(
    args: readonly string[],
    options?: { env?: Record<string, string>; input?: string },
  ): Promise<string> {
    return this.memory.git(this.root, args, options);
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

  async rebaseStopped(): Promise<boolean> {
    const path = await this.git(['rev-parse', '--git-path', 'rebase-merge']);
    return exists(resolve(this.root, path.trim()));
  }

  /** creates both scope directories, which git drops once their last note goes. */
  async scope(cwd: string): Promise<MemoryScope> {
    const paths = await this.memory.scopePaths(cwd);
    for (const directory of [paths.global, paths.project])
      await mkdir(await this.checkedPath(directory, 'directory'), {
        recursive: true,
      });
    return paths;
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

  /** publishes anything left over, moves to `main`, and returns the revision and scope the turn starts from. */
  async begin(cwd: string): Promise<{ revision: string; scope: MemoryScope }> {
    if (await this.isDirty())
      throw new Error('Resolve pending memory before running another task');
    if ((await this.publish()) === 'conflict')
      throw new Error(
        'Your memory changes conflict with another conversation. Keep yours or discard them.',
      );
    await this.git(['merge', '--ff-only', '--quiet', main]);
    return { revision: await this.revision(), scope: await this.scope(cwd) };
  }

  async publish(): Promise<'published' | 'conflict'> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const latest = (await this.git(['rev-parse', main])).trim();
      // an idle worktree behind main stays where its last turn left it
      const published = await this.memory.run(
        this.root,
        ['merge-base', '--is-ancestor', 'HEAD', latest],
        { codes: [0, 1] },
      );
      if (published.code === 0) return 'published';
      const based = await this.memory.run(
        this.root,
        ['merge-base', '--is-ancestor', latest, 'HEAD'],
        { codes: [0, 1] },
      );
      if (based.code !== 0) {
        // --merge overrides rebase.backend=apply, which would stop where rebaseStopped() doesn't look
        const rebase = await this.memory.run(
          this.root,
          ['rebase', '--merge', '--quiet', latest],
          { codes: [0, 1, 128] },
        );
        if (rebase.code !== 0) {
          if (!(await this.rebaseStopped()))
            throw new Error(rebase.stderr.trim() || 'Memory rebase failed');
          await this.git(['rebase', '--abort']);
          return 'conflict';
        }
      }
      const update = await this.memory.run(
        this.root,
        ['update-ref', main, 'HEAD', latest],
        { codes: [0, 1, 128] },
      );
      if (update.code === 0) return 'published';
      if ((await this.git(['rev-parse', main])).trim() === latest)
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
    const tracked = await this.git(['diff', 'HEAD', '--']);
    const untracked = (await this.git(['ls-files', '--others', '-z']))
      .split('\0')
      .filter(Boolean);
    const additions = await Promise.all(
      untracked.map(
        async (file) =>
          `New file: ${file}\n${await this.checkedPath(file).then(
            (path) => readFile(path, 'utf8'),
            (error: unknown) => String(error),
          )}`,
      ),
    );
    return [tracked, ...additions].filter(Boolean).join('\n\n');
  }

  /** the paths `main` and this branch disagree on, including content conflicts, and this branch's changes. */
  async conflict(): Promise<{ paths: string[]; diff: string }> {
    const latest = (await this.git(['rev-parse', main])).trim();
    const merged = await this.memory.run(
      this.root,
      [
        'merge-tree',
        '--write-tree',
        '--no-messages',
        '-z',
        '--name-only',
        latest,
        'HEAD',
      ],
      { codes: [0, 1] },
    );
    const base = (await this.git(['merge-base', 'HEAD', latest])).trim();
    return {
      paths: merged.stdout.split('\0').slice(1).filter(Boolean),
      diff: await this.git(['diff', base, 'HEAD', '--']),
    };
  }

  /** `clean -ffdx` also removes repositories an agent created inside memory. */
  async discardPending(): Promise<void> {
    await this.git(['reset', '--hard', '--quiet']);
    await this.git(['clean', '-ffdx', '--quiet']);
  }

  /** my side wins each conflicting change; every other change from both sides merges. */
  async keepMine(): Promise<void> {
    const latest = (await this.git(['rev-parse', main])).trim();
    const merged = await this.memory.run(
      this.root,
      [
        'merge-tree',
        '--write-tree',
        '-X',
        'ours',
        '--no-messages',
        '-z',
        '--name-only',
        'HEAD',
        latest,
      ],
      { codes: [0, 1] },
    );
    const [tree, ...listed] = merged.stdout.split('\0');
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
      await this.git(['read-tree', tree!], { env });
      for (const path of listed.filter(Boolean))
        if ((await this.has(base, path)) && !(await this.has('HEAD', path)))
          await this.git(['update-index', '--force-remove', '--', path], {
            env,
          });
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
    const content = await this.memory.read(revision, file);
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
