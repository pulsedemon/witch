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

const url = 'https://github.test/o/r/pull/7';

const lookup = [
  'api graphql --hostname github.test',
  '-f query=query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { deleteBranchOnMerge defaultBranchRef { name } pullRequest(number: $number) { isCrossRepository } } }',
  '-f owner=o -f name=r -F number=7',
  '--jq .data.repository | .deleteBranchOnMerge, .defaultBranchRef.name, .pullRequest.isCrossRepository',
].join(' ');

/** a `gh` script that prints `settings`, the lines of deleteBranchOnMerge, the default branch and isCrossRepository. */
const answering = (settings: string) =>
  `[ "$*" = ${quote(lookup)} ] || exit 1\nprintf ${quote(settings)}`;

const failing = "echo 'HTTP 502' >&2\nexit 1";

/** runs `body` with `script` as the `gh` on PATH. */
async function withGh<T>(
  root: string,
  script: string,
  body: () => Promise<T>,
): Promise<T> {
  const bin = join(root, 'bin');
  await write(join(bin, 'gh'), `#!/bin/sh\n${script}\n`);
  await chmod(join(bin, 'gh'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    return await body();
  } finally {
    process.env.PATH = previousPath;
  }
}

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

test("a head branch GitHub deletes after the first fetch goes, even past the deletion window and when reading the repository's settings fails", async () => {
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
  const mergedAt = new Date(Date.now() - 60_000).toISOString();
  const result = await withGh(root, failing, () =>
    cleanUpMerge(checkout, { ...pullRequest(tip), url, mergedAt }, idle),
  );
  assert.equal(typeof result === 'object' && result.cleaned, true);
  assert.deepEqual(await branches(checkout), ['main']);
  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
});

test("a head branch the repository keeps after merging goes at once, unless its remote branch moved before or during the lookup, it's the default branch or a fork's, or the repository deletes merged branches or its settings can't be read", async () => {
  // the default branch waits out GitHub's deletion like any branch the repository might delete
  for (const { gh, moved, ago, result, cleaned } of [
    {
      gh: answering('false\nmain\nfalse\n'),
      moved: '',
      ago: 0,
      cleaned: true,
      result: '#7 merged: switched to main and pulled, deleted branch feat/x.',
    },
    {
      gh: answering('false\nmain\nfalse\n'),
      moved: 'before',
      ago: 0,
      cleaned: false,
      result:
        "#7 merged, but feat/x's remote branch has changed since, so it stays.",
    },
    {
      gh: answering('false\nmain\nfalse\n'),
      moved: 'during',
      ago: 0,
      cleaned: false,
      result:
        "#7 merged, but feat/x's remote branch has changed since, so it stays.",
    },
    {
      gh: answering('false\nfeat/x\nfalse\n'),
      moved: '',
      ago: 60_000,
      cleaned: false,
      result: '#7 merged, but feat/x is still on its remote, so it stays.',
    },
    {
      gh: answering('true\nmain\nfalse\n'),
      moved: '',
      ago: 60_000,
      cleaned: false,
      result: '#7 merged, but feat/x is still on its remote, so it stays.',
    },
    {
      gh: answering('null\nmain\nfalse\n'),
      moved: '',
      ago: 60_000,
      cleaned: false,
      result:
        "#7 merged, but feat/x is still on its remote, so it stays (couldn't read whether the repository keeps merged branches: deleteBranchOnMerge was null).",
    },
    {
      gh: answering('false\nnull\nfalse\n'),
      moved: '',
      ago: 60_000,
      cleaned: false,
      result:
        "#7 merged, but feat/x is still on its remote, so it stays (couldn't read whether the repository keeps merged branches: the default branch was missing).",
    },
    {
      gh: answering('false\nmain\ntrue\n'),
      moved: '',
      ago: 60_000,
      cleaned: false,
      result: '#7 merged, but feat/x is still on its remote, so it stays.',
    },
    {
      gh: failing,
      moved: '',
      ago: 60_000,
      cleaned: false,
      result:
        "#7 merged, but feat/x is still on its remote, so it stays (couldn't read whether the repository keeps merged branches: HTTP 502).",
    },
    {
      gh: 'exit 3',
      moved: '',
      ago: 60_000,
      cleaned: false,
      result:
        "#7 merged, but feat/x is still on its remote, so it stays (couldn't read whether the repository keeps merged branches: gh exited with code 3).",
    },
  ]) {
    const { root, origin, checkout, other, tip } = await merged();
    await merge(other, 'feat/x', true);
    let script = gh;
    if (moved) {
      await git(other, 'switch', 'feat/x');
      await git(other, 'commit', '--allow-empty', '-m', 'after');
      // a push that lands while gh answers
      if (moved === 'during') {
        await git(other, 'push', 'origin', 'feat/x:later');
        script = `git -C ${quote(origin)} update-ref refs/heads/feat/x refs/heads/later\n${gh}`;
      } else await git(other, 'push', 'origin', 'feat/x');
    }
    const mergedAt = new Date(Date.now() - ago).toISOString();
    const outcome = await withGh(root, script, () =>
      within(
        cleanUpMerge(checkout, { ...pullRequest(tip), url, mergedAt }, idle),
        5000,
        'the cleanup',
      ),
    );
    assert.deepEqual(outcome, { text: result, cleaned });
    assert.ok(await git(origin, 'rev-parse', '--verify', 'refs/heads/feat/x'));
    assert.equal(
      await git(checkout, 'branch', '--show-current'),
      cleaned ? 'main' : 'feat/x',
    );
    assert.deepEqual(
      await branches(checkout),
      cleaned ? ['main'] : ['feat/x', 'main'],
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
