import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
import { Workspace } from './workspace.js';

export interface MemoryScope {
  global: string;
  project: string;
  /** the checkout's path key while an origin names another project, so its notes can move there. */
  checkout?: string;
}

export interface GitOptions {
  cwd: string;
  env?: Record<string, string>;
  input?: string;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type GitRunner = (
  args: readonly string[],
  options: GitOptions,
) => Promise<GitResult>;

// host and path of a URL or scp-style remote, so `git@github.com:a/b.git` and `https://github.com/a/b` match.
// like git, it reads a remote with a slash before any colon as a local path, a port only in a URL, and an scp host up to its colon.
// a leading slash is dropped, since that match already pairs a home-relative scp path with a URL's absolute one
const remote =
  /^(?=[^/]*:)(?:[a-zA-Z][\w+.-]*:\/\/(?:[^/]*@)?(\[[^\]]*\]|[^/:@]+)(?::\d*)?\/|(?:[^/:]*@)?(\[[^\]]*\]|[^/:@]+):)\/*(.+?)(?:\.git)?\/?$/;

/** a full refname, so a note named `main` at the worktree root can't make a revision ambiguous. */
export const main = 'refs/heads/main';

const overrides = [
  '-c',
  'user.name=Witch',
  '-c',
  'user.email=witch@localhost',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'commit.gpgsign=false',
  // prints non-ASCII paths as written instead of octal-escaped and quoted
  '-c',
  'core.quotePath=false',
];

export const runGit: GitRunner = (args, { cwd, env, input }) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.stdin.end(input);
  });

/** a key named for its repository, cut to fit the 255 UTF-16 units an APFS name holds with the hash. */
function projectKey(identity: string): string {
  let name = '';
  for (const char of basename(identity)) {
    if (name.length + char.length > 238) break;
    name += char;
  }
  return `projects/${name}-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

/** a run of percent escapes as text; one that isn't UTF-8 names no APFS path, so it stays escaped. */
function decoded(run: string): string {
  try {
    return decodeURIComponent(run);
  } catch {
    return run;
  }
}

/** a path as the OS reads it: links resolve in the part that exists, so `..` climbs out of a link's target, and a missing origin keeps its key. */
async function physical(path: string): Promise<string> {
  const real = await realpath(path).catch(() => undefined);
  if (real) return real;
  const parent = dirname(path);
  return parent === path ? path : join(await physical(parent), basename(path));
}

export async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** a note path relative to the memory root, refusing one that leaves the root or enters `.git`. */
export function notePath(path: string): string {
  const file = posix.normalize(path);
  const [top] = file.split('/');
  if (top === '..' || top === '.git')
    throw new Error('Memory path is outside the note directories');
  return file;
}

/** a note name is agent-written; without control characters it can't carry a terminal escape, such as an OSC 8 link, or a line break into text Witch writes around it. */
export function printable(path: string): string {
  return path.replace(/\p{Cc}/gu, '');
}

export class Memory {
  constructor(
    readonly root: string,
    private readonly runner: GitRunner = runGit,
  ) {}

  async run(
    cwd: string,
    args: readonly string[],
    options: {
      env?: Record<string, string>;
      input?: string;
      codes?: readonly number[];
    } = {},
  ): Promise<GitResult> {
    const result = await this.runner([...overrides, ...args], {
      cwd,
      env: options.env,
      input: options.input,
    });
    if (!(options.codes ?? [0]).includes(result.code))
      throw new Error(
        result.stderr.trim() || `git ${args[0]} exited with ${result.code}`,
      );
    return result;
  }

  async git(
    cwd: string,
    args: readonly string[],
    options: { env?: Record<string, string>; input?: string } = {},
  ): Promise<string> {
    return (await this.run(cwd, args, options)).stdout;
  }

  /** builds the seeded bare repository beside its final path, so a second instance never sees it half made. */
  async initialize(): Promise<void> {
    if (await exists(this.root)) return;
    const parent = dirname(this.root);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const building = `${this.root}.${randomUUID()}`;
    await this.git(parent, [
      'init',
      '--bare',
      '--quiet',
      '-b',
      'main',
      building,
    ]);
    // git init copies info/ from its template, which may not have one
    await mkdir(join(building, 'info'), { recursive: true });
    // every agent indexes its notes in MEMORY.md, so overlapping index lines merge instead of conflicting
    await writeFile(
      join(building, 'info', 'attributes'),
      'MEMORY.md merge=union\n',
    );
    const blob = await this.git(building, ['hash-object', '-w', '--stdin'], {
      input: '# Global memory\n',
    });
    const global = await this.git(building, ['mktree'], {
      input: `100644 blob ${blob.trim()}\tMEMORY.md\n`,
    });
    const tree = await this.git(building, ['mktree'], {
      input: `040000 tree ${global.trim()}\tglobal\n`,
    });
    const commit = await this.git(building, [
      'commit-tree',
      tree.trim(),
      '-m',
      'chore(memory): initialize shared memory',
    ]);
    await this.git(building, ['update-ref', main, commit.trim()]);
    try {
      await rename(building, this.root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
      await rm(building, { recursive: true, force: true });
    }
  }

  workspace(directory: string, id: string): Workspace {
    return new Workspace(this, join(directory, 'memory'), id);
  }

  /** the relative scope paths for a project directory; creates nothing. every clone of a repository shares its origin's scope. */
  async scopePaths(directory: string): Promise<MemoryScope> {
    const { identity, top } = await this.reach(await realpath(directory));
    const project = projectKey(identity);
    const checkout = projectKey(top);
    return {
      global: 'global',
      project,
      ...(checkout === project ? {} : { checkout }),
    };
  }

  /** the repository git reaches through a checkout's origin, and the checkout's top level. a local origin with an origin of its own is followed, so a clone of a clone shares its project. */
  private async reach(
    cwd: string,
    seen = new Set<string>(),
    ceiling?: string,
  ): Promise<{ identity: string; top: string }> {
    // only a missing origin, repository or work tree falls back, so a git that fails can't move the key.
    // git exits 128 for the last two and for fatal errors such as a bad config, so its untranslated message tells them apart.
    // a `.git` file whose gitdir is gone prints `not a git repository: <gitdir>`, without the parenthesis, and fails
    const read = async (args: string[]) => {
      const result = await this.run(cwd, args, {
        codes: [0, 2, 128],
        env: {
          LC_ALL: 'C',
          ...(ceiling ? { GIT_CEILING_DIRECTORIES: ceiling } : {}),
        },
      });
      if (
        result.code === 128 &&
        !/not a git repository \(|must be run in a work tree/.test(
          result.stderr,
        )
      )
        throw new Error(`${cwd}: ${result.stderr.trim()}`);
      return result.code === 0 ? result.stdout.trim() : undefined;
    };
    // git reads a `file://` origin as the path after its host, with percent escapes but `%00` decoded
    const origin = (await read(['remote', 'get-url', 'origin']))?.replace(
      /^file:\/\/[^/]*(.*)$/s,
      (_, path: string) => path.replace(/(?:%(?!00)[\da-f]{2})+/gi, decoded),
    );
    const [, url, scp, path] = (origin && remote.exec(origin)) || [];
    const host = url ?? scp;
    const top = (await read(['rev-parse', '--show-toplevel'])) || cwd;
    if (host) return { identity: `${host.toLowerCase()}/${path}`, top };
    seen.add(cwd).add(top);
    // git resolves a relative origin against the top level
    const local = await physical(
      origin?.startsWith('/') ? origin : `${top}/${origin ?? ''}`,
    );
    const directory = await stat(local).then(
      (found) => found.isDirectory(),
      () => false,
    );
    if (!origin || !directory || seen.has(local) || seen.size > 32)
      return { identity: local, top };
    // the ceiling stops git at the origin itself, so a directory inside another repository isn't that repository
    return {
      identity: (await this.reach(local, seen, dirname(local))).identity,
      top,
    };
  }

  async resolve(revision: string, cwd = this.root): Promise<string> {
    return (
      await this.git(cwd, ['rev-parse', '--verify', `${revision}^{commit}`])
    ).trim();
  }

  async snapshot(
    revision: string,
    root: string,
    scope: MemoryScope,
    previous?: string,
  ): Promise<string> {
    const paths = [scope.global, scope.project];
    const files = await this.files(revision, scope);
    const essentials = await Promise.all(
      paths.map(async (path) => {
        const index = `${path}/MEMORY.md`;
        const content = files.includes(index)
          ? await this.read(revision, index)
          : '(No saved essentials.)';
        return `${join(root, index)}\n${content}`;
      }),
    );
    const changes = previous
      ? await this.git(this.root, [
          'diff',
          '--name-status',
          previous,
          revision,
          '--',
          ...paths,
        ])
      : '';
    return [
      `Accepted shared memory, revision ${revision}.`,
      'This snapshot supersedes earlier shared-memory snapshots. Removed facts are no longer active preferences. Re-read changed reference notes before relying on them.',
      ...essentials,
      `Available reference notes:\n${files.map((file) => join(root, file)).join('\n') || '(none)'}`,
      ...(changes
        ? [`Changed or deleted notes since the previous snapshot:\n${changes}`]
        : []),
    ].join('\n\n');
  }

  async files(revision: string, scope: MemoryScope): Promise<string[]> {
    const result = await this.git(this.root, [
      'ls-tree',
      '-r',
      '-z',
      revision,
      '--',
      scope.global,
      scope.project,
    ]);
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

  async read(revision: string, path: string): Promise<string> {
    const file = notePath(path);
    const entry = await this.git(this.root, [
      'ls-tree',
      '-z',
      revision,
      '--',
      file,
    ]);
    if (!/^100(644|755) blob /.test(entry))
      throw new Error(`Memory notes must be regular files: ${file}`);
    return this.git(this.root, ['show', `${revision}:${file}`]);
  }

  async catalog(
    revision: string,
    scope: MemoryScope,
  ): Promise<{ path: string; deleted: boolean }[]> {
    const present = new Set(await this.files(revision, scope));
    const history = await this.git(this.root, [
      'log',
      '--format=',
      '--name-only',
      '-z',
      '--no-renames',
      revision,
      '--',
      scope.global,
      scope.project,
    ]);
    return [...new Set([...present, ...history.split('\0').filter(Boolean)])]
      .sort()
      .map((path) => ({ path, deleted: !present.has(path) }));
  }

  async history(
    revision: string,
    path: string,
  ): Promise<{ revision: string; subject: string }[]> {
    const log = await this.git(this.root, [
      'log',
      '--format=%H%x09%s',
      '--diff-filter=AM',
      '--no-renames',
      // a user's log.follow would otherwise follow the note's earlier name
      '--no-follow',
      revision,
      '--',
      notePath(path),
    ]);
    return log
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        return { revision: line.slice(0, tab), subject: line.slice(tab + 1) };
      });
  }
}
