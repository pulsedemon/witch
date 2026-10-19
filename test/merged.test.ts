import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { Snapshot } from '../src/core/coordinator.js';
import {
  cleanUpMerge,
  refreshInstall,
  watchMerges,
} from '../src/core/merged.js';
import type { PullRequest, Repository } from '../src/core/repository.js';
import { scratch } from './fixtures/scratch.js';

const execute = promisify(execFile);

const git = async (cwd: string, ...args: string[]) =>
  (
    await execute(
      'git',
      [
        '-c',
        'init.defaultBranch=main',
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        ...args,
      ],
      { cwd },
    )
  ).stdout.trim();

const write = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

const exists = (path: string) =>
  readFile(path).then(
    () => true,
    () => false,
  );

async function merged(
  files: Record<string, string> = {},
  ignore: string[] = [],
): Promise<{
  root: string;
  origin: string;
  checkout: string;
  other: string;
  tip: string;
}> {
  const root = await scratch('witch-merged-');
  const origin = join(root, 'origin.git');
  const checkout = join(root, 'checkout');
  const other = join(root, 'other');
  await git(root, 'init', '--bare', origin);
  await git(root, 'clone', origin, checkout);
  await write(
    join(checkout, '.gitignore'),
    ['docs/superpowers/', '.superpowers/', ...ignore, ''].join('\n'),
  );
  for (const [name, text] of Object.entries(files))
    await write(join(checkout, name), text);
  await git(checkout, 'add', '.');
  await git(checkout, 'commit', '-m', 'base');
  await git(checkout, 'push', '-u', 'origin', 'main');
  await git(checkout, 'switch', '-c', 'feat/x');
  await write(join(checkout, 'x.txt'), 'x\n');
  await git(checkout, 'add', '.');
  await git(checkout, 'commit', '-m', 'x');
  await git(checkout, 'push', '-u', 'origin', 'feat/x');
  await git(root, 'clone', origin, other);
  return {
    root,
    origin,
    checkout,
    other,
    tip: await git(checkout, 'rev-parse', 'HEAD'),
  };
}

/** merges `branch` into origin's main from `other`, deleting the remote branch unless `keep`. */
async function merge(other: string, branch: string, keep = false) {
  await git(other, 'pull');
  await git(
    other,
    'merge',
    '--no-ff',
    '-m',
    `merge ${branch}`,
    `origin/${branch}`,
  );
  await git(other, 'push', 'origin', 'main');
  if (!keep) await git(other, 'push', 'origin', '--delete', branch);
}

const pullRequest = (tip: string): PullRequest => ({
  number: 7,
  url: 'https://x.test/7',
  state: 'MERGED',
  branch: 'feat/x',
  commit: tip,
  base: 'main',
});

const plans = (checkout: string) => join(checkout, 'docs/superpowers/plans');

const branches = async (checkout: string) =>
  (await git(checkout, 'branch', '--format=%(refname:short)')).split('\n');

await test("a merged branch's checkout switches to the base, and loses the branch, its ignored plan and ledger, and the merged branches whose remote branch is gone", async () => {
  const { root, checkout, other, tip } = await merged();
  await git(checkout, 'switch', 'main');
  for (const name of ['feat/old', 'feat/live', 'feat/wt']) {
    await git(checkout, 'switch', '-c', name, 'main');
    await write(join(checkout, `${name.slice(5)}.txt`), name);
    await git(checkout, 'add', '.');
    await git(checkout, 'commit', '-m', name);
    await git(checkout, 'push', '-u', 'origin', name);
    await merge(other, name, name === 'feat/live');
    await git(checkout, 'switch', 'main');
  }
  await git(checkout, 'switch', '-c', 'feat/new', 'origin/main');
  await git(checkout, 'switch', 'main');
  await git(checkout, 'worktree', 'add', join(root, 'wt'), 'feat/wt');
  await git(checkout, 'pull');
  await write(join(plans(checkout), 'tracked.md'), '`git switch -c feat/x`.\n');
  await git(checkout, 'add', '-f', 'docs/superpowers/plans/tracked.md');
  await git(checkout, 'commit', '-m', 'tracked plan');
  await git(checkout, 'push', 'origin', 'main');
  await git(checkout, 'switch', 'feat/x');
  await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`.\n');
  await write(join(plans(checkout), 'x2.md'), '`git switch -c feat/x-2`.\n');
  await write(
    join(plans(checkout), 'stack.md'),
    '`git switch -c feat/a`\n\nlater\n\n`git switch -c feat/x`\n',
  );
  await write(
    join(plans(checkout), 'multi.md'),
    '`git switch -c feat/x`\n\nlater\n\n`git switch -c feat/b`\n',
  );
  await write(
    join(plans(checkout), 'plus.md'),
    '`git switch -c feat/x+next`.\n',
  );
  await write(
    join(plans(checkout), 'quoted.md'),
    '`git switch -c feat/x`\n\nlater\n\n`git switch -c "feat/y"`\n',
  );
  await write(join(plans(checkout), 'y.md'), 'on branch feat/x\n');
  await write(
    join(checkout, '.superpowers/sdd/x/plan-path'),
    'docs/superpowers/plans/x.md\n',
  );
  await write(
    join(checkout, '.superpowers/sdd/y/plan-path'),
    'docs/superpowers/plans/y.md\n',
  );
  await merge(other, 'feat/x');
  const result = await cleanUpMerge(checkout, pullRequest(tip));
  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
  assert.equal(
    await git(checkout, 'rev-parse', 'HEAD'),
    await git(other, 'rev-parse', 'origin/main'),
  );
  assert.deepEqual(await branches(checkout), [
    'feat/live',
    'feat/new',
    'feat/wt',
    'main',
  ]);
  await assert.rejects(
    git(checkout, 'config', '--get-regexp', '^branch\\.feat/x\\.'),
  );
  assert.deepEqual((await readdir(plans(checkout))).sort(), [
    'multi.md',
    'plus.md',
    'quoted.md',
    'stack.md',
    'tracked.md',
    'x2.md',
    'y.md',
  ]);
  assert.deepEqual(await readdir(join(checkout, '.superpowers/sdd')), ['y']);
  assert.deepEqual(result, {
    text: '#7 merged: switched to main and pulled, deleted branches feat/x and feat/old, and plan x.md.',
    cleaned: true,
  });
});

await test('a plan that also creates another branch stays whichever git command creates it, named or not, and one for the branch alone goes in any spelling', async () => {
  const { checkout, other, tip } = await merged();
  for (const [name, command] of [
    ['create.md', 'git switch --create feat/y'],
    ['force.md', 'git switch --force-create=feat/y'],
    ['checkout.md', 'git checkout -B feat/y'],
    ['worktree.md', 'git worktree add -b feat/y ../y'],
    ['path.md', 'git worktree add ../y -b feat/y'],
    ['dir.md', 'git -C ../y switch -c feat/y'],
    ['track.md', 'git checkout --track -b feat/y origin/feat/y'],
    ['orphan.md', 'git switch --orphan feat/y'],
    ['branch.md', 'git branch feat/y'],
    ['reset.md', 'git branch -f feat/y main'],
    ['copy.md', 'git branch -c feat/x feat/y'],
    ['unnamed.md', 'git worktree add ../y'],
    ['remote.md', 'git checkout --track origin/feat/y'],
  ] as const)
    await write(
      join(plans(checkout), name),
      `\`git switch -c feat/x\`\n\nlater\n\n\`${command}\`\n`,
    );
  await write(
    join(plans(checkout), 'upper.md'),
    '```sh\ngit switch main && git pull --ff-only && git switch -C feat/x\n```\n\nafter the merge\n\n`git branch -d feat/x`, since `git checkout -b` would fail\n',
  );
  await merge(other, 'feat/x');
  const result = await cleanUpMerge(checkout, pullRequest(tip));
  assert.deepEqual((await readdir(plans(checkout))).sort(), [
    'branch.md',
    'checkout.md',
    'copy.md',
    'create.md',
    'dir.md',
    'force.md',
    'orphan.md',
    'path.md',
    'remote.md',
    'reset.md',
    'track.md',
    'unnamed.md',
    'worktree.md',
  ]);
  assert.equal(
    result?.text,
    '#7 merged: switched to main and pulled, deleted branch feat/x, and plan upper.md.',
  );
});

await test('a head branch still on its remote stays', async () => {
  const { checkout, other, tip } = await merged();
  await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`.\n');
  await merge(other, 'feat/x', true);
  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip)), {
    text: '#7 merged, but feat/x is still on its remote, so it stays.',
    cleaned: false,
  });
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  assert.ok(await exists(join(plans(checkout), 'x.md')));
});

await test('a head branch that tracks no remote branch stays, and says so', async () => {
  const { checkout, other, tip } = await merged();
  await git(checkout, 'branch', '--unset-upstream');
  await merge(other, 'feat/x');
  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip)), {
    text: '#7 merged, but feat/x tracks no remote branch, so it stays.',
    cleaned: false,
  });
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
});

await test("a squash merge's branch goes too", async () => {
  const { checkout, other, tip } = await merged();
  await git(other, 'pull');
  await git(other, 'merge', '--squash', 'origin/feat/x');
  await git(other, 'commit', '-m', 'squash');
  await git(other, 'push', 'origin', 'main');
  await git(other, 'push', 'origin', '--delete', 'feat/x');
  await cleanUpMerge(checkout, pullRequest(tip));
  assert.deepEqual(await branches(checkout), ['main']);
  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
  assert.equal(
    await git(checkout, 'rev-parse', 'HEAD'),
    await git(other, 'rev-parse', 'origin/main'),
  );
});

await test("a branch whose last commit isn't the merged one stays, and so does everything else", async () => {
  const { checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`.\n');
  await git(checkout, 'commit', '--allow-empty', '-m', 'after');
  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip)), {
    text: "#7 merged, but feat/x's last commit isn't the one it merged, so it stays.",
    cleaned: false,
  });
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  assert.ok(await exists(join(plans(checkout), 'x.md')));
});

await test('a checkout that changed since the watch looked is left alone', async () => {
  const { checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`.\n');
  await writeFile(join(checkout, 'x.txt'), 'changed\n');
  assert.equal(await cleanUpMerge(checkout, pullRequest(tip)), undefined);
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  assert.equal(await readFile(join(checkout, 'x.txt'), 'utf8'), 'changed\n');
  assert.deepEqual(await branches(checkout), ['feat/x', 'main']);
  assert.ok(await exists(join(plans(checkout), 'x.md')));
  await git(checkout, 'checkout', '--', 'x.txt');
  await git(checkout, 'switch', 'main');
  assert.equal(await cleanUpMerge(checkout, pullRequest(tip)), undefined);
  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
  assert.deepEqual(await branches(checkout), ['feat/x', 'main']);
  assert.ok(await exists(join(plans(checkout), 'x.md')));
});

await test('an ignored file the base or the merge would start tracking stops the cleanup before overwriting it', async () => {
  {
    const { checkout, other } = await merged({ 'config.local': 'base\n' });
    const first = await git(checkout, 'rev-parse', 'HEAD');
    await git(checkout, 'rm', '--cached', '-q', 'config.local');
    await writeFile(
      join(checkout, '.gitignore'),
      'docs/superpowers/\n.superpowers/\nconfig.local\n',
    );
    await git(checkout, 'add', '.gitignore');
    await git(checkout, 'commit', '-m', 'untrack');
    const tip = await git(checkout, 'rev-parse', 'HEAD');
    await git(other, 'pull');
    await git(other, 'merge', '--no-ff', '-m', 'merge', first);
    await git(other, 'push', 'origin', 'main');
    await git(other, 'push', 'origin', '--delete', 'feat/x');
    await writeFile(join(checkout, 'config.local'), 'mine');
    await assert.rejects(cleanUpMerge(checkout, pullRequest(tip)));
    assert.equal(
      await readFile(join(checkout, 'config.local'), 'utf8'),
      'mine',
    );
    assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  }
  {
    const { checkout, other, tip } = await merged({}, ['secret.txt']);
    await merge(other, 'feat/x');
    await writeFile(join(other, 'secret.txt'), 'theirs');
    await git(other, 'add', '-f', 'secret.txt');
    await git(other, 'commit', '-m', 'secret');
    await git(other, 'push', 'origin', 'main');
    await writeFile(join(checkout, 'secret.txt'), 'mine');
    await assert.rejects(cleanUpMerge(checkout, pullRequest(tip)), (error) => {
      const message = (error as Error).message;
      assert.ok(
        message.startsWith(
          '#7 merged: switched to main and deleted branch feat/x',
        ),
        message,
      );
      assert.ok(message.trim().endsWith('Aborting'), message);
      return true;
    });
    assert.equal(await readFile(join(checkout, 'secret.txt'), 'utf8'), 'mine');
    assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
  }
});

await test('a branch committed to after the tip check stays, and so does its plan', async () => {
  const { checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`.\n');
  // runs after the cleanup's switch, as a commit from another terminal could
  const hooks = join(checkout, '.git/hooks');
  await git(checkout, 'config', 'core.hooksPath', hooks);
  await write(
    join(hooks, 'post-checkout'),
    `#!/bin/sh\ngit update-ref refs/heads/feat/x "$(git -c user.name=t -c user.email=t@t commit-tree -p ${tip} -m late '${tip}^{tree}')"\n`,
  );
  await execute('chmod', ['+x', join(hooks, 'post-checkout')]);
  await assert.rejects(cleanUpMerge(checkout, pullRequest(tip)), (error) => {
    const message = (error as Error).message;
    assert.ok(
      message.startsWith(
        "#7 merged: switched to main, but feat/x wasn't deleted",
      ),
      message,
    );
    return true;
  });
  assert.equal(await git(checkout, 'rev-parse', 'feat/x^'), tip);
  assert.ok(await exists(join(plans(checkout), 'x.md')));
});

await test('a base that tracks another remote is brought up to date from it', async () => {
  const { root, origin, checkout, tip } = await merged();
  const upstream = join(root, 'upstream.git');
  const fork = join(root, 'fork');
  await git(root, 'clone', '--bare', origin, upstream);
  await git(checkout, 'remote', 'add', 'upstream', upstream);
  await git(checkout, 'fetch', 'upstream');
  await git(checkout, 'branch', '--set-upstream-to=upstream/main', 'main');
  await git(root, 'clone', upstream, fork);
  await git(fork, 'merge', '--no-ff', '-m', 'merge feat/x', 'origin/feat/x');
  await git(fork, 'push', 'origin', 'main');
  await git(checkout, 'push', 'origin', '--delete', 'feat/x');
  const result = await cleanUpMerge(checkout, pullRequest(tip));
  assert.equal(
    await git(checkout, 'rev-parse', 'HEAD'),
    await git(fork, 'rev-parse', 'HEAD'),
  );
  assert.deepEqual(result, {
    text: '#7 merged: switched to main and pulled, deleted branch feat/x.',
    cleaned: true,
  });
});

await test("the cleanup fetches through the user's own ssh command, and through ssh in batch mode otherwise", async () => {
  for (const own of [true, false]) {
    const { root, origin, checkout, other, tip } = await merged();
    await merge(other, 'feat/x');
    await git(checkout, 'remote', 'set-url', 'origin', `ssh://x.test${origin}`);
    // stands in for ssh: logs its arguments and runs the remote command here
    const log = join(root, 'ssh.log');
    const ssh = join(root, 'bin', own ? 'own-ssh' : 'ssh');
    await write(
      ssh,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\neval "command=\\\${$#}"\nexec sh -c "$command"\n`,
    );
    await execute('chmod', ['+x', ssh]);
    const path = process.env.PATH;
    if (own) {
      await git(checkout, 'config', 'core.sshCommand', ssh);
      await git(checkout, 'config', 'ssh.variant', 'simple');
    } else process.env.PATH = `${dirname(ssh)}:${path}`;
    try {
      assert.equal(
        (await cleanUpMerge(checkout, pullRequest(tip)))?.cleaned,
        true,
      );
    } finally {
      process.env.PATH = path;
    }
    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    assert.equal(calls.length, 2);
    for (const call of calls)
      assert.ok(call.startsWith(own ? 'x.test ' : '-o BatchMode=yes '), call);
  }
});

await test('a branch switched to during the base fetch is left as it was, and the cleanup stops', async () => {
  const { root, checkout, other, tip } = await merged();
  await git(checkout, 'switch', '-c', 'feat/y', 'main');
  await git(checkout, 'push', '-u', 'origin', 'feat/y');
  const before = await git(checkout, 'rev-parse', 'HEAD');
  await git(other, 'fetch');
  await git(other, 'switch', 'feat/y');
  await git(other, 'commit', '--allow-empty', '-m', 'y');
  await git(other, 'push');
  await git(other, 'switch', 'main');
  await git(checkout, 'switch', 'feat/x');
  await merge(other, 'feat/x');
  // runs in each fetch, and switches once the cleanup is on the base, as another terminal could
  const pack = join(root, 'upload-pack');
  await write(
    pack,
    `#!/bin/sh\nif [ "$(git -C '${checkout}' branch --show-current)" = main ]; then git -C '${checkout}' switch -q feat/y; fi\nexec git upload-pack "$@"\n`,
  );
  await execute('chmod', ['+x', pack]);
  await git(checkout, 'config', 'remote.origin.uploadpack', pack);
  await assert.rejects(cleanUpMerge(checkout, pullRequest(tip)), {
    message:
      "#7 merged: switched to main and deleted branch feat/x, but main didn't fast-forward: the checkout left main or changed during the fetch",
  });
  assert.equal(await git(checkout, 'rev-parse', 'feat/y'), before);
});

await test('an edit made during the base fetch stops the cleanup before the fast-forward', async () => {
  const { root, checkout, other, tip } = await merged({ 'a.txt': 'a\n' });
  const before = await git(checkout, 'rev-parse', 'main');
  await merge(other, 'feat/x');
  // runs in each fetch, and edits once the cleanup is on the base, as another terminal could
  const pack = join(root, 'upload-pack');
  await write(
    pack,
    `#!/bin/sh\nif [ "$(git -C '${checkout}' branch --show-current)" = main ]; then echo edited > '${checkout}/a.txt'; fi\nexec git upload-pack "$@"\n`,
  );
  await execute('chmod', ['+x', pack]);
  await git(checkout, 'config', 'remote.origin.uploadpack', pack);
  await assert.rejects(cleanUpMerge(checkout, pullRequest(tip)), {
    message:
      "#7 merged: switched to main and deleted branch feat/x, but main didn't fast-forward: the checkout left main or changed during the fetch",
  });
  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), before);
  assert.equal(await readFile(join(checkout, 'a.txt'), 'utf8'), 'edited\n');
});

await test('the install pulls, installs and builds when clean on the base, and stays put otherwise', async () => {
  const { root, origin, other } = await merged({ 'a.txt': 'a\n' });
  const install = join(root, 'install');
  await git(root, 'clone', origin, install);
  await git(other, 'commit', '--allow-empty', '-m', 'ahead');
  await git(other, 'push');
  const calls: [string, string[], { cwd: string; timeout: number }][] = [];
  const run = async (
    command: string,
    args: string[],
    options: { cwd: string; timeout: number },
  ) => {
    calls.push([command, args, options]);
    return { stdout: '' };
  };
  const head = await git(origin, 'rev-parse', 'main');
  assert.equal(
    await refreshInstall(install, 'main', run),
    `Rebuilt Witch at ${head.slice(0, 7)}, for its next start.`,
  );
  assert.equal(await git(install, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(calls, [
    [
      'pnpm',
      ['install', '--frozen-lockfile'],
      { cwd: install, timeout: 300_000 },
    ],
    ['pnpm', ['build'], { cwd: install, timeout: 300_000 }],
  ]);
  const kept = `Witch's checkout at ${install} isn't clean on main, so it wasn't rebuilt.`;
  await writeFile(join(install, 'a.txt'), 'changed\n');
  assert.equal(await refreshInstall(install, 'main', run), kept);
  await git(install, 'checkout', '--', 'a.txt');
  await git(install, 'switch', '-c', 'elsewhere');
  assert.equal(await refreshInstall(install, 'main', run), kept);
  assert.equal(calls.length, 2);
  assert.equal(await git(install, 'rev-parse', 'HEAD'), head);
});

await test("an edit made during the install's fetch keeps it from being pulled and built", async () => {
  const { root, origin, other } = await merged({ 'a.txt': 'a\n' });
  const install = join(root, 'install');
  await git(root, 'clone', origin, install);
  const head = await git(install, 'rev-parse', 'HEAD');
  await git(other, 'commit', '--allow-empty', '-m', 'ahead');
  await git(other, 'push');
  // runs in the fetch, as an edit from another terminal could
  const pack = join(root, 'upload-pack');
  await write(
    pack,
    `#!/bin/sh\necho edited > '${install}/a.txt'\nexec git upload-pack "$@"\n`,
  );
  await execute('chmod', ['+x', pack]);
  await git(install, 'config', 'remote.origin.uploadpack', pack);
  const calls: string[][] = [];
  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    return { stdout: '' };
  };
  assert.equal(
    await refreshInstall(install, 'main', run),
    `Witch's checkout at ${install} isn't clean on main, so it wasn't rebuilt.`,
  );
  assert.deepEqual(calls, []);
  assert.equal(await git(install, 'rev-parse', 'HEAD'), head);
});

await test("an ignored file the install's incoming commits would start tracking stops its rebuild before overwriting it", async () => {
  const { root, origin, other } = await merged({}, ['secret.txt']);
  const install = join(root, 'install');
  await git(root, 'clone', origin, install);
  const head = await git(install, 'rev-parse', 'HEAD');
  await writeFile(join(other, 'secret.txt'), 'theirs');
  await git(other, 'add', '-f', 'secret.txt');
  await git(other, 'commit', '-m', 'secret');
  await git(other, 'push');
  await writeFile(join(install, 'secret.txt'), 'mine');
  const calls: string[][] = [];
  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    return { stdout: '' };
  };
  await assert.rejects(refreshInstall(install, 'main', run));
  assert.equal(await readFile(join(install, 'secret.txt'), 'utf8'), 'mine');
  assert.deepEqual(calls, []);
  assert.equal(await git(install, 'rev-parse', 'HEAD'), head);
});

await test('the watch cleans up after each merged commit once, only on its branch, clean and idle', async () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const listeners = {
    repository: new Set<() => void>(),
    coordinator: new Set<() => void>(),
  };
  const status = (
    pullRequest?: PullRequest,
    fields: Partial<Repository> = {},
  ): Repository => ({
    branch: 'feat/x',
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    conflicts: 0,
    untracked: 0,
    pullRequest,
    ...fields,
  });
  const pr = (
    state: PullRequest['state'],
    commit: string,
    branch = 'feat/x',
  ): PullRequest => ({ ...pullRequest(commit), state, branch });
  const repository = {
    snapshot: undefined as Repository | undefined,
    subscribe: (listener: () => void) => {
      listeners.repository.add(listener);
      return () => listeners.repository.delete(listener);
    },
  };
  const calls: [PullRequest, string | undefined][] = [];
  let pending: PromiseWithResolvers<boolean> | undefined;
  const coordinator = {
    snapshot: { phase: 'idle', queue: [] } as unknown as Snapshot,
    subscribe: (listener: () => void) => {
      listeners.coordinator.add(listener);
      return () => listeners.coordinator.delete(listener);
    },
    // as operate does, the cleanup holds the phase until it settles
    cleanUpMerge: (merged: PullRequest, install?: string) => {
      calls.push([merged, install]);
      publishCoordinator({ phase: 'cleaning' });
      pending = Promise.withResolvers<boolean>();
      return pending.promise;
    },
  };
  const publishRepository = async (snapshot = repository.snapshot) => {
    repository.snapshot = snapshot;
    for (const listener of listeners.repository) listener();
    await tick();
  };
  function publishCoordinator(update: Partial<Snapshot>) {
    coordinator.snapshot = { ...coordinator.snapshot, ...update };
    for (const listener of listeners.coordinator) listener();
  }
  const publish = async (update: Partial<Snapshot> = {}) => {
    publishCoordinator(update);
    await tick();
  };
  const settle = async (value: boolean | Error) => {
    publishCoordinator({ phase: 'idle' });
    if (value instanceof Error) pending!.reject(value);
    else pending!.resolve(value);
    await tick();
  };
  const stop = watchMerges(repository, coordinator, '/install');
  await publishRepository(status(pr('OPEN', 'c1')));
  assert.equal(calls.length, 0, 'an open pull request');
  await publishRepository(status(pr('MERGED', 'c1'), { modified: 1 }));
  assert.equal(calls.length, 0, 'a modified checkout');
  await publishRepository(status(pr('MERGED', 'c1')));
  assert.deepEqual(calls, [[pr('MERGED', 'c1'), '/install']], 'a clean one');
  await publishRepository();
  await publish();
  assert.equal(calls.length, 1, 'publishes while the cleanup runs');
  await settle(true);
  await publishRepository();
  await publish();
  assert.equal(calls.length, 1, 'publishes after it acted');
  await publish({ phase: 'running' });
  await publishRepository(status(pr('MERGED', 'c2')));
  assert.equal(calls.length, 1, 'a turn running');
  await publish({ phase: 'idle', error: 'boom' });
  assert.equal(calls.length, 1, 'an error shown');
  await publish({ error: undefined, queue: ['queued'] });
  assert.equal(calls.length, 1, 'a queued prompt');
  await publish({ queue: [] });
  assert.equal(calls.length, 2, 'idle, with no error or queue');
  await settle(false);
  await publish();
  assert.equal(calls.length, 2, 'a coordinator publish after nothing was done');
  await publishRepository();
  assert.equal(calls.length, 3, 'the next status publish');
  await settle(new Error('failed'));
  await publishRepository();
  assert.equal(calls.length, 3, 'a status publish after a failure');
  await publishRepository(status(pr('MERGED', 'c3', 'feat/y')));
  assert.equal(calls.length, 3, "another branch's pull request");
  stop();
  await publishRepository(status(pr('MERGED', 'c4')));
  await publish();
  assert.equal(calls.length, 3, 'after the stop');
});
