import assert from 'node:assert/strict';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { cleanUpMerge } from '../../../src/core/repository/merged.js';
import type { MergeCleanup } from '../../../src/core/repository/merged.js';
import {
  branches,
  idle,
  merge,
  merged,
  pullRequest,
  write,
} from '../../fixtures/merged.js';
import { git } from '../../fixtures/git.js';
import { exists, until } from '../../fixtures/within.js';

// a developer's own git config would take part in the fixtures' switches and fetches
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const detached = {
  text: '#7 merged: detached at origin/main, deleted branch feat/x.',
  cleaned: true,
};

/** a post-checkout hook in the shared config, so it runs in the worktree's switch. */
async function hook(checkout: string, body: string) {
  const hooks = join(dirname(checkout), 'hooks');
  await git(checkout, 'config', 'core.hooksPath', hooks);
  await write(join(hooks, 'post-checkout'), `#!/bin/sh\n${body}\n`);
  await chmod(join(hooks, 'post-checkout'), 0o755);
}

test('a main checkout whose path contains a newline switches to its base after a merge', async () => {
  const { root, checkout, other, tip } = await merged();
  const renamed = join(root, 'check\nout');
  await rename(checkout, renamed);
  await merge(other, 'feat/x');
  const expected = await git(other, 'rev-parse', 'HEAD');
  const result = await cleanUpMerge(renamed, pullRequest(tip), idle);

  assert.deepEqual(result, {
    text: '#7 merged: switched to main and pulled, deleted branch feat/x.',
    cleaned: true,
  });

  assert.equal(await git(renamed, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.equal(await git(renamed, 'rev-parse', 'HEAD'), expected);
  assert.deepEqual(await branches(renamed), ['main']);
});

test("a merged branch in a worktree whose base another worktree holds detaches at the base's upstream and loses the branch", async () => {
  const { launcher, checkout, other, tip } = await merged({}, [], true);
  await merge(other, 'feat/x');
  const held = await git(launcher, 'rev-parse', 'HEAD');

  assert.deepEqual(
    await cleanUpMerge(checkout, pullRequest(tip), idle),
    detached,
  );

  await assert.rejects(git(checkout, 'symbolic-ref', '-q', 'HEAD'));

  assert.equal(
    await git(checkout, 'rev-parse', 'HEAD'),
    await git(other, 'rev-parse', 'HEAD'),
  );

  assert.deepEqual(await branches(checkout), ['main']);
  assert.equal(await git(launcher, 'branch', '--show-current'), 'main');
  assert.equal(await git(launcher, 'rev-parse', 'HEAD'), held);
});

test('a merged branch in a worktree detaches while the base is free, so the launcher can switch back to it', async () => {
  const { launcher, checkout, other, tip } = await merged({}, [], true);
  await git(launcher, 'switch', '-c', 'feat/y');
  await merge(other, 'feat/x');

  assert.deepEqual(
    await cleanUpMerge(checkout, pullRequest(tip), idle),
    detached,
  );

  await assert.rejects(git(checkout, 'symbolic-ref', '-q', 'HEAD'));
  await git(launcher, 'switch', 'main');
});

test('a main checkout whose base a linked worktree holds detaches and leaves that worktree alone', async () => {
  const { root, checkout, other, tip } = await merged();
  const holder = join(root, 'holder');
  await git(checkout, 'worktree', 'add', holder, 'main');
  const held = await git(holder, 'rev-parse', 'HEAD');
  await merge(other, 'feat/x');

  assert.deepEqual(
    await cleanUpMerge(checkout, pullRequest(tip), idle),
    detached,
  );

  assert.equal(
    await git(checkout, 'rev-parse', 'HEAD'),
    await git(other, 'rev-parse', 'HEAD'),
  );

  assert.equal(await git(holder, 'branch', '--show-current'), 'main');
  assert.equal(await git(holder, 'rev-parse', 'HEAD'), held);
});

test("a main checkout's cleanup interrupted before the detach keeps detaching on resume after the worktree lets go of the base", async () => {
  const { root, checkout, other, tip } = await merged();
  const holder = join(root, 'holder');
  await git(checkout, 'worktree', 'add', holder, 'main');
  await merge(other, 'feat/x');
  const controller = new AbortController();
  const progress: MergeCleanup = {};
  let checks = 0;

  // the second check comes after the fetches, right before the detach
  const blocked = async () => {
    if (++checks === 2) controller.abort();

    return false;
  };

  await assert.rejects(
    cleanUpMerge(checkout, pullRequest(tip), blocked, {
      signal: controller.signal,
      progress,
    }),
  );

  assert.equal(progress.moved, undefined);
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  const main = await git(checkout, 'rev-parse', 'main');
  await git(holder, 'switch', '--detach');

  assert.deepEqual(
    await cleanUpMerge(checkout, pullRequest(tip), idle, { progress }),
    detached,
  );

  await assert.rejects(git(checkout, 'symbolic-ref', '-q', 'HEAD'));

  assert.equal(
    await git(checkout, 'rev-parse', 'HEAD'),
    await git(other, 'rev-parse', 'HEAD'),
  );

  assert.equal(await git(checkout, 'rev-parse', 'main'), main);
});

for (const moved of [false, true])
  test(`a worktree cleanup interrupted right after the detach records the move and ${moved ? 'leaves a HEAD moved since alone' : 'finishes on resume'}`, async () => {
    const { root, checkout, other, tip } = await merged({}, [], true);
    await merge(other, 'feat/x');
    const entered = join(root, 'entered');
    // the hook runs once the detach has moved HEAD, and holds the switch there
    await hook(checkout, `touch '${entered}'\nsleep 30`);
    const controller = new AbortController();
    const progress: MergeCleanup = {};

    const first = cleanUpMerge(checkout, pullRequest(tip), idle, {
      signal: controller.signal,
      progress,
    });

    await until('the detach', () => exists(entered), 500);
    controller.abort();
    await assert.rejects(first);
    assert.equal(progress.moved, true);
    await git(checkout, 'config', '--unset', 'core.hooksPath');

    if (moved) {
      await git(checkout, 'switch', '--detach', 'HEAD~1');

      assert.equal(
        await cleanUpMerge(checkout, pullRequest(tip), idle, { progress }),
        'changed',
      );

      assert.deepEqual(await branches(checkout), ['feat/x', 'main']);
    } else {
      assert.deepEqual(
        await cleanUpMerge(checkout, pullRequest(tip), idle, { progress }),
        detached,
      );

      assert.deepEqual(await branches(checkout), ['main']);
    }
  });

for (const code of [0, 1])
  test(`a post-checkout hook that leaves a worktree on another branch at the target, exiting ${code}, stops the cleanup`, async () => {
    const { checkout, other, tip } = await merged({}, [], true);
    await merge(other, 'feat/x');

    await hook(
      checkout,
      `git -c core.hooksPath=/dev/null switch -q -c other\nexit ${code}`,
    );

    assert.equal(
      await cleanUpMerge(checkout, pullRequest(tip), idle),
      'changed',
    );

    assert.equal(await git(checkout, 'branch', '--show-current'), 'other');
    assert.ok((await branches(checkout)).includes('feat/x'));
  });

test("a worktree's detach whose post-checkout hook fails still finishes when HEAD is detached at the target", async () => {
  const { checkout, other, tip } = await merged({}, [], true);
  await merge(other, 'feat/x');
  await hook(checkout, 'exit 1');

  assert.deepEqual(
    await cleanUpMerge(checkout, pullRequest(tip), idle),
    detached,
  );

  assert.deepEqual(await branches(checkout), ['main']);
});

test("a worktree's detach that would overwrite an ignored file stops with git's error before moving", async () => {
  const { checkout, other, tip } = await merged({}, ['secret.txt'], true);
  await merge(other, 'feat/x');
  await writeFile(join(other, 'secret.txt'), 'theirs');
  await git(other, 'add', '-f', 'secret.txt');
  await git(other, 'commit', '-m', 'secret');
  await git(other, 'push', 'origin', 'main');
  await writeFile(join(checkout, 'secret.txt'), 'mine');

  await assert.rejects(cleanUpMerge(checkout, pullRequest(tip), idle), {
    message: /^#7 merged, but its cleanup failed before deleting feat\/x: /,
  });

  assert.equal(await readFile(join(checkout, 'secret.txt'), 'utf8'), 'mine');
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
});

/** the base tracks `upstream`, where a fork merged `feat/x`, so `origin/main` and `upstream/main` differ. */
async function upstreamMerged(files: Record<string, string> = {}) {
  const fixture = await merged(files, [], true);
  const { root, origin, checkout } = fixture;
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

  return { ...fixture, fork };
}

test("a worktree whose base tracks its own remote detaches at that remote's commit", async () => {
  const { checkout, fork, tip } = await upstreamMerged();

  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
    text: '#7 merged: detached at upstream/main, deleted branch feat/x.',
    cleaned: true,
  });

  assert.equal(
    await git(checkout, 'rev-parse', 'HEAD'),
    await git(fork, 'rev-parse', 'HEAD'),
  );

  assert.notEqual(
    await git(checkout, 'rev-parse', 'HEAD'),
    await git(checkout, 'rev-parse', 'origin/main'),
  );
});

for (const change of ['branch', 'edit'])
  test(`a ${change === 'branch' ? 'branch switched to' : 'edit made'} while a worktree fetches its base's own remote stops the cleanup`, async () => {
    const { root, checkout, tip } = await upstreamMerged({ 'a.txt': 'a\n' });
    await git(checkout, 'branch', 'feat/y', 'main');
    // runs in the upstream fetch, as another terminal could
    const pack = join(root, 'upload-pack');

    await write(
      pack,
      `#!/bin/sh\n${change === 'branch' ? `git -C '${checkout}' switch -q feat/y` : `echo edited > '${checkout}/a.txt'`}\nexec git upload-pack "$@"\n`,
    );

    await chmod(pack, 0o755);
    await git(checkout, 'config', 'remote.upstream.uploadpack', pack);

    assert.equal(
      await cleanUpMerge(checkout, pullRequest(tip), idle),
      'changed',
    );

    assert.ok((await branches(checkout)).includes('feat/x'));

    if (change === 'edit')
      assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  });

test("a worktree whose stacked base exists only on its remote detaches at the remote's commit", async () => {
  const { launcher, checkout, other, tip } = await merged({}, [], true);
  await git(launcher, 'push', 'origin', 'main:stack');
  await git(other, 'fetch');
  await git(other, 'switch', 'stack');
  await git(other, 'merge', '--no-ff', '-m', 'merge feat/x', 'origin/feat/x');
  await git(other, 'push', 'origin', 'stack');
  await git(other, 'push', 'origin', '--delete', 'feat/x');

  assert.deepEqual(
    await cleanUpMerge(checkout, { ...pullRequest(tip), base: 'stack' }, idle),
    {
      text: '#7 merged: detached at origin/stack, deleted branch feat/x.',
      cleaned: true,
    },
  );

  assert.equal(
    await git(checkout, 'rev-parse', 'HEAD'),
    await git(other, 'rev-parse', 'HEAD'),
  );

  assert.deepEqual(await branches(checkout), ['main']);
});
