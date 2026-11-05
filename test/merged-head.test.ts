import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { cleanUpMerge } from '../src/core/merged.js';
import { quote } from '../src/shell.js';
import {
  branches,
  idle,
  merge,
  merged,
  pullRequest,
  write,
} from './fixtures/merged.js';
import { git } from './fixtures/git.js';
import { exists, within } from './fixtures/within.js';

// a developer's own git config would take part in the fixtures' switches and fetches
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const execute = promisify(execFile);

const plans = (checkout: string) => join(checkout, 'docs/superpowers/plans');

test('a head branch still on its remote once GitHub would have deleted it stays', async () => {
  const { checkout, other, tip } = await merged();
  await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`.\n');
  await merge(other, 'feat/x', true);
  // close enough to the end of the wait for one more fetch
  const mergedAt = new Date(Date.now() - 14_000).toISOString();
  assert.deepEqual(
    await cleanUpMerge(checkout, { ...pullRequest(tip), mergedAt }, idle),
    {
      text: '#7 merged, but feat/x is still on its remote, so it stays.',
      cleaned: false,
    },
  );
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  assert.ok(await exists(join(plans(checkout), 'x.md')));
});

test('a head branch GitHub deletes after the first fetch goes', async () => {
  const { root, origin, checkout, other, tip } = await merged();
  await merge(other, 'feat/x', true);
  const pack = join(root, 'upload-pack');
  const fetched = join(root, 'fetched');
  await write(
    pack,
    `#!/bin/sh\nif [ -e '${fetched}' ]; then git -C '${origin}' update-ref -d refs/heads/feat/x; fi\ntouch '${fetched}'\nexec git upload-pack "$@"\n`,
  );
  await execute('chmod', ['+x', pack]);
  await git(checkout, 'config', 'remote.origin.uploadpack', pack);
  const mergedAt = new Date().toISOString();
  const result = await cleanUpMerge(
    checkout,
    { ...pullRequest(tip), mergedAt },
    idle,
  );
  assert.equal(typeof result === 'object' && result.cleaned, true);
  assert.deepEqual(await branches(checkout), ['main']);
  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
});

test("a head branch the repository keeps after merging goes at once, unless its remote branch moved or it's the default branch", async () => {
  // the default branch waits out GitHub's deletion like any branch the repository might delete
  for (const { settings, moved, ago, result, cleaned } of [
    {
      settings: 'false\nmain\n',
      moved: false,
      ago: 0,
      cleaned: true,
      result: '#7 merged: switched to main and pulled, deleted branch feat/x.',
    },
    {
      settings: 'false\nmain\n',
      moved: true,
      ago: 0,
      cleaned: false,
      result:
        "#7 merged, but feat/x's remote branch has changed since, so it stays.",
    },
    {
      settings: 'false\nfeat/x\n',
      moved: false,
      ago: 60_000,
      cleaned: false,
      result: '#7 merged, but feat/x is still on its remote, so it stays.',
    },
  ]) {
    const { root, origin, checkout, other, tip } = await merged();
    await merge(other, 'feat/x', true);
    if (moved) {
      await git(other, 'switch', 'feat/x');
      await git(other, 'commit', '--allow-empty', '-m', 'after');
      await git(other, 'push', 'origin', 'feat/x');
    }
    const bin = join(root, 'bin');
    await write(
      join(bin, 'gh'),
      `#!/bin/sh\n[ "$*" = 'api --hostname github.test repos/o/r --jq .delete_branch_on_merge, .default_branch' ] || exit 1\nprintf ${quote(settings)}\n`,
    );
    await chmod(join(bin, 'gh'), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const outcome = await within(
        cleanUpMerge(
          checkout,
          {
            ...pullRequest(tip),
            url: 'https://github.test/o/r/pull/7',
            mergedAt: new Date(Date.now() - ago).toISOString(),
          },
          idle,
        ),
        5000,
        'the cleanup',
      );
      assert.deepEqual(outcome, { text: result, cleaned });
    } finally {
      process.env.PATH = previousPath;
    }
    assert.ok(await git(origin, 'rev-parse', '--verify', 'refs/heads/feat/x'));
    assert.equal(
      await git(checkout, 'branch', '--show-current'),
      cleaned ? 'main' : 'feat/x',
    );
  }
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
