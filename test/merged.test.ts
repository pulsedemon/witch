import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { quote } from '../src/shell.js';
import { runCommand } from '../src/core/command.js';
import { cleanUpMerge, refreshInstall } from '../src/core/merged.js';
import type { Run } from '../src/core/repository.js';
import { openLocked } from '../src/persistence/lock.js';
import { scratch } from './fixtures/scratch.js';
import {
  branches,
  exists,
  git,
  idle,
  merge,
  merged,
  pullRequest,
  write,
} from './fixtures/merged.js';
import { within } from './fixtures/within.js';

// a developer's own ssh command would take the place of the ssh test's stand-in
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.GIT_SSH;
delete process.env.GIT_SSH_COMMAND;

const execute = promisify(execFile);

const plans = (checkout: string) => join(checkout, 'docs/superpowers/plans');

test("a merged branch's checkout switches to the base, and loses the branch, its ignored plan and ledger, and the merged branches whose remote branch is gone", async () => {
  const { root, checkout, other, tip } = await merged();
  await git(checkout, 'switch', 'main');
  for (const name of ['feat/old', 'feat/live', 'feat/wt', 'feat/unmerged']) {
    await git(checkout, 'switch', '-c', name, 'main');
    await write(join(checkout, `${name.slice(5)}.txt`), name);
    await git(checkout, 'add', '.');
    await git(checkout, 'commit', '-m', name);
    await git(checkout, 'push', '-u', 'origin', name);
    if (name === 'feat/unmerged')
      await git(checkout, 'push', 'origin', '--delete', name);
    else await merge(other, name, name === 'feat/live');
    await git(checkout, 'switch', 'main');
  }
  const unmergedTip = await git(checkout, 'rev-parse', 'feat/unmerged');
  assert.equal(
    await git(
      checkout,
      'for-each-ref',
      '--format=%(upstream:track)',
      'refs/heads/feat/unmerged',
    ),
    '[gone]',
  );
  await assert.rejects(
    git(checkout, 'merge-base', '--is-ancestor', unmergedTip, 'origin/main'),
    { code: 1 },
  );
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
  // a stray file among the ledgers has no plan-path to read
  await write(join(checkout, '.superpowers/sdd/.DS_Store'), '');
  await merge(other, 'feat/x');
  const result = await cleanUpMerge(checkout, pullRequest(tip), idle);
  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
  assert.equal(
    await git(checkout, 'rev-parse', 'HEAD'),
    await git(other, 'rev-parse', 'origin/main'),
  );
  assert.deepEqual(await branches(checkout), [
    'feat/live',
    'feat/new',
    'feat/unmerged',
    'feat/wt',
    'main',
  ]);
  assert.equal(await git(checkout, 'rev-parse', 'feat/unmerged'), unmergedTip);
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
  assert.deepEqual((await readdir(join(checkout, '.superpowers/sdd'))).sort(), [
    '.DS_Store',
    'y',
  ]);
  assert.deepEqual(result, {
    text: '#7 merged: switched to main and pulled, deleted branches feat/x and feat/old, and plan x.md.',
    cleaned: true,
  });
});

test('a plan that also creates another branch stays whichever git command creates it, named or not, and one for the branch alone goes in any spelling', async () => {
  const { checkout, other, tip } = await merged();
  for (const [name, command] of [
    ['create.md', 'git switch --create feat/y'],
    ['force.md', 'git switch --force-create=feat/y'],
    ['checkout.md', 'git checkout -B feat/y'],
    ['lower.md', 'git checkout -b feat/y'],
    ['bundled.md', 'git checkout -qb feat/y'],
    ['quiet.md', 'git switch -qc feat/y'],
    ['worktree.md', 'git worktree add -b feat/y ../y'],
    ['path.md', 'git worktree add ../y -b feat/y'],
    ['dir.md', 'git -C ../y switch -c feat/y'],
    ['config.md', 'git -c advice.detachedHead=false switch -c feat/y'],
    ['space.md', 'git -C "../my y" switch -c feat/y'],
    ['gitdir.md', 'git --git-dir ../y/.git switch -c feat/y'],
    ['worktree-dir.md', 'git --work-tree ../y checkout -b feat/y'],
    ['continued.md', 'git checkout \\\n  -b feat/y'],
    ['track.md', 'git checkout --track -b feat/y origin/feat/y'],
    ['orphan.md', 'git switch --orphan feat/y'],
    ['checkout-orphan.md', 'git checkout --orphan feat/y'],
    ['short-track.md', 'git checkout -t origin/feat/y'],
    ['branch.md', 'git branch feat/y'],
    ['reset.md', 'git branch -f feat/y main'],
    ['copy.md', 'git branch -c feat/x feat/y'],
    ['move.md', 'git branch -m feat/x feat/y'],
    ['unnamed.md', 'git worktree add ../y'],
    ['remote.md', 'git checkout --track origin/feat/y'],
  ] as const)
    await write(
      join(plans(checkout), name),
      `\`git switch -c feat/x\`\n\nlater\n\n\`${command}\`\n`,
    );
  for (const [name, separator] of [
    ['semicolon.md', ';'],
    ['or.md', '||'],
  ] as const)
    await write(
      join(plans(checkout), name),
      `git switch -c feat/x ${separator} git switch -c feat/y\n`,
    );
  await write(
    join(plans(checkout), 'upper.md'),
    '```sh\ngit switch main && git pull --ff-only && git switch -C feat/x\ngit worktree add -fb feat/x ../x\n```\n\n`git branch --show-current` and `git branch -a` show it, and `git constructor x` is no command\n\nafter the merge\n\n`git branch -d feat/x`, since `git checkout -b` would fail\n',
  );
  await merge(other, 'feat/x');
  const result = await cleanUpMerge(checkout, pullRequest(tip), idle);
  assert.ok(typeof result === 'object');
  assert.deepEqual((await readdir(plans(checkout))).sort(), [
    'branch.md',
    'bundled.md',
    'checkout-orphan.md',
    'checkout.md',
    'config.md',
    'continued.md',
    'copy.md',
    'create.md',
    'dir.md',
    'force.md',
    'gitdir.md',
    'lower.md',
    'move.md',
    'or.md',
    'orphan.md',
    'path.md',
    'quiet.md',
    'remote.md',
    'reset.md',
    'semicolon.md',
    'short-track.md',
    'space.md',
    'track.md',
    'unnamed.md',
    'worktree-dir.md',
    'worktree.md',
  ]);
  assert.equal(
    result?.text,
    '#7 merged: switched to main and pulled, deleted branch feat/x, and plan upper.md.',
  );
});

test('a head branch still on its remote stays', async () => {
  const { checkout, other, tip } = await merged();
  await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`.\n');
  await merge(other, 'feat/x', true);
  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
    text: '#7 merged, but feat/x is still on its remote, so it stays.',
    cleaned: false,
  });
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  assert.ok(await exists(join(plans(checkout), 'x.md')));
});

test('a head branch that tracks no remote branch stays, and says so', async () => {
  const { checkout, other, tip } = await merged();
  await git(checkout, 'branch', '--unset-upstream');
  await merge(other, 'feat/x');
  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
    text: '#7 merged, but feat/x tracks no remote branch, so it stays.',
    cleaned: false,
  });
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
});

test('a head branch that tracks another branch stays, and says which', async () => {
  const { checkout, other, tip } = await merged();
  await git(checkout, 'branch', '--set-upstream-to=origin/main');
  await merge(other, 'feat/x');
  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
    text: '#7 merged, but feat/x tracks origin/main rather than its own remote branch, so it stays.',
    cleaned: false,
  });
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
});

test("a dangling plan link stays quietly, a plan that can't be read or go with its ledgers stays with them and is named, and so are plans that can't be listed, even when the base can't fast-forward", async () => {
  {
    const { checkout, other, tip } = await merged();
    await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`\n');
    await symlink('missing.md', join(plans(checkout), 'dangling.md'));
    await merge(other, 'feat/x');
    assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
      text: '#7 merged: switched to main and pulled, deleted branch feat/x, and plan x.md.',
      cleaned: true,
    });
    assert.deepEqual(await readdir(plans(checkout)), ['dangling.md']);
  }
  // the ledger can't be removed, the ledgers can't be listed, the plan-path can't be read, and the plan can't be read
  for (const [locked, mode, restored] of [
    ['.superpowers/sdd', 0o500, 0o700],
    ['.superpowers/sdd', 0o000, 0o700],
    ['.superpowers/sdd/x/plan-path', 0o000, 0o600],
    ['docs/superpowers/plans/x.md', 0o000, 0o600],
  ] as const) {
    const { checkout, other, tip } = await merged();
    await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`\n');
    const ledgers = join(checkout, '.superpowers/sdd');
    await write(join(ledgers, 'x/plan-path'), 'docs/superpowers/plans/x.md\n');
    await merge(other, 'feat/x');
    await chmod(join(checkout, locked), mode);
    const result = await cleanUpMerge(checkout, pullRequest(tip), idle).finally(
      () => chmod(join(checkout, locked), restored),
    );
    assert.ok(typeof result === 'object');
    assert.ok(
      result?.text.startsWith(
        '#7 merged: switched to main and pulled, deleted branch feat/x, but plan x.md stayed: EACCES',
      ),
      result?.text,
    );
    assert.deepEqual(await readdir(plans(checkout)), ['x.md']);
    assert.deepEqual(await readdir(ledgers), ['x']);
    assert.equal(
      await git(checkout, 'rev-parse', 'HEAD'),
      await git(other, 'rev-parse', 'origin/main'),
    );
  }
  // the plan can't be removed, and the plans can't be listed
  for (const [mode, stayed] of [
    [0o500, 'plan x.md'],
    [0o000, 'plans'],
  ] as const) {
    const { checkout, other, tip } = await merged();
    await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`\n');
    await merge(other, 'feat/x');
    await chmod(plans(checkout), mode);
    const result = await cleanUpMerge(checkout, pullRequest(tip), idle).finally(
      () => chmod(plans(checkout), 0o700),
    );
    assert.ok(typeof result === 'object');
    assert.ok(
      result?.text.startsWith(
        `#7 merged: switched to main and pulled, deleted branch feat/x, but ${stayed} stayed: EACCES`,
      ),
      result?.text,
    );
    assert.deepEqual(await readdir(plans(checkout)), ['x.md']);
  }
  {
    const { checkout, other, tip } = await merged();
    for (const name of ['a', 'b', 'c'])
      await write(
        join(plans(checkout), `${name}.md`),
        '`git switch -c feat/x`\n',
      );
    const ledgers = join(checkout, '.superpowers/sdd');
    for (const name of ['a', 'b'])
      await write(
        join(ledgers, `${name}/plan-path`),
        `docs/superpowers/plans/${name}.md\n`,
      );
    await merge(other, 'feat/x');
    await chmod(ledgers, 0o500);
    const result = await cleanUpMerge(checkout, pullRequest(tip), idle).finally(
      () => chmod(ledgers, 0o700),
    );
    assert.ok(typeof result === 'object');
    assert.match(
      result?.text ?? '',
      /^#7 merged: switched to main and pulled, deleted branch feat\/x, and plan c\.md, but plans (a\.md and b\.md|b\.md and a\.md) stayed: EACCES/,
    );
    assert.deepEqual((await readdir(plans(checkout))).sort(), ['a.md', 'b.md']);
  }
  {
    const { checkout, other, tip } = await merged();
    await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`\n');
    const ledgers = join(checkout, '.superpowers/sdd');
    await write(join(ledgers, 'x/plan-path'), 'docs/superpowers/plans/x.md\n');
    // a commit only the checkout's main has, so main can't fast-forward
    await git(checkout, 'switch', 'main');
    await git(checkout, 'commit', '--allow-empty', '-m', 'local');
    await git(checkout, 'switch', 'feat/x');
    await merge(other, 'feat/x');
    await chmod(ledgers, 0o500);
    await assert.rejects(
      cleanUpMerge(checkout, pullRequest(tip), idle).finally(() =>
        chmod(ledgers, 0o700),
      ),
      (error) => {
        const message = (error as Error).message;
        assert.ok(
          message.startsWith(
            '#7 merged: switched to main and deleted branch feat/x (plan x.md stayed: EACCES',
          ),
          message,
        );
        assert.ok(
          message.includes("), but main didn't fast-forward: "),
          message,
        );
        return true;
      },
    );
  }
});

test('a plan whose ignore check fails stays, and is named', async () => {
  const { root, checkout, other, tip } = await merged();
  // git won't check a path beyond a symbolic link
  const outside = join(root, 'outside');
  await write(join(outside, 'x.md'), '`git switch -c feat/x`\n');
  await mkdir(join(checkout, 'docs/superpowers'), { recursive: true });
  await symlink(outside, plans(checkout));
  await merge(other, 'feat/x');
  const result = await cleanUpMerge(checkout, pullRequest(tip), idle);
  assert.ok(typeof result === 'object');
  assert.match(
    result.text,
    /^#7 merged: switched to main and pulled, deleted branch feat\/x, but plan x\.md stayed: Command failed: git check-ignore .*beyond a symbolic link\.$/s,
  );
  assert.deepEqual(await readdir(outside), ['x.md']);
});

test('a ledger the repository tracks stays when its plan goes', async () => {
  const { checkout, other, tip } = await merged({
    '.gitignore': 'docs/superpowers/\n',
    '.superpowers/sdd/x/plan-path': 'docs/superpowers/plans/x.md\n',
  });
  await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`\n');
  await merge(other, 'feat/x');
  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
    text: '#7 merged: switched to main and pulled, deleted branch feat/x, and plan x.md.',
    cleaned: true,
  });
  assert.ok(await exists(join(checkout, '.superpowers/sdd/x/plan-path')));
  assert.equal(await git(checkout, 'status', '--porcelain'), '');
});

test("a squash merge's branch goes too", async () => {
  const { checkout, other, tip } = await merged();
  await git(other, 'pull');
  await git(other, 'merge', '--squash', 'origin/feat/x');
  await git(other, 'commit', '-m', 'squash');
  await git(other, 'push', 'origin', 'main');
  await git(other, 'push', 'origin', '--delete', 'feat/x');
  await cleanUpMerge(checkout, pullRequest(tip), idle);
  assert.deepEqual(await branches(checkout), ['main']);
  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
  assert.equal(
    await git(checkout, 'rev-parse', 'HEAD'),
    await git(other, 'rev-parse', 'origin/main'),
  );
});

test("a branch whose last commit isn't the merged one stays, and so does everything else", async () => {
  const { checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`.\n');
  await git(checkout, 'commit', '--allow-empty', '-m', 'after');
  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
    text: "#7 merged, but feat/x's last commit isn't the one it merged, so it stays.",
    cleaned: false,
  });
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  assert.ok(await exists(join(plans(checkout), 'x.md')));
});

test('a checkout that changed since the watch looked is left alone', async () => {
  const { checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`.\n');
  await writeFile(join(checkout, 'x.txt'), 'changed\n');
  assert.equal(await cleanUpMerge(checkout, pullRequest(tip), idle), 'changed');
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  assert.equal(await readFile(join(checkout, 'x.txt'), 'utf8'), 'changed\n');
  assert.deepEqual(await branches(checkout), ['feat/x', 'main']);
  assert.ok(await exists(join(plans(checkout), 'x.md')));
  await git(checkout, 'checkout', '--', 'x.txt');
  await git(checkout, 'switch', 'main');
  assert.equal(await cleanUpMerge(checkout, pullRequest(tip), idle), 'changed');
  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
  assert.deepEqual(await branches(checkout), ['feat/x', 'main']);
  assert.ok(await exists(join(plans(checkout), 'x.md')));
});

test('a checkout with a staged or conflicted change is left alone, and one with only an untracked file is not', async () => {
  for (const change of ['staged', 'conflicted'] as const) {
    const { checkout, other, tip } = await merged();
    await merge(other, 'feat/x');
    await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`.\n');
    if (change === 'staged') {
      await writeFile(join(checkout, 's.txt'), 's\n');
      await git(checkout, 'add', 's.txt');
    } else {
      // a commit that adds x.txt too, so merging it conflicts while the branch stays at the merged commit
      await git(checkout, 'switch', '--detach', 'main');
      await writeFile(join(checkout, 'x.txt'), 'side\n');
      await git(checkout, 'add', 'x.txt');
      await git(checkout, 'commit', '-m', 'side');
      const side = await git(checkout, 'rev-parse', 'HEAD');
      await git(checkout, 'switch', 'feat/x');
      await assert.rejects(git(checkout, 'merge', side));
    }
    assert.equal(
      await cleanUpMerge(checkout, pullRequest(tip), idle),
      'changed',
      change,
    );
    assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
    assert.deepEqual(await branches(checkout), ['feat/x', 'main']);
    assert.ok(await exists(join(plans(checkout), 'x.md')));
  }
  const { checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  await writeFile(join(checkout, 'notes.txt'), 'notes\n');
  const result = await cleanUpMerge(checkout, pullRequest(tip), idle);
  assert.ok(typeof result === 'object');
  assert.equal(result.cleaned, true);
  assert.deepEqual(await branches(checkout), ['main']);
  assert.equal(await readFile(join(checkout, 'notes.txt'), 'utf8'), 'notes\n');
});

test('an ignored file the base or the merge would start tracking stops the cleanup before overwriting it', async () => {
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
    await assert.rejects(cleanUpMerge(checkout, pullRequest(tip), idle));
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
    await assert.rejects(
      cleanUpMerge(checkout, pullRequest(tip), idle),
      (error) => {
        const message = (error as Error).message;
        assert.ok(
          message.startsWith(
            '#7 merged: switched to main and deleted branch feat/x',
          ),
          message,
        );
        assert.ok(message.trim().endsWith('Aborting'), message);
        return true;
      },
    );
    assert.equal(await readFile(join(checkout, 'secret.txt'), 'utf8'), 'mine');
    assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
  }
});

test('of two cleanups in one checkout at once, one cleans up and the other does nothing', async () => {
  const { checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  const results = await Promise.all([
    cleanUpMerge(checkout, pullRequest(tip), idle),
    cleanUpMerge(checkout, pullRequest(tip), idle),
  ]);
  assert.deepEqual(
    results.filter((result) => typeof result === 'object'),
    [
      {
        text: '#7 merged: switched to main and pulled, deleted branch feat/x.',
        cleaned: true,
      },
    ],
  );
  assert.deepEqual(await branches(checkout), ['main']);
});

test('a cleanup that fails before deleting the branch says which merge it was for', async () => {
  const { root, checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  const bin = join(root, 'bin');
  const realGit = (await execute('/usr/bin/which', ['git'])).stdout.trim();
  const previousPath = process.env.PATH;
  await write(
    join(bin, 'git'),
    `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.join(' ') === 'rev-parse --absolute-git-dir') {
  process.stderr.write('injected lock lookup failure');
  process.exit(23);
}
process.exit(spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }).status ?? 1);
`,
  );
  await chmod(join(bin, 'git'), 0o755);
  for (const mode of ['lookup', 'open']) {
    if (mode === 'lookup') process.env.PATH = `${bin}:${previousPath}`;
    else await chmod(join(checkout, '.git'), 0o111);
    try {
      await assert.rejects(
        cleanUpMerge(checkout, pullRequest(tip), idle),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(
            error.message.startsWith(
              '#7 merged, but its cleanup failed while locking feat/x:',
            ),
          );
          assert.match(
            error.message,
            mode === 'lookup' ? /injected lock lookup failure/ : /EACCES/,
          );
          assert.equal(
            (error.cause as { code: unknown }).code,
            mode === 'lookup' ? 23 : 'EACCES',
          );
          return true;
        },
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await chmod(join(checkout, '.git'), 0o755);
    }
    assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
    assert.deepEqual(await branches(checkout), ['feat/x', 'main']);
    assert.equal(await git(checkout, 'rev-parse', 'HEAD'), tip);
  }
  await git(checkout, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
  await assert.rejects(cleanUpMerge(checkout, pullRequest(tip), idle), {
    message:
      /^#7 merged, but its cleanup failed before deleting feat\/x: Command failed: git .*fetch --prune/,
  });
  const reacquired = await openLocked(
    join(checkout, '.git'),
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  await reacquired.close();
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
});

test('a cleanup failure after branch deletion reports the completed work', async () => {
  const realGit = (await execute('/usr/bin/which', ['git'])).stdout.trim();
  const previousPath = process.env.PATH;
  for (const mode of ['plans', 'siblings']) {
    const { root, checkout, other, tip } = await merged();
    const before = await git(checkout, 'rev-parse', 'main');
    await merge(other, 'feat/x');
    const after = await git(other, 'rev-parse', 'main');
    const unreadable = join(plans(checkout), 'unreadable.md');
    if (mode === 'plans')
      await writeFile(join(checkout, '.git/config.lock'), '');
    else {
      await write(join(plans(checkout), 'removed.md'), 'git switch -c feat/x');
      await write(unreadable, 'git switch -c feat/x');
      await chmod(unreadable, 0o000);
    }
    const bin = join(root, 'bin');
    await write(
      join(bin, 'git'),
      `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (${JSON.stringify(mode)} === 'plans' ? args.join(' ') === 'rev-parse --show-toplevel' : args[0] === 'for-each-ref' && args.includes('--merged')) {
  process.stderr.write('injected ${mode} failure');
  process.exit(23);
}
process.exit(spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }).status ?? 1);
`,
    );
    await chmod(join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      await assert.rejects(
        cleanUpMerge(checkout, pullRequest(tip), idle),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /injected .* failure/);
          if (mode === 'plans') {
            assert.ok(
              error.message.startsWith(
                '#7 merged: switched to main and deleted branch feat/x',
              ),
            );
            assert.match(
              error.message,
              /config section branch\.feat\/x stayed:/,
            );
            assert.match(error.message, /but could not locate its plans:/);
            assert.doesNotMatch(error.message, /and pulled/);
          } else {
            assert.ok(
              error.message.startsWith(
                '#7 merged: switched to main and pulled, deleted branch feat/x, and plan removed.md',
              ),
            );
            assert.match(error.message, /plan unreadable\.md stayed: EACCES/);
            assert.match(
              error.message,
              /but could not list other merged branches:/,
            );
          }
          assert.equal((error.cause as { code: unknown }).code, 23);
          return true;
        },
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (mode === 'siblings') await chmod(unreadable, 0o644);
    }
    assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
    assert.deepEqual(await branches(checkout), ['main']);
    assert.equal(
      await git(checkout, 'rev-parse', 'HEAD'),
      mode === 'plans' ? before : after,
    );
    if (mode === 'siblings') {
      await assert.rejects(readFile(join(plans(checkout), 'removed.md')), {
        code: 'ENOENT',
      });
      assert.equal(await readFile(unreadable, 'utf8'), 'git switch -c feat/x');
    }
  }
});

test('a branch committed to after the tip check stays, and so does its plan', async () => {
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
  await assert.rejects(
    cleanUpMerge(checkout, pullRequest(tip), idle),
    (error) => {
      const message = (error as Error).message;
      assert.ok(
        message.startsWith(
          "#7 merged: switched to main, but feat/x wasn't deleted",
        ),
        message,
      );
      return true;
    },
  );
  assert.equal(await git(checkout, 'rev-parse', 'feat/x^'), tip);
  assert.ok(await exists(join(plans(checkout), 'x.md')));
});

test("a merged branch's config section that can't be removed is named, and the rest of the cleanup goes on", async () => {
  const { checkout, other, tip } = await merged();
  await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`.\n');
  await merge(other, 'feat/x');
  // as another git command holding the config's lock leaves it
  await writeFile(join(checkout, '.git/config.lock'), '');
  const result = await cleanUpMerge(checkout, pullRequest(tip), idle);
  assert.ok(typeof result === 'object');
  assert.match(
    result.text,
    /^#7 merged: switched to main and pulled, deleted branch feat\/x, and plan x\.md, but config section branch\.feat\/x stayed: .*could not lock config file/s,
  );
  assert.equal(
    await git(checkout, 'config', 'branch.feat/x.merge'),
    'refs/heads/feat/x',
  );
  assert.deepEqual(await branches(checkout), ['main']);
  assert.equal(
    await git(checkout, 'rev-parse', 'HEAD'),
    await git(other, 'rev-parse', 'origin/main'),
  );
});

test('a switch whose post-checkout hook fails after moving the checkout still finishes the cleanup', async () => {
  const { checkout, other, tip } = await merged();
  await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`.\n');
  await merge(other, 'feat/x');
  const hooks = join(checkout, '.git/hooks');
  await git(checkout, 'config', 'core.hooksPath', hooks);
  await write(join(hooks, 'post-checkout'), '#!/bin/sh\nexit 1\n');
  await execute('chmod', ['+x', join(hooks, 'post-checkout')]);
  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
    text: '#7 merged: switched to main and pulled, deleted branch feat/x, and plan x.md.',
    cleaned: true,
  });
  assert.deepEqual(await branches(checkout), ['main']);
});

test('a base and a merged branch named like options are switched to and deleted', async () => {
  const { checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  await git(other, 'push', 'origin', 'main:refs/heads/-base');
  await git(checkout, 'fetch');
  // git's porcelain won't name a branch this way, but update-ref will
  await git(checkout, 'update-ref', 'refs/heads/-base', 'origin/-base');
  await git(checkout, 'update-ref', 'refs/heads/-old', 'main');
  for (const name of ['-base', '-old']) {
    await git(checkout, 'config', `branch.${name}.remote`, 'origin');
    await git(checkout, 'config', `branch.${name}.merge`, `refs/heads/${name}`);
  }
  assert.deepEqual(
    await cleanUpMerge(checkout, { ...pullRequest(tip), base: '-base' }, idle),
    {
      text: '#7 merged: switched to -base and pulled, deleted branches feat/x and -old.',
      cleaned: true,
    },
  );
  assert.equal(await git(checkout, 'branch', '--show-current'), '-base');
  assert.deepEqual(await branches(checkout), ['-base', 'main']);
});

test("another merged branch's config section that branch -d leaves is named", async () => {
  const { checkout, other, tip } = await merged();
  await git(checkout, 'switch', '-c', 'feat/old', 'main');
  await git(checkout, 'commit', '--allow-empty', '-m', 'old');
  await git(checkout, 'push', '-u', 'origin', 'feat/old');
  await merge(other, 'feat/old');
  await git(checkout, 'switch', 'feat/x');
  await merge(other, 'feat/x');
  // runs after the fast-forward, so only the other branches meet the locked config
  const hooks = join(checkout, '.git/hooks');
  await git(checkout, 'config', 'core.hooksPath', hooks);
  await write(
    join(hooks, 'post-merge'),
    `#!/bin/sh\ntouch '${join(checkout, '.git/config.lock')}'\n`,
  );
  await execute('chmod', ['+x', join(hooks, 'post-merge')]);
  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
    text: '#7 merged: switched to main and pulled, deleted branches feat/x and feat/old, but config section branch.feat/old stayed.',
    cleaned: true,
  });
  assert.deepEqual(await branches(checkout), ['main']);
});

test('a merged branch that cannot be deleted stays named with its error while other branches go', async () => {
  const { checkout, other, tip } = await merged();
  for (const name of ['feat/blocked', 'feat/later']) {
    await git(checkout, 'switch', '-c', name, 'main');
    await git(checkout, 'commit', '--allow-empty', '-m', name);
    await git(checkout, 'push', '-u', 'origin', name);
    await merge(other, name);
  }
  await git(checkout, 'switch', 'feat/x');
  await merge(other, 'feat/x');
  await write(join(checkout, '.git/refs/heads/feat/blocked.lock'), '');
  const result = await cleanUpMerge(checkout, pullRequest(tip), idle);
  assert.ok(typeof result === 'object');
  assert.deepEqual(await branches(checkout), ['feat/blocked', 'main']);
  assert.equal(result?.cleaned, true);
  assert.match(
    result.text,
    /^#7 merged: switched to main and pulled, deleted branches feat\/x and feat\/later, but branch feat\/blocked stayed: Command failed: git branch -d --end-of-options feat\/blocked\n/,
  );
  assert.match(result.text, /feat\/blocked\.lock.*File exists/);
});

test('a base that tracks another remote is brought up to date from it', async () => {
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
  const result = await cleanUpMerge(checkout, pullRequest(tip), idle);
  assert.equal(
    await git(checkout, 'rev-parse', 'HEAD'),
    await git(fork, 'rev-parse', 'HEAD'),
  );
  assert.deepEqual(result, {
    text: '#7 merged: switched to main and pulled, deleted branch feat/x.',
    cleaned: true,
  });
});

test("the cleanup fetches through the user's own ssh command, from git's config or GIT_SSH, and through ssh in batch mode otherwise", async () => {
  for (const own of ['config', 'environment', undefined] as const) {
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
    // simple, or git would first probe the stand-in with -G
    if (own) await git(checkout, 'config', 'ssh.variant', 'simple');
    if (own === 'config') await git(checkout, 'config', 'core.sshCommand', ssh);
    else if (own) process.env.GIT_SSH = ssh;
    else process.env.PATH = `${dirname(ssh)}:${path}`;
    try {
      const result = await cleanUpMerge(checkout, pullRequest(tip), idle);
      assert.ok(typeof result === 'object');
      assert.equal(result.cleaned, true);
    } finally {
      process.env.PATH = path;
      delete process.env.GIT_SSH;
    }
    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    assert.equal(calls.length, 2);
    for (const call of calls)
      assert.ok(call.startsWith(own ? 'x.test ' : '-o BatchMode=yes '), call);
  }
});

test('a branch switched to during the base fetch is left as it was, and the cleanup stops', async () => {
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
  await assert.rejects(cleanUpMerge(checkout, pullRequest(tip), idle), {
    message:
      "#7 merged: switched to main and deleted branch feat/x, but main didn't fast-forward: the checkout left main or changed during the fetch",
  });
  assert.equal(await git(checkout, 'rev-parse', 'feat/y'), before);
});

test('an edit made during the base fetch stops the cleanup before the fast-forward', async () => {
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
  await assert.rejects(cleanUpMerge(checkout, pullRequest(tip), idle), {
    message:
      "#7 merged: switched to main and deleted branch feat/x, but main didn't fast-forward: the checkout left main or changed during the fetch",
  });
  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), before);
  assert.equal(await readFile(join(checkout, 'a.txt'), 'utf8'), 'edited\n');
});

test('the install pulls, installs and builds when clean on the base, and stays put otherwise', async () => {
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
  await git(install, 'switch', 'main');
  assert.equal(
    await refreshInstall(install, 'main', run),
    `Rebuilt Witch at ${head.slice(0, 7)}, for its next start.`,
  );
  assert.deepEqual(calls.slice(2), [
    [
      'pnpm',
      ['install', '--frozen-lockfile'],
      { cwd: install, timeout: 300_000 },
    ],
    ['pnpm', ['build'], { cwd: install, timeout: 300_000 }],
  ]);
});

test('a busy install is skipped before fetching', async () => {
  const { root, origin } = await merged();
  const install = join(root, 'install');
  await git(root, 'clone', origin, install);
  const fetchMarker = join(root, 'fetches');
  const pack = join(root, 'upload-pack');
  await write(
    pack,
    `#!/bin/sh\nprintf 'fetch\\n' >> '${fetchMarker}'\nexec git upload-pack "$@"\n`,
  );
  await chmod(pack, 0o755);
  await git(install, 'config', 'remote.origin.uploadpack', pack);
  const lock = await openLocked(
    join(install, '.git'),
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  const calls: string[][] = [];
  try {
    const result = await within(
      refreshInstall(install, 'main', async (_, args) => {
        calls.push(args);
        return { stdout: '' };
      }),
      5000,
      'the busy install',
    );
    assert.equal(
      result,
      `Witch's checkout at ${install} is busy, so it wasn't rebuilt.`,
    );
    assert.deepEqual(calls, []);
    assert.equal(await exists(fetchMarker), false);
  } finally {
    await lock.close();
  }
});

test('an install stays locked through install and build, aliases share it, and another install can refresh', async () => {
  const { root, origin } = await merged();
  const install = join(root, 'install');
  const independent = join(root, 'independent');
  const alias = join(root, 'alias');
  await git(root, 'clone', origin, install);
  await git(root, 'clone', origin, independent);
  await symlink(install, alias);
  const head = await git(origin, 'rev-parse', 'main');
  const rebuilt = `Rebuilt Witch at ${head.slice(0, 7)}, for its next start.`;
  const request = { ...pullRequest(head), branch: 'main' };
  const gates = {
    install: {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    },
    build: {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    },
  };
  const refreshing = refreshInstall(install, 'main', async (_, args) => {
    const gate = args[0] === 'install' ? gates.install : gates.build;
    gate.entered.resolve();
    await gate.release.promise;
    return { stdout: '' };
  });
  void refreshing.catch(() => {});
  const calls: string[][] = [];
  const run: Run = async (_, args) => {
    calls.push(args);
    return { stdout: '' };
  };
  try {
    for (const [stage, target] of [
      ['install', alias],
      ['build', install],
    ] as const) {
      await within(gates[stage].entered.promise, 5000, `the held ${stage}`);
      assert.equal(
        await within(
          refreshInstall(target, 'main', run),
          5000,
          'the contender',
        ),
        `Witch's checkout at ${target} is busy, so it wasn't rebuilt.`,
      );
      assert.deepEqual(calls, []);
      if (stage === 'install') {
        assert.equal(await cleanUpMerge(install, request, idle), undefined);
        const independentCalls: string[][] = [];
        assert.equal(
          await within(
            refreshInstall(independent, 'main', async (_, args) => {
              independentCalls.push(args);
              return { stdout: '' };
            }),
            5000,
            'the independent install',
          ),
          rebuilt,
        );
        assert.equal(await git(independent, 'rev-parse', 'HEAD'), head);
        assert.deepEqual(independentCalls, [
          ['install', '--frozen-lockfile'],
          ['build'],
        ]);
      }
      gates[stage].release.resolve();
    }
    assert.equal(await refreshing, rebuilt);
    assert.deepEqual(await cleanUpMerge(install, request, idle), {
      text: '#7 merged, but main is still on its remote, so it stays.',
      cleaned: false,
    });
    assert.equal(await refreshInstall(install, 'main', run), rebuilt);
    assert.deepEqual(calls, [['install', '--frozen-lockfile'], ['build']]);
  } finally {
    gates.install.release.resolve();
    gates.build.release.resolve();
    await refreshing;
  }
});

test('an install stays locked through revision reporting and releases on success or failure', async () => {
  const { root, origin } = await merged();
  const install = join(root, 'install');
  await git(root, 'clone', origin, install);
  const head = await git(origin, 'rev-parse', '--short', 'main');
  const directory = join(install, '.git');
  const marker = join(root, 'revision-lock');
  const bin = join(root, 'bin');
  const realGit = (await execute('/usr/bin/which', ['git'])).stdout.trim();
  const previousPath = process.env.PATH;
  for (const failing of [false, true]) {
    await write(
      join(bin, 'git'),
      `#!/bin/sh
exec ${[
        process.execPath,
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('fixtures/revision-lock.mts', import.meta.url)),
        directory,
        marker,
        realGit,
        String(failing),
      ]
        .map(quote)
        .join(' ')} "$@"
`,
    );
    await chmod(join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const result = refreshInstall(install, 'main', async () => ({
        stdout: '',
      }));
      if (failing)
        await assert.rejects(result, (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(
            error.message.startsWith(
              `Witch's checkout at ${install} wasn't rebuilt:`,
            ),
          );
          assert.match(error.message, /revision unavailable/);
          assert.equal((error.cause as { code: number }).code, 23);
          return true;
        });
      else
        assert.equal(
          await result,
          `Rebuilt Witch at ${head}, for its next start.`,
        );
      assert.equal(await readFile(marker, 'utf8'), 'EAGAIN');
      const lock = await openLocked(
        directory,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      await lock.close();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }
});

test('an install lock lookup failure keeps the install context', async () => {
  const install = await scratch('witch-invalid-install-');
  const calls: string[][] = [];
  await assert.rejects(
    refreshInstall(install, 'main', async (_, args) => {
      calls.push(args);
      return { stdout: '' };
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.startsWith(
          `Witch's checkout at ${install} wasn't rebuilt:`,
        ),
      );
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test('an install lock open failure keeps its cause and install context', async () => {
  const { root, origin } = await merged();
  const install = join(root, 'install');
  await git(root, 'clone', origin, install);
  const directory = join(install, '.git');
  const calls: string[][] = [];
  await chmod(directory, 0o111);
  try {
    await assert.rejects(
      refreshInstall(install, 'main', async (_, args) => {
        calls.push(args);
        return { stdout: '' };
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(
          error.message.startsWith(
            `Witch's checkout at ${install} wasn't rebuilt:`,
          ),
        );
        assert.equal((error.cause as NodeJS.ErrnoException).code, 'EACCES');
        return true;
      },
    );
    assert.deepEqual(calls, []);
  } finally {
    await chmod(directory, 0o755);
  }
});

test("a failed rebuild names the install and keeps tsc's errors", async () => {
  const { root, origin } = await merged();
  const install = join(root, 'install');
  await git(root, 'clone', origin, install);
  const run = async (_: string, args: string[]) => {
    if (args[0] !== 'build') return { stdout: '' };
    // as execFile rejects, with the command's stdout beside the message
    throw Object.assign(new Error('Command failed: pnpm build\n'), {
      stdout:
        "src/a.ts(1,7): error TS2322: Type 'number' is not assignable to type 'string'.\n",
    });
  };
  await assert.rejects(refreshInstall(install, 'main', run), {
    message: `Witch's checkout at ${install} wasn't rebuilt: Command failed: pnpm build\nsrc/a.ts(1,7): error TS2322: Type 'number' is not assignable to type 'string'.`,
  });
  await assert.rejects(
    refreshInstall(install, 'main', (_, args, options) =>
      args[0] === 'build'
        ? runCommand(
            process.execPath,
            [
              '-e',
              "process.stdout.write('build stdout'); process.stderr.write('build stderr'); setTimeout(() => process.exit(29), 10000)",
            ],
            { ...options, timeout: 1500 },
          )
        : Promise.resolve({ stdout: '' }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.startsWith(
          `Witch's checkout at ${install} wasn't rebuilt: Timed out after 1500 ms: Command failed:`,
        ),
      );
      assert.match(error.message, /build stderr\nbuild stdout$/);
      assert.equal((error.cause as { killed: boolean }).killed, true);
      return true;
    },
  );
  const head = await git(origin, 'rev-parse', 'main');
  const calls: string[][] = [];
  assert.equal(
    await refreshInstall(install, 'main', async (_, args) => {
      calls.push(args);
      return { stdout: '' };
    }),
    `Rebuilt Witch at ${head.slice(0, 7)}, for its next start.`,
  );
  assert.deepEqual(calls, [['install', '--frozen-lockfile'], ['build']]);
});

test("an edit made during the install's fetch keeps it from being pulled and built", async () => {
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

test('a branch switched to during the install fetch is left as it was and skips rebuilding', async () => {
  const { root, origin, other } = await merged();
  const install = join(root, 'install');
  await git(root, 'clone', origin, install);
  await git(install, 'branch', '--track', 'elsewhere', 'origin/main');
  const before = await git(install, 'rev-parse', 'HEAD');
  await git(other, 'commit', '--allow-empty', '-m', 'ahead');
  await git(other, 'push');
  const pack = join(root, 'upload-pack');
  await write(
    pack,
    `#!/bin/sh\ngit -C ${quote(install)} switch -q elsewhere\nexec git upload-pack "$@"\n`,
  );
  await chmod(pack, 0o755);
  await git(install, 'config', 'remote.origin.uploadpack', pack);
  const calls: string[][] = [];
  const result = await refreshInstall(
    install,
    'main',
    async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: '' };
    },
  );
  assert.equal(
    result,
    `Witch's checkout at ${install} isn't clean on main, so it wasn't rebuilt.`,
  );
  assert.deepEqual(calls, []);
  assert.equal(await git(install, 'branch', '--show-current'), 'elsewhere');
  for (const ref of ['HEAD', 'main'])
    assert.equal(await git(install, 'rev-parse', ref), before);
});

test("an ignored file the install's incoming commits would start tracking stops its rebuild before overwriting it", async () => {
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
