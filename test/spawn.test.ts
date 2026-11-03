import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  readdir,
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
    // Linux ci's GNU cp has no -c, the clone flag on macOS
    if (command === 'cp' && process.platform !== 'darwin')
      return runCommand(
        command,
        args.filter((arg) => arg !== '-c'),
        options,
      );
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

test("spawn starts worktrees at the main checkout's own upstream, not origin's main", async () => {
  const { root, main, slot } = await checkout();
  const fork = join(root, 'fork.git');
  await git(root, 'init', '--bare', '-b', 'stable', fork);
  await git(main, 'remote', 'add', 'fork', fork);
  await git(main, 'commit', '--allow-empty', '-m', 'stable only');
  await git(main, 'push', 'fork', 'HEAD:stable');
  await git(main, 'branch', '--set-upstream-to', 'fork/stable');
  // the main checkout sees this commit only once spawn fetches its upstream's remote
  const other = join(root, 'other');
  await git(root, 'clone', '-b', 'stable', fork, other);
  await git(other, 'commit', '--allow-empty', '-m', 'later');
  await git(other, 'push');
  const stable = await git(other, 'rev-parse', 'HEAD');
  const { base } = await spawnWorktrees(main, 1, {
    run: recording().run,
    live: async () => false,
  });
  assert.equal(base, 'fork/stable');
  assert.equal(await git(slot(1), 'rev-parse', 'HEAD'), stable);
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
    /^copy failed: cp: .*a\.local.*Permission denied, pnpm install failed: ERR_PNPM_OUTDATED_LOCKFILE$/,
  );
  assert.equal(spawned!.opened, true);
  assert.deepEqual(tabs(), [[slot(1)]]);
  assert.equal(await exists(join(slot(1), 'a.local')), false);
  assert.equal(await readFile(join(slot(1), 'b.local'), 'utf8'), 'b');
});

test("copies the new worktree's own rules don't ignore are removed and reported", async () => {
  const { main, slot } = await checkout();
  await writeFile(join(main, '.gitignore'), 'keys/*\n!keys/visible.env\n');
  await git(main, 'add', '.');
  await git(main, 'commit', '-m', 'ignores');
  await git(main, 'push');
  // ignored only by the launcher's uncommitted .gitignore, so the worktree at the upstream would show them untracked
  await writeFile(
    join(main, '.gitignore'),
    'keys/\nsecret\nsecret.env\nexports/\nvendor/\n',
  );
  // a nested clone, which git lists as its directory
  await mkdir(join(main, 'vendor', 'lib'), { recursive: true });
  await git(join(main, 'vendor', 'lib'), 'init', '-q');
  await writeFile(join(main, 'vendor', 'lib', 'lib.js'), '');
  await writeFile(join(main, 'secret'), 'token');
  await writeFile(join(main, 'secret.env'), 'token');
  await mkdir(join(main, 'exports'));
  await writeFile(join(main, 'exports', 'build.bin'), '');
  // git lists keys/ whole, but the upstream's rules keep visible.env out of the ignore
  await mkdir(join(main, 'keys'));
  await writeFile(join(main, 'keys', 'visible.env'), 'token');
  await writeFile(join(main, 'keys', 'a.key'), 'key');
  const [spawned] = (
    await spawnWorktrees(main, 1, {
      run: recording().run,
      live: async () => false,
    })
  ).slots;
  assert.equal(
    spawned!.error,
    "removed copies the worktree doesn't ignore: exports/build.bin, keys/visible.env, secret, secret.env, vendor/lib/",
  );
  assert.equal(await readFile(join(slot(1), 'keys', 'a.key'), 'utf8'), 'key');
  assert.equal(await exists(join(slot(1), 'vendor', 'lib')), false);
  assert.equal(await git(slot(1), 'status', '--porcelain'), '');
});

test("an ignored directory the upstream tracks a file in gets the main checkout's other files one by one", async () => {
  const { main, slot } = await checkout();
  await mkdir(join(main, '.claude'));
  await writeFile(join(main, '.claude', 'settings.json'), '{}');
  await writeFile(join(main, '.gitignore'), '.claude/settings.local.json\n');
  await git(main, 'add', '.');
  await git(main, 'commit', '-m', 'claude settings');
  await git(main, 'push');
  // a launcher commit not pushed yet ignores the whole directory, so git lists it as one entry
  await git(main, 'rm', '-q', '.claude/settings.json');
  await writeFile(join(main, '.gitignore'), '.claude/\n');
  await git(main, 'commit', '-qam', 'ignore claude');
  await mkdir(join(main, '.claude'), { recursive: true });
  await writeFile(join(main, '.claude', 'settings.local.json'), '{"main":1}');
  const [spawned] = (
    await spawnWorktrees(main, 1, {
      run: recording().run,
      live: async () => false,
    })
  ).slots;
  assert.equal(spawned!.error, undefined);
  assert.equal(
    await readFile(join(slot(1), '.claude', 'settings.local.json'), 'utf8'),
    '{"main":1}',
  );
  assert.equal(
    await readFile(join(slot(1), '.claude', 'settings.json'), 'utf8'),
    '{}',
  );
});

test("removing a copied .gitignore removes what it was ignoring, when the worktree's rules don't ignore that either", async () => {
  const { main, slot } = await checkout();
  // ignored only by the launcher's uncommitted .gitignore
  await writeFile(join(main, '.gitignore'), 'out/\n');
  await mkdir(join(main, 'out'));
  await writeFile(join(main, 'out', '.gitignore'), '*.bin\n');
  await writeFile(join(main, 'out', 'a.bin'), 'secret');
  const [spawned] = (
    await spawnWorktrees(main, 1, {
      run: recording().run,
      live: async () => false,
    })
  ).slots;
  assert.equal(
    spawned!.error,
    "removed copies the worktree doesn't ignore: out/.gitignore, out/a.bin",
  );
  assert.equal(await exists(join(slot(1), 'out', 'a.bin')), false);
  assert.equal(await git(slot(1), 'status', '--porcelain'), '');
});

test('a copy that a symlink the upstream tracks would carry outside the worktree is reported, not written', async () => {
  const { root, origin, main, slot } = await checkout();
  await mkdir(join(main, 'config'));
  await writeFile(join(main, 'config', 'tracked.txt'), '');
  await writeFile(join(main, '.gitignore'), '*.env\n');
  await git(main, 'add', '.');
  await git(main, 'commit', '-m', 'config');
  await git(main, 'push');
  await writeFile(join(main, 'config', 'secret.env'), 'token');
  // the upstream turns config into a symlink to a directory outside any checkout
  const outside = join(root, 'outside');
  await mkdir(outside);
  const other = join(root, 'other');
  await git(root, 'clone', origin, other);
  await git(other, 'rm', '-rq', 'config');
  await symlink(outside, join(other, 'config'));
  await git(other, 'add', 'config');
  await git(other, 'commit', '-m', 'link config');
  await git(other, 'push');
  const [spawned] = (
    await spawnWorktrees(main, 1, {
      run: recording().run,
      live: async () => false,
    })
  ).slots;
  assert.match(
    spawned!.error!,
    /^config\/secret\.env would land outside the worktree, at /,
  );
  assert.deepEqual(await readdir(outside), []);
  assert.equal(await exists(join(slot(1), 'config')), true);
});

test('a failed check of the copies is reported and the slot still opens its tab', async () => {
  const { main, slot } = await checkout();
  const { run: recorded, tabs } = recording();
  const run: Run = (command, args, options) =>
    options.cwd === slot(1) && args[0] === 'ls-files'
      ? Promise.reject(
          Object.assign(new Error('Command failed'), {
            code: 128,
            stdout: '',
            stderr: 'fatal: bad index\n',
          }),
        )
      : recorded(command, args, options);
  const [spawned] = (
    await spawnWorktrees(main, 1, { run, live: async () => false })
  ).slots;
  assert.equal(
    spawned!.error,
    "copies the worktree doesn't ignore may remain: ls-files failed: fatal: bad index",
  );
  assert.deepEqual(tabs(), [[slot(1)]]);
});

test("a directory git can't read while listing ignored files is reported on the new worktrees, not reused ones", async () => {
  const { main } = await checkout();
  await mkdir(join(main, 'config'));
  await writeFile(join(main, 'config', 'tracked.txt'), '');
  await writeFile(join(main, '.gitignore'), '*.local\n');
  await git(main, 'add', '.');
  await git(main, 'commit', '-m', 'config');
  await git(main, 'push');
  await writeFile(join(main, 'config', 'secret.local'), 'token');
  const { run } = recording();
  await spawnWorktrees(main, 1, { run, live: async () => false });
  await chmod(join(main, 'config'), 0o000);
  try {
    const [reused, ...created] = (
      await spawnWorktrees(main, 3, { run, live: async () => false })
    ).slots;
    assert.equal(reused!.error, undefined);
    for (const spawned of created)
      assert.match(
        spawned.error!,
        /^ignored files may be missing: .*could not open directory 'config\/'/,
      );
  } finally {
    await chmod(join(main, 'config'), 0o755);
  }
});

test('a directory copy that fails partway still leaves out what its copy would act on', async () => {
  const { main, slot } = await checkout();
  await writeFile(join(main, '.gitignore'), 'tools/\n');
  await git(main, 'add', '.');
  await git(main, 'commit', '-m', 'ignores');
  await git(main, 'push');
  await mkdir(join(main, 'tools', 'venv'), { recursive: true });
  await writeFile(join(main, 'tools', 'venv', 'pyvenv.cfg'), '');
  await writeFile(join(main, 'tools', 'locked'), '');
  await chmod(join(main, 'tools', 'locked'), 0o000);
  const [spawned] = (
    await spawnWorktrees(main, 1, {
      run: recording().run,
      live: async () => false,
    })
  ).slots;
  assert.match(
    spawned!.error!,
    /^copy failed: cp: .*locked.*Permission denied$/,
  );
  assert.equal(await exists(join(slot(1), 'tools', 'venv')), false);
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
      'app/.godot/*',
      '!app/.godot/.gitkeep',
      'app/.plugged/',
      'game/.godot/',
      'tools/',
      '.superpowers/',
      'docs/superpowers/plans/*.md',
      '',
    ].join('\n'),
  );
  // one cache partly tracked, so git lists its contents on their own, and one wholly ignored
  await mkdir(join(main, 'app', '.godot'), { recursive: true });
  await writeFile(join(main, 'app', '.godot', '.gitkeep'), '');
  await mkdir(join(main, 'game'));
  await writeFile(join(main, 'game', 'project.godot'), '');
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
  await local('game/.godot/instances/1');
  await local('.claude/worktrees/agent/.git', 'gitdir: elsewhere');
  await local('app/.plugged/addon/.git/HEAD', 'ref: refs/heads/main');
  await local('tools/venv/pyvenv.cfg');
  await local('tools/notes.txt');
  await local('.superpowers/sdd/ledger');
  await local('.superpowers/brainstorm.md');
  await local('docs/superpowers/plans/task.md');
  // ignored only by its own .gitignore, like husky's hooks or a pytest cache, which the worktree lacks until it's copied
  await local('.cache/.gitignore', '*\n');
  await local('.cache/data');
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
    '.cache/data',
    'app/.plugged/addon/.git/HEAD',
    'tools/notes.txt',
    '.superpowers/brainstorm.md',
  ])
    assert.equal(await copied(path), true, path);
  for (const path of [
    'app/.godot/instances',
    'game/.godot',
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
