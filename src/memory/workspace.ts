import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { errorMessage } from '../errors.js';
import { branchOf, indexNote, main, notePath, printable } from './memory.js';
import type { Memory, MemoryScope } from './memory.js';
import { within } from '../paths.js';
import { mapper, present } from '../persistence/directories.js';
import type { Ledger } from '../persistence/directories.js';

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

const nameCharacter = /[\p{L}\p{N}_\-./~]/u;

const delimiter = /[\s`'"()[\]<>,;:#?]/;

/** whitespace then a word holding a slash, which continues a path whose name has a space. */
const spacedPath = /[^\S\n]+\S*\//y;

/** what may follow a whole path: a separator, a delimiter, or a sentence's full stop. */
const pathEnd = /[/#?\s`'")\]>,;:]|\.(?=\s|$)/y;

const matchesAt = (pattern: RegExp, text: string, index: number) => {
  pattern.lastIndex = index;

  return pattern.test(text);
};

/**
 * a note with each reference to a moved directory, absolute or under `~/`, mapped through `map`. a reference ends at a
 * path boundary: inside `` `…` `` or `<…>` the rest of the span up to a `#` or `?`, elsewhere the next delimiter. a
 * moved path followed by a space and a word holding a slash is left alone, since the space may be part of the name.
 */
export function repointText(
  text: string,
  forms: readonly string[],
  map: (path: string) => string | undefined,
  home: string,
): string {
  const pattern = new RegExp(
    [...forms]
      .sort((a, b) => b.length - a.length)
      .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|'),
    'g',
  );

  let result = '';

  let cursor = 0;

  // the line's backtick and angle bracket state up to `scanned`, carried from match to match so each line is read once
  let scanned = 0;

  let ticks = false;

  let opened = -1;

  let closed = -1;

  let lineEnd = -1;

  // the next of each boundary character at or after the last search, Infinity once there's none
  const next = { '`': -1, '>': -1, '#': -1, '?': -1 };

  const nextOf = (character: keyof typeof next, from: number) => {
    if (next[character] < from) {
      const found = text.indexOf(character, from);

      next[character] = found < 0 ? Infinity : found;
    }

    return next[character];
  };

  // where the bare path last scanned stops, which every later match inside it shares
  let pathStop = -1;

  for (const match of text.matchAll(pattern)) {
    const start = match.index;

    const form = match[0];

    for (; scanned < start; scanned++) {
      const character = text[scanned];

      if (character === '\n') {
        ticks = false;

        opened = closed = -1;
      } else if (character === '`') ticks = !ticks;
      else if (character === '<') opened = scanned;
      else if (character === '>') closed = scanned;
    }

    if (start < cursor || nameCharacter.test(text[start - 1] ?? '')) continue;

    if (lineEnd < start) {
      const newline = text.indexOf('\n', start);

      lineEnd = newline < 0 ? text.length : newline;
    }

    const angle = opened > closed;

    const tail = start + form.length;

    const close = ticks ? nextOf('`', tail) : angle ? nextOf('>', tail) : -1;

    let end = tail;

    if ((ticks || angle) && close >= 0 && close <= lineEnd) {
      if (tail < close && !'/#?'.includes(text[tail]!)) continue;

      end = Math.min(close, nextOf('#', tail), nextOf('?', tail));
    } else {
      if (matchesAt(spacedPath, text, tail)) continue;

      if (tail < lineEnd && !matchesAt(pathEnd, text, tail)) continue;

      if (text[tail] === '/') {
        if (pathStop < tail) {
          pathStop = tail;

          while (pathStop < lineEnd) {
            const character = text[pathStop]!;

            if (delimiter.test(character)) break;

            if (
              character === '.' &&
              (pathStop + 1 === lineEnd || /\s/.test(text[pathStop + 1]!))
            )
              break;

            pathStop++;
          }
        }

        end = pathStop;
      }
    }

    // macOS opens no path longer than PATH_MAX bytes, so a longer reference names no directory. a UTF-16 unit is at
    // least a byte, which lets the length rule most out before the slice
    if (end - start > 1024) continue;

    const reference = text.slice(start, end);

    if (Buffer.byteLength(reference) > 1024) continue;

    const tilde = form.startsWith('~');

    const absolute = tilde ? home + reference.slice(1) : reference;

    const moved = map(absolute);

    if (moved === undefined || moved === absolute) continue;

    let replacement =
      tilde && within(moved, home) ? `~${moved.slice(home.length)}` : moved;

    if (
      /\s/.test(replacement) &&
      text.slice(start - 2, start) === '](' &&
      !angle
    )
      replacement = `<${replacement}>`;

    result += text.slice(cursor, start) + replacement;

    cursor = end;
  }

  return result + text.slice(cursor);
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
    return present(join(this.root, '.git'));
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

    const add = (args: string[]) =>
      this.memory.git(this.memory.root, [
        'worktree',
        'add',
        '--force',
        '--quiet',
        ...args,
      ]);

    // a missing worktree is almost always a new conversation's, so creating its branch first spares a lookup
    await add(['-b', this.branch, this.root, main]).catch(
      async (error: unknown) => {
        if (!(await this.branchExists())) throw error;

        await add([this.root, this.branch]);
      },
    );
  }

  /** restores the worktree of a branch that exists, never creating the branch. */
  async repairWorktree(): Promise<void> {
    if (await this.branchExists()) await this.ensureWorktree();
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

    return present(join(directory, 'rebase-merge'));
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
    return (await this.status()).dirty;
  }

  /** whether the worktree holds changes, the commit HEAD names, and HEAD's commits ahead of and behind `main`, from one process. the counts are absent when git can't give them, such as on a detached HEAD. */
  async status(): Promise<{
    dirty: boolean;
    head: string;
    ahead?: number;
    behind?: number;
  }> {
    // the user's status.showUntrackedFiles=no would hide new notes
    const output = await this.git([
      // `main` as the branch's upstream has status count against it, sparing a merge-base
      '-c',
      `branch.${this.branch}.remote=.`,
      '-c',
      `branch.${this.branch}.merge=${main}`,
      'status',
      '--porcelain=v2',
      '--branch',
      '--ahead-behind',
      '--untracked-files=normal',
      '--ignored=matching',
    ]);

    // an upstream in the repository's config comes first and outranks the one given here
    const [, ahead, behind] =
      /^# branch\.upstream main\n# branch\.ab \+(\d+) -(\d+)$/m.exec(output) ??
      [];

    return {
      // every line but the `# ` headers is a change
      dirty: /^[^#]/m.test(output),
      head: /^# branch\.oid (\S+)$/m.exec(output)![1]!,
      ...(ahead !== undefined && {
        ahead: Number(ahead),
        behind: Number(behind),
      }),
    };
  }

  /**
   * publishes anything left over, moves to `main`, takes in the notes keyed by the checkout's path and by the `former`
   * keys a path-keyed project had before it moved, repoints notes at directories that moved, and returns the revision
   * the turn starts from with how many notes it repointed. a failed repoint is rolled back and reported in `notice`, so
   * only a failed rollback stops the turn.
   */
  async begin(
    scope: MemoryScope,
    ledger?: Ledger,
    former: readonly string[] = [],
  ): Promise<{ revision: string; repointed: number; notice?: string }> {
    const { dirty, head, ahead, behind } = await this.status();

    if (dirty)
      throw new Error('Resolve pending memory before running another task');

    // level with main, HEAD names main's commit
    let latest = ahead === 0 && behind === 0 ? head : await this.latest();

    // a worktree at or behind main has nothing to publish
    if (head !== latest && !(await this.isAncestor(head, latest))) {
      if ((await this.publish()) !== 'published')
        throw new Error(
          'Your memory changes conflict with another conversation. Keep yours or discard them.',
        );

      latest = await this.latest();
    }

    return this.beginFrom(head, latest, scope, ledger, former);
  }

  /** begins from a clean worktree at `head`, which is `latest` or behind it. */
  private async beginFrom(
    head: string,
    latest: string,
    scope: MemoryScope,
    ledger: Ledger | undefined,
    former: readonly string[],
  ): Promise<{ revision: string; repointed: number; notice?: string }> {
    for (let attempt = 1; ; attempt++) {
      // moving to `latest`, not to `main`, lets an unmoved begin return it without asking git
      if (head !== latest)
        await this.git(['merge', '--ff-only', '--quiet', latest]);

      await this.prepare(scope);

      const moved = await this.adoptAll(scope, former).catch(
        async (error: unknown) => {
          await this.discardPending().catch((rollback: unknown) => {
            throw new Error(
              `${errorMessage(error)}\n\nCould not discard the failed memory move: ${errorMessage(rollback)}`,
              { cause: error },
            );
          });

          throw error;
        },
      );

      const first = await this.tryRepoint(ledger);

      if (!moved && !first.repointed) return { revision: latest, ...first };

      if ((await this.publish()) === 'published') {
        // a rebase onto another conversation's notes can merge old links back into MEMORY.md
        let { repointed, notice } = first;

        for (let again = 0; again < 5; again++) {
          const more = await this.tryRepoint(ledger);

          notice ??= more.notice;

          if (!more.repointed) break;

          if ((await this.publish()) !== 'published') {
            // the next begin repoints what lost to another conversation here
            await this.git(['reset', '--hard', '--quiet', await this.latest()]);

            break;
          }

          repointed += more.repointed;
        }

        return { revision: await this.revision(), repointed, notice };
      }

      // discarding this derived move loses no accepted notes
      head = latest = await this.latest();

      await this.git(['reset', '--hard', '--quiet', latest]);

      if (attempt === 5)
        throw new Error(
          'Moving project notes kept losing to other conversations',
        );
    }
  }

  /** repoints and commits, or rolls back what it changed and says why. */
  private async tryRepoint(
    ledger: Ledger | undefined,
  ): Promise<{ repointed: number; notice?: string }> {
    if (!ledger?.moves.length) return { repointed: 0 };

    try {
      return { repointed: await this.repoint(ledger) };
    } catch (error) {
      await this.discardPending().catch((rollback: unknown) => {
        throw new Error(
          `${errorMessage(error)}\n\nCould not discard the failed memory repoint: ${errorMessage(rollback)}`,
          { cause: error },
        );
      });

      return {
        repointed: 0,
        notice: `Could not repoint memory notes at moved directories: ${errorMessage(error)}`,
      };
    }
  }

  /** rewrites references to moved directories in every scope as a commit of its own, and says how many notes changed. */
  private async repoint(ledger: Ledger): Promise<number> {
    const { map } = await mapper(ledger);

    const home = homedir();

    const forms = new Set<string>();

    for (const { from } of ledger.moves) {
      forms.add(from);

      if (within(from, home) && from !== home)
        forms.add(`~${from.slice(home.length)}`);
    }

    const found = await this.memory.run(
      this.root,
      ['grep', '-l', '-z', '-F', ...[...forms].flatMap((form) => ['-e', form])],
      { codes: [0, 1] },
    );

    let changed = 0;

    for (const file of found.stdout
      .toString('utf8')
      .split('\0')
      .filter(Boolean)) {
      const path = await this.checkedPath(file);

      const text = await readFile(path, 'utf8');

      const next = repointText(text, [...forms], map, home);

      if (next === text) continue;

      await writeFile(path, next);

      changed++;
    }

    if (changed)
      await this.commit(
        `chore(memory): repoint moved directories\n\n${ledger.moves.map(({ from, to }) => `${from} -> ${to}`).join('\n')}\nconversation: ${this.id}`,
      );

    return changed;
  }

  /** begins outside a turn to take in the notes keyed by the checkout's path or by a path-keyed project's `former` keys and repoint moved paths, unless pending or unpublished memory waits for settling. */
  async adoptCheckout(
    scope: MemoryScope,
    ledger?: Ledger,
    former: readonly string[] = [],
  ): Promise<{ repointed: number; notice?: string }> {
    if (!(await this.exists())) return { repointed: 0 };

    const { dirty, head, ahead, behind } = await this.status();

    if (dirty) return { repointed: 0 };

    const latest = ahead === 0 && behind === 0 ? head : await this.latest();

    if (head !== latest && !(await this.isAncestor(head, latest)))
      return { repointed: 0 };

    const { repointed, notice } = await this.beginFrom(
      head,
      latest,
      scope,
      ledger,
      former,
    );

    return { repointed, notice };
  }

  /** adopts the checkout's notes and each former key's, and says whether any of them held notes. */
  private async adoptAll(
    { project, checkout }: MemoryScope,
    former: readonly string[],
  ): Promise<boolean> {
    let moved = false;

    for (const key of checkout ? [checkout, ...former] : former)
      if (await this.adopt(project, key)) moved = true;

    return moved;
  }

  /** merges the notes under another project key into `project` as a commit of its own, and says whether that key held notes. */
  private async adopt(project: string, key: string): Promise<boolean> {
    // begin runs only on a clean worktree, so the index matches HEAD and a key missing on disk tracks nothing
    const missing = await lstat(join(this.root, key)).then(
      () => false,
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    );

    if (missing) return false;

    const files = (await this.git(['ls-files', '-z', '--', key]))
      .split('\0')
      .filter(Boolean);

    if (!files.length) return false;

    const notes = new Set(files.map((file) => posix.relative(key, file)));

    const directories = new Set<string>();

    for (const note of notes)
      for (let dir = posix.dirname(note); dir !== '.'; dir = posix.dirname(dir))
        directories.add(dir);

    const label = posix.basename(key).replace(/-[0-9a-f]{16}$/, '');

    const index = posix.join(key, indexNote);

    const renamed = new Map<string, string>();

    // the index merges last, so its lines can link where renamed notes went
    for (const file of files.sort((a, b) => +(a === index) - +(b === index))) {
      const source = await this.checkedPath(file);

      const content = await readFile(source);

      const note = posix.relative(key, file);

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
          (await present(target))
            ? mergeLines((await readFile(target)).toString(), text)
            : text,
        );

        await rm(source);

        continue;
      }

      const placed = await this.place(project, label, note, content);

      if (placed === undefined) continue;

      const target = await this.checkedPath(posix.join(project, placed));

      if (await present(target)) await rm(source);
      else {
        await mkdir(dirname(target), { recursive: true });

        await rename(source, target);
      }

      if (placed !== note) renamed.set(note, placed);
    }

    await this.commit(
      `chore(memory): move ${key} notes to ${project}\n\nconversation: ${this.id}`,
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
            !(await present(target)) ||
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

  async commit(message: string, accept = () => true): Promise<void> {
    if (!(await this.isDirty())) return;

    const files = await this.git(['ls-files', '--cached', '--others', '-z']);

    for (const file of new Set(files.split('\0').filter(Boolean)))
      await this.checkedPath(file);

    if (!accept()) return;

    const previous = await this.revision();

    await this.git(['add', '--all', '--force', '--', '.']);

    if (!accept()) return;

    await this.git(['commit', '--quiet', '-m', message]);

    // a rejection during git's commit leaves the notes pending for recovery.
    if (!accept()) await this.git(['reset', '--soft', previous]);
  }

  /** the pending changes, with new files shown whole. */
  async diff(): Promise<string> {
    const tracked = await this.patch('HEAD');

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

    const { paths, relocated } = await this.mergeTree(
      `--merge-base=${blocked}^`,
      replayed,
      blocked,
    );

    return {
      paths: [...new Set(paths.map((path) => relocated.get(path) ?? path))],
      diff: await this.patch(`${blocked}^`, blocked),
    };
  }

  /** a unified diff; a user's diff.external would otherwise replace it. */
  private patch(...revisions: string[]): Promise<string> {
    return this.git([
      'diff',
      '--no-ext-diff',
      '--no-prefix',
      ...revisions,
      '--',
    ]);
  }

  /** `git merge-tree` exits 1 for a conflicted merge it still reports. */
  private async mergeTree(...args: string[]) {
    const merged = await this.memory.run(
      this.root,
      [
        'merge-tree',
        '--write-tree',
        '--messages',
        '-z',
        '--name-only',
        ...args,
      ],
      { codes: [0, 1] },
    );

    return mergeResult(merged.stdout);
  }

  /** `clean -ffdx` also removes repositories an agent created inside memory. */
  async discardPending(): Promise<void> {
    await this.git(['reset', '--hard', '--quiet']);

    await this.git(['clean', '-ffdx', '--quiet']);
  }

  /** my side wins each conflicting change; every other change from both sides merges. */
  async keepMine(): Promise<void> {
    const latest = await this.latest();

    const { tree, paths, relocated } = await this.mergeTree(
      '-X',
      'ours',
      'HEAD',
      latest,
    );

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
