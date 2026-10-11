import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export interface MemoryScope {
  global: string;
  project: string;
}

export interface MemorySnapshot {
  revision: string;
  text: string;
}

export class Memory {
  constructor(readonly root: string) {}

  async initialize(): Promise<void> {
    await this.checkedPath(this.root, 'directory');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const initialized = await access(join(this.root, '.git')).then(
      () => true,
      () => false,
    );
    if (!initialized) await this.git('init', '-b', 'main');
    const hasHead = await this.git('rev-parse', '--verify', 'HEAD').then(
      () => true,
      () => false,
    );
    if (!hasHead) {
      await this.prepareNote('global/MEMORY.md', '# Global memory\n');
      await this.commit('chore(memory): initialize shared memory');
    }
  }

  async scope(directory: string): Promise<MemoryScope> {
    const cwd = await realpath(directory);
    const projectRoot = await execute('git', ['rev-parse', '--show-toplevel'], {
      cwd,
    }).then(
      (result) => result.stdout.trim(),
      () => cwd,
    );
    const key = `${basename(projectRoot)}-${createHash('sha256').update(projectRoot).digest('hex').slice(0, 16)}`;
    const scope = {
      global: join(this.root, 'global'),
      project: join(this.root, 'projects', key),
    };
    await mkdir(await this.checkedPath(scope.global, 'directory'), {
      recursive: true,
    });
    await mkdir(await this.checkedPath(scope.project, 'directory'), {
      recursive: true,
    });
    return scope;
  }

  async revision(): Promise<string> {
    return (await this.git('rev-parse', 'HEAD')).trim();
  }

  async isDirty(): Promise<boolean> {
    return (await this.git('status', '--porcelain')).length > 0;
  }

  async snapshot(
    scope: MemoryScope,
    previous?: string,
  ): Promise<MemorySnapshot> {
    const revision = await this.revision();
    const paths = ['global', this.path(scope.project)];
    const files = await this.files(scope);
    const essentials = await Promise.all(
      paths.map(async (path) => {
        const index = `${path}/MEMORY.md`;
        const content = files.includes(index)
          ? await this.read(index)
          : '(No saved essentials.)';
        return `${join(this.root, index)}\n${content}`;
      }),
    );
    const changes =
      previous && previous !== revision
        ? await this.git(
            'diff',
            '--name-status',
            previous,
            revision,
            '--',
            ...paths,
          )
        : '';
    return {
      revision,
      text: [
        `Accepted shared memory, revision ${revision}.`,
        'This snapshot supersedes earlier shared-memory snapshots. Removed facts are no longer active preferences. Re-read changed reference notes before relying on them.',
        ...essentials,
        `Available reference notes:\n${files.map((file) => join(this.root, file)).join('\n') || '(none)'}`,
        ...(changes
          ? [
              `Changed or deleted notes since the previous snapshot:\n${changes}`,
            ]
          : []),
      ].join('\n\n'),
    };
  }

  async files(scope: MemoryScope): Promise<string[]> {
    const result = await this.git(
      'ls-tree',
      '-r',
      '-z',
      'HEAD',
      '--',
      'global',
      this.path(scope.project),
    );
    return result
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        if (!/^100(644|755) blob /.test(entry))
          throw new Error(
            `Memory notes must be regular files: ${entry.slice(entry.indexOf('\t') + 1)}`,
          );
        return entry.slice(entry.indexOf('\t') + 1);
      });
  }

  async read(path: string): Promise<string> {
    return this.readRevision(this.path(path), 'HEAD');
  }

  async prepareNote(path: string, initial = ''): Promise<string> {
    const file = await this.checkedPath(path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, initial, { flag: 'wx' }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    return file;
  }

  async catalog(
    scope: MemoryScope,
  ): Promise<{ path: string; deleted: boolean }[]> {
    const present = new Set(await this.files(scope));
    const history = await this.git(
      'log',
      '--format=',
      '--name-only',
      '-z',
      '--no-renames',
      'HEAD',
      '--',
      'global',
      this.path(scope.project),
    );
    return [...new Set([...present, ...history.split('\0').filter(Boolean)])]
      .sort()
      .map((path) => ({ path, deleted: !present.has(path) }));
  }

  async commit(message: string): Promise<string> {
    if (!(await this.isDirty())) return this.revision();
    const files = await this.git(
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
    );
    for (const file of new Set(files.split('\0').filter(Boolean)))
      await this.checkedPath(file);
    await this.git('add', '--all', '--', '.');
    await this.git(
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Witch',
      '-c',
      'user.email=witch@localhost',
      'commit',
      '-m',
      message,
    );
    return this.revision();
  }

  async diff(): Promise<string> {
    const tracked = await this.git('diff', 'HEAD');
    const untracked = (
      await this.git('ls-files', '--others', '--exclude-standard', '-z')
    )
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

  async discard(): Promise<void> {
    await this.git('reset', '--hard', 'HEAD');
    await this.git('clean', '-fd');
  }

  async history(
    path: string,
  ): Promise<{ revision: string; subject: string }[]> {
    const log = await this.git(
      'log',
      '--format=%H%x09%s',
      '--diff-filter=AM',
      '--no-renames',
      '--',
      this.path(path),
    );
    return log
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        return { revision: line.slice(0, tab), subject: line.slice(tab + 1) };
      });
  }

  async restore(path: string, revision: string): Promise<void> {
    if (await this.isDirty())
      throw new Error('Resolve pending memory before restoring a file');
    const file = this.path(path);
    const destination = await this.checkedPath(file);
    const content = await this.readRevision(file, revision);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
    await this.commit(`chore(memory): restore ${file}`);
  }

  private path(path: string): string {
    const file = relative(this.root, resolve(this.root, path));
    if (file === '..' || file.startsWith(`..${sep}`) || file.startsWith('.git'))
      throw new Error('Memory path is outside the note directories');
    return file;
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

  private async readRevision(file: string, revision: string): Promise<string> {
    const entry = await this.git('ls-tree', '-z', revision, '--', file);
    if (!/^100(644|755) blob /.test(entry))
      throw new Error(`Memory notes must be regular files: ${file}`);
    return this.git('show', `${revision}:${file}`);
  }

  private async git(...args: string[]): Promise<string> {
    return (
      await execute('git', args, {
        cwd: this.root,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;
  }
}
