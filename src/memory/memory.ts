import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
import { Workspace } from './workspace.js';
import { present } from '../persistence/directories.js';
import { gone } from '../persistence/json.js';

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
  signal?: AbortSignal;
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

export type GitRunner = (
  args: readonly string[],
  options: GitOptions,
) => Promise<GitResult>;

// host and path of a URL or scp-style remote, so `git@github.com:a/b.git` and `https://github.com/a/b` match.
// like git, it reads a remote with a slash before any colon as a local path and an scp host up to its colon. a URL's port is dropped, a port inside an scp host's brackets stays.
// a leading slash is dropped, so `host:/srv/a` matches `ssh://host/srv/a` as `host:a` matches `https://host/a`
const remote =
  /^(?=[^/]*:)(?:[a-zA-Z][\w+.-]*:\/\/(?:[^/]*@)?(\[[^\]]*\]|[^/:@]+)(?::\d*)?\/|(?:[^/:]*@)?(\[[^\]]*\]|[^/:@]+):)\/*(.+?)(?:\.git)?\/?$/s;

/** a full refname, so a note named `main` at the worktree root can't make a revision ambiguous. */
export const main = 'refs/heads/main';

const branches = 'conversations/';

/** the branch a conversation's memory worktree is on. */
export const branchOf = (id: string) => `${branches}${id}`;

/** the note that indexes the rest of its scope. */
export const indexNote = 'MEMORY.md';

export const indexByteLimit = 6_000;

const changeListByteLimit = 2_000;

const staleReferences =
  'Treat all previously read reference notes as stale. Rediscover relevant notes in the current shared-memory directories before relying on them; missing notes no longer apply.';

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

export const runGit: GitRunner = (args, { cwd, env, input, signal }) =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();

    const child = spawn('git', args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      signal,
      killSignal: 'SIGKILL',
    });

    const stdout: Buffer[] = [];

    let stderr = '';

    let failure: Error | undefined;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });

    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.stdin.on('error', () => {});

    child.on('error', (error) => {
      failure = error;
    });

    child.on('close', (code) => {
      if (failure) reject(failure);
      else resolve({ stdout: Buffer.concat(stdout), stderr, code: code ?? 1 });
    });

    child.stdin.end(input);
  });

/** preserves APFS keys while fitting Linux's byte limit, without splitting a code point. */
export function projectKey(identity: string): string {
  let name = '';

  for (const char of basename(identity)) {
    const next = name + char;

    if (
      (process.platform === 'linux' ? Buffer.byteLength(next) : next.length) >
      238
    )
      break;

    name = next;
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

/** a path as the OS reads it: links resolve in the part that exists, so `..` climbs out of a link's target, and an origin not created yet keys as its path, as it does once created with no origin of its own. one the OS refuses to read throws. */
async function physical(path: string): Promise<string> {
  const real = await realpath(path).catch((error: unknown) => {
    if (!gone(error)) throw error;
  });

  if (real) return real;

  const parent = dirname(path);

  return parent === path ? path : join(await physical(parent), basename(path));
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

/** text for a notice, which renders as Markdown, escaped so it can't carry a Markdown link of its own. */
export function noticeText(text: string): string {
  return printable(text).replace(/[\\[\]]/g, '\\$&');
}

/** the shared memory repository under a state root. */
export function memoryRepository(stateRoot: string): string {
  return join(stateRoot, 'memory.git');
}

/** the path in an `ls-tree -z` entry, refusing anything but a regular file, named `name` in the refusal. */
function noteEntry(
  entry: string,
  name = entry.slice(entry.indexOf('\t') + 1),
): string {
  if (!/^100(644|755) blob /.test(entry))
    throw new Error(`Memory notes must be regular files: ${name}`);

  return entry.slice(entry.indexOf('\t') + 1);
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
      signal?: AbortSignal;
    } = {},
  ): Promise<GitResult> {
    const result = await this.runner([...overrides, ...args], {
      cwd,
      env: options.env,
      input: options.input,
      signal: options.signal,
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
    return (await this.run(cwd, args, options)).stdout.toString('utf8');
  }

  /** builds the seeded bare repository beside its final path, so a second instance never sees it half made. */
  async initialize(): Promise<void> {
    if (await present(this.root)) return;

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
      `${indexNote} merge=union\n`,
    );

    const blob = await this.git(building, ['hash-object', '-w', '--stdin'], {
      input: '# Global memory\n',
    });

    const global = await this.git(building, ['mktree'], {
      input: `100644 blob ${blob.trim()}\t${indexNote}\n`,
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

  /** the relative scope paths for a project directory; creates nothing. */
  async scopePaths(
    directory: string,
    signal?: AbortSignal,
  ): Promise<MemoryScope> {
    signal?.throwIfAborted();

    const { identity, top } = await this.reach(
      await realpath(directory),
      signal,
    );

    signal?.throwIfAborted();

    const project = projectKey(identity);

    const checkout = projectKey(top);

    return {
      global: 'global',
      project,
      ...(checkout === project ? {} : { checkout }),
    };
  }

  /** the path a directory's project key derives from, when that project is keyed by its own path rather than an origin. */
  async pathScope(directory: string): Promise<string | undefined> {
    const { identity, top } = await this.reach(await realpath(directory));

    return identity === top ? top : undefined;
  }

  /** the Git config of the repository holding a directory, or undefined when Git exits 128, such as outside a repository. */
  async configPath(directory: string): Promise<string | undefined> {
    const result = await this.run(
      directory,
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { codes: [0, 128] },
    );

    return result.code === 0
      ? join(result.stdout.toString('utf8').trim(), 'config')
      : undefined;
  }

  /** the repository git reaches through a checkout's origin, and the checkout's top level. a local origin with an origin of its own is followed, so a clone of a clone shares its project. */
  private async reach(
    cwd: string,
    signal?: AbortSignal,
    seen = new Set<string>(),
  ): Promise<{ identity: string; top: string }> {
    // only absent origins and work trees may change the project key; other Git failures must surface.
    // exit 128 also covers fatal errors, so only untranslated missing-work-tree messages fall back.
    // a broken `.git` target remains an error.
    let outside = false;

    const read = async (
      args: string[],
      absent = /not a git repository \(|must be run in a work tree/,
    ) => {
      signal?.throwIfAborted();

      const result = await this.run(cwd, args, {
        codes: [0, 2, 128],
        env: { LC_ALL: 'C' },
        signal,
      });

      signal?.throwIfAborted();

      if (result.code === 128 && !absent.test(result.stderr))
        throw new Error(`${cwd}: ${result.stderr.trim()}`);

      outside =
        result.code === 128 && /not a git repository \(/.test(result.stderr);

      return result.code === 0
        ? result.stdout.toString('utf8').trim()
        : undefined;
    };

    // git reads a `file://` origin as the path after its host, decoding every percent escape except `%00`
    const origin = (await read(['remote', 'get-url', 'origin']))?.replace(
      /^file:\/\/[^/]*(.*)$/s,
      (_, path: string) => path.replace(/(?:%(?!00)[\da-f]{2})+/gi, decoded),
    );

    // outside any repository there is no top level either, so git needn't be asked
    if (outside) return { identity: cwd, top: cwd };

    const [, url, scp, path] = (origin && remote.exec(origin)) || [];

    const host = url ?? scp;

    const top = (await read(['rev-parse', '--show-toplevel'])) || cwd;

    if (host) return { identity: `${host.toLowerCase()}/${path}`, top };

    if (!origin) return { identity: top, top };

    seen.add(cwd).add(top);

    // git resolves a relative origin against the top level, and `<p>/.git` is `<p>`'s repository
    const given = await physical(
      origin.startsWith('/') ? origin : `${top}/${origin}`,
    );

    const local = basename(given) === '.git' ? dirname(given) : given;

    // git reaches the first of these that is a repository, so a directory inside another repository isn't that repository
    const dotted = await physical(`${local}.git`);

    let repository: string | undefined;

    for (const [form, directory] of [
      [join(local, '.git'), local],
      [local, local],
      [join(dotted, '.git'), dotted],
      [dotted, dotted],
    ] as const)
      if (
        // git reads a missing form as not a gitdir, so it needs no process
        !(await lstat(form).then(() => false, gone)) &&
        (await read(
          ['rev-parse', '--resolve-git-dir', form],
          /not a gitdir|invalid gitfile format|too large to be a \.git file/,
        ))
      ) {
        repository = directory;

        break;
      }

    if (!repository || seen.has(repository)) return { identity: local, top };

    return {
      identity: (await this.reach(repository, signal, seen)).identity,
      top,
    };
  }

  async resolve(revision: string, cwd = this.root): Promise<string> {
    return (
      await this.git(cwd, ['rev-parse', '--verify', `${revision}^{commit}`])
    ).trim();
  }

  /** the ids of conversations whose branches hold commits `main` lacks. */
  async unpublished(): Promise<string[]> {
    return (
      await this.git(this.root, [
        'for-each-ref',
        `--format=%(refname:short) %(ahead-behind:${main})`,
        `refs/heads/${branches}`,
      ])
    )
      .split('\n')
      .map((line) => line.split(' '))
      .filter(([, count]) => Number(count) > 0)
      .map(([branch]) => branch!.slice(branches.length));
  }

  /** reverted paths still need delivery after an unsuccessful turn received an intermediate revision. */
  async snapshot(
    revision: string,
    root: string,
    scope: MemoryScope,
    previous?: string,
  ): Promise<string> {
    const paths = [scope.global, scope.project];

    const changed = previous
      ? new Set(await this.touchedPaths(`${previous}..${revision}`, scope))
      : undefined;

    if (changed?.size === 0) return '';

    const files = new Set(await this.files(revision, scope));

    const essentials = await Promise.all(
      paths
        .map((path) => `${path}/${indexNote}`)
        .filter((index) => !changed || changed.has(index))
        .map(async (index) => {
          const content = files.has(index)
            ? await this.git(this.root, [
                'show',
                `${revision}:${notePath(index)}`,
              ])
            : '(No saved essentials.)';

          const bytes = Buffer.byteLength(content, 'utf8');

          const body =
            bytes <= indexByteLimit
              ? content
              : `(${bytes} bytes)\nThis index exceeds the inline budget. Read the complete file at the path above before acting. It replaces the previous index for this scope; do not rely on an older copy. Preserve its details in linked notes before shortening it.`;

          return `${join(root, index)}\n${body}`;
        }),
    );

    let changes: string | undefined;

    if (previous && changed) {
      const before = new Set(await this.files(previous, scope));

      const list = [...changed]
        .sort()
        .map((path) => {
          const status = !files.has(path) ? 'D' : before.has(path) ? 'M' : 'A';

          return `${status}\t${JSON.stringify(join(root, path))}`;
        })
        .join('\n');

      changes =
        Buffer.byteLength(list, 'utf8') > changeListByteLimit
          ? staleReferences
          : `Changed or deleted notes since the previous snapshot:\n${list}`;
    }

    return [
      `Accepted shared memory, revision ${revision}.`,
      previous
        ? 'The index blocks below replace only their named scopes. Other current scopes are unchanged. Removed index facts and deleted notes are no longer active. Re-read changed reference notes before relying on them.'
        : `This baseline supersedes all earlier shared-memory snapshots. Only the global and project scopes named here apply. Removed facts are no longer active preferences. ${staleReferences}`,
      ...essentials,
      ...(changes ? [changes] : []),
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
      .map((entry) => noteEntry(entry));
  }

  async readBytes(revision: string, path: string): Promise<Buffer> {
    const file = notePath(path);

    const entry = await this.git(this.root, [
      'ls-tree',
      '-z',
      revision,
      '--',
      file,
    ]);

    noteEntry(entry, file);

    return (await this.run(this.root, ['show', `${revision}:${file}`])).stdout;
  }

  async read(revision: string, path: string): Promise<string> {
    return (await this.readBytes(revision, path)).toString('utf8');
  }

  async catalog(
    revision: string,
    scope: MemoryScope,
  ): Promise<{ path: string; deleted: boolean }[]> {
    const present = new Set(await this.files(revision, scope));

    const history = await this.touchedPaths(revision, scope);

    return [...new Set([...present, ...history])]
      .sort()
      .map((path) => ({ path, deleted: !present.has(path) }));
  }

  private async touchedPaths(
    revisions: string,
    scope: MemoryScope,
  ): Promise<string[]> {
    const history = await this.git(this.root, [
      'log',
      '--format=',
      '--name-only',
      '-z',
      '--no-renames',
      revisions,
      '--',
      scope.global,
      scope.project,
    ]);

    return history.split('\0').filter(Boolean);
  }

  async history(
    revision: string,
    path: string,
  ): Promise<{ revision: string; subject: string }[]> {
    const log = await this.git(this.root, [
      '--literal-pathspecs',
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
