import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { cleanUpMerge } from '../../../src/core/repository/merged.js';
import type { MergeCleanup } from '../../../src/core/repository/merged.js';
import { quote } from '../../../src/shell.js';
import {
  answering,
  branches,
  editingSequence,
  idle,
  merge,
  merged,
  pullRequest,
  pushingOnBase,
  url,
  withGh,
  withGit,
  write,
} from '../../fixtures/merged.js';
import { git } from '../../fixtures/git.js';
import { configureGitEnvironment } from '../../fixtures/merged-environment.js';
import { exists, until, within } from '../../fixtures/within.js';

configureGitEnvironment();
const plans = (checkout: string) => join(checkout, 'docs/superpowers/plans');
const failing = "echo 'HTTP 502' >&2\nexit 1";

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

  await chmod(pack, 0o755);
  await git(checkout, 'config', 'remote.origin.uploadpack', pack);
  const mergedAt = new Date(Date.now() - 60_000).toISOString();

  const result = await withGh(root, failing, () =>
    cleanUpMerge(checkout, { ...pullRequest(tip), url, mergedAt }, idle),
  );

  assert.equal(typeof result === 'object' && result.cleaned, true);
  assert.deepEqual(await branches(checkout), ['main']);
  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
});

test('a retained head pushed during the deletion wait keeps its local branch and plan', async () => {
  const { root, origin, checkout, other, tip } = await merged();
  await merge(other, 'feat/x', true);
  await git(other, 'switch', 'feat/x');
  await git(other, 'commit', '--allow-empty', '-m', 'after merge');
  await git(other, 'push', 'origin', 'feat/x:later');
  const later = await git(origin, 'rev-parse', 'later');
  const count = join(root, 'fetch-count');
  const plan = join(plans(checkout), 'x.md');
  await write(plan, '`git switch -c feat/x`.\n');
  const mergedAt = new Date().toISOString();

  const result = await withGit(
    root,
    `if (args.includes('fetch')) {
      const file = ${JSON.stringify(count)};
      const count = existsSync(file) ? Number(readFileSync(file, 'utf8')) + 1 : 1;
      writeFileSync(file, String(count));
      if (count === 3) run(['--git-dir', ${JSON.stringify(origin)}, 'update-ref', 'refs/heads/feat/x', ${JSON.stringify(later)}], 'pipe');
    }`,
    () =>
      withGh(root, answering('true\nmain\nfalse\n'), () =>
        cleanUpMerge(checkout, { ...pullRequest(tip), url, mergedAt }, idle),
      ),
  );

  assert.deepEqual(result, {
    text: "#7 merged, but feat/x's remote branch has changed since, so it stays.",
    cleaned: false,
  });

  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), tip);
  assert.equal(await git(origin, 'rev-parse', 'feat/x'), later);
  assert.equal(await git(checkout, 'config', 'branch.feat/x.remote'), 'origin');
  assert.equal(await exists(plan), true);
});

test('a retained head goes only with an unchanged remote tip and a verified same-repository, non-default branch', async () => {
  // the default branch waits out GitHub's deletion like any branch the repository might delete
  for (const { gh, moved, ago, result, cleaned } of [
    {
      gh: answering('false\nmain\nfalse\n'),
      moved: '',
      ago: 0,
      cleaned: true,
      result:
        '#7 merged: switched to main and pulled, deleted branch feat/x, and plan x.md.',
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
      moved: 'deleted',
      ago: 0,
      cleaned: true,
      result:
        '#7 merged: switched to main and pulled, deleted branch feat/x, and plan x.md.',
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
      cleaned: true,
      result:
        '#7 merged: switched to main and pulled, deleted branch feat/x, and plan x.md.',
    },
    ...['before', 'during'].map((moved) => ({
      gh: answering('true\nmain\nfalse\n'),
      moved,
      ago: 60_000,
      cleaned: false,
      result:
        "#7 merged, but feat/x's remote branch has changed since, so it stays.",
    })),
    ...['true\nfeat/x\nfalse\n', 'true\nmain\ntrue\n'].map((settings) => ({
      gh: answering(settings),
      moved: '',
      ago: 60_000,
      cleaned: false,
      result: '#7 merged, but feat/x is still on its remote, so it stays.',
    })),
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
    await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`.\n');
    const base = await git(origin, 'rev-parse', 'main');
    let script = gh;

    if (moved === 'deleted')
      script = `git -C ${quote(origin)} update-ref -d refs/heads/feat/x\n${gh}`;
    else if (moved) {
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
    assert.equal(await exists(join(plans(checkout), 'x.md')), !cleaned);

    if (cleaned) {
      assert.equal(await git(checkout, 'rev-parse', 'HEAD'), base);

      await assert.rejects(
        git(checkout, 'config', '--get', 'branch.feat/x.remote'),
      );
    }

    assert.equal(
      await git(
        origin,
        'for-each-ref',
        '--format=%(refname)',
        'refs/heads/feat/x',
      ),
      moved === 'deleted' ? '' : 'refs/heads/feat/x',
    );

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

  assert.deepEqual(
    await cleanUpMerge(checkout, { ...pullRequest(tip), url }, idle),
    {
      text: '#7 merged, but feat/x tracks no remote branch, so it stays.',
      cleaned: false,
    },
  );

  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
});

for (const upstream of ['origin/main', 'main'])
  test(`a head branch tracking ${upstream} stays and names its upstream`, async () => {
    const { checkout, other, tip } = await merged();
    await git(checkout, 'branch', `--set-upstream-to=${upstream}`);
    await merge(other, 'feat/x');

    assert.deepEqual(
      await cleanUpMerge(checkout, { ...pullRequest(tip), url }, idle),
      {
        text: `#7 merged, but feat/x tracks ${upstream} rather than its own remote branch, so it stays.`,
        cleaned: false,
      },
    );

    assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  });

async function older(
  checkout: string,
  other: string,
  name: string,
  keep = true,
) {
  await git(checkout, 'switch', '-c', name, 'main');
  await git(checkout, 'commit', '--allow-empty', '-m', name);
  const tip = await git(checkout, 'rev-parse', 'HEAD');
  await git(checkout, 'push', '-u', 'origin', name);
  await merge(other, name, keep);
  await git(checkout, 'switch', 'feat/x');

  return tip;
}

test('a head left behind with automatic deletion enabled is cleaned up without pruning other retained branches', async () => {
  const { root, origin, checkout, other, tip } = await merged();
  const old = await older(checkout, other, 'feat/old');
  await merge(other, 'feat/x', true);
  await write(join(plans(checkout), 'x.md'), '`git switch -c feat/x`.\n');
  const base = await git(origin, 'rev-parse', 'main');
  const mergedAt = new Date(Date.now() - 60_000).toISOString();

  const result = await withGh(root, answering('true\nmain\nfalse\n'), () =>
    cleanUpMerge(checkout, { ...pullRequest(tip), url, mergedAt }, idle),
  );

  assert.equal(typeof result === 'object' && result.cleaned, true);
  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), base);
  assert.deepEqual(await branches(checkout), ['feat/old', 'main']);
  assert.equal(await git(checkout, 'rev-parse', 'feat/old'), old);
  assert.equal(await git(origin, 'rev-parse', 'feat/x'), tip);
  assert.equal(await git(origin, 'rev-parse', 'feat/old'), old);
  assert.equal(await exists(join(plans(checkout), 'x.md')), false);

  await assert.rejects(
    git(checkout, 'config', '--get', 'branch.feat/x.remote'),
  );
});

for (const keepHead of [true, false])
  test(`older retained branches go with a ${keepHead ? 'retained' : 'deleted'} head while ineligible branches and remote refs stay`, async () => {
    const { root, origin, checkout, other, tip } = await merged();
    const old = await older(checkout, other, 'feat/old');
    const changed = await older(checkout, other, 'feat/changed');
    await git(origin, 'update-ref', 'refs/heads/feat/changed', tip);
    await git(checkout, 'branch', 'feat/local', 'main');
    await git(checkout, 'switch', '-c', 'feat/unmerged', 'main');
    await git(checkout, 'commit', '--allow-empty', '-m', 'unmerged');
    const unmerged = await git(checkout, 'rev-parse', 'HEAD');
    await git(checkout, 'push', '-u', 'origin', 'feat/unmerged');
    await git(checkout, 'switch', 'feat/x');
    await merge(other, 'feat/x', keepHead);
    await git(checkout, 'fetch');
    await git(checkout, 'branch', '--track', 'feat/alias', 'origin/main');
    const alias = await git(checkout, 'rev-parse', 'feat/alias');
    assert.equal(alias, await git(checkout, 'rev-parse', 'origin/main'));

    const result = await withGh(root, answering('false\nmain\nfalse\n'), () =>
      cleanUpMerge(checkout, { ...pullRequest(tip), url }, idle),
    );

    assert.deepEqual(await branches(checkout), [
      'feat/alias',
      'feat/changed',
      'feat/local',
      'feat/unmerged',
      'main',
    ]);

    assert.equal(await git(checkout, 'rev-parse', 'feat/changed'), changed);
    assert.equal(await git(checkout, 'rev-parse', 'feat/alias'), alias);
    assert.equal(await git(checkout, 'rev-parse', 'feat/unmerged'), unmerged);
    assert.equal(await git(origin, 'rev-parse', 'feat/old'), old);
    assert.equal(await git(origin, 'rev-parse', 'feat/changed'), tip);

    await assert.rejects(
      git(checkout, 'config', '--get', 'branch.feat/old.merge'),
    );

    assert.deepEqual(result, {
      cleaned: true,
      text: '#7 merged: switched to main and pulled, deleted branches feat/x and feat/old.',
    });
  });

test('retained pruning preserves free default and base branches plus a branch held by a worktree', async () => {
  const { root, origin, launcher, checkout, other, tip } = await merged(
    {},
    [],
    true,
  );

  await older(checkout, other, 'feat/old');
  const held = await older(checkout, other, 'feat/held');
  const holder = join(root, 'holder');
  await git(checkout, 'worktree', 'add', holder, 'feat/held');
  await merge(other, 'feat/x', true);
  await git(other, 'push', 'origin', 'main:release');
  await git(checkout, 'fetch');
  await git(checkout, 'branch', '--track', 'release', 'origin/release');
  await git(launcher, 'merge', '--ff-only', 'origin/main');
  await git(launcher, 'switch', '--detach');
  const main = await git(checkout, 'rev-parse', 'main');
  assert.equal(main, await git(checkout, 'rev-parse', 'origin/main'));
  const release = await git(checkout, 'rev-parse', 'release');

  const result = await withGh(root, answering('false\nmain\nfalse\n'), () =>
    cleanUpMerge(checkout, { ...pullRequest(tip), url, base: 'release' }, idle),
  );

  assert.deepEqual(await branches(checkout), ['feat/held', 'main', 'release']);
  assert.equal(await git(checkout, 'rev-parse', 'main'), main);
  assert.equal(await git(checkout, 'rev-parse', 'release'), release);
  assert.equal(await git(holder, 'rev-parse', 'HEAD'), held);
  assert.equal(await git(origin, 'rev-parse', 'feat/held'), held);

  assert.deepEqual(result, {
    cleaned: true,
    text: '#7 merged: detached at origin/release, deleted branches feat/x and feat/old.',
  });
});

test('retained pruning refreshes the head remote even when the base uses another, and leaves branches of that other remote', async () => {
  const { root, origin, checkout, other, tip } = await merged();
  const old = await older(checkout, other, 'feat/old');
  const foreign = await older(checkout, other, 'feat/foreign');
  const changed = await older(checkout, other, 'feat/changed');
  await merge(other, 'feat/x');
  const upstream = join(root, 'upstream.git');
  await git(root, 'clone', '--bare', origin, upstream);
  await git(checkout, 'remote', 'add', 'upstream', upstream);
  await git(checkout, 'fetch', 'upstream');
  await git(checkout, 'branch', '--set-upstream-to=upstream/main', 'main');

  await git(
    checkout,
    'branch',
    '--set-upstream-to=upstream/feat/foreign',
    'feat/foreign',
  );

  const result = await withGh(
    root,
    `git -C ${quote(origin)} update-ref refs/heads/feat/changed ${quote(tip)}\n${answering('false\nmain\nfalse\n')}`,
    () => cleanUpMerge(checkout, { ...pullRequest(tip), url }, idle),
  );

  assert.deepEqual(await branches(checkout), [
    'feat/changed',
    'feat/foreign',
    'main',
  ]);

  assert.equal(await git(checkout, 'rev-parse', 'feat/foreign'), foreign);
  assert.equal(await git(checkout, 'rev-parse', 'feat/changed'), changed);
  assert.equal(await git(checkout, 'rev-parse', 'origin/feat/changed'), tip);
  assert.equal(await git(origin, 'rev-parse', 'feat/old'), old);
  assert.ok(typeof result === 'object' && result.cleaned);
});

test('a retained tip changed immediately before deletion is preserved with its config', async () => {
  const { root, checkout, other, tip } = await merged();
  const old = await older(checkout, other, 'feat/old');
  await git(checkout, 'switch', '-c', 'unmerged', 'main');
  await git(checkout, 'commit', '--allow-empty', '-m', 'unmerged');
  const changed = await git(checkout, 'rev-parse', 'HEAD');
  await git(checkout, 'switch', 'feat/x');
  await merge(other, 'feat/x');

  const result = await withGit(
    root,
    `
if (args[0] === 'update-ref' && args[1] === '-d' && args[2] === 'refs/heads/feat/old') {
  run(['update-ref', 'refs/heads/feat/old', ${JSON.stringify(changed)}]);
  run(['update-ref', 'refs/remotes/origin/feat/old', ${JSON.stringify(changed)}]);
}
`,
    () =>
      withGh(root, answering('false\nmain\nfalse\n'), () =>
        cleanUpMerge(checkout, { ...pullRequest(tip), url }, idle),
      ),
  );

  assert.notEqual(changed, old);
  assert.equal(await git(checkout, 'rev-parse', 'feat/old'), changed);

  assert.equal(
    await git(checkout, 'config', '--get', 'branch.feat/old.merge'),
    'refs/heads/feat/old',
  );

  assert.ok(typeof result === 'object' && result.cleaned);
  assert.match(result.text, /branch feat\/old stayed:.*update-ref/s);
  assert.deepEqual(await branches(checkout), ['feat/old', 'main', 'unmerged']);
});

test('a worktree that starts holding a retained candidate after enumeration keeps its branch', async () => {
  const { root, checkout, other, tip } = await merged();
  const old = await older(checkout, other, 'feat/old');
  await merge(other, 'feat/x');
  const holder = join(root, 'holder');
  const scans = join(root, 'scans');

  await withGit(
    root,
    `
if (args[0] === 'for-each-ref' && args.includes('--merged') && args.at(-1) === 'refs/heads') {
  const scans = ${JSON.stringify(scans)};
  const count = existsSync(scans) ? Number(readFileSync(scans, 'utf8')) + 1 : 1;
  writeFileSync(scans, String(count));
  if (count === 2) {
    const result = run(args, 'pipe');
    const added = run(['worktree', 'add', ${JSON.stringify(holder)}, 'feat/old'], 'pipe');
    process.stdout.write(result.stdout);
    process.stderr.write(Buffer.concat([result.stderr, added.stderr]));
    process.exit(result.status || added.status || 0);
  }
}
`,
    () =>
      withGh(root, answering('false\nmain\nfalse\n'), () =>
        cleanUpMerge(checkout, { ...pullRequest(tip), url }, idle),
      ),
  );

  assert.deepEqual(await branches(checkout), ['feat/old', 'main']);
  assert.equal(await git(holder, 'rev-parse', 'HEAD'), old);
});

for (const failure of ['policy', 'fetch', 'disabled'])
  test(`${failure} in retained pruning leaves retained refs and still deletes gone refs`, async () => {
    const { root, checkout, other, tip } = await merged();
    const old = await older(checkout, other, 'feat/old');
    await older(checkout, other, 'feat/gone', false);
    await merge(other, 'feat/x');

    const run = () =>
      withGh(
        root,
        failure === 'policy'
          ? failing
          : answering(`${failure === 'disabled'}\nmain\nfalse\n`),
        () => cleanUpMerge(checkout, { ...pullRequest(tip), url }, idle),
      );

    const result =
      failure === 'fetch'
        ? await withGit(
            root,
            `
if (args.at(-2) === 'fetch' && args.at(-1) === 'origin') {
  process.stderr.write('optional refresh failed');
  process.exit(23);
}
`,
            run,
          )
        : await run();

    assert.deepEqual(await branches(checkout), ['feat/old', 'main']);
    assert.equal(await git(checkout, 'rev-parse', 'feat/old'), old);
    assert.ok(typeof result === 'object' && result.cleaned);
    assert.match(result.text, /deleted branches feat\/x and feat\/gone/);

    if (failure === 'disabled')
      assert.doesNotMatch(result.text, /retained merged branches stayed/);
    else {
      assert.equal(
        result.text.match(/retained merged branches stayed:/g)?.length,
        1,
      );

      assert.match(
        result.text,
        failure === 'policy'
          ? /HTTP 502/
          : /couldn't refresh origin:.*optional refresh failed/s,
      );
    }
  });

test('cleanup without retained candidates needs no policy lookup or extra fetch', async () => {
  const { root, checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  const called = join(root, 'called');

  const result = await withGit(
    root,
    `
if (args.at(-2) === 'fetch' && args.at(-1) === 'origin') {
  writeFileSync(${JSON.stringify(called)}, 'fetch');
  process.exit(23);
}
`,
    () =>
      withGh(root, `touch ${quote(called)}\n${failing}`, () =>
        cleanUpMerge(checkout, { ...pullRequest(tip), url }, idle),
      ),
  );

  assert.equal(await exists(called), false);

  assert.deepEqual(result, {
    cleaned: true,
    text: '#7 merged: switched to main and pulled, deleted branch feat/x.',
  });
});

for (const repoint of [false, true])
  test(`resumed retained pruning ${repoint ? 'rejects a repointed remote' : 'refreshes changed tips and deletes eligible refs once'}`, async () => {
    const { root, origin, checkout, other, tip } = await merged();
    const old = await older(checkout, other, 'feat/old');
    const changed = await older(checkout, other, 'feat/changed');
    await merge(other, 'feat/x');
    await git(other, 'commit', '--allow-empty', '-m', 'during pull');
    await pushingOnBase(root, checkout, other);
    const entered = join(root, 'entered');
    const hooks = join(root, 'hooks');
    await git(checkout, 'config', 'core.hooksPath', hooks);

    await write(
      join(hooks, 'post-merge'),
      `#!/bin/sh\ntouch ${quote(entered)}\nsleep 30\n`,
    );

    await chmod(join(hooks, 'post-merge'), 0o755);
    const controller = new AbortController();
    const progress: MergeCleanup = {};

    const first = cleanUpMerge(checkout, { ...pullRequest(tip), url }, idle, {
      signal: controller.signal,
      progress,
    });

    try {
      await until('the base merge', () => exists(entered), 500);
    } finally {
      controller.abort();
    }

    await assert.rejects(first);

    await assert.rejects(
      git(checkout, 'config', '--get', 'branch.feat/x.remote'),
    );

    await git(checkout, 'config', '--unset', 'core.hooksPath');
    assert.deepEqual(progress.remote, { name: 'origin', url: origin });

    if (repoint) {
      const replacement = join(root, 'replacement.git');
      await git(root, 'clone', '--bare', origin, replacement);
      await git(checkout, 'remote', 'set-url', 'origin', replacement);
    } else await git(origin, 'update-ref', 'refs/heads/feat/changed', tip);

    const result = await withGh(root, answering('false\nmain\nfalse\n'), () =>
      cleanUpMerge(checkout, { ...pullRequest(tip), url }, idle, { progress }),
    );

    assert.equal(await git(checkout, 'rev-parse', 'feat/changed'), changed);
    assert.equal(await git(origin, 'rev-parse', 'feat/old'), old);
    assert.ok(typeof result === 'object' && result.cleaned);

    if (repoint) {
      assert.deepEqual(await branches(checkout), [
        'feat/changed',
        'feat/old',
        'main',
      ]);

      assert.match(result.text, /origin's URL changed during cleanup/);
    } else {
      assert.deepEqual(await branches(checkout), ['feat/changed', 'main']);
      assert.equal(result.text.match(/feat\/old/g)?.length, 1);
    }

    assert.deepEqual(
      await cleanUpMerge(checkout, { ...pullRequest(tip), url }, idle, {
        progress,
      }),
      result,
    );
  });

test('a config read failure after retained deletion reports the deleted ref and the surviving config', async () => {
  const { root, checkout, other, tip } = await merged();
  await older(checkout, other, 'feat/old');
  await merge(other, 'feat/x');

  const result = await withGit(
    root,
    `
if (args[0] === 'config' && args[1] === '--get-regexp' && args[2].includes('feat/old')) {
  process.stderr.write('config unreadable');
  process.exit(23);
}
`,
    () =>
      withGh(root, answering('false\nmain\nfalse\n'), () =>
        cleanUpMerge(checkout, { ...pullRequest(tip), url }, idle),
      ),
  );

  assert.deepEqual(await branches(checkout), ['main']);

  assert.equal(
    await git(checkout, 'config', '--get', 'branch.feat/old.merge'),
    'refs/heads/feat/old',
  );

  assert.ok(typeof result === 'object' && result.cleaned);
  assert.match(result.text, /deleted branches feat\/x and feat\/old/);

  assert.match(
    result.text,
    /config section branch\.feat\/old stayed:.*config unreadable/s,
  );
});

test('retained pruning rejects a remote repointed during the initial head policy lookup', async () => {
  const { root, origin, checkout, other, tip } = await merged();
  const old = await older(checkout, other, 'feat/old');
  await merge(other, 'feat/x', true);
  const replacement = join(root, 'replacement.git');
  await git(root, 'clone', '--bare', origin, replacement);

  const result = await withGh(
    root,
    `git -C ${quote(checkout)} remote set-url origin ${quote(replacement)}\n${answering('false\nmain\nfalse\n')}`,
    () => cleanUpMerge(checkout, { ...pullRequest(tip), url }, idle),
  );

  assert.deepEqual(await branches(checkout), ['feat/old', 'main']);
  assert.equal(await git(checkout, 'rev-parse', 'feat/old'), old);
  assert.ok(typeof result === 'object' && result.cleaned);
  assert.match(result.text, /origin's URL changed during cleanup/);
});

for (const during of ['gone deletion', 'retained config removal'])
  test(`resuming after interruption during ${during} finishes config cleanup without stale failure notices`, async () => {
    const { root, checkout, other, tip } = await merged();
    await older(checkout, other, 'feat/old');
    const policyFailure = during === 'gone deletion';

    if (policyFailure) await older(checkout, other, 'feat/gone', false);

    await merge(other, 'feat/x');
    const entered = join(root, 'entered');
    const queried = join(root, 'queried');
    const progress: MergeCleanup = {};
    const controller = new AbortController();

    const result = await withGit(
      root,
      `
const target = ${JSON.stringify(policyFailure)}
  ? args[0] === 'branch' && args[1] === '-d' && args.at(-1) === 'feat/gone'
  : args[0] === 'config' && args[1] === '--remove-section' && args[2] === 'branch.feat/old';
if (target && !existsSync(${JSON.stringify(entered)})) {
  writeFileSync(${JSON.stringify(entered)}, 'entered');
  spawnSync('/bin/sleep', ['30']);
}
`,
      () =>
        withGh(
          root,
          `${policyFailure ? `if [ ! -e ${quote(queried)} ]; then touch ${quote(queried)}; ${failing}; fi\n` : ''}${answering('false\nmain\nfalse\n')}`,
          async () => {
            const first = cleanUpMerge(
              checkout,
              { ...pullRequest(tip), url },
              idle,
              { signal: controller.signal, progress },
            );

            try {
              await until(
                'the pruning interruption',
                () => exists(entered),
                500,
              );
            } finally {
              controller.abort();
            }

            await assert.rejects(first);

            return cleanUpMerge(checkout, { ...pullRequest(tip), url }, idle, {
              progress,
            });
          },
        ),
    );

    assert.deepEqual(await branches(checkout), ['main']);

    await assert.rejects(
      git(checkout, 'config', '--get', 'branch.feat/old.merge'),
    );

    assert.ok(typeof result === 'object' && result.cleaned);
    assert.match(result.text, /deleted branches feat\/x.*feat\/old/);

    assert.doesNotMatch(
      result.text,
      /retained merged branches stayed|config section/,
    );

    assert.equal(result.text.match(/feat\/old/g)?.length, 1);
  });

test('a worktree acquired during the upstream-tip read keeps its branch and config', async () => {
  const { root, checkout, other, tip } = await merged();
  const old = await older(checkout, other, 'feat/old');
  await merge(other, 'feat/x');
  const holder = join(root, 'holder');

  await withGit(
    root,
    `
if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'refs/remotes/origin/feat/old' && !existsSync(${JSON.stringify(holder)})) {
  const added = run(['worktree', 'add', ${JSON.stringify(holder)}, 'feat/old'], 'pipe');
  if (added.status) { process.stderr.write(added.stderr); process.exit(added.status); }
}
`,
    () =>
      withGh(root, answering('false\nmain\nfalse\n'), () =>
        cleanUpMerge(checkout, { ...pullRequest(tip), url }, idle),
      ),
  );

  assert.deepEqual(await branches(checkout), ['feat/old', 'main']);
  assert.equal(await git(holder, 'rev-parse', 'HEAD'), old);

  assert.equal(
    await git(checkout, 'config', '--get', 'branch.feat/old.merge'),
    'refs/heads/feat/old',
  );
});

for (const mode of ['bisect', 'rebase', 'apply', 'update-refs'])
  test(`retained pruning preserves branches owned by ${mode} with a detached worktree HEAD`, async () => {
    const { root, origin, launcher, checkout, other, tip } = await merged(
      {},
      [],
      mode === 'bisect',
    );

    const base = await git(checkout, 'rev-parse', 'main');
    await older(checkout, other, 'feat/old');
    await git(checkout, 'switch', 'feat/old');
    await git(checkout, 'commit', '--allow-empty', '-m', 'middle');
    await write(join(checkout, 'shared.txt'), 'old\n');
    await git(checkout, 'add', 'shared.txt');
    await git(checkout, 'commit', '-m', 'last');
    const old = await git(checkout, 'rev-parse', 'HEAD');
    await git(checkout, 'push');
    await merge(other, 'feat/old', true);
    await git(checkout, 'switch', 'feat/x');
    await merge(other, 'feat/x');

    if (mode === 'apply') {
      await git(checkout, 'switch', '-c', 'target', base);
      await write(join(checkout, 'shared.txt'), 'target\n');
      await git(checkout, 'add', 'shared.txt');
      await git(checkout, 'commit', '-m', 'target');
      await git(checkout, 'switch', 'feat/x');
    }

    const holder = mode === 'bisect' ? launcher : join(root, 'holder');

    if (mode === 'bisect') await git(holder, 'switch', 'feat/old');
    else if (mode === 'update-refs')
      await git(
        checkout,
        'worktree',
        'add',
        '-b',
        'control',
        holder,
        'feat/old',
      );
    else await git(checkout, 'worktree', 'add', holder, 'feat/old');

    if (mode === 'bisect')
      await git(holder, 'bisect', 'start', 'feat/old', base);
    else if (mode === 'apply')
      await assert.rejects(
        git(holder, 'rebase', '--apply', '--onto', 'target', base),
      );
    else {
      const editor = await editingSequence(root);

      await git(
        holder,
        '-c',
        `sequence.editor=${quote(editor)}`,
        'rebase',
        '-i',
        '--force-rebase',
        '--keep-empty',
        ...(mode === 'update-refs' ? ['--update-refs'] : []),
        base,
      );
    }

    await assert.rejects(git(holder, 'symbolic-ref', '-q', 'HEAD'));

    assert.equal(
      await git(
        checkout,
        'for-each-ref',
        '--format=%(worktreepath)',
        'refs/heads/feat/old',
      ),
      '',
    );

    await assert.rejects(
      git(checkout, 'branch', '-d', 'feat/old'),
      /used by worktree/,
    );

    const result = await withGh(root, answering('false\nmain\nfalse\n'), () =>
      cleanUpMerge(checkout, { ...pullRequest(tip), url }, idle),
    );

    assert.ok(typeof result === 'object' && result.cleaned);
    assert.equal(await git(checkout, 'rev-parse', 'feat/old'), old);
    assert.equal(await git(origin, 'rev-parse', 'feat/old'), old);

    assert.equal(
      await git(checkout, 'config', '--get', 'branch.feat/old.merge'),
      'refs/heads/feat/old',
    );

    assert.equal((await branches(checkout)).includes('feat/x'), false);

    await git(
      holder,
      ...(mode === 'bisect' ? ['bisect', 'reset'] : ['rebase', '--abort']),
    );

    assert.equal(await git(holder, 'rev-parse', 'HEAD'), old);

    assert.equal(
      await git(holder, 'symbolic-ref', '--short', 'HEAD'),
      mode === 'update-refs' ? 'control' : 'feat/old',
    );
  });
