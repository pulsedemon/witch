import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test, vi } from 'vitest';
import { runCommand } from '../src/core/command.js';
import type { Run } from '../src/core/repository.js';
import { exists } from '../src/memory/memory.js';
import { StateStore } from '../src/persistence/store.js';
import { runSpawn, sessionsIn, spawnWorktrees } from '../src/spawn.js';
import { scratch } from './fixtures/scratch.js';

const execute = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd },
  );
  return stdout.trim();
}

/**
 * a checkout on `main` tracking a bare origin, in its own scratch root so its `<main>-<i>` slots are removed with it.
 * without `lockfile` it has no `pnpm-lock.yaml`, like a Godot project.
 */
async function checkout(name = 'repo', lockfile = true) {
  const root = await scratch('witch-spawn-');
  const origin = join(root, 'origin.git');
  const main = join(root, name);
  await git(root, 'init', '--bare', '-b', 'main', origin);
  await git(root, 'init', '-b', 'main', main);
  if (lockfile)
    await writeFile(join(main, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  else await writeFile(join(main, 'project.godot'), '');
  await git(main, 'add', '.');
  await git(main, 'commit', '-m', 'first');
  await git(main, 'remote', 'add', 'origin', origin);
  await git(main, 'push', '-u', 'origin', 'main');
  return { root, origin, main, slot: (index: number) => `${main}-${index}` };
}

/**
 * runs git, cp and find for real and records `pnpm` and `osascript`. a call `fail` returns output for rejects as execFile does, with
 * the command line in its message; one it returns an error for rejects with that error.
 */
function recording(
  fail: (
    command: string,
    cwd: string,
  ) => { stdout?: string; stderr?: string } | Error | undefined = () =>
    undefined,
) {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const run: Run = async (command, args, options) => {
    if (['git', 'cp', 'find'].includes(command))
      return runCommand(command, args, options);
    calls.push({ command, args, cwd: options.cwd });
    const failure = fail(command, options.cwd);
    if (failure instanceof Error) throw failure;
    if (failure)
      throw Object.assign(
        new Error(
          `Command failed: ${[command, ...args].join(' ')}\n${failure.stderr ?? ''}`,
        ),
        { stdout: '', stderr: '', ...failure },
      );
    return { stdout: '', stderr: '' };
  };
  return {
    run,
    installs: () =>
      calls.filter(({ command }) => command === 'pnpm').map(({ cwd }) => cwd),
    tabs: () =>
      calls
        .filter(({ command }) => command === 'osascript')
        .map(({ args }) => args.slice(2)),
    calls,
  };
}

const worktrees = async (main: string) =>
  (await git(main, 'worktree', 'list', '--porcelain'))
    .split('\n')
    .flatMap((line) =>
      line.startsWith('worktree ') ? [line.slice('worktree '.length)] : [],
    );

async function printed(work: () => Promise<number>) {
  const write = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true);
  try {
    const code = await work();
    return { code, output: write.mock.calls.map(([text]) => text).join('') };
  } finally {
    write.mockRestore();
  }
}

test("spawn creates the missing worktrees detached at the main checkout's upstream and opens a tab for each", async () => {
  const { root, origin, main, slot } = await checkout();
  // the slots must sit on this commit, which the main checkout sees only after a fetch
  const other = join(root, 'other');
  await git(root, 'clone', origin, other);
  await git(other, 'commit', '--allow-empty', '-m', 'later');
  await git(other, 'push', 'origin', 'main');
  const later = await git(other, 'rev-parse', 'HEAD');
  const { run, calls, tabs } = recording();
  const { base, slots } = await spawnWorktrees(main, 2, {
    run,
    live: async () => false,
  });
  assert.equal(base, 'origin/main');
  assert.deepEqual(slots, [
    { path: slot(1), slot: true, created: true, opened: true },
    { path: slot(2), slot: true, created: true, opened: true },
  ]);
  assert.deepEqual(await worktrees(main), [main, slot(1), slot(2)]);
  for (const path of [slot(1), slot(2)]) {
    assert.equal(await git(path, 'rev-parse', 'HEAD'), later);
    assert.equal(
      await git(path, 'rev-parse', '--symbolic-full-name', 'HEAD'),
      'HEAD',
    );
  }
  assert.deepEqual(
    calls
      .filter(({ command }) => command === 'pnpm')
      .map(({ args, cwd }) => [cwd, ...args]),
    [
      [slot(1), 'install', '--frozen-lockfile'],
      [slot(2), 'install', '--frozen-lockfile'],
    ],
  );
  assert.deepEqual(tabs(), [[slot(1), slot(2)]]);
});

test('spawn reuses existing worktrees, installs and opens tabs only where no session runs, and reports a registered slot missing from disk', async () => {
  const { main, slot } = await checkout();
  await spawnWorktrees(main, 3, {
    run: recording().run,
    live: async () => false,
  });
  await rm(slot(2), { recursive: true });
  const { run, installs, tabs } = recording();
  const { slots } = await spawnWorktrees(main, 4, {
    run,
    live: async (path) => path === slot(1),
  });
  assert.deepEqual(slots, [
    { path: slot(1), slot: true, created: false, opened: false },
    {
      path: slot(2),
      slot: false,
      created: false,
      opened: false,
      error: 'registered but missing; run git worktree prune',
    },
    { path: slot(3), slot: true, created: false, opened: true },
    { path: slot(4), slot: true, created: true, opened: true },
  ]);
  assert.deepEqual(installs(), [slot(3), slot(4)]);
  assert.deepEqual(tabs(), [[slot(3), slot(4)]]);
});

test("spawn leaves a non-empty directory that isn't a worktree alone", async () => {
  const { main, slot } = await checkout();
  await mkdir(slot(1));
  await writeFile(join(slot(1), 'notes.txt'), 'mine\n');
  const { run, installs, tabs } = recording();
  const { slots } = await spawnWorktrees(main, 2, {
    run,
    live: async () => false,
  });
  const [blocked, created] = slots;
  assert.equal(blocked!.slot, false);
  assert.equal(blocked!.created, false);
  assert.equal(blocked!.opened, false);
  assert.match(blocked!.error!, /already exists/);
  assert.deepEqual(created, {
    path: slot(2),
    slot: true,
    created: true,
    opened: true,
  });
  assert.deepEqual(await worktrees(main), [main, slot(2)]);
  assert.equal(await exists(join(slot(1), 'notes.txt')), true);
  assert.deepEqual(installs(), [slot(2)]);
  assert.deepEqual(tabs(), [[slot(2)]]);
});

test('a failed osascript marks every slot awaiting a tab with its stderr, not its script', async () => {
  const { root, main, slot } = await checkout();
  const { run } = recording((command) =>
    command === 'osascript'
      ? { stderr: '18:67: execution error: Not authorized. (-1743)\n' }
      : undefined,
  );
  const { slots } = await spawnWorktrees(main, 2, {
    run,
    live: async () => false,
  });
  assert.deepEqual(slots, [
    {
      path: slot(1),
      slot: true,
      created: true,
      opened: false,
      error:
        'osascript failed: 18:67: execution error: Not authorized. (-1743)',
    },
    {
      path: slot(2),
      slot: true,
      created: true,
      opened: false,
      error:
        'osascript failed: 18:67: execution error: Not authorized. (-1743)',
    },
  ]);
  assert.deepEqual(
    await printed(() => runSpawn(main, 2, join(root, 'state'), run)),
    {
      code: 1,
      output: [
        'Worktrees start at origin/main.',
        `${slot(1)}: exists, osascript failed: 18:67: execution error: Not authorized. (-1743)`,
        `${slot(2)}: exists, osascript failed: 18:67: execution error: Not authorized. (-1743)`,
        '',
      ].join('\n'),
    },
  );
});

test('slots whose install fails report what pnpm printed and still get their tabs', async () => {
  const { root, main, slot } = await checkout();
  const { run, tabs } = recording((command, cwd) => {
    if (command !== 'pnpm') return undefined;
    if (cwd === slot(1))
      return { stdout: ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install\n\n' };
    if (cwd === slot(2)) return new Error('spawn pnpm ENOENT');
    return Object.assign(
      new Error('Timed out after 300000 ms: Command failed'),
      {
        killed: true,
        stdout: 'Progress: resolved 1\n',
        stderr: '',
      },
    );
  });
  assert.deepEqual(
    await printed(() => runSpawn(main, 3, join(root, 'state'), run)),
    {
      code: 1,
      output: [
        'Worktrees start at origin/main.',
        `${slot(1)}: created, pnpm install failed: ERR_PNPM_OUTDATED_LOCKFILE Cannot install, opened`,
        `${slot(2)}: created, spawn pnpm ENOENT, opened`,
        `${slot(3)}: created, pnpm install timed out: Progress: resolved 1, opened`,
        '',
      ].join('\n'),
    },
  );
  assert.deepEqual(tabs(), [[slot(1), slot(2), slot(3)]]);
});

test('spawn names slots from the main worktree when run inside one', async () => {
  const { main, slot } = await checkout();
  await spawnWorktrees(main, 1, {
    run: recording().run,
    live: async () => false,
  });
  const { slots } = await spawnWorktrees(slot(1), 2, {
    run: recording().run,
    live: async () => false,
  });
  assert.deepEqual(
    slots.map(({ path, created }) => ({ path, created })),
    [
      { path: slot(1), created: false },
      { path: slot(2), created: true },
    ],
  );
  assert.equal(await exists(`${slot(1)}-1`), false);
});

test('spawn passes paths with spaces and quotes to osascript as arguments', async () => {
  const { main, slot } = await checkout("it's a repo");
  const { run, calls } = recording();
  await spawnWorktrees(main, 1, { run, live: async () => false });
  const [script, ...paths] = calls
    .find(({ command }) => command === 'osascript')!
    .args.slice(1);
  assert.deepEqual(paths, [slot(1)]);
  assert.equal(script!.includes(main), false);
  assert.equal(script!.includes("it's"), false);
});

test('spawn fails before creating anything when the main checkout is detached', async () => {
  const { main } = await checkout();
  await git(main, 'switch', '--detach');
  const { run, calls } = recording();
  await assert.rejects(
    spawnWorktrees(main, 2, { run, live: async () => false }),
    {
      message: `${main} is detached; switch it to the branch worktrees should start from.`,
    },
  );
  assert.deepEqual(await worktrees(main), [main]);
  assert.deepEqual(calls, []);
});

test('an ignored file that fails to copy is reported along with a failed install, and the rest are copied', async () => {
  const { main, slot } = await checkout();
  await writeFile(join(main, '.gitignore'), '*.local\n');
  await git(main, 'add', '.');
  await git(main, 'commit', '-m', 'ignores');
  await git(main, 'push');
  await writeFile(join(main, 'a.local'), 'a');
  await chmod(join(main, 'a.local'), 0o000);
  await writeFile(join(main, 'b.local'), 'b');
  const { run, tabs } = recording((command) =>
    command === 'pnpm' ? { stdout: 'ERR_PNPM_OUTDATED_LOCKFILE\n' } : undefined,
  );
  const [spawned] = (
    await spawnWorktrees(main, 1, { run, live: async () => false })
  ).slots;
  assert.match(
    spawned!.error!,
    /^copy failed: cp: .*a\.local: Permission denied, pnpm install failed: ERR_PNPM_OUTDATED_LOCKFILE$/,
  );
  assert.equal(spawned!.opened, true);
  assert.deepEqual(tabs(), [[slot(1)]]);
  assert.equal(await exists(join(slot(1), 'a.local')), false);
  assert.equal(await readFile(join(slot(1), 'b.local'), 'utf8'), 'b');
});

test('an ignored file that leaves the main checkout while its worktree is created is skipped, and the rest are copied', async () => {
  const { main, slot } = await checkout();
  await writeFile(join(main, '.gitignore'), '*.local\n');
  await git(main, 'add', '.');
  await git(main, 'commit', '-m', 'ignores');
  await git(main, 'push');
  await writeFile(join(main, 'a.local'), 'a');
  await writeFile(join(main, 'b.local'), 'b');
  const { run: recorded } = recording();
  const run: Run = async (command, args, options) => {
    const result = await recorded(command, args, options);
    if (args[0] === 'worktree' && args[1] === 'add')
      await rm(join(main, 'a.local'));
    return result;
  };
  assert.deepEqual(
    (await spawnWorktrees(main, 1, { run, live: async () => false })).slots,
    [{ path: slot(1), slot: true, created: true, opened: true }],
  );
  assert.equal(await exists(join(slot(1), 'a.local')), false);
  assert.equal(await readFile(join(slot(1), 'b.local'), 'utf8'), 'b');
});

test("spawn fails before creating anything when the main checkout's branch has no upstream", async () => {
  const { main } = await checkout();
  await git(main, 'branch', '--unset-upstream');
  const { run, calls } = recording();
  await assert.rejects(
    spawnWorktrees(main, 2, { run, live: async () => false }),
    { message: `${main} has no upstream branch to start worktrees from.` },
  );
  assert.deepEqual(await worktrees(main), [main]);
  assert.deepEqual(calls, []);
});

test('a session counts as open in a slot only while its conversation is locked and its cwd is in that slot', async () => {
  const root = await scratch('witch-spawn-sessions-');
  const main = join(root, 'repo');
  for (const path of [`${main}-1`, join(`${main}-2`, 'src'), `${main}-10`])
    await mkdir(path, { recursive: true });
  const link = join(root, 'link');
  await symlink(`${main}-2`, link);
  const state = join(root, 'state');
  const store = await StateStore.open(state);
  const conversation = (id: string, cwd: string) => ({
    id,
    title: id,
    cwd,
    agent: 'codex',
    sessions: {},
    createdAt: new Date().toISOString(),
  });
  await (await store.create(conversation('closed', `${main}-1`))).close();
  const held = [
    await store.create(conversation('nested', join(`${main}-2`, 'src'))),
    await store.create(conversation('sibling', `${main}-10`)),
  ];
  try {
    const live = sessionsIn(state);
    assert.equal(await live(`${main}-1`), false);
    assert.equal(await live(`${main}-2`), true);
    assert.equal(await live(`${main}-10`), true);
    assert.equal(await live(link), true);
    held.push(await store.create(conversation('later', `${main}-1`)));
    assert.equal(await live(`${main}-1`), true);
  } finally {
    for (const files of held) await files.close();
  }
});

test('a locked conversation that has not saved its record yet leaves ownership unknown', async () => {
  const root = await scratch('witch-spawn-sessions-');
  const state = join(root, 'state');
  const held = await (
    await StateStore.open(state)
  ).create({
    id: 'new',
    title: 'new',
    cwd: '/elsewhere',
    agent: 'codex',
    sessions: {},
    createdAt: new Date().toISOString(),
  });
  try {
    await rm(join(state, 'conversations', 'new', 'state.json'));
    await assert.rejects(sessionsIn(state)(root), {
      message:
        'cannot determine session ownership: a conversation is still saving its first record',
    });
  } finally {
    await held.close();
  }
});

test('an unreadable open conversation record blocks tabs and names its file', async () => {
  const { root, main, slot } = await checkout();
  const state = join(root, 'state');
  const store = await StateStore.open(state);
  const held = await store.create({
    id: 'damaged',
    title: 'damaged',
    cwd: '/elsewhere',
    agent: 'codex',
    sessions: {},
    createdAt: new Date().toISOString(),
  });
  const file = join(state, 'conversations', 'damaged', 'state.json');
  await writeFile(file, '{broken');
  const { run, calls } = recording();
  try {
    assert.deepEqual(await printed(() => runSpawn(main, 1, state, run)), {
      code: 1,
      output: [
        'Worktrees start at origin/main.',
        `${slot(1)}: created, cannot determine session ownership: ${file}`,
        '',
      ].join('\n'),
    });
  } finally {
    await held.close();
  }
  assert.deepEqual(calls, []);
});

test("a new worktree gets the main checkout's ignored files and directories, except what its copy would act on and the plans, and a reused one keeps its own", async () => {
  const { main, slot } = await checkout();
  await writeFile(
    join(main, '.gitignore'),
    [
      '.env.local',
      '.claude/settings.local.json',
      '.claude/worktrees/',
      'node_modules/',
      'app/.godot/',
      'tools/',
      '.superpowers/',
      'docs/superpowers/plans/*.md',
      '',
    ].join('\n'),
  );
  await mkdir(join(main, 'app'));
  await writeFile(join(main, 'app', 'project.godot'), '');
  await mkdir(join(main, 'docs', 'superpowers', 'plans'), { recursive: true });
  await writeFile(join(main, 'docs', 'superpowers', 'plans', '.gitkeep'), '');
  await git(main, 'add', '.');
  await git(main, 'commit', '-m', 'ignores');
  await git(main, 'push');
  const local = async (path: string, text = '') => {
    await mkdir(dirname(join(main, path)), { recursive: true });
    await writeFile(join(main, path), text);
  };
  await local('.env.local', 'main\n');
  // alone in an untracked directory, which git lists along with the file, as in netshooter
  await local('.claude/settings.local.json', '{"main":1}');
  await local('node_modules/x/index.js');
  await local('app/.godot/instances/1');
  await local('.claude/worktrees/agent/.git', 'gitdir: elsewhere');
  await local('tools/venv/pyvenv.cfg');
  await local('tools/notes.txt');
  await local('.superpowers/sdd/ledger');
  await local('.superpowers/brainstorm.md');
  await local('docs/superpowers/plans/task.md');
  const { run } = recording();
  assert.deepEqual(
    (await spawnWorktrees(main, 1, { run, live: async () => false })).slots,
    [{ path: slot(1), slot: true, created: true, opened: true }],
  );
  const copied = async (path: string) => exists(join(slot(1), path));
  assert.equal(await readFile(join(slot(1), '.env.local'), 'utf8'), 'main\n');
  assert.equal(
    await readFile(join(slot(1), '.claude', 'settings.local.json'), 'utf8'),
    '{"main":1}',
  );
  for (const path of [
    'node_modules/x/index.js',
    'tools/notes.txt',
    '.superpowers/brainstorm.md',
  ])
    assert.equal(await copied(path), true, path);
  for (const path of [
    'app/.godot',
    '.claude/worktrees/agent',
    'tools/venv',
    '.superpowers/sdd',
    'docs/superpowers/plans/task.md',
  ])
    assert.equal(await copied(path), false, path);
  assert.equal(await git(slot(1), 'status', '--porcelain'), '');
  await writeFile(join(slot(1), '.env.local'), 'slot\n');
  await writeFile(join(main, '.env.local'), 'changed\n');
  await spawnWorktrees(main, 1, { run, live: async () => false });
  assert.equal(await readFile(join(slot(1), '.env.local'), 'utf8'), 'slot\n');
});

test('a repository without pnpm-lock.yaml gets its worktrees and tabs without pnpm', async () => {
  const { main, slot } = await checkout('repo', false);
  const { run, installs, tabs } = recording();
  await spawnWorktrees(main, 2, { run, live: async () => false });
  assert.deepEqual(await worktrees(main), [main, slot(1), slot(2)]);
  assert.deepEqual(installs(), []);
  assert.deepEqual(tabs(), [[slot(1), slot(2)]]);
});

test('a slot whose session opens while a later slot installs gets no tab', async () => {
  const { main, slot } = await checkout();
  const { run, installs, tabs } = recording();
  const { slots } = await spawnWorktrees(main, 2, {
    run,
    live: async (path) => path === slot(1) && installs().includes(slot(2)),
  });
  assert.deepEqual(installs(), [slot(1), slot(2)]);
  assert.deepEqual(tabs(), [[slot(2)]]);
  assert.deepEqual(slots, [
    { path: slot(1), slot: true, created: true, opened: false },
    { path: slot(2), slot: true, created: true, opened: true },
  ]);
});

test('spawn runs no osascript when every slot has an open session', async () => {
  const { main, slot } = await checkout();
  const { run, calls } = recording();
  const { slots } = await spawnWorktrees(main, 2, {
    run,
    live: async () => true,
  });
  assert.deepEqual(slots, [
    { path: slot(1), slot: true, created: true, opened: false },
    { path: slot(2), slot: true, created: true, opened: false },
  ]);
  assert.deepEqual(calls, []);
});
