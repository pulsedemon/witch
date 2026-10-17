import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Memory, main } from '../src/memory/memory.js';
import type { Workspace } from '../src/memory/workspace.js';
import { hookedGit, passThrough } from './fixtures/git.js';
import type { GitHook } from './fixtures/git.js';

// a developer's `url.<base>.insteadOf` would rewrite the origins these tests key
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const execute = promisify(execFile);
const lines = (changes: Record<number, string> = {}) =>
  [1, 2, 3, 4, 5].map((line) => changes[line] ?? `line ${line}`).join('\n') +
  '\n';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'witch-memory-'));
  const project = join(root, 'project');
  await mkdir(project);
  const hook = { current: passThrough };
  const memory = new Memory(join(root, 'memory.git'), hookedGit(hook));
  await memory.initialize();
  const open = async (id: string) => {
    const directory = join(root, 'conversations', id);
    await mkdir(directory, { recursive: true });
    const workspace = memory.workspace(directory, id);
    await workspace.ensureWorktree();
    const scope = await workspace.scope(project);
    return {
      workspace,
      scope: {
        global: join(workspace.root, scope.global),
        project: join(workspace.root, scope.project),
      },
    };
  };
  return { memory, root, project, hook, open };
}

async function save(
  workspace: Workspace,
  files: Record<string, string | null>,
  message = 'save',
) {
  for (const [path, text] of Object.entries(files)) {
    const file = join(workspace.root, path);
    if (text === null) await rm(file);
    else {
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, text);
    }
  }
  await workspace.commit(message);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute('git', args, { cwd })).stdout;
}

async function repository(
  root: string,
  name: string,
  origin?: string,
): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await git(path, 'init', '--quiet');
  if (origin) await git(path, 'remote', 'add', 'origin', origin);
  return path;
}

await test('parallel initialization seeds one repository and leaves a stray build alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'witch-memory-init-'));
  const stray = join(root, `memory.git.${randomUUID()}`);
  await git(root, 'init', '--bare', '--quiet', stray);
  const before = await readdir(stray, { recursive: true });
  const held = Promise.withResolvers<void>();
  const inited = Promise.withResolvers<void>();
  let calls = 0;
  const hook = {
    current: (async (command, run) => {
      const result = await run();
      if (command[0] === 'init' && calls++ === 0) {
        inited.resolve();
        await held.promise;
      }
      return result;
    }) as GitHook,
  };
  const memory = new Memory(join(root, 'memory.git'), hookedGit(hook));
  const seeded = async () => {
    await git(memory.root, 'rev-parse', '--verify', 'main');
    assert.equal(
      (await git(memory.root, 'rev-list', '--count', 'main')).trim(),
      '1',
    );
  };
  const first = memory.initialize();
  await inited.promise;
  await memory.initialize();
  await seeded();
  held.resolve();
  await first;
  await seeded();
  assert.deepEqual(
    (await readdir(root)).sort(),
    ['memory.git', stray.slice(root.length + 1)].sort(),
  );
  assert.deepEqual(await readdir(stray, { recursive: true }), before);
});

await test('memory works under user Git configuration with no identity, an empty template, the apply rebase backend, hidden untracked files, log.follow and an external diff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'witch-memory-identity-'));
  const template = join(root, 'template');
  await mkdir(template);
  const module = new URL('../src/memory/memory.ts', import.meta.url).href;
  const { stdout } = await execute(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      `import { Memory } from ${JSON.stringify(module)};
       import { mkdir, rename, writeFile } from 'node:fs/promises';
       import { join } from 'node:path';
       const root = ${JSON.stringify(root)};
       const memory = new Memory(join(root, 'memory.git'));
       await memory.initialize();
       const open = async (id) => {
         await mkdir(join(root, id));
         const workspace = memory.workspace(join(root, id), id);
         await workspace.ensureWorktree();
         return workspace;
       };
       const mine = await open('mine');
       const theirs = await open('theirs');
       const note = (workspace, path, text) => writeFile(join(workspace.root, path), text);
       await note(theirs, 'global/theirs.md', 'Theirs.');
       await theirs.commit('theirs');
       await theirs.publish();
       await note(mine, 'global/mine.md', 'Mine.');
       await mine.commit('mine');
       await mine.publish();
       await note(theirs, 'global/preference.md', 'Their preference.');
       await theirs.commit('their preference');
       await theirs.publish();
       await note(mine, 'global/preference.md', 'New preference.');
       await mine.commit('my preference');
       if ((await mine.publish()) !== 'conflict') throw new Error('expected a conflict');
       await mine.conflict();
       await mine.keepMine();
       await mine.publish();
       console.log(await memory.read('refs/heads/main', 'global/preference.md'));
       await rename(join(mine.root, 'global/mine.md'), join(mine.root, 'global/renamed.md'));
       await mine.commit('rename mine');
       await note(mine, 'global/renamed.md', 'Renamed.');
       await mine.diff();
       await mine.commit('edit renamed');
       await mine.publish();
       const history = await memory.history('refs/heads/main', 'global/renamed.md');
       console.log(history.map(({ subject }) => subject).join(', '));`,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_COUNT: '5',
        GIT_CONFIG_KEY_0: 'user.useConfigOnly',
        GIT_CONFIG_VALUE_0: 'true',
        GIT_CONFIG_KEY_1: 'rebase.backend',
        GIT_CONFIG_VALUE_1: 'apply',
        GIT_CONFIG_KEY_2: 'status.showUntrackedFiles',
        GIT_CONFIG_VALUE_2: 'no',
        GIT_CONFIG_KEY_3: 'log.follow',
        GIT_CONFIG_VALUE_3: 'true',
        GIT_CONFIG_KEY_4: 'diff.external',
        GIT_CONFIG_VALUE_4: '/usr/bin/false',
        GIT_TEMPLATE_DIR: template,
        GIT_AUTHOR_NAME: undefined,
        GIT_AUTHOR_EMAIL: undefined,
        GIT_COMMITTER_NAME: undefined,
        GIT_COMMITTER_EMAIL: undefined,
      },
    },
  );
  assert.deepEqual(stdout.trim().split('\n'), [
    'New preference.',
    'edit renamed, rename mine',
  ]);
  const log = await git(
    join(root, 'memory.git'),
    'log',
    '--format=%an <%ae> | %cn <%ce>',
    main,
  );
  const identities = log.trim().split('\n');
  assert.equal(identities.length, 7);
  for (const identity of identities)
    assert.equal(identity, 'Witch <witch@localhost> | Witch <witch@localhost>');
});

await test('pending notes show in the recovery diff, block the next turn and stay out of accepted snapshots', async () => {
  const { memory, open, project } = await fixture();
  const { workspace, scope } = await open('a');
  await writeFile(join(scope.project, 'MEMORY.md'), 'Accepted project fact.');
  await workspace.commit('seed');
  await writeFile(join(scope.project, 'MEMORY.md'), 'Unfinished project fact.');
  await writeFile(join(scope.project, 'pending.md'), 'Unfinished new note.');
  assert.equal(await workspace.isDirty(), true);
  const diff = await workspace.diff();
  assert.match(diff, /^--- projects\/[^/\n]+\/MEMORY\.md$/m);
  assert.match(diff, /^\+Unfinished project fact\.$/m);
  assert.match(diff, /pending\.md\nUnfinished new note\./);
  await assert.rejects(workspace.begin(project), /Resolve pending memory/);
  const snapshot = await memory.snapshot(
    await workspace.revision(),
    workspace.root,
    await memory.scopePaths(project),
  );
  assert.match(snapshot, /Accepted project fact/);
  assert.doesNotMatch(snapshot, /Unfinished/);
  await workspace.discardPending();
  assert.equal(await workspace.isDirty(), false);
  assert.equal(
    await readFile(join(scope.project, 'MEMORY.md'), 'utf8'),
    'Accepted project fact.',
  );
  await assert.rejects(readFile(join(scope.project, 'pending.md')));
});

await test('a .gitignore inside memory hides no note from the recovery diff, discard, publishing or the symlink check', async () => {
  const { memory, open } = await fixture();
  const { workspace, scope } = await open('a');
  const ignore = join(workspace.root, '.gitignore');
  const hidden = join(scope.global, 'hidden.md');
  await writeFile(ignore, '*\n');
  await writeFile(hidden, 'Hidden fact.');
  assert.equal(await workspace.isDirty(), true);
  assert.match(await workspace.diff(), /hidden\.md\nHidden fact\./);
  await workspace.discardPending();
  assert.equal(await workspace.isDirty(), false);
  await assert.rejects(readFile(hidden));
  await writeFile(ignore, '*\n');
  await writeFile(hidden, 'Hidden fact.');
  await workspace.commit('save');
  await workspace.publish();
  assert.equal(await memory.read(main, 'global/hidden.md'), 'Hidden fact.');
  await symlink(tmpdir(), join(scope.global, 'linked.md'));
  await assert.rejects(workspace.commit('link'), /regular file/);
});

await test('global memory crosses projects while project notes remain scoped', async () => {
  const { memory, open, root } = await fixture();
  const { workspace, scope } = await open('a');
  await writeFile(join(scope.global, 'MEMORY.md'), 'Use concise replies.');
  await writeFile(
    join(scope.project, 'MEMORY.md'),
    'Project A uses port 4567.',
  );
  await workspace.commit('preferences');
  await workspace.publish();
  const other = join(root, 'other');
  await mkdir(other);
  const snapshot = await memory.snapshot(
    await memory.resolve(main),
    workspace.root,
    await memory.scopePaths(other),
  );
  assert.match(snapshot, /Use concise replies/);
  assert.doesNotMatch(snapshot, /4567/);
});

await test('a subdirectory of a repository shares its project memory, and its notes move once the repository has an origin', async () => {
  const { memory, open, project } = await fixture();
  await git(project, 'init', '--quiet');
  const src = join(project, 'src');
  await mkdir(src);
  // notes saved before origins keyed projects live under this key
  const top = await realpath(project);
  assert.deepEqual(await memory.scopePaths(src), {
    global: 'global',
    project: `projects/project-${createHash('sha256').update(top).digest('hex').slice(0, 16)}`,
  });
  const { workspace } = await open('a');
  const begun = await workspace.begin(src);
  await save(workspace, { [`${begun.scope.project}/x.md`]: 'X.\n' });
  await workspace.publish();
  await git(project, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  const moved = await workspace.begin(src);
  assert.equal(await memory.read(main, `${moved.scope.project}/x.md`), 'X.\n');
});

await test('clones of one origin share project memory under its name across directories, URL and scp forms, users and host case', async () => {
  const { memory, root } = await fixture();
  const clone = async (directory: string, origin: string) =>
    (await memory.scopePaths(await repository(root, directory, origin)))
      .project;
  const ssh = await clone('work', 'git@github.com:owner/repo.git');
  assert.match(ssh, /^projects\/repo-[0-9a-f]{16}$/);
  assert.equal(await clone('copy', 'HTTPS://github.com/owner/repo/'), ssh);
  assert.equal(
    await clone('mixed', 'ssh://git@GitHub.com:22/owner/repo.git'),
    ssh,
  );
  assert.notEqual(
    await clone('fork', 'https://github.com/other/repo.git'),
    ssh,
  );
  assert.notEqual(
    await clone('host', 'https://gitlab.com/owner/repo.git'),
    ssh,
  );
  const ipv6 = await clone('ipv6', 'git@[2001:db8::1]:owner/repo.git');
  assert.equal(
    await clone('ipv6-https', 'https://[2001:db8::1]/owner/repo.git'),
    ipv6,
  );
  assert.equal(
    await clone('ipv6-port', 'ssh://git@[2001:db8::1]:22/owner/repo.git'),
    ipv6,
  );
  assert.equal(
    await clone('absolute', 'git@example.org:/srv/repos/app.git'),
    await clone('absolute-url', 'ssh://git@example.org/srv/repos/app.git'),
  );
  assert.notEqual(
    await clone('suffix-case', 'git@github.com:owner/repo.GIT'),
    ssh,
  );
  assert.notEqual(
    await clone('path-case', 'git@github.com:Owner/repo.git'),
    ssh,
  );
  assert.equal(
    await clone('numeric', 'git@github.com:7/repo.git'),
    await clone('numeric-url', 'https://github.com/7/repo.git'),
  );
  assert.notEqual(
    await clone('at-path', 'host:a@b/c'),
    await clone('at-host', 'b:c'),
  );
});

await test('a local origin names the repository git reaches through it: from the top level, through links, by file URL, by its .git forms, and before it exists', async () => {
  const { memory, root } = await fixture();
  const clone = async (directory: string, origin: string) => {
    const path = await repository(root, directory, origin);
    await mkdir(join(path, 'src'));
    return path;
  };
  const key = async (path: string) => (await memory.scopePaths(path)).project;
  for (const repository of ['a/upstream.git', 'a/upstream', 'b/upstream.git'])
    await git(root, 'init', '--quiet', '--bare', repository);
  await symlink(join(root, 'a'), join(root, 'alias'));
  await mkdir(join(root, 'b/child'));
  await symlink(join(root, 'b/child'), join(root, 'a/link'));
  const a = await clone('a/clone', '../upstream.git');
  const upstream = await key(a);
  assert.equal(await key(join(a, 'src')), upstream);
  assert.notEqual(
    await key(await clone('b/clone', '../upstream.git')),
    upstream,
  );
  assert.equal(
    await key(await clone('c', join(root, 'alias/upstream.git'))),
    upstream,
  );
  const absolute = join(root, 'a/upstream.git');
  assert.equal(await key(await clone('d', `file://${absolute}`)), upstream);
  assert.equal(await key(await clone('e', `file://host${absolute}`)), upstream);
  assert.equal(
    await key(await clone('j', `file://${join(root, 'a/up%73tream.git')}`)),
    upstream,
  );
  assert.match(
    await key(await clone('k', `file://${join(root, 'a%00b')}`)),
    /^projects\/a%00b-/,
  );
  assert.match(
    await key(await clone('l', `file://${join(root, 'caf%E9')}`)),
    /^projects\/caf%E9-/,
  );
  assert.notEqual(
    await key(await clone('f', `file://${join(root, 'a/upstream')}`)),
    upstream,
  );
  const bare = await key(await clone('h', join(root, 'b/upstream.git')));
  assert.equal(
    await key(await clone('g', `${root}/a/link/../upstream.git`)),
    bare,
  );
  assert.equal(await key(await clone('m', join(root, 'b/upstream'))), bare);
  await git(root, 'init', '--quiet', '--bare', 'b/child.git');
  assert.equal(
    await key(await clone('n', join(root, 'b/child'))),
    await key(await clone('o', join(root, 'b/child.git'))),
  );
  await git(root, 'init', '--quiet', 'worktree');
  assert.equal(
    await key(await clone('p', join(root, 'worktree/.git'))),
    await key(join(root, 'worktree')),
  );
  const later = await clone('i', join(root, 'alias/later.git'));
  const missing = await key(later);
  await git(root, 'init', '--quiet', '--bare', 'a/later.git');
  assert.equal(await key(later), missing);
});

await test("a turn merges the notes keyed by a checkout's path into its origin's project, keeping both versions of a note", async () => {
  const { memory, open, root, project } = await fixture();
  const begin = async (
    workspace: Workspace,
    cwd: string,
    notes: Record<string, string> = {},
  ) => {
    const begun = await workspace.begin(cwd);
    await save(
      workspace,
      Object.fromEntries(
        Object.entries(notes).map(([note, text]) => [
          `${begun.scope.project}/${note}`,
          text,
        ]),
      ),
    );
    await workspace.publish();
    return begun;
  };
  const first = (await open('a')).workspace;
  await git(project, 'init', '--quiet');
  // its copy's name passes the 255 UTF-16 units an APFS name holds
  const long = `${'n'.repeat(251)}.md`;
  const path = (
    await begin(first, project, {
      'MEMORY.md': '# Project\n- [deploy](deploy.md)\n- shared  \n',
      [long]: 'Long A.\n',
      'deploy.md': 'Deploy with A.\n',
      'notes/a.md': 'A note.\n',
      'same.md': 'Same.\n',
      'dot.md': 'A.\n',
      'angled.md': 'A.\n',
      'p(1).md': 'A.\n',
    })
  ).scope.project;
  const copy = await repository(root, 'copy');
  const second = (await open('b')).workspace;
  await begin(second, copy, {
    'MEMORY.md':
      '# Project\n- shared  \n- [deploy](deploy.md)\n- [two](two.md)\n- [two](two.md)\n- [dot](./dot.md)\n- [angled](<angled.md>)\n- [p](p(1).md)\n',
    [long]: 'Long B.\n',
    'deploy.md': 'Deploy with B.\n',
    notes: 'A file named notes.\n',
    'same.md': 'Same.\n',
    'two.md': 'Two.\n',
    'dot.md': 'B.\n',
    'angled.md': 'B.\n',
    'p(1).md': 'B.\n',
  });
  const origin = 'https://github.com/owner/repo.git';
  await git(project, 'remote', 'add', 'origin', origin);
  await git(copy, 'remote', 'add', 'origin', origin);
  assert.equal((await begin(first, project)).scope.checkout, path);
  const merged = await begin(second, copy);
  assert.equal(merged.revision, await memory.resolve(main));
  const target = merged.scope.project;
  assert.equal(
    (
      await memory.git(memory.root, [
        'ls-tree',
        '-r',
        '--name-only',
        merged.revision,
        '--',
        'projects',
      ])
    ).trim(),
    [
      `(copy)/${long}`,
      '(copy)/notes',
      'MEMORY.md',
      'angled (copy).md',
      'angled.md',
      'deploy (copy).md',
      'deploy.md',
      'dot (copy).md',
      'dot.md',
      long,
      'notes/a.md',
      'p(1) (copy).md',
      'p(1).md',
      'same.md',
      'two.md',
    ]
      .map((note) => `${target}/${note}`)
      .join('\n'),
  );
  assert.equal(
    await memory.read(merged.revision, `${target}/MEMORY.md`),
    '# Project\n- [deploy](deploy.md)\n- shared  \n- [deploy](<deploy (copy).md>)\n- [two](two.md)\n- [dot](<dot (copy).md>)\n- [angled](<angled (copy).md>)\n- [p](<p(1) (copy).md>)\n',
  );
  assert.equal(
    await memory.read(merged.revision, `${target}/deploy.md`),
    'Deploy with A.\n',
  );
  assert.equal(
    await memory.read(merged.revision, `${target}/deploy (copy).md`),
    'Deploy with B.\n',
  );
  assert.equal(
    await memory.read(merged.revision, `${target}/(copy)/notes`),
    'A file named notes.\n',
  );
  assert.equal(
    await memory.read(merged.revision, `${target}/(copy)/${long}`),
    'Long B.\n',
  );
});

await test("a move that loses to another clone's move is made again on the newer main", async () => {
  const { memory, open, root, project, hook } = await fixture();
  const begin = async (workspace: Workspace, cwd: string, note?: string) => {
    const begun = await workspace.begin(cwd);
    if (note) await save(workspace, { [`${begun.scope.project}/x.md`]: note });
    await workspace.publish();
    return begun;
  };
  const first = (await open('a')).workspace;
  await git(project, 'init', '--quiet');
  await begin(first, project, 'A version.\n');
  const copy = await repository(root, 'copy');
  const second = (await open('b')).workspace;
  await begin(second, copy, 'B version.\n');
  for (const checkout of [project, copy])
    await git(
      checkout,
      'remote',
      'add',
      'origin',
      'https://github.com/o/r.git',
    );
  // the other clone's move lands after this one read main and before it publishes
  let raced = false;
  hook.current = async (command, run, options) => {
    if (
      !raced &&
      options.cwd === second.root &&
      command[0] === 'ls-files' &&
      command[1] === '-z'
    ) {
      raced = true;
      await first.begin(project);
    }
    return run();
  };
  const merged = await second.begin(copy);
  assert.ok(raced);
  assert.equal(merged.revision, await memory.resolve(main));
  const target = merged.scope.project;
  assert.equal(await memory.read(main, `${target}/x.md`), 'A version.\n');
  assert.equal(
    await memory.read(main, `${target}/x (copy).md`),
    'B version.\n',
  );
});

await test('a move that keeps losing to other clones gives up on main, so it never waits to publish', async () => {
  const { memory, open, root } = await fixture();
  const { workspace } = await open('a');
  const copy = await repository(root, 'copy');
  const key = (await workspace.begin(copy)).scope.project;
  await save(workspace, { [`${key}/x.md`]: 'X.\n' });
  await workspace.publish();
  await git(copy, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  const publish = workspace.publish.bind(workspace);
  let publishes = 0;
  // the leftover publish goes through, and every move after it loses
  workspace.publish = async () => (publishes++ ? 'conflict' : publish());
  await assert.rejects(workspace.begin(copy), /kept losing/);
  assert.equal(
    (await git(workspace.root, 'rev-parse', 'HEAD')).trim(),
    await memory.resolve(main),
  );
});

await test("a note with no free path in the project stays under the checkout's key", async () => {
  const { memory, open, root } = await fixture();
  const { workspace } = await open('a');
  const origin = 'https://github.com/o/r.git';
  const upstream = await repository(root, 'upstream', origin);
  const target = (await workspace.begin(upstream)).scope.project;
  await save(workspace, {
    [`${target}/x.md/note.md`]: 'A directory.\n',
    [`${target}/(app)`]: 'A file.\n',
  });
  await workspace.publish();
  const app = await repository(root, 'app');
  const key = (await workspace.begin(app)).scope.project;
  await save(workspace, { [`${key}/x.md`]: 'Stays.\n' });
  await workspace.publish();
  await git(app, 'remote', 'add', 'origin', origin);
  await workspace.begin(app);
  assert.equal(await memory.read(main, `${key}/x.md`), 'Stays.\n');
});

await test('a move that fails on an OS error fails the turn and leaves every note where it was', async () => {
  const { memory, open, root, hook } = await fixture();
  const first = (await open('a')).workspace;
  const target = (
    await first.begin(
      await repository(root, 'upstream', 'https://github.com/o/r.git'),
    )
  ).scope.project;
  await save(first, { [`${target}/d/y.md`]: 'Y.\n' });
  await first.publish();
  const copy = await repository(root, 'copy');
  const second = (await open('b')).workspace;
  const key = (await second.begin(copy)).scope.project;
  await save(second, { [`${key}/a.md`]: 'A.\n', [`${key}/d/x.md`]: 'X.\n' });
  await second.publish();
  await git(copy, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  const locked = join(second.root, target, 'd');
  // d is unreadable only while the move places notes, between its git commands
  hook.current = async (command, run, options) => {
    if (options.cwd === second.root)
      await chmod(
        locked,
        command[0] === 'ls-files' && command[1] === '-z' ? 0o000 : 0o755,
      );
    return run();
  };
  try {
    await assert.rejects(second.begin(copy), /EACCES/);
  } finally {
    await chmod(locked, 0o755);
  }
  assert.equal(await second.isDirty(), false);
  assert.equal(await memory.read(main, `${key}/a.md`), 'A.\n');
  assert.equal(await memory.read(main, `${key}/d/x.md`), 'X.\n');
});

await test(
  "a third version of a note from another checkout of the same name takes the next copy number, in the index's line endings",
  { timeout: 20_000 },
  async () => {
    const { memory, open, root } = await fixture();
    const { workspace } = await open('a');
    const begin = async (cwd: string, notes: Record<string, string> = {}) => {
      const { scope } = await workspace.begin(cwd);
      await save(
        workspace,
        Object.fromEntries(
          Object.entries(notes).map(([note, text]) => [
            `${scope.project}/${note}`,
            text,
          ]),
        ),
      );
      await workspace.publish();
      return scope.project;
    };
    const origin = 'https://github.com/o/r.git';
    const upstream = await repository(root, 'upstream', origin);
    const target = await begin(upstream, {
      'MEMORY.md': '# Project\r\n- [x](x.md)\r\n',
      'x.md': 'A.\n',
    });
    const checkouts = [
      await repository(root, 'first/app'),
      await repository(root, 'second/app'),
    ];
    for (const [index, checkout] of checkouts.entries())
      await begin(checkout, {
        'MEMORY.md': '# Project\n- [x](x.md)\n',
        'x.md': `${'BC'[index]}.\n`,
      });
    for (const checkout of checkouts) {
      await git(checkout, 'remote', 'add', 'origin', origin);
      await begin(checkout);
    }
    assert.equal(await memory.read(main, `${target}/x.md`), 'A.\n');
    assert.equal(await memory.read(main, `${target}/x (app).md`), 'B.\n');
    assert.equal(await memory.read(main, `${target}/x (app 2).md`), 'C.\n');
    assert.equal(
      await memory.read(main, `${target}/MEMORY.md`),
      '# Project\r\n- [x](x.md)\r\n- [x](<x (app).md>)\r\n- [x](<x (app 2).md>)\r\n',
    );
  },
);

await test('a project name too long for an APFS name is cut by UTF-16 units to fit beside its hash', async () => {
  const { open, root } = await fixture();
  const name = async (directory: string, slug: string) => {
    const path = await repository(
      root,
      directory,
      `https://example.org/o/${slug}`,
    );
    const { scope } = await (await open(directory)).workspace.begin(path);
    return basename(scope.project);
  };
  assert.match(await name('fits', '字'.repeat(80)), /^字{80}-[0-9a-f]{16}$/);
  assert.match(
    await name('long', `x${'é'.repeat(250)}`),
    /^xé{237}-[0-9a-f]{16}$/,
  );
  assert.match(
    await name('emoji', `x${'😀'.repeat(200)}`),
    /^x😀{118}-[0-9a-f]{16}$/u,
  );
});

await test(
  'a clone of a checkout shares the project its origin names, and an origin that is no repository of its own keys as its path',
  { timeout: 10_000 },
  async () => {
    const { memory, root } = await fixture();
    const scope = (path: string) => memory.scopePaths(path);
    const checkout = await repository(root, 'checkout');
    await mkdir(join(checkout, 'sub'));
    await git(
      checkout,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@localhost',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'c',
    );
    await git(
      checkout,
      'remote',
      'add',
      'origin',
      'https://github.com/o/r.git',
    );
    await git(root, 'clone', '--quiet', checkout, 'clone');
    const upstream = await scope(checkout);
    const cloned = await scope(join(root, 'clone'));
    assert.equal(cloned.project, upstream.project);
    assert.notEqual(cloned.project, upstream.checkout);
    await git(
      checkout,
      'bundle',
      'create',
      '--quiet',
      join(root, 'c.bundle'),
      '--all',
    );
    await git(root, 'clone', '--quiet', join(root, 'c.bundle'), 'unbundled');
    assert.match(
      (await scope(join(root, 'unbundled'))).project,
      /^projects\/c\.bundle-/,
    );
    // git turns away a file over 1 MiB, such as a large bundle, as too large rather than invalid
    await writeFile(join(root, 'big.bundle'), Buffer.alloc(2 ** 20 + 1));
    const large = await repository(root, 'large', join(root, 'big.bundle'));
    assert.match((await scope(large)).project, /^projects\/big\.bundle-/);
    const inside = await repository(root, 'inside', join(checkout, 'sub'));
    assert.match((await scope(inside)).project, /^projects\/sub-/);
    await git(checkout, 'remote', 'set-url', 'origin', join(root, 'clone'));
    assert.match(
      (await scope(checkout)).project,
      /^projects\/(checkout|clone)-/,
    );
  },
);

await test('a git or OS that fails reading a checkout or its origin fails the project key instead of falling back to the path, and no repository falls back in any language', async () => {
  const { memory, hook, project, root } = await fixture();
  await git(project, 'init', '--quiet');
  hook.current = async (command, run) =>
    command[0] === 'remote'
      ? { stdout: '', stderr: 'fatal: unreadable config', code: 1 }
      : run();
  await assert.rejects(memory.scopePaths(project), /unreadable config/);
  hook.current = async (command, run) => {
    if (command[0] === 'remote') throw new Error('spawn git EAGAIN');
    return run();
  };
  await assert.rejects(memory.scopePaths(project), /EAGAIN/);
  hook.current = passThrough;
  await writeFile(join(project, '.git', 'config'), '[remote "origin"\n', {
    flag: 'a',
  });
  await assert.rejects(memory.scopePaths(project), /bad config/);
  const dangling = join(root, 'dangling');
  await mkdir(dangling);
  await writeFile(join(dangling, '.git'), 'gitdir: /does/not/exist\n');
  await assert.rejects(
    memory.scopePaths(dangling),
    /not a git repository: \/does\/not\/exist/,
  );
  const locked = join(root, 'locked');
  await mkdir(join(locked, 'upstream'), { recursive: true });
  const reader = await repository(root, 'reader', join(locked, 'upstream'));
  await chmod(locked, 0o000);
  try {
    await assert.rejects(memory.scopePaths(reader), /EACCES/);
  } finally {
    await chmod(locked, 0o755);
  }
  const plain = join(root, 'plain');
  await mkdir(plain);
  const locale = process.env.LC_ALL;
  process.env.LC_ALL = 'de_DE.UTF-8';
  try {
    assert.match((await memory.scopePaths(plain)).project, /^projects\/plain-/);
  } finally {
    if (locale === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = locale;
  }
});

await test('restore recreates a deleted directory, produces a new accepted revision, and deletion remains visible', async () => {
  const { memory, open, project } = await fixture();
  const { workspace, scope } = await open('a');
  const paths = await memory.scopePaths(project);
  const path = join(scope.project, 'MEMORY.md');
  const note = `${paths.project}/MEMORY.md`;
  await writeFile(path, 'Use value A.');
  await workspace.commit('first preference');
  const first = await workspace.revision();
  await writeFile(path, 'Use value B.');
  await workspace.commit('second preference');
  const second = await workspace.revision();
  await rm(scope.project, { recursive: true });
  await workspace.restore(note, first);
  assert.equal(await readFile(path, 'utf8'), 'Use value A.');
  const restored = await workspace.revision();
  assert.notEqual(restored, first);
  assert.notEqual(restored, second);
  assert.match(
    await memory.snapshot(restored, workspace.root, paths),
    /Use value A/,
  );
  assert.equal((await memory.history(restored, note)).length, 3);
  await unlink(path);
  await workspace.commit('remove preference');
  const removed = await memory.snapshot(
    await workspace.revision(),
    workspace.root,
    paths,
    restored,
  );
  assert.doesNotMatch(removed, /Use value A/);
  assert.ok(removed.includes(`since the previous snapshot:\nD\t${note}`));
});

await test('a changed note with a non-ASCII name reaches the agent as written', async () => {
  const { memory, open, project } = await fixture();
  const { workspace } = await open('a');
  const before = await workspace.revision();
  await save(workspace, { 'global/café.md': 'Order the café au lait.' });
  const snapshot = await memory.snapshot(
    await workspace.revision(),
    workspace.root,
    await memory.scopePaths(project),
    before,
  );
  assert.ok(
    snapshot.includes('since the previous snapshot:\nA\tglobal/café.md'),
  );
  assert.ok(
    snapshot.split('\n').includes(join(workspace.root, 'global/café.md')),
  );
});

await test('preparing an existing note keeps its text', async () => {
  const { open } = await fixture();
  const { workspace, scope } = await open('a');
  const path = join(scope.project, 'MEMORY.md');
  await writeFile(path, 'Saved.');
  await workspace.prepareNote(path);
  assert.equal(await readFile(path, 'utf8'), 'Saved.');
});

await test('preparing a note outside the note directories is refused', async () => {
  const { open } = await fixture();
  const { workspace } = await open('a');
  for (const path of ['../outside.md', '.git'])
    await assert.rejects(
      workspace.prepareNote(path),
      /outside the note directories/,
      path,
    );
});

await test('a clean turn does not add an empty memory commit', async () => {
  const { open } = await fixture();
  const { workspace } = await open('a');
  const before = await workspace.revision();
  await workspace.commit('no changes');
  assert.equal(await workspace.revision(), before);
});

await test('commit, restore, note preparation and the note list refuse symlinked destinations and parent directories', async () => {
  for (const parent of [false, true]) {
    const { memory, open, project, root } = await fixture();
    const { workspace, scope } = await open('a');
    const path = join(scope.project, 'note.md');
    await writeFile(path, 'Saved preference.');
    await workspace.commit('save note');
    const revision = await workspace.revision();
    const outside = join(root, 'outside');
    await mkdir(outside);
    const target = join(outside, 'note.md');
    await writeFile(target, 'External content.');
    await rename(parent ? scope.project : path, join(root, 'original'));
    await symlink(parent ? outside : target, parent ? scope.project : path);
    await assert.rejects(workspace.commit('link'), /regular (file|directory)/);
    // Memory's git commits without the checks a workspace commit makes
    await memory.git(workspace.root, ['add', '--all']);
    await memory.git(workspace.root, ['commit', '-m', 'legacy symlink']);
    assert.equal(await workspace.isDirty(), false);
    await assert.rejects(
      memory.files(
        await workspace.revision(),
        await memory.scopePaths(project),
      ),
      /regular files/,
    );
    await assert.rejects(
      workspace.restore(path, revision),
      /regular (file|directory)/,
    );
    await assert.rejects(
      workspace.prepareNote(path),
      /regular (file|directory)/,
    );
    assert.equal(await readFile(target, 'utf8'), 'External content.');
    if (!parent) {
      const linkedRevision = await workspace.revision();
      await rename(path, join(root, 'saved-link'));
      await writeFile(path, 'Regular note again.');
      await workspace.commit('replace link with note');
      await assert.rejects(
        workspace.restore(path, linkedRevision),
        /regular files/,
      );
      assert.equal(await readFile(path, 'utf8'), 'Regular note again.');
    }
  }
});

await test('pending symlinks cannot be accepted or read through a recovery preview', async () => {
  const { open, root } = await fixture();
  const { workspace, scope } = await open('a');
  const before = await workspace.revision();
  const target = join(root, 'private.txt');
  await writeFile(target, 'External private content.');
  // the preview must not repeat a link carried in the name
  await symlink(
    target,
    join(scope.project, '\u001b]8;;..:1\u0007reference\u001b]8;;\u0007.md'),
  );
  await assert.rejects(workspace.commit('accept link'), /regular file/);
  assert.equal(await workspace.revision(), before);
  const diff = await workspace.diff();
  assert.match(diff, /New file: .*reference/);
  assert.match(diff, /regular file: .*reference/);
  assert.ok(!diff.includes('\u001b'));
  assert.doesNotMatch(diff, /External private content/);
  await workspace.discardPending();
  assert.equal(await workspace.isDirty(), false);
  assert.equal(await readFile(target, 'utf8'), 'External private content.');
});

await test('a scope refuses a symlinked note directory without changing its target', async () => {
  const { open, root, project } = await fixture();
  const { workspace } = await open('a');
  const outside = join(root, 'outside');
  await mkdir(outside);
  const note = join(outside, 'MEMORY.md');
  await writeFile(note, 'Existing external note.');
  await rm(join(workspace.root, 'global'), { recursive: true });
  await symlink(outside, join(workspace.root, 'global'));
  await assert.rejects(workspace.scope(project), /regular directory/);
  assert.equal(await readFile(note, 'utf8'), 'Existing external note.');
});

await test('two workspaces publish different notes, each with its own attribution', async () => {
  const { memory, open } = await fixture();
  const { workspace: first } = await open('first');
  const { workspace: second } = await open('second');
  await save(
    first,
    { 'global/first.md': 'First.' },
    'save\n\nconversation: first',
  );
  await save(
    second,
    { 'global/second.md': 'Second.' },
    'save\n\nconversation: second',
  );
  assert.equal(await first.publish(), 'published');
  assert.equal(await second.publish(), 'published');
  assert.equal(await memory.read(main, 'global/first.md'), 'First.');
  assert.equal(await memory.read(main, 'global/second.md'), 'Second.');
  const bodies = await git(memory.root, 'log', '--format=%b', main);
  assert.match(bodies, /conversation: first/);
  assert.match(bodies, /conversation: second/);
});

await test('keep mine wins conflicting lines and merges every other change, and discard mine takes main', async () => {
  for (const decision of ['keep', 'discard'] as const) {
    const { memory, open, project } = await fixture();
    const { workspace: theirs } = await open('theirs');
    const { workspace: mine } = await open('mine');
    const base = {
      'global/one.md': lines(),
      'global/two.md': lines(),
    };
    await save(theirs, base);
    await theirs.publish();
    await mine.begin(project);
    await save(theirs, {
      'global/one.md': lines({ 1: 'theirs 1', 3: 'theirs 3' }),
      'global/two.md': lines({ 1: 'theirs 1' }),
    });
    await theirs.publish();
    await save(mine, {
      'global/one.md': lines({ 1: 'mine 1' }),
      'global/two.md': lines({ 3: 'mine 3' }),
      'global/three.md': 'Mine only.',
    });
    assert.equal(await mine.publish(), 'conflict');
    const conflict = await mine.conflict();
    assert.deepEqual(conflict.paths, ['global/one.md']);
    assert.match(conflict.diff, /^--- global\/one\.md$/m);
    assert.match(conflict.diff, /^\+mine 1$/m);
    assert.doesNotMatch(conflict.diff, /theirs/);
    if (decision === 'keep') {
      await mine.keepMine();
      assert.equal(await mine.publish(), 'published');
      assert.equal(
        await memory.read(main, 'global/one.md'),
        lines({ 1: 'mine 1', 3: 'theirs 3' }),
      );
      assert.equal(
        await memory.read(main, 'global/two.md'),
        lines({ 1: 'theirs 1', 3: 'mine 3' }),
      );
      assert.equal(await memory.read(main, 'global/three.md'), 'Mine only.');
    } else {
      await mine.discardMine();
      assert.equal(await mine.revision(), await memory.resolve(main));
      assert.equal(
        await readFile(join(mine.root, 'global/one.md'), 'utf8'),
        lines({ 1: 'theirs 1', 3: 'theirs 3' }),
      );
      assert.equal(await mine.publish(), 'published');
    }
  }
});

await test('keep mine carries no markers through a rename on either side', async () => {
  for (const renamer of ['theirs', 'mine'] as const) {
    const { memory, open, project } = await fixture();
    const { workspace: theirs } = await open('theirs');
    const { workspace: mine } = await open('mine');
    await save(theirs, { 'global/one.md': lines() });
    await theirs.publish();
    await mine.begin(project);
    if (renamer === 'theirs') {
      await save(theirs, {
        'global/one.md': null,
        'global/renamed.md': lines({ 2: 'theirs 2' }),
      });
      await save(mine, { 'global/one.md': lines({ 2: 'mine 2' }) });
    } else {
      await save(theirs, {
        'global/one.md': lines({ 2: 'theirs 2', 4: 'theirs 4' }),
      });
      await save(mine, {
        'global/one.md': null,
        'global/renamed.md': lines({ 2: 'mine 2' }),
      });
    }
    await theirs.publish();
    assert.equal(await mine.publish(), 'conflict');
    await mine.keepMine();
    assert.equal(await mine.publish(), 'published');
    await memory.run(memory.root, ['grep', '-q', '<<<<<<<', main], {
      codes: [1],
    });
    await assert.rejects(memory.read(main, 'global/one.md'));
    assert.equal(
      await memory.read(main, 'global/renamed.md'),
      renamer === 'theirs'
        ? lines({ 2: 'mine 2' })
        : lines({ 2: 'mine 2', 4: 'theirs 4' }),
    );
  }
});

await test('a publish that loses the race to update main retries onto the new main', async () => {
  const { memory, open, hook } = await fixture();
  const { workspace: first } = await open('first');
  const { workspace: second } = await open('second');
  await save(first, { 'global/first.md': 'First.' });
  await save(second, { 'global/second.md': 'Second.' });
  let armed = true;
  hook.current = async (command, run, options) => {
    const result = await run();
    if (
      armed &&
      options.cwd === first.root &&
      command.join(' ') === `rev-parse ${main}`
    ) {
      armed = false;
      await second.publish();
    }
    return result;
  };
  assert.equal(await first.publish(), 'published');
  assert.equal(await memory.read(main, 'global/first.md'), 'First.');
  assert.equal(await memory.read(main, 'global/second.md'), 'Second.');
});

await test('keep mine merges against the main it read even when main moves', async () => {
  const { memory, open, hook } = await fixture();
  const { workspace: theirs } = await open('theirs');
  const { workspace: mine } = await open('mine');
  const { workspace: other } = await open('other');
  await save(theirs, { 'global/one.md': 'Theirs.\n' });
  await save(mine, { 'global/one.md': 'Mine.\n' });
  await save(other, { 'global/other.md': 'Other.' });
  await theirs.publish();
  assert.equal(await mine.publish(), 'conflict');
  hook.current = async (command, run) => {
    const result = await run();
    if (command[0] === 'merge-tree') {
      hook.current = passThrough;
      await other.publish();
    }
    return result;
  };
  await mine.keepMine();
  assert.equal(await mine.publish(), 'published');
  assert.equal(await memory.read(main, 'global/one.md'), 'Mine.\n');
  assert.equal(await memory.read(main, 'global/other.md'), 'Other.');
});

await test('a crash inside keep mine before its reset leaves the worktree clean and the conflict standing', async () => {
  const { open, hook } = await fixture();
  const { workspace: theirs } = await open('theirs');
  const { workspace: mine } = await open('mine');
  // their extra note puts the merged tree ahead of my HEAD, which a real index would stage
  await save(theirs, {
    'global/one.md': 'Theirs.\n',
    'global/theirs.md': 'Theirs only.',
  });
  await save(mine, { 'global/one.md': 'Mine.\n' });
  await theirs.publish();
  assert.equal(await mine.publish(), 'conflict');
  hook.current = async (command, run) => {
    const result = await run();
    if (command[0] === 'commit-tree') throw new Error('crashed');
    return result;
  };
  await assert.rejects(mine.keepMine(), /crashed/);
  hook.current = passThrough;
  assert.equal(await mine.isDirty(), false);
  assert.equal(await mine.publish(), 'conflict');
});

await test('a deleted worktree directory comes back on its branch with its unpublished commit', async () => {
  const { memory, open } = await fixture();
  const { workspace } = await open('a');
  await save(workspace, { 'global/kept.md': 'Kept.' });
  const commit = await workspace.revision();
  await rm(workspace.root, { recursive: true });
  await workspace.ensureWorktree();
  assert.equal(
    (await git(workspace.root, 'symbolic-ref', 'HEAD')).trim(),
    'refs/heads/conversations/a',
  );
  assert.equal(await workspace.revision(), commit);
  await workspace.publish();
  assert.equal(await memory.read(main, 'global/kept.md'), 'Kept.');
});

await test('a leftover rebase is aborted back onto the branch before publishing', async () => {
  const { memory, open, root } = await fixture();
  const { workspace } = await open('a');
  await save(workspace, { 'global/kept.md': 'Kept.' });
  const editor = join(root, 'break.sh');
  await writeFile(editor, '#!/bin/sh\nprintf "break\\n" > "$1"\n');
  await chmod(editor, 0o755);
  await execute('git', ['rebase', '-i', 'HEAD~1'], {
    cwd: workspace.root,
    env: { ...process.env, GIT_SEQUENCE_EDITOR: editor },
  });
  assert.equal(await workspace.rebaseStopped(), true);
  await workspace.ensureWorktree();
  assert.equal(await workspace.rebaseStopped(), false);
  assert.equal(
    (await git(workspace.root, 'symbolic-ref', 'HEAD')).trim(),
    'refs/heads/conversations/a',
  );
  await workspace.publish();
  assert.equal(await memory.read(main, 'global/kept.md'), 'Kept.');
});

for (const [name, mineChange, theirChange, expected] of [
  ['I delete, they edit', null, lines({ 2: 'theirs 2' }), undefined],
  ['I edit, they delete', lines({ 2: 'mine 2' }), null, lines({ 2: 'mine 2' })],
] as const) {
  await test(`keep mine when ${name}`, async () => {
    const { memory, open, project } = await fixture();
    const { workspace: theirs } = await open('theirs');
    const { workspace: mine } = await open('mine');
    await save(theirs, { 'global/one.md': lines(), 'global/keep.md': 'Keep.' });
    await theirs.publish();
    await mine.begin(project);
    await save(theirs, { 'global/one.md': theirChange });
    await save(mine, { 'global/one.md': mineChange });
    await theirs.publish();
    assert.equal(await mine.publish(), 'conflict');
    await mine.keepMine();
    await mine.publish();
    if (expected === undefined)
      await assert.rejects(memory.read(main, 'global/one.md'));
    else assert.equal(await memory.read(main, 'global/one.md'), expected);
    assert.equal(await memory.read(main, 'global/keep.md'), 'Keep.');
  });
}

await test('keep mine keeps their renamed copy of a note I deleted', async () => {
  const { memory, open, project } = await fixture();
  const { workspace: theirs } = await open('theirs');
  const { workspace: mine } = await open('mine');
  await save(theirs, { 'global/one.md': lines(), 'global/keep.md': 'Keep.' });
  await theirs.publish();
  await mine.begin(project);
  await save(theirs, { 'global/one.md': null, 'global/renamed.md': lines() });
  await save(mine, { 'global/one.md': null });
  await theirs.publish();
  assert.equal(await mine.publish(), 'conflict');
  await mine.keepMine();
  await mine.publish();
  assert.equal(await memory.read(main, 'global/renamed.md'), lines());
});

await test('begin recreates the project directory after its last note is deleted on main', async () => {
  const { memory, open, project } = await fixture();
  const { workspace: first, scope } = await open('first');
  const { workspace: second } = await open('second');
  const paths = await memory.scopePaths(project);
  await writeFile(join(scope.project, 'MEMORY.md'), 'Project note.');
  await first.commit('note');
  await first.publish();
  await second.begin(project);
  await rm(join(second.root, paths.project, 'MEMORY.md'));
  await second.commit('delete');
  await second.publish();
  const { scope: begun } = await first.begin(project);
  assert.ok((await stat(join(first.root, begun.project))).isDirectory());
  assert.ok((await stat(join(first.root, begun.global))).isDirectory());
});

await test('snapshot paths point into the worktree, never the bare repository', async () => {
  const { memory, open, project } = await fixture();
  const { workspace } = await open('a');
  const paths = await memory.scopePaths(project);
  const snapshot = await memory.snapshot(
    await workspace.revision(),
    workspace.root,
    paths,
  );
  assert.ok(
    snapshot
      .split('\n')
      .includes(join(workspace.root, paths.project, 'MEMORY.md')),
  );
  assert.doesNotMatch(snapshot, /memory\.git/);
});

await test('begin returns the worktree revision when main moves during it', async () => {
  const { memory, open, hook, project } = await fixture();
  const { workspace: first } = await open('first');
  const { workspace: second } = await open('second');
  await save(second, { 'global/later.md': 'Later.' });
  hook.current = async (command, run, options) => {
    const result = await run();
    if (options.cwd === first.root && command[0] === 'merge') {
      hook.current = passThrough;
      await second.publish();
    }
    return result;
  };
  const { revision } = await first.begin(project);
  assert.equal(revision, await first.revision());
  assert.notEqual(revision, await memory.resolve(main));
});

await test('publishing a clean worktree behind main leaves it where it was', async () => {
  const { open } = await fixture();
  const { workspace: first } = await open('first');
  const { workspace: second } = await open('second');
  const before = await first.revision();
  await save(second, { 'global/later.md': 'Later.' });
  await second.publish();
  assert.equal(await first.publish(), 'published');
  assert.equal(await first.revision(), before);
});

await test('discarding works when notes are named main and HEAD', async () => {
  const { memory, open } = await fixture();
  const { workspace } = await open('a');
  await save(workspace, { main: 'A note named main.', HEAD: 'And HEAD.' });
  await writeFile(join(workspace.root, 'HEAD'), 'Pending.');
  await workspace.discardPending();
  assert.equal(await workspace.isDirty(), false);
  await workspace.discardMine();
  assert.equal(await workspace.revision(), await memory.resolve(main));
});

await test('index lines both sides add to MEMORY.md merge without a conflict', async () => {
  const { memory, open } = await fixture();
  const { workspace: first } = await open('first');
  const { workspace: second } = await open('second');
  await save(first, {
    'global/MEMORY.md': '# Global memory\n- [first](first.md)\n',
  });
  await save(second, {
    'global/MEMORY.md': '# Global memory\n- [second](second.md)\n',
  });
  assert.equal(await first.publish(), 'published');
  assert.equal(await second.publish(), 'published');
  const index = await memory.read(main, 'global/MEMORY.md');
  assert.match(index, /- \[first\]\(first\.md\)/);
  assert.match(index, /- \[second\]\(second\.md\)/);
});
