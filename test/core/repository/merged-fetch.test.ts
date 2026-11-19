import assert from 'node:assert/strict';
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { Memory } from '../../../src/memory/memory.js';
import { StateStore } from '../../../src/persistence/store.js';
import { runMergeCleanup } from '../../../src/core/repository/merged.js';
import type { MergeCleanup } from '../../../src/core/repository/merged.js';
import type { PullRequest } from '../../../src/core/repository/repository.js';
import { record } from '../../fixtures/coordinator.js';
import { git } from '../../fixtures/git.js';
import {
  answering,
  branches,
  merge,
  merged,
  pullRequest,
  url,
  withGh,
  withGit,
  write,
} from '../../fixtures/merged.js';
import { configureGitEnvironment } from '../../fixtures/merged-environment.js';
import { exists, until } from '../../fixtures/within.js';

configureGitEnvironment();

async function operation(root: string, cwd: string) {
  const store = await StateStore.open(join(root, 'state'));
  const memory = new Memory(join(root, 'memory.git'));
  const notices: string[] = [];

  return {
    notices,
    run: (
      request: PullRequest,
      progress: MergeCleanup = {},
      signal = new AbortController().signal,
    ) =>
      runMergeCleanup(request, progress, {
        store,
        memory,
        conversation: record('c', cwd),
        signal,
        notice: (text) => notices.push(text),
      }),
  };
}

const mismatch = (ref = 'refs/remotes/origin/main') =>
  `error: cannot lock ref '${ref}': is at ${'a'.repeat(40)} but expected ${'b'.repeat(40)}\n`;

test('a cleanup losing a real fetch race retries after the sibling cleanup and removes both branches and plans', async () => {
  const { root, origin, launcher, checkout, other, tip } = await merged(
    {},
    [],
    true,
  );

  const peer = join(root, 'peer');
  await git(launcher, 'worktree', 'add', '-b', 'feat/y', peer, 'main');
  await git(peer, 'commit', '--allow-empty', '-m', 'y');
  const peerTip = await git(peer, 'rev-parse', 'HEAD');
  await git(peer, 'push', '-u', 'origin', 'feat/y');
  const held = await git(launcher, 'rev-parse', 'HEAD');
  const plan = (cwd: string) => join(cwd, 'docs/superpowers/plans/branch.md');
  await write(plan(checkout), 'git switch -c feat/x\n');
  await write(plan(peer), 'git switch -c feat/y\n');
  await merge(other, 'feat/x');
  await merge(other, 'feat/y');
  const expected = await git(origin, 'rev-parse', 'main');
  const entered = join(root, 'entered');
  const release = join(root, 'release');
  const once = join(root, 'once');
  const output = join(root, 'fetch.json');
  const upload = join(root, 'upload.mjs');

  await write(
    upload,
    `#!${process.execPath}
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
const child = spawn('git', ['upload-pack', ...process.argv.slice(2)], { stdio: ['pipe', 'inherit', 'inherit'] });
child.on('exit', (code) => process.exit(code ?? 1));
let held = false;
for await (const bytes of process.stdin) {
  if (!held && bytes.includes('want ')) {
    held = true;
    writeFileSync(${JSON.stringify(entered)}, '');
    while (!existsSync(${JSON.stringify(release)})) await setTimeout(10);
  }
  child.stdin.write(bytes);
}
child.stdin.end();
`,
  );

  await chmod(upload, 0o755);
  const first = await operation(root, checkout);
  const second = await operation(root, peer);
  const progress: MergeCleanup = {};
  const controller = new AbortController();

  await withGit(
    root,
    `
if (process.cwd() === ${JSON.stringify(checkout)} && args.includes('fetch') && !existsSync(${JSON.stringify(once)})) {
  writeFileSync(${JSON.stringify(once)}, '');
  const result = run(['-c', 'protocol.version=0', '-c', ${JSON.stringify(`remote.origin.uploadpack=${upload}`)}, ...args], 'pipe');
  writeFileSync(${JSON.stringify(output)}, JSON.stringify({ code: result.status, stderr: result.stderr.toString() }));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
`,
    async () => {
      const pending = first.run(pullRequest(tip), progress, controller.signal);

      try {
        await until('the first fetch wants its objects', () => exists(entered));

        assert.equal(
          await second.run({
            ...pullRequest(peerTip),
            number: 8,
            url: 'https://x.test/8',
            branch: 'feat/y',
          }),
          true,
        );

        assert.equal(await git(checkout, 'rev-parse', 'origin/main'), expected);
        await write(release, '');
        assert.equal(await pending, 'retry');
        assert.deepEqual(first.notices, []);
        assert.equal(await exists(plan(checkout)), true);
        assert.equal(await git(checkout, 'branch', '--show-current'), 'feat/x');

        const failure = JSON.parse(await readFile(output, 'utf8')) as {
          code: number;
          stderr: string;
        };

        assert.equal(failure.code, 1);
        assert.match(failure.stderr, /cannot lock ref.*is at .*but expected/);
        assert.equal(await first.run(pullRequest(tip), progress), true);
      } finally {
        await write(release, '');
        controller.abort();
        await pending.catch(() => {});
      }
    },
  );

  assert.deepEqual(await branches(checkout), ['main']);
  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), expected);
  assert.equal(await git(peer, 'rev-parse', 'HEAD'), expected);
  await assert.rejects(git(checkout, 'symbolic-ref', '-q', 'HEAD'));
  await assert.rejects(git(peer, 'symbolic-ref', '-q', 'HEAD'));
  assert.equal(await git(launcher, 'rev-parse', 'HEAD'), held);
  assert.equal(await exists(plan(checkout)), false);
  assert.equal(await exists(plan(peer)), false);
  assert.equal(first.notices.length, 1);
  assert.equal(second.notices.length, 1);
});

for (const phase of ['base fetch', 'retained refresh'])
  test(`a conflict during ${phase} retains completed deletion and finishes on retry`, async () => {
    const { root, origin, checkout, other, tip } = await merged();
    const plan = join(checkout, 'docs/superpowers/plans/x.md');
    await write(plan, 'git switch -c feat/x\n');

    if (phase === 'retained refresh') {
      await git(checkout, 'switch', '-c', 'feat/old', 'main');
      await git(checkout, 'commit', '--allow-empty', '-m', 'old');
      await git(checkout, 'push', '-u', 'origin', 'feat/old');
      await merge(other, 'feat/old', true);
      await git(checkout, 'switch', 'feat/x');
    }

    await merge(other, 'feat/x');
    const expected = await git(origin, 'rev-parse', 'main');
    const once = join(root, 'once');
    const deleted = join(root, 'deleted');
    const operationIn = await operation(root, checkout);
    const progress: MergeCleanup = {};
    const request = { ...pullRequest(tip), url };

    await withGit(
      root,
      `
if (args[0] === 'update-ref' && args[1] === '-d') {
  writeFileSync(${JSON.stringify(deleted)}, args[2] + '\\n', { flag: 'a' });
}
if (args.includes('fetch') && args.at(-1) === ${JSON.stringify(phase === 'base fetch' ? 'fetch' : 'origin')} && !existsSync(${JSON.stringify(once)})) {
  writeFileSync(${JSON.stringify(once)}, '');
  process.stderr.write(${JSON.stringify(mismatch())});
  process.exit(1);
}
`,
      () =>
        withGh(root, answering('false\nmain\nfalse\n'), async () => {
          assert.equal(await operationIn.run(request, progress), 'retry');
          assert.deepEqual(progress.deleted, ['feat/x']);
          assert.equal(progress.plans?.done, true);
          assert.equal(await exists(plan), false);
          assert.deepEqual(operationIn.notices, []);
          const removed = progress.deleted;
          const plans = progress.plans;
          assert.equal(await operationIn.run(request, progress), true);
          assert.equal(progress.deleted, removed);
          assert.equal(progress.plans, plans);
        }),
    );

    assert.equal(await git(checkout, 'rev-parse', 'HEAD'), expected);
    assert.deepEqual(await branches(checkout), ['main']);
    assert.equal(operationIn.notices.length, 1);

    assert.deepEqual(
      (await readFile(deleted, 'utf8')).trim().split('\n'),
      phase === 'base fetch'
        ? ['refs/heads/feat/x']
        : ['refs/heads/feat/x', 'refs/heads/feat/old'],
    );
  });

for (const [name, code, stderr] of [
  ['wrong exit status', 128, mismatch()],
  [
    'a lock file collision',
    1,
    "error: cannot lock ref 'refs/remotes/origin/main': File exists\n",
  ],
  ['a local head mismatch', 1, mismatch('refs/heads/main')],
  ['a mixed fatal failure', 1, `${mismatch()}fatal: transport failed\n`],
  ['a mixed remote failure', 1, `${mismatch()}remote: error: rejected\n`],
] as const)
  test(`${name} remains a terminal cleanup failure with its diagnostic`, async () => {
    const { root, checkout, other, tip } = await merged();
    await merge(other, 'feat/x');
    const operationIn = await operation(root, checkout);

    await withGit(
      root,
      `
if (args.includes('fetch')) {
  process.stderr.write(${JSON.stringify(stderr)});
  process.exit(${code});
}
`,
      () =>
        assert.rejects(operationIn.run(pullRequest(tip)), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes(stderr.trim()));

          return true;
        }),
    );

    assert.equal(operationIn.notices.length, 1);
    assert.ok(operationIn.notices[0]!.includes(stderr.trim()));
    assert.deepEqual(await branches(checkout), ['feat/x', 'main']);
  });
