import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { cleanUpMerge } from '../../../src/core/repository/merged.js';
import type { MergeCleanup } from '../../../src/core/repository/merged.js';
import { quote } from '../../../src/shell.js';
import { git } from '../../fixtures/git.js';
import {
  branches,
  duringFetch,
  editingSequence,
  idle,
  merge,
  merged,
  pullRequest,
  write,
} from '../../fixtures/merged.js';
import { configureGitEnvironment } from '../../fixtures/merged-environment.js';

configureGitEnvironment();

async function staleBase(third = false) {
  const state = await merged({ 'shared.txt': 'base\n' });
  const { origin, checkout, other } = state;
  await git(checkout, 'switch', 'main');
  await write(join(checkout, 'shared.txt'), 'main\n');
  await git(checkout, 'commit', '-am', 'main');

  if (third) await git(checkout, 'commit', '--allow-empty', '-m', 'third');

  await git(checkout, 'push');
  const before = await git(checkout, 'rev-parse', 'main');
  await git(checkout, 'switch', 'feat/x');
  await merge(other, 'feat/x');
  await git(origin, 'merge-base', '--is-ancestor', before, 'main');
  assert.notEqual(before, await git(origin, 'rev-parse', 'main'));

  return { ...state, before, target: await git(origin, 'rev-parse', 'main') };
}

async function updateRefs(
  root: string,
  checkout: string,
  holder: string,
  race = false,
) {
  const editor = await editingSequence(root);

  const commands = [
    [
      '-C',
      checkout,
      'worktree',
      'add',
      '--quiet',
      '-b',
      'control',
      holder,
      'main',
    ],
    ['-C', holder, 'commit', '--allow-empty', '-m', 'holder'],
    [
      '-C',
      holder,
      '-c',
      `sequence.editor=${quote(editor)}`,
      'rebase',
      '-i',
      '--force-rebase',
      '--keep-empty',
      '--update-refs',
      'main~1',
    ],
  ];

  if (race)
    await duringFetch(
      root,
      checkout,
      commands.map((args) => `run(...${JSON.stringify(args)});`).join('\n'),
    );
  else for (const args of commands) await git(checkout, ...args);
}

async function secondRemote(root: string, origin: string, checkout: string) {
  const upstream = join(root, 'upstream.git');
  const fork = join(root, 'fork');
  await git(root, 'clone', '--bare', origin, upstream);
  await git(root, 'clone', upstream, fork);
  await git(fork, 'commit', '--allow-empty', '-m', 'upstream');
  await git(fork, 'push');
  await git(checkout, 'remote', 'add', 'upstream', upstream);

  return git(fork, 'rev-parse', 'HEAD');
}

test('a worktree acquiring the stale base during the fetch prevents its advance', async () => {
  const { root, checkout, tip, before } = await staleBase();
  const holder = join(root, 'holder');

  await duringFetch(
    root,
    checkout,
    `run('-C', ${JSON.stringify(checkout)}, 'worktree', 'add', '--quiet', ${JSON.stringify(holder)}, 'main');`,
  );

  await assert.rejects(
    cleanUpMerge(checkout, pullRequest(tip), idle),
    /#7 merged, but its cleanup failed before deleting feat\/x/,
  );

  assert.equal(await git(checkout, 'rev-parse', 'main'), before);
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  assert.equal(await git(holder, 'status', '--porcelain'), '');
});

for (const mode of ['rebase', 'apply', 'bisect', 'update-refs'])
  test(`a stale base owned by ${mode} detaches without moving the owned ref`, async () => {
    const { root, checkout, tip, before, target } = await staleBase(
      mode === 'bisect',
    );

    const holder = join(root, 'holder');

    if (mode === 'update-refs') await updateRefs(root, checkout, holder);
    else {
      if (mode !== 'bisect') {
        await git(checkout, 'switch', '-c', 'side', 'main~1');
        await write(join(checkout, 'shared.txt'), 'side\n');
        await git(checkout, 'commit', '-am', 'side');
        await git(checkout, 'switch', 'feat/x');
      }

      await git(checkout, 'worktree', 'add', holder, 'main');

      if (mode === 'bisect')
        await git(holder, 'bisect', 'start', 'main', 'main~2');
      else
        await assert.rejects(
          git(
            holder,
            'rebase',
            ...(mode === 'apply' ? ['--apply'] : []),
            'side',
            'main',
          ),
        );
    }

    await assert.rejects(git(holder, 'symbolic-ref', '-q', 'HEAD'));

    assert.equal(
      await git(
        checkout,
        'for-each-ref',
        '--format=%(worktreepath)',
        'refs/heads/main',
      ),
      '',
    );

    if (mode === 'update-refs')
      assert.match(
        await readFile(
          join(
            await git(holder, 'rev-parse', '--absolute-git-dir'),
            'rebase-merge/update-refs',
          ),
          'utf8',
        ),
        /refs\/heads\/main\n/,
      );

    assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
      text: '#7 merged: detached at origin/main, deleted branch feat/x.',
      cleaned: true,
    });

    assert.equal(await git(checkout, 'branch', '--show-current'), '');
    assert.equal(await git(checkout, 'rev-parse', 'HEAD'), target);
    assert.equal(await git(checkout, 'rev-parse', 'main'), before);
    assert.ok(!(await branches(checkout)).includes('feat/x'));
  });

for (const race of [false, true])
  test(`a dangling symbolic base ${race ? 'created during the fetch defers then' : 'already present'} detaches without creating its target`, async () => {
    const { root, checkout, tip, target } = await staleBase();

    const commands = [
      ['-C', checkout, 'branch', '-D', 'main'],
      ['-C', checkout, 'symbolic-ref', 'refs/heads/main', 'refs/heads/owned'],
    ];

    if (race)
      await duringFetch(
        root,
        checkout,
        commands.map((args) => `run(...${JSON.stringify(args)});`).join('\n'),
      );
    else for (const args of commands) await git(checkout, ...args);

    const progress: MergeCleanup = {};

    if (race) {
      assert.equal(
        await cleanUpMerge(checkout, pullRequest(tip), idle, { progress }),
        undefined,
      );

      assert.equal(progress.deferred, 'main became a symbolic ref');
      assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
      assert.equal(await git(checkout, 'rev-parse', 'feat/x'), tip);

      await assert.rejects(
        git(checkout, 'rev-parse', '--verify', 'refs/heads/owned'),
      );
    }

    assert.deepEqual(
      await cleanUpMerge(checkout, pullRequest(tip), idle, { progress }),
      {
        text: '#7 merged: detached at origin/main, deleted branch feat/x.',
        cleaned: true,
      },
    );

    assert.equal(await git(checkout, 'branch', '--show-current'), '');
    assert.equal(await git(checkout, 'rev-parse', 'HEAD'), target);

    await assert.rejects(
      git(checkout, 'rev-parse', '--verify', 'refs/heads/owned'),
    );

    assert.ok(!(await branches(checkout)).includes('feat/x'));
  });

test('a symbolic base detaches without moving its checked-out target', async () => {
  const { root, checkout, tip, before, target } = await staleBase();
  const holder = join(root, 'holder');
  await git(checkout, 'branch', 'owned', 'main');
  await git(checkout, 'worktree', 'add', holder, 'owned');
  await git(checkout, 'symbolic-ref', 'refs/heads/main', 'refs/heads/owned');

  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
    text: '#7 merged: detached at origin/main, deleted branch feat/x.',
    cleaned: true,
  });

  assert.equal(await git(checkout, 'branch', '--show-current'), '');
  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), target);
  assert.equal(await git(checkout, 'rev-parse', 'owned'), before);
  assert.equal(await git(holder, 'status', '--porcelain'), '');
  assert.ok(!(await branches(checkout)).includes('feat/x'));
});

for (const mode of ['update-refs', 'symbolic', 'late-upstream symbolic'])
  test(`${mode === 'update-refs' ? 'an' : 'a'} ${mode} owner appearing during the fetch defers then detaches`, async () => {
    const { root, origin, checkout, tip, before, target } = await staleBase();
    const holder = join(root, 'holder');
    let expected = target;
    const late = mode === 'late-upstream symbolic';

    if (mode === 'update-refs') await updateRefs(root, checkout, holder, true);
    else {
      await git(checkout, 'branch', 'owned', 'main');
      await git(checkout, 'worktree', 'add', holder, 'owned');

      if (late) {
        expected = await secondRemote(root, origin, checkout);
        await git(checkout, 'branch', '--unset-upstream', 'main');
      }

      await duringFetch(
        root,
        checkout,
        `run('-C', ${JSON.stringify(checkout)}, 'symbolic-ref', 'refs/heads/main', 'refs/heads/owned');
${
  late
    ? `run('-C', ${JSON.stringify(checkout)}, 'config', 'branch.main.remote', 'upstream');
run('-C', ${JSON.stringify(checkout)}, 'config', 'branch.main.merge', 'refs/heads/main');`
    : ''
}`,
      );
    }

    const progress: MergeCleanup = {};

    assert.equal(
      await cleanUpMerge(checkout, pullRequest(tip), idle, { progress }),
      undefined,
    );

    assert.equal(
      progress.deferred,
      mode === 'update-refs'
        ? 'another worktree owns main'
        : 'main became a symbolic ref',
    );

    assert.equal(await git(checkout, 'rev-parse', 'main'), before);
    assert.equal(await git(checkout, 'rev-parse', 'feat/x'), tip);
    assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');

    if (mode !== 'update-refs')
      assert.equal(await git(checkout, 'rev-parse', 'owned'), before);

    if (late)
      assert.equal(await git(checkout, 'rev-parse', 'upstream/main'), expected);

    assert.deepEqual(
      await cleanUpMerge(checkout, pullRequest(tip), idle, { progress }),
      {
        text: `#7 merged: detached at ${late ? 'upstream' : 'origin'}/main, deleted branch feat/x.`,
        cleaned: true,
      },
    );

    assert.equal(await git(checkout, 'branch', '--show-current'), '');
    assert.equal(await git(checkout, 'rev-parse', 'HEAD'), expected);
    assert.equal(await git(checkout, 'rev-parse', 'main'), before);
    assert.ok(!(await branches(checkout)).includes('feat/x'));

    if (mode !== 'update-refs') {
      assert.equal(await git(checkout, 'rev-parse', 'owned'), before);
      assert.equal(await git(holder, 'status', '--porcelain'), '');
    }
  });

test('a held base repointed during the head fetch detaches at its newly fetched upstream', async () => {
  const { root, origin, checkout, tip, before } = await staleBase();
  const holder = join(root, 'holder');
  await git(checkout, 'worktree', 'add', holder, 'main');
  const target = await secondRemote(root, origin, checkout);

  await duringFetch(
    root,
    checkout,
    `run('-C', ${JSON.stringify(checkout)}, 'config', 'branch.main.remote', 'upstream');`,
  );

  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
    text: '#7 merged: detached at upstream/main, deleted branch feat/x.',
    cleaned: true,
  });

  assert.equal(await git(checkout, 'branch', '--show-current'), '');
  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), target);
  assert.equal(await git(checkout, 'rev-parse', 'main'), before);
  assert.equal(await git(holder, 'status', '--porcelain'), '');
  assert.ok(!(await branches(checkout)).includes('feat/x'));
});

test('a held base without an upstream ignores its leftover remote and detaches at origin', async () => {
  const { root, checkout, tip, before, target } = await staleBase();
  const holder = join(root, 'holder');
  await git(checkout, 'worktree', 'add', holder, 'main');
  await git(checkout, 'branch', '--unset-upstream', 'main');
  await git(checkout, 'remote', 'add', 'defunct', join(root, 'absent.git'));
  await git(checkout, 'config', 'branch.main.remote', 'defunct');

  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
    text: '#7 merged: detached at origin/main, deleted branch feat/x.',
    cleaned: true,
  });

  assert.equal(await git(checkout, 'branch', '--show-current'), '');
  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), target);
  assert.equal(await git(checkout, 'rev-parse', 'main'), before);
  assert.equal(await git(holder, 'status', '--porcelain'), '');
  assert.ok(!(await branches(checkout)).includes('feat/x'));
});
