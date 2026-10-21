import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Coordinator } from '../src/core/coordinator.js';
import { watchMerges } from '../src/core/merged.js';
import type { PullRequest, Repository } from '../src/core/repository.js';
import { identifyProcess } from '../src/persistence/process.js';
import type { ConversationStore } from '../src/persistence/store.js';
import { FixtureAgent, TurnGate } from './fixtures/agent.js';
import { activity, fixture, record, turns } from './fixtures/coordinator.js';
import { until, within } from './fixtures/within.js';

const gitIn = async (cwd: string, ...args: string[]) =>
  (
    await promisify(execFile)(
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

const mergedPullRequest = (commit: string): PullRequest => ({
  number: 7,
  url: 'https://x.test/7',
  state: 'MERGED',
  branch: 'feat/x',
  commit,
  base: 'main',
});

const kept =
  "#7 merged, but feat/x's last commit isn't the one it merged, so it stays.";

const notices = (coordinator: Coordinator) =>
  coordinator.snapshot.items
    .filter((item) => item.kind === 'notice')
    .map((item) => item.text);

await test('a merge cleanup holds the phase, a prompt sent during it runs after it, and its notice says what it did', async () => {
  const { coordinator, a, project } = await fixture();
  try {
    await gitIn(project, 'init', '-q', '-b', 'feat/x');
    await gitIn(project, 'commit', '-q', '--allow-empty', '-m', 'one');
    let queued = false;
    let sent: Promise<void> | undefined;
    coordinator.subscribe(() => {
      if (coordinator.snapshot.phase !== 'cleaning') return;
      sent ??= coordinator.send('After');
      if (coordinator.snapshot.queue.includes('After')) queued = true;
    });
    const acted = await coordinator.cleanUpMerge(
      mergedPullRequest('0'.repeat(40)),
      project,
    );
    assert.equal(acted, true);
    assert.ok(queued);
    await sent;
    await until('the queued prompt', () =>
      turns(a).some(([prompt]) => prompt === 'After'),
    );
    assert.deepEqual(notices(coordinator), [kept]);
  } finally {
    await coordinator.close();
  }
});

await test('a turn that ends with a prompt queued runs that prompt before the merge cleanup', async () => {
  const { coordinator, a, project } = await fixture();
  await gitIn(project, 'init', '-q', '-b', 'feat/x');
  await gitIn(project, 'commit', '-q', '--allow-empty', '-m', 'one');
  const gate = new TurnGate();
  const repository = {
    snapshot: {
      branch: 'feat/x',
      ahead: 0,
      behind: 0,
      staged: 0,
      modified: 0,
      conflicts: 0,
      untracked: 0,
      pullRequest: mergedPullRequest('0'.repeat(40)),
    } as Repository,
    subscribe: () => () => {},
  };
  let stop = () => {};
  try {
    a.gate = gate;
    a.refuseSteer = true;
    const sending = coordinator.send('first');
    await within(gate.entered, 2000, 'the gated turn');
    stop = watchMerges(repository, coordinator);
    await coordinator.send('second');
    gate.open();
    await within(sending, 2000, 'the queued turn');
    await until('the notice', () => notices(coordinator).length > 0);
    assert.deepEqual(turns(a), [
      ['first', undefined],
      ['second', undefined],
    ]);
    const texts = coordinator.snapshot.items.map((item) => item.text);
    assert.ok(texts.indexOf(kept) > texts.indexOf('second'));
  } finally {
    stop();
    gate.open();
    await coordinator.close();
  }
});

await test("a merge cleanup waits for another Witch's turn in its directory, but not for one whose agent has exited or isn't recorded, or one elsewhere", async () => {
  const { coordinator, store, memory, project } = await fixture();
  const agent = new FixtureAgent('a');
  const other = new Coordinator(store, memory, [
    { adapter: agent, executable: 'a' },
  ]);
  const gate = new TurnGate();
  const left: ConversationStore[] = [];
  try {
    await other.initialize(project);
    await gitIn(project, 'init', '-q', '-b', 'feat/x');
    await gitIn(project, 'commit', '-q', '--allow-empty', '-m', 'one');
    agent.gate = gate;
    const sending = other.send('Start');
    await within(gate.entered, 2000, 'the other turn');
    assert.equal(
      await coordinator.cleanUpMerge(mergedPullRequest('0'.repeat(40))),
      false,
    );
    assert.deepEqual(notices(coordinator), []);
    gate.open();
    await within(sending, 2000, 'the other turn');
    for (const [cwd, owner] of [
      [project, { pid: 1, started: 'never' }],
      [project, undefined],
      [join(project, '..'), (await identifyProcess(process.pid))!],
    ] as const) {
      const files = await store.create(record(randomUUID(), cwd));
      left.push(files);
      files.record.activity = activity();
      files.record.process = owner;
      await files.save(files.record);
    }
    assert.equal(
      await coordinator.cleanUpMerge(mergedPullRequest('0'.repeat(40))),
      true,
    );
    assert.deepEqual(notices(coordinator), [kept]);
  } finally {
    gate.open();
    for (const files of left) await files.close();
    await other.close();
    await coordinator.close();
  }
});

await test("a merge cleanup waits while a conversation record can't be read", async () => {
  const { coordinator, store, project } = await fixture();
  try {
    await gitIn(project, 'init', '-q', '-b', 'feat/x');
    await gitIn(project, 'commit', '-q', '--allow-empty', '-m', 'one');
    const broken = join(store.root, 'conversations', randomUUID());
    await mkdir(broken);
    await writeFile(join(broken, 'state.json'), '{');
    assert.equal(
      await coordinator.cleanUpMerge(mergedPullRequest('0'.repeat(40))),
      false,
    );
    assert.deepEqual(notices(coordinator), []);
    await rm(broken, { recursive: true });
    assert.equal(
      await coordinator.cleanUpMerge(mergedPullRequest('0'.repeat(40))),
      true,
    );
  } finally {
    await coordinator.close();
  }
});

await test('a merge cleanup leaves a checkout that changed alone, and says nothing', async () => {
  const { coordinator, project } = await fixture();
  try {
    await gitIn(project, 'init', '-q', '-b', 'feat/x');
    await writeFile(join(project, 'a.txt'), 'a\n');
    await gitIn(project, 'add', '.');
    await gitIn(project, 'commit', '-q', '-m', 'one');
    await writeFile(join(project, 'a.txt'), 'b\n');
    assert.equal(
      await coordinator.cleanUpMerge(mergedPullRequest('0'.repeat(40))),
      false,
    );
    assert.deepEqual(notices(coordinator), []);
  } finally {
    await coordinator.close();
  }
});

await test('a partial cleanup failure reaches the coordinator without a success notice', async () => {
  const { coordinator, root, project } = await fixture();
  const previousPath = process.env.PATH;
  try {
    const origin = join(root, 'origin.git');
    await gitIn(root, 'init', '--bare', origin);
    await gitIn(root, 'clone', origin, project);
    await gitIn(project, 'commit', '--allow-empty', '-m', 'base');
    await gitIn(project, 'push', '-u', 'origin', 'main');
    await gitIn(project, 'switch', '-c', 'feat/x');
    await gitIn(project, 'commit', '--allow-empty', '-m', 'feature');
    const tip = await gitIn(project, 'rev-parse', 'HEAD');
    await gitIn(project, 'push', 'origin', 'feat/x:main');
    await gitIn(project, 'config', 'branch.feat/x.remote', 'origin');
    await gitIn(project, 'config', 'branch.feat/x.merge', 'refs/heads/feat/x');
    const expectedRevision = await gitIn(origin, 'rev-parse', 'main');
    const bin = join(root, 'bin');
    const realGit = (
      await promisify(execFile)('/usr/bin/which', ['git'])
    ).stdout.trim();
    await mkdir(bin);
    await writeFile(
      join(bin, 'git'),
      `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'for-each-ref' && args.includes('--merged')) {
  process.stderr.write('injected sibling listing failure');
  process.exit(23);
}
process.exit(spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }).status ?? 1);
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${previousPath}`;
    let rejected: Error | undefined;
    await assert.rejects(
      coordinator.cleanUpMerge(mergedPullRequest(tip)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        rejected = error;
        assert.ok(
          error.message.startsWith(
            '#7 merged: switched to main and pulled, deleted branch feat/x, but could not list other merged branches:',
          ),
        );
        assert.match(error.message, /injected sibling listing failure/);
        assert.equal((error.cause as { code: number }).code, 23);
        return true;
      },
    );
    assert.equal(coordinator.snapshot.error, rejected!.message);
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.deepEqual(notices(coordinator), []);
    assert.equal(await gitIn(project, 'branch', '--show-current'), 'main');
    assert.equal(
      await gitIn(project, 'branch', '--format=%(refname:short)'),
      'main',
    );
    assert.equal(await gitIn(project, 'rev-parse', 'HEAD'), expectedRevision);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await coordinator.close();
  }
});

await test('merge cleanup preserves its notice when the install is absent, belongs to another project, is on another branch, has diverged or is locked', async () => {
  for (const variant of ['b', 'a', 'diverged', 'none', 'busy'] as const) {
    const { coordinator, root, project } = await fixture();
    const previousPath = process.env.PATH;
    let lock: FileHandle | undefined;
    try {
      const a = join(root, 'a.git');
      await gitIn(root, 'init', '-q', '--bare', a);
      await gitIn(root, 'clone', '-q', a, project);
      await writeFile(join(project, 'a.txt'), 'a\n');
      await gitIn(project, 'add', '.');
      await gitIn(project, 'commit', '-q', '-m', 'base');
      await gitIn(project, 'push', '-q', '-u', 'origin', 'main');
      await gitIn(project, 'switch', '-q', '-c', 'feat/x');
      await writeFile(join(project, 'x.txt'), 'x\n');
      await gitIn(project, 'add', '.');
      await gitIn(project, 'commit', '-q', '-m', 'x');
      await gitIn(project, 'push', '-q', '-u', 'origin', 'feat/x');
      const tip = await gitIn(project, 'rev-parse', 'HEAD');
      const merger = join(root, 'merger');
      await gitIn(root, 'clone', '-q', a, merger);
      await gitIn(merger, 'merge', '-q', '--no-ff', 'origin/feat/x');
      await gitIn(merger, 'push', '-q');
      await gitIn(merger, 'push', '-q', 'origin', '--delete', 'feat/x');
      const install = join(root, 'install');
      if (variant === 'b') {
        const b = join(root, 'b.git');
        await gitIn(root, 'init', '-q', '--bare', b);
        await gitIn(root, 'clone', '-q', b, install);
      } else if (variant !== 'none') {
        await gitIn(root, 'clone', '-q', a, install);
        if (variant === 'a')
          await gitIn(install, 'switch', '-q', '-c', 'elsewhere');
        else if (variant === 'diverged') {
          // a commit the merge doesn't have, so the install can't fast-forward
          await gitIn(install, 'reset', '-q', '--hard', 'HEAD~1');
          await gitIn(install, 'commit', '-q', '--allow-empty', '-m', 'local');
        }
      }
      const pnpmCalls = join(root, 'pnpm-calls');
      if (variant === 'busy') {
        const bin = join(root, 'bin');
        await mkdir(bin);
        await writeFile(
          join(bin, 'pnpm'),
          `#!/bin/sh\nprintf '%s\\n' "$*" >> '${pnpmCalls}'\n`,
          { mode: 0o755 },
        );
        process.env.PATH = `${bin}:${previousPath}`;
        lock = await open(
          join(install, '.git'),
          constants.O_RDONLY | constants.O_NONBLOCK | 0x20,
        );
      }
      const cleanup = coordinator.cleanUpMerge(
        mergedPullRequest(tip),
        variant === 'none' ? undefined : install,
      );
      if (variant === 'diverged') await assert.rejects(cleanup);
      else assert.equal(await cleanup, true);
      const cleaned =
        '#7 merged: switched to main and pulled, deleted branch feat/x.';
      assert.deepEqual(
        notices(coordinator),
        variant === 'a'
          ? [
              cleaned,
              `Witch's checkout at ${install} isn't clean on main, so it wasn't rebuilt.`,
            ]
          : variant === 'busy'
            ? [
                cleaned,
                `Witch's checkout at ${install} is busy, so it wasn't rebuilt.`,
              ]
            : [cleaned],
      );
      if (variant === 'busy') {
        assert.equal(coordinator.snapshot.phase, 'idle');
        assert.equal(coordinator.snapshot.error, undefined);
        await assert.rejects(readFile(pnpmCalls), { code: 'ENOENT' });
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await lock?.close();
      await coordinator.close();
    }
  }
});
