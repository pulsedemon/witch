import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { chmod, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeEach, test, vi } from 'vitest';
import { cleanUpMerge } from '../../../src/core/repository/merged.js';
import type { MergeCleanup } from '../../../src/core/repository/merged.js';
import { quote } from '../../../src/shell.js';
import {
  branches,
  idle,
  merge,
  merged,
  pullRequest,
  write,
} from '../../fixtures/merged.js';
import { git } from '../../fixtures/git.js';
import {
  configureGitEnvironment,
  execute,
} from '../../fixtures/merged-environment.js';
import { exists, until } from '../../fixtures/within.js';

configureGitEnvironment();
const plans = (checkout: string) => join(checkout, 'docs/superpowers/plans');
const plan = '`git switch -c feat/x`.\n';

const held = {
  text: '#7 merged, but feat/x is checked out, rebased or bisected in a worktree, so it stays.',
  cleaned: false,
};

const recreated = {
  text: '#7 merged, but feat/x was recreated, so it stays.',
  cleaned: false,
};

beforeEach(() => {
  const timeout = AbortSignal.timeout;

  // the check after an interrupted deletion must not depend on how fast Git starts under load
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) =>
    ms === 1000 ? new AbortController().signal : timeout(ms),
  );
});

const noConfig = (checkout: string) =>
  assert.rejects(
    git(checkout, 'config', '--get-regexp', '^branch\\.feat/x\\.'),
    {
      code: 1,
    },
  );

/** two more commits on `feat/x`, so a bisect between it and `main` checks out a commit in between. returns its tip. */
async function deeper(checkout: string) {
  await git(checkout, 'commit', '--allow-empty', '-m', 'middle');
  await write(join(checkout, 'shared.txt'), 'x\n');
  await git(checkout, 'add', 'shared.txt');
  await git(checkout, 'commit', '-m', 'last');
  await git(checkout, 'push');

  return git(checkout, 'rev-parse', 'HEAD');
}

/** a branch at `main` whose upstream is gone, which the on-branch cleanup would prune. */
async function gone(checkout: string, name: string) {
  await git(checkout, 'switch', '-c', name, 'main');
  await git(checkout, 'push', '-u', 'origin', name);
  await git(checkout, 'push', 'origin', '--delete', name);
}

/** runs `body` with a node `git` first on PATH that runs `script` before passing the command on. */
async function withGit<T>(
  root: string,
  script: string,
  body: () => Promise<T>,
): Promise<T> {
  const realGit = (await execute('/usr/bin/which', ['git'])).stdout.trim();
  const previousPath = process.env.PATH;
  const bin = join(root, 'bin');

  await write(
    join(bin, 'git'),
    `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const run = (args, stdio = 'inherit') => spawnSync(${JSON.stringify(realGit)}, args, { stdio });
${script}
process.exit(run(args).status ?? 1);
`,
  );

  await chmod(join(bin, 'git'), 0o755);
  process.env.PATH = `${bin}:${previousPath}`;

  try {
    return await body();
  } finally {
    process.env.PATH = previousPath;
  }
}

/** an `upload-pack` that touches `marker` and sleeps on the `nth` fetch from `origin`. */
async function slowFetch(root: string, checkout: string, nth: number) {
  const pack = join(root, 'upload-pack');
  const count = join(root, 'fetches');
  const marker = join(root, 'fetching');

  await write(
    pack,
    `#!/bin/sh\nn=$(($(cat ${quote(count)} 2>/dev/null || echo 0) + 1))\necho $n > ${quote(count)}\nif [ $n -eq ${nth} ]; then touch ${quote(marker)}; sleep 30; fi\nexec git upload-pack "$@"\n`,
  );

  await chmod(pack, 0o755);
  await git(checkout, 'config', 'remote.origin.uploadpack', pack);

  return marker;
}

/** a hook in `checkout` named `name` that runs `body`. */
async function hook(
  root: string,
  checkout: string,
  name: string,
  body: string,
) {
  const hooks = join(root, 'hooks');
  await write(join(hooks, name), `#!/bin/sh\n${body}\n`);
  await chmod(join(hooks, name), 0o755);
  await git(checkout, 'config', 'core.hooksPath', hooks);
}

/** starts a cleanup, aborts it once `marker` appears, and returns its progress after it rejects. */
async function interrupt(
  checkout: string,
  tip: string,
  marker: string,
  progress: MergeCleanup = {},
) {
  const controller = new AbortController();

  const first = cleanUpMerge(checkout, pullRequest(tip), idle, {
    signal: controller.signal,
    progress,
  });

  try {
    await until('the held command', () => exists(marker), 500);
  } finally {
    controller.abort();
  }

  await assert.rejects(first);

  return progress;
}

test('a pull request that merges while its checkout sits on the base is cleaned up from there', async () => {
  const { checkout, other, tip } = await merged();
  await gone(checkout, 'feat/z');
  await git(checkout, 'switch', 'main');
  await write(join(plans(checkout), 'x.md'), plan);
  await merge(other, 'feat/x');

  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
    text: '#7 merged: stayed on main and pulled, deleted branch feat/x, and plan x.md.',
    cleaned: true,
  });

  // this cleanup prunes nothing, so feat/z stays
  assert.deepEqual(await branches(checkout), ['feat/z', 'main']);
  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');

  assert.equal(
    await git(checkout, 'rev-parse', 'main'),
    await git(other, 'rev-parse', 'HEAD'),
  );

  assert.equal(await exists(join(plans(checkout), 'x.md')), false);
  await noConfig(checkout);
});

test("a pull request that merges while its checkout sits on a base tracking another remote fetches the head branch's own", async () => {
  const { root, origin, checkout, other, tip } = await merged();
  const upstream = join(root, 'upstream.git');
  const fork = join(root, 'fork');
  await git(checkout, 'switch', 'main');
  await git(root, 'clone', '--bare', origin, upstream);
  await git(checkout, 'remote', 'add', 'upstream', upstream);
  await git(checkout, 'fetch', 'upstream');
  await git(checkout, 'branch', '--set-upstream-to=upstream/main', 'main');
  await git(root, 'clone', upstream, fork);
  await git(fork, 'merge', '--no-ff', '-m', 'merge feat/x', 'origin/feat/x');
  await git(fork, 'push', 'origin', 'main');
  // only a fetch of origin shows feat/x gone
  await git(other, 'push', 'origin', '--delete', 'feat/x');

  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
    text: '#7 merged: stayed on main and pulled, deleted branch feat/x.',
    cleaned: true,
  });

  const landed = await git(fork, 'rev-parse', 'HEAD');
  assert.equal(await git(checkout, 'rev-parse', 'main'), landed);
  assert.equal(await git(checkout, 'rev-parse', 'upstream/main'), landed);
});

for (const detach of [false, true])
  test(`a checkout on other work keeps its place and loses only the merged branch${detach ? ', detached in a worktree' : ''}`, async () => {
    const { checkout, other, tip } = await merged({}, [], detach);
    await gone(checkout, 'feat/z');
    await git(checkout, 'switch', '-c', 'feat/y');
    await git(checkout, 'commit', '--allow-empty', '-m', 'y');

    if (detach) {
      await git(checkout, 'switch', '--detach', 'feat/y');
      // a linked worktree's cleanup on the merged branch would need it
      await git(checkout, 'branch', '--unset-upstream', 'main');
    }

    const head = await git(checkout, 'rev-parse', 'HEAD');
    const main = await git(checkout, 'rev-parse', 'main');
    await merge(other, 'feat/x');

    assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
      text: detach
        ? '#7 merged: left the detached checkout where it was, deleted branch feat/x.'
        : '#7 merged: left feat/y checked out, deleted branch feat/x.',
      cleaned: true,
    });

    assert.equal(
      await git(checkout, 'branch', '--show-current'),
      detach ? '' : 'feat/y',
    );

    assert.equal(await git(checkout, 'rev-parse', 'HEAD'), head);
    assert.equal(await git(checkout, 'rev-parse', 'main'), main);
    assert.deepEqual(await branches(checkout), ['feat/y', 'feat/z', 'main']);
  });

test('a left branch stays when it moved or a worktree holds it', async () => {
  {
    const { checkout, other, tip } = await merged();
    await merge(other, 'feat/x');
    await git(checkout, 'commit', '--allow-empty', '-m', 'after');
    const moved = await git(checkout, 'rev-parse', 'HEAD');
    await git(checkout, 'switch', 'main');

    assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
      text: "#7 merged, but feat/x's last commit isn't the one it merged, so it stays.",
      cleaned: false,
    });

    assert.equal(await git(checkout, 'rev-parse', 'feat/x'), moved);
  }

  for (const bisect of [false, true]) {
    const { root, checkout, other } = await merged();
    const base = await git(checkout, 'rev-parse', 'main');

    const tip = bisect
      ? await deeper(checkout)
      : await git(checkout, 'rev-parse', 'HEAD');

    await merge(other, 'feat/x');
    await git(checkout, 'switch', 'main');
    const holder = join(root, 'holder');
    await git(checkout, 'worktree', 'add', holder, 'feat/x');

    if (bisect) await git(holder, 'bisect', 'start', 'feat/x', base);

    assert.deepEqual(
      await cleanUpMerge(checkout, pullRequest(tip), idle),
      held,
    );

    assert.equal(await git(checkout, 'rev-parse', 'feat/x'), tip);

    if (bisect) {
      await assert.rejects(git(holder, 'symbolic-ref', '-q', 'HEAD'));
      await git(holder, 'bisect', 'log');
    } else
      assert.equal(await git(holder, 'branch', '--show-current'), 'feat/x');
  }
});

test("a bisect of the merged branch in the checkout itself waits for it, and the on-branch cleanup runs once it's reset", async () => {
  const { checkout, other } = await merged();
  const base = await git(checkout, 'rev-parse', 'main');
  const tip = await deeper(checkout);
  await merge(other, 'feat/x');
  await git(checkout, 'bisect', 'start', 'feat/x', base);
  await assert.rejects(git(checkout, 'symbolic-ref', '-q', 'HEAD'));
  const progress: MergeCleanup = {};

  assert.equal(
    await cleanUpMerge(checkout, pullRequest(tip), idle, { progress }),
    'changed',
  );

  assert.equal(await git(checkout, 'rev-parse', 'feat/x'), tip);
  await git(checkout, 'bisect', 'reset');

  assert.deepEqual(
    await cleanUpMerge(checkout, pullRequest(tip), idle, { progress }),
    {
      text: '#7 merged: switched to main and pulled, deleted branch feat/x.',
      cleaned: true,
    },
  );
});

test('a checkout that goes back to the merged branch during the fetch keeps it', async () => {
  const { checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  await git(checkout, 'switch', 'main');
  let checks = 0;

  const blocked = async () => {
    if (++checks === 2) await git(checkout, 'switch', 'feat/x');

    return false;
  };

  assert.equal(
    await cleanUpMerge(checkout, pullRequest(tip), blocked),
    'changed',
  );

  assert.equal(await git(checkout, 'rev-parse', 'feat/x'), tip);
  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
});

/**
 * waits until a reader has the FIFO open, runs `act`, then lets the reader see another branch. the FIFO goes before the
 * reader can finish, so the scan after it finds nothing.
 */
async function hold(fifo: string, act: () => Promise<unknown>) {
  let writer: FileHandle | undefined;

  for (let attempt = 0; !writer; attempt++)
    try {
      writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      // ENXIO: nobody has it open to read yet
      if ((error as NodeJS.ErrnoException).code !== 'ENXIO' || attempt > 1000)
        throw error;

      await delay(10);
    }

  try {
    await act();
    await writer.write('feat/other\n');
    await unlink(fifo);
  } finally {
    await writer.close();
  }
}

for (const during of ['switch', 'worktree'] as const)
  test(`a ${during === 'switch' ? 'switch back to' : 'worktree that takes'} the merged branch while its owners are scanned keeps it`, async () => {
    const { root, checkout, other, tip } = await merged();
    await merge(other, 'feat/x');
    await git(checkout, 'switch', 'main');
    const fifo = join(checkout, '.git', 'BISECT_START');
    const holder = join(root, 'holder');
    let holding: Promise<void> | undefined;
    let checks = 0;

    // the read of the checkout's own Git dir before the fetch would open a FIFO that was there from the start
    const blocked = async () => {
      if (++checks === 2) {
        await execute('/usr/bin/mkfifo', [fifo]);

        holding = hold(fifo, () =>
          during === 'switch'
            ? git(checkout, 'switch', 'feat/x')
            : git(checkout, 'worktree', 'add', holder, 'feat/x'),
        );
      }

      return false;
    };

    const result = await cleanUpMerge(checkout, pullRequest(tip), blocked);
    await holding;
    assert.deepEqual(result, during === 'switch' ? 'changed' : held);
    assert.equal(await git(checkout, 'rev-parse', 'feat/x'), tip);
  });

test('a bisect that a worktree starts from the merged branch right before the deletion keeps it', async () => {
  const { root, checkout, other } = await merged();
  const base = await git(checkout, 'rev-parse', 'main');
  const tip = await deeper(checkout);
  await merge(other, 'feat/x');
  await git(checkout, 'switch', 'main');
  const holder = join(root, 'holder');

  const result = await withGit(
    root,
    `
if (args[0] === 'for-each-ref' && args[1] === '--format=%(refname)%09%(worktreepath)') {
  for (const command of [['worktree', 'add', ${JSON.stringify(holder)}, 'feat/x'], ['-C', ${JSON.stringify(holder)}, 'bisect', 'start', 'feat/x', ${JSON.stringify(base)}]]) {
    const started = run(command, 'pipe');
    if (started.status) { process.stderr.write(started.stderr); process.exit(started.status); }
  }
}
`,
    () => cleanUpMerge(checkout, pullRequest(tip), idle),
  );

  assert.deepEqual(result, held);
  assert.equal(await git(checkout, 'rev-parse', 'feat/x'), tip);
  await assert.rejects(git(holder, 'symbolic-ref', '-q', 'HEAD'));
  await git(holder, 'bisect', 'log');
});

test('a modified tracked file on the base stops the cleanup before it deletes anything', async () => {
  const { checkout, other, tip } = await merged({ 'a.txt': 'a\n' });
  await merge(other, 'feat/x');
  await git(checkout, 'switch', 'main');
  await write(join(plans(checkout), 'x.md'), plan);
  await write(join(checkout, 'a.txt'), 'changed\n');
  assert.equal(await cleanUpMerge(checkout, pullRequest(tip), idle), 'changed');
  assert.deepEqual(await branches(checkout), ['feat/x', 'main']);
  assert.ok(await exists(join(plans(checkout), 'x.md')));
});

test('a branch that is already gone still loses its plans, and the base is still brought up to date', async () => {
  for (const pulled of [false, true]) {
    const { checkout, other, tip } = await merged();
    await merge(other, 'feat/x');
    await git(checkout, 'switch', 'main');

    if (pulled) await git(checkout, 'pull', '--ff-only');

    await git(checkout, 'branch', '-D', 'feat/x');
    await write(join(plans(checkout), 'x.md'), plan);

    // a cleanup that moved nothing doesn't refresh Witch's install again
    assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
      text: '#7 merged: stayed on main and pulled. feat/x was already gone; removed plan x.md.',
      cleaned: !pulled,
    });

    assert.equal(await exists(join(plans(checkout), 'x.md')), false);

    assert.equal(
      await git(checkout, 'rev-parse', 'main'),
      await git(other, 'rev-parse', 'HEAD'),
    );
  }

  const { checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  await git(checkout, 'switch', '-c', 'feat/y', 'main');
  await git(checkout, 'branch', '-D', 'feat/x');

  assert.deepEqual(await cleanUpMerge(checkout, pullRequest(tip), idle), {
    text: '#7 merged: left feat/y checked out. feat/x was already gone.',
    cleaned: false,
  });
});

test('an interrupted cleanup on the base starts again from the top, with the base where it went since', async () => {
  const { root, checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  await git(checkout, 'switch', 'main');
  // the head branch's fetch is the first, and the fast-forward's the second
  const marker = await slowFetch(root, checkout, 2);
  const progress = await interrupt(checkout, tip, marker);
  assert.deepEqual(await branches(checkout), ['main']);
  await git(checkout, 'config', '--unset', 'remote.origin.uploadpack');
  await git(other, 'commit', '--allow-empty', '-m', 'newer');
  await git(other, 'push', 'origin', 'main');
  await git(checkout, 'pull', '--ff-only');
  await git(other, 'commit', '--allow-empty', '-m', 'last');
  await git(other, 'push', 'origin', 'main');

  assert.deepEqual(
    await cleanUpMerge(checkout, pullRequest(tip), idle, { progress }),
    {
      text: '#7 merged: stayed on main and pulled, deleted branch feat/x.',
      cleaned: true,
    },
  );

  assert.equal(
    await git(checkout, 'rev-parse', 'main'),
    await git(other, 'rev-parse', 'HEAD'),
  );
});

test('a deletion interrupted off the merged branch is recorded, and a branch recreated afterwards stays', async () => {
  const { root, checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  await git(checkout, 'switch', '-c', 'feat/y', 'main');
  const marker = join(root, 'deleting');

  await hook(
    root,
    checkout,
    'reference-transaction',
    `[ "$1" = committed ] || exit 0\ngrep -q ' refs/heads/feat/x$' || exit 0\ntouch ${quote(marker)}\nsleep 30`,
  );

  const progress = await interrupt(checkout, tip, marker);
  await git(checkout, 'config', '--unset', 'core.hooksPath');
  assert.deepEqual(await branches(checkout), ['feat/y', 'main']);
  assert.deepEqual(progress.deleted, ['feat/x']);
  await git(checkout, 'commit', '--allow-empty', '-m', 'y');

  assert.deepEqual(
    await cleanUpMerge(checkout, pullRequest(tip), idle, {
      progress: structuredClone(progress),
    }),
    {
      text: '#7 merged: left feat/y checked out, deleted branch feat/x.',
      cleaned: true,
    },
  );

  await noConfig(checkout);
  await git(checkout, 'branch', 'feat/x', tip);
  await git(checkout, 'config', 'branch.feat/x.remote', 'origin');
  await git(checkout, 'config', 'branch.feat/x.merge', 'refs/heads/feat/x');

  assert.deepEqual(
    await cleanUpMerge(checkout, pullRequest(tip), idle, {
      progress: structuredClone(progress),
    }),
    recreated,
  );

  assert.equal(await git(checkout, 'rev-parse', 'feat/x'), tip);

  assert.equal(
    await git(checkout, 'config', 'branch.feat/x.merge'),
    'refs/heads/feat/x',
  );
});

test('an already gone branch interrupted inside the fast-forward counts the base it moved, wherever the checkout went since', async () => {
  const { root, checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  await git(checkout, 'switch', 'main');
  await git(checkout, 'branch', 'feat/y');
  await git(checkout, 'branch', '-D', 'feat/x');
  const marker = join(root, 'merging');
  await hook(root, checkout, 'post-merge', `touch ${quote(marker)}\nsleep 30`);
  const progress = await interrupt(checkout, tip, marker);
  await git(checkout, 'config', '--unset', 'core.hooksPath');

  assert.equal(
    await git(checkout, 'rev-parse', 'main'),
    await git(other, 'rev-parse', 'HEAD'),
  );

  assert.deepEqual(
    await cleanUpMerge(checkout, pullRequest(tip), idle, {
      progress: structuredClone(progress),
    }),
    {
      text: '#7 merged: stayed on main and pulled. feat/x was already gone.',
      cleaned: true,
    },
  );

  await git(checkout, 'switch', 'feat/y');

  assert.deepEqual(
    await cleanUpMerge(checkout, pullRequest(tip), idle, {
      progress: structuredClone(progress),
    }),
    {
      text: '#7 merged: left feat/y checked out. feat/x was already gone.',
      cleaned: true,
    },
  );

  await git(checkout, 'branch', 'feat/x', tip);
  await git(checkout, 'config', 'branch.feat/x.remote', 'origin');
  await git(checkout, 'config', 'branch.feat/x.merge', 'refs/heads/feat/x');
  await git(checkout, 'switch', 'feat/x');

  assert.deepEqual(
    await cleanUpMerge(checkout, pullRequest(tip), idle, {
      progress: structuredClone(progress),
    }),
    recreated,
  );

  assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');
  assert.equal(await git(checkout, 'rev-parse', 'feat/x'), tip);

  assert.equal(
    await git(checkout, 'config', 'branch.feat/x.merge'),
    'refs/heads/feat/x',
  );
});

test("an already gone branch interrupted inside the fast-forward's fetch doesn't count a base that never moved", async () => {
  const { root, checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  await git(checkout, 'switch', '-c', 'feat/y', 'main');
  await git(checkout, 'commit', '--allow-empty', '-m', 'y');
  await git(checkout, 'switch', 'main');
  await git(checkout, 'branch', '-D', 'feat/x');
  const marker = await slowFetch(root, checkout, 1);
  const progress = await interrupt(checkout, tip, marker);
  await git(checkout, 'config', '--unset', 'remote.origin.uploadpack');
  await git(checkout, 'switch', 'feat/y');

  assert.deepEqual(
    await cleanUpMerge(checkout, pullRequest(tip), idle, { progress }),
    {
      text: '#7 merged: left feat/y checked out. feat/x was already gone.',
      cleaned: false,
    },
  );
});

test('a cleanup interrupted off the merged branch before the deletion ends as the on-branch cleanup once the checkout is back', async () => {
  const { checkout, other, tip } = await merged();
  await merge(other, 'feat/x');
  await git(checkout, 'switch', '-c', 'feat/y', 'main');
  const controller = new AbortController();
  const progress: MergeCleanup = {};
  let checks = 0;

  // the second check comes after the fetch, right before the deletion's reads
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

  assert.equal(await git(checkout, 'rev-parse', 'feat/x'), tip);
  await git(checkout, 'switch', 'feat/x');

  assert.deepEqual(
    await cleanUpMerge(checkout, pullRequest(tip), idle, { progress }),
    {
      text: '#7 merged: switched to main and pulled, deleted branch feat/x.',
      cleaned: true,
    },
  );
});

for (const back of [false, true])
  test(`a switch made while the fast-forward resolves its target can't move another branch or bring in another branch's upstream${back ? ', switching back after' : ''}`, async () => {
    const { root, checkout, other, tip } = await merged();
    await git(checkout, 'switch', 'main');
    const base = await git(checkout, 'rev-parse', 'main');
    await merge(other, 'feat/x');
    const mergeCommit = await git(other, 'rev-parse', 'HEAD');
    await git(other, 'switch', '-c', 'feat/y');
    await git(other, 'commit', '--allow-empty', '-m', 'y');
    await git(other, 'push', '-u', 'origin', 'feat/y');
    await git(checkout, 'fetch', 'origin', 'feat/y:refs/remotes/origin/feat/y');
    await git(checkout, 'branch', 'feat/y', base);
    await git(checkout, 'branch', '--set-upstream-to=origin/feat/y', 'feat/y');
    const switched = join(root, 'switched');

    const cleanup = withGit(
      root,
      `
if (args[0] === 'rev-parse' && args.at(-1).endsWith('@{upstream}')) {
  if (run(['switch', 'feat/y'], 'pipe').status) process.exit(1);
  require('node:fs').writeFileSync(${JSON.stringify(switched)}, '');
  ${
    back
      ? `const result = run(args, 'pipe');
  run(['switch', 'main'], 'pipe');
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);`
      : ''
  }
}
`,
      () => cleanUpMerge(checkout, pullRequest(tip), idle),
    );

    if (back) {
      assert.deepEqual(await cleanup, {
        text: '#7 merged: stayed on main and pulled, deleted branch feat/x.',
        cleaned: true,
      });

      assert.equal(await git(checkout, 'rev-parse', 'main'), mergeCommit);
    } else {
      await assert.rejects(cleanup, {
        message:
          "#7 merged: stayed on main and deleted branch feat/x, but main didn't fast-forward: the checkout left main or changed during the fetch",
      });

      assert.equal(await git(checkout, 'rev-parse', 'main'), base);
    }

    assert.ok(await exists(switched));
    assert.equal(await git(checkout, 'rev-parse', 'feat/y'), base);
  });
