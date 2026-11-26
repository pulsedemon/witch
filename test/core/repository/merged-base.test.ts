import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { cleanUpMerge } from '../../../src/core/repository/merged.js';
import type { MergeCleanup } from '../../../src/core/repository/merged.js';
import { git } from '../../fixtures/git.js';
import {
  branches,
  duringFetch,
  idle,
  ignoredVendor,
  merge,
  merged,
  pullRequest,
  withGit,
} from '../../fixtures/merged.js';
import { configureGitEnvironment } from '../../fixtures/merged-environment.js';

configureGitEnvironment();

for (const second of [false, true])
  test(`a stale base reaches its ${second ? 'second remote' : 'origin'} before switching over ignored replacements`, async () => {
    const { root, origin, checkout, other, tip } = await ignoredVendor();
    let target: string;

    if (second) {
      const upstream = join(root, 'upstream.git');
      const fork = join(root, 'fork');
      await git(root, 'clone', '--bare', origin, upstream);
      await git(checkout, 'remote', 'add', 'upstream', upstream);
      await git(checkout, 'fetch', 'upstream');
      await git(checkout, 'branch', '--set-upstream-to=upstream/main', 'main');
      await git(root, 'clone', upstream, fork);
      await merge(fork, 'feat/x');
      await git(checkout, 'push', 'origin', '--delete', 'feat/x');
      target = await git(fork, 'rev-parse', 'HEAD');
    } else {
      await merge(other, 'feat/x');
      target = await git(other, 'rev-parse', 'HEAD');
    }

    assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
      text: '#7 merged: switched to main and pulled, deleted branch feat/x.',
      cleaned: true,
    });

    assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
    assert.equal(await git(checkout, 'rev-parse', 'HEAD'), target);
    assert.deepEqual(await branches(checkout), ['main']);

    assert.equal(
      await readFile(join(checkout, 'vendor/lib.js'), 'utf8'),
      'installed\n',
    );
  });

for (const appears of ['base', 'upstream'])
  test(`a stale ${appears} appearing during the head fetch advances before switching`, async () => {
    const { root, checkout, other, tip } = await ignoredVendor();
    await merge(other, 'feat/x');

    if (appears === 'base') await git(checkout, 'branch', '-D', 'main');
    else await git(checkout, 'branch', '--unset-upstream', 'main');

    await duringFetch(
      root,
      checkout,
      appears === 'base'
        ? `run('-C', ${JSON.stringify(checkout)}, 'branch', '--track', 'main', 'origin/main');`
        : `run('-C', ${JSON.stringify(checkout)}, 'branch', '--set-upstream-to=origin/main', 'main');`,
    );

    assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
      text: '#7 merged: switched to main and pulled, deleted branch feat/x.',
      cleaned: true,
    });

    assert.equal(await git(checkout, 'branch', '--show-current'), 'main');

    assert.equal(
      await git(checkout, 'rev-parse', 'HEAD'),
      await git(other, 'rev-parse', 'main'),
    );

    assert.deepEqual(await branches(checkout), ['main']);

    assert.equal(
      await readFile(join(checkout, 'vendor/lib.js'), 'utf8'),
      'installed\n',
    );
  });

test('a stale base tracking an annotated tag advances to its commit', async () => {
  const { checkout, other, tip } = await ignoredVendor();
  await merge(other, 'feat/x');
  await git(checkout, 'fetch');
  const target = await git(other, 'rev-parse', 'main');
  await git(checkout, 'tag', '-a', 'release', '-m', 'release', target);
  await git(checkout, 'config', 'branch.main.remote', '.');
  await git(checkout, 'config', 'branch.main.merge', 'refs/tags/release');

  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
    text: '#7 merged: switched to main and pulled, deleted branch feat/x.',
    cleaned: true,
  });

  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), target);
  assert.deepEqual(await branches(checkout), ['main']);

  assert.equal(
    await readFile(join(checkout, 'vendor/lib.js'), 'utf8'),
    'installed\n',
  );
});

test('a base moved immediately before its advance keeps the competing commit', async () => {
  const { root, checkout, other, tip } = await merged();
  await git(checkout, 'switch', '-c', 'moved', 'main');
  await git(checkout, 'commit', '--allow-empty', '-m', 'competing');
  const moved = await git(checkout, 'rev-parse', 'HEAD');
  await git(checkout, 'switch', 'feat/x');
  await merge(other, 'feat/x');
  const marker = join(root, 'moved');

  await withGit(
    root,
    `if (args[0] === 'update-ref' && args.includes('refs/heads/main') && !existsSync(${JSON.stringify(marker)})) {
  writeFileSync(${JSON.stringify(marker)}, '');
  if (run(['update-ref', 'refs/heads/main', ${JSON.stringify(moved)}], 'ignore').status) process.exit(1);
}`,
    () => assert.rejects(cleanUpMerge(checkout, pullRequest(tip), idle)),
  );

  assert.equal(await git(checkout, 'rev-parse', 'main'), moved);
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  assert.equal(await git(checkout, 'rev-parse', 'feat/x'), tip);
});

test('an unfetched upstream leaves the advance to the later pull failure', async () => {
  const { checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  await git(checkout, 'config', 'branch.main.merge', 'refs/heads/absent');

  await assert.rejects(
    cleanUpMerge(checkout, pullRequest(tip), idle),
    /#7 merged: switched to main and deleted branch feat\/x, but main didn't fast-forward/,
  );

  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
  assert.deepEqual(await branches(checkout), ['main']);
});

test('an expression upstream cannot advance the base as a revision', async () => {
  const { checkout, other, tip } = await merged();
  const before = await git(checkout, 'rev-parse', 'main');
  await merge(other, 'feat/x');
  await git(checkout, 'fetch');
  await git(checkout, 'switch', '-c', 'other', 'origin/main');
  await git(checkout, 'commit', '--allow-empty', '-m', 'after');
  await git(checkout, 'switch', 'feat/x');
  await git(checkout, 'config', 'branch.main.remote', '.');
  await git(checkout, 'config', 'branch.main.merge', 'other~1');

  await assert.rejects(
    cleanUpMerge(checkout, pullRequest(tip), idle),
    /#7 merged: switched to main and deleted branch feat\/x, but main didn't fast-forward/,
  );

  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
  assert.equal(await git(checkout, 'rev-parse', 'main'), before);
  assert.ok(!(await branches(checkout)).includes('feat/x'));
});

test('a base without an upstream ignores its leftover remote until the pull', async () => {
  const { root, checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  await git(checkout, 'branch', '--unset-upstream', 'main');
  await git(checkout, 'remote', 'add', 'defunct', join(root, 'absent.git'));
  await git(checkout, 'config', 'branch.main.remote', 'defunct');

  await assert.rejects(
    cleanUpMerge(checkout, pullRequest(tip), idle),
    /#7 merged: switched to main and deleted branch feat\/x, but main didn't fast-forward/,
  );

  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
  assert.deepEqual(await branches(checkout), ['main']);
});

test('a cleanup resumes after switching to the advanced base without a completed status read', async () => {
  const { root, checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  const target = await git(other, 'rev-parse', 'main');
  const marker = join(root, 'switched');
  const progress: MergeCleanup = {};

  await withGit(
    root,
    `if (args[0] === 'switch') {
  const result = run(args, 'ignore');
  writeFileSync(${JSON.stringify(marker)}, '');
  process.exit(result.status ?? 1);
}
if (args.includes('status') && existsSync(${JSON.stringify(marker)})) {
  process.stderr.write('injected status failure');
  process.exit(23);
}`,
    () =>
      assert.rejects(
        cleanUpMerge(checkout, pullRequest(tip), idle, { progress }),
        /injected status failure/,
      ),
  );

  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), target);

  assert.deepEqual(
    await cleanUpMerge(checkout, pullRequest(tip), idle, { progress }),
    {
      text: '#7 merged: switched to main and pulled, deleted branch feat/x.',
      cleaned: true,
    },
  );

  assert.deepEqual(await branches(checkout), ['main']);
});
