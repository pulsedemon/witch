import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

/** a checkout on `main` tracking a bare origin, in its own scratch root so its `<main>-<i>` slots are removed with it. */
async function checkout(name = 'repo') {
  const root = await scratch('witch-spawn-');
  const origin = join(root, 'origin.git');
  const main = join(root, name);
  await git(root, 'init', '--bare', '-b', 'main', origin);
  await git(root, 'init', '-b', 'main', main);
  await writeFile(join(main, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  await git(main, 'add', '.');
  await git(main, 'commit', '-m', 'first');
  await git(main, 'remote', 'add', 'origin', origin);
  await git(main, 'push', '-u', 'origin', 'main');
  return { root, origin, main, slot: (index: number) => `${main}-${index}` };
}

/** runs git for real and records `pnpm` and `osascript`, failing a call with the message `fail` returns for it. */
function recording(
  fail: (command: string, cwd: string) => string | undefined = () => undefined,
) {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const run: Run = async (command, args, options) => {
    if (command === 'git') return runCommand(command, args, options);
    calls.push({ command, args, cwd: options.cwd });
    const message = fail(command, options.cwd);
    if (message !== undefined) throw new Error(message);
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

test('a failed osascript marks every slot awaiting a tab with its error', async () => {
  const { root, main, slot } = await checkout();
  const { run } = recording((command) =>
    command === 'osascript' ? 'Command failed: osascript\nboom\n' : undefined,
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
      error: 'Command failed: osascript boom',
    },
    {
      path: slot(2),
      slot: true,
      created: true,
      opened: false,
      error: 'Command failed: osascript boom',
    },
  ]);
  assert.deepEqual(
    await printed(() => runSpawn(main, 2, join(root, 'state'), run)),
    {
      code: 1,
      output: [
        'Worktrees start at origin/main.',
        `${slot(1)}: exists, Command failed: osascript boom`,
        `${slot(2)}: exists, Command failed: osascript boom`,
        '',
      ].join('\n'),
    },
  );
});

test('a slot whose install fails still gets its tab', async () => {
  const { root, main, slot } = await checkout();
  const { run, tabs } = recording((command, cwd) =>
    command === 'pnpm' && cwd === slot(1)
      ? 'Command failed: pnpm install\nERR_PNPM_OUTDATED_LOCKFILE\n'
      : undefined,
  );
  assert.deepEqual(
    await printed(() => runSpawn(main, 2, join(root, 'state'), run)),
    {
      code: 1,
      output: [
        'Worktrees start at origin/main.',
        `${slot(1)}: created, Command failed: pnpm install ERR_PNPM_OUTDATED_LOCKFILE, opened`,
        `${slot(2)}: created, opened`,
        '',
      ].join('\n'),
    },
  );
  assert.deepEqual(tabs(), [[slot(1), slot(2)]]);
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
  } finally {
    for (const files of held) await files.close();
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
