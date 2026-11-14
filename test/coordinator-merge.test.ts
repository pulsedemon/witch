import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { promisify } from 'node:util';
import { Coordinator } from '../src/core/coordinator.js';
import { watchMerges } from '../src/core/merge-watch.js';
import type { MergeCleanup } from '../src/core/merged.js';
import type { Repository } from '../src/core/repository.js';
import { openLocked } from '../src/persistence/lock.js';
import { identifyProcess, ps } from '../src/persistence/process.js';
import type { ConversationStore } from '../src/persistence/store.js';
import { FixtureAgent, TurnGate } from './fixtures/agent.js';
import {
  activity,
  fixture,
  notices,
  record,
  turns,
} from './fixtures/coordinator.js';
import { until, within } from './fixtures/within.js';
import type { RegisterCleanup } from './fixtures/cleanup.js';
import { git } from './fixtures/git.js';
import { repositoryRead } from './fixtures/repository.js';
import { pullRequest } from './fixtures/merged.js';

const kept =
  "#7 merged, but feat/x's last commit isn't the one it merged, so it stays.";

async function mergedOrigin(root: string, project: string, worktree = false) {
  const origin = join(root, 'origin.git');
  const install = worktree ? join(root, 'launcher') : project;

  await git(root, 'init', '--bare', origin);

  await git(root, 'clone', origin, install);

  await git(install, 'commit', '--allow-empty', '-m', 'base');

  await git(install, 'push', '-u', 'origin', 'main');

  const base = await git(install, 'rev-parse', 'HEAD');

  if (worktree) await git(install, 'worktree', 'add', '-b', 'feat/x', project);
  else await git(project, 'switch', '-c', 'feat/x');

  await git(project, 'commit', '--allow-empty', '-m', 'feature');

  const tip = await git(project, 'rev-parse', 'HEAD');

  await git(project, 'push', 'origin', 'feat/x:main');

  await git(project, 'config', 'branch.feat/x.remote', 'origin');

  await git(project, 'config', 'branch.feat/x.merge', 'refs/heads/feat/x');

  return { origin, install, base, tip };
}

test('a merge cleanup holds the phase and spins the pentacle, a prompt sent during it runs after it, and its notice says what it did', async () => {
  const { coordinator, a, project } = await fixture();

  try {
    await git(project, 'init', '-q', '-b', 'feat/x');

    await git(project, 'commit', '-q', '--allow-empty', '-m', 'one');

    let queued = false;
    const spinning: boolean[] = [];
    let sent: Promise<void> | undefined;

    coordinator.subscribe(() => {
      if (coordinator.snapshot.phase !== 'cleaning') return;

      spinning.push(coordinator.pentacle.active);

      sent ??= coordinator.send('After');

      if (coordinator.snapshot.queue.includes('After')) queued = true;
    });

    const acted = await coordinator.cleanUpMerge(
      pullRequest('0'.repeat(40)),
      project,
    );

    assert.equal(acted, true);

    assert.ok(queued);

    assert.ok(spinning.length > 0 && spinning.every(Boolean));

    await sent;

    await until('the queued prompt', () =>
      turns(a).some(([prompt]) => prompt === 'After'),
    );

    assert.deepEqual(notices(coordinator), [kept]);
  } finally {
    await coordinator.close();
  }
});

test('a turn that ends with a prompt queued runs that prompt before the merge cleanup', async () => {
  const { coordinator, a, project } = await fixture();

  await git(project, 'init', '-q', '-b', 'feat/x');

  await git(project, 'commit', '-q', '--allow-empty', '-m', 'one');

  const gate = new TurnGate();

  const repository = {
    snapshot: repositoryRead({
      pullRequest: pullRequest('0'.repeat(40)),
    }) as Repository,
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

test("a merge cleanup waits for another Witch's turn in its directory, but not for one whose agent has exited or isn't recorded, or one elsewhere", async () => {
  const { coordinator, store, memory, project } = await fixture();
  const agent = new FixtureAgent('a');

  const other = new Coordinator(store, memory, [
    { adapter: agent, executable: 'a' },
  ]);

  const gate = new TurnGate();
  const left: ConversationStore[] = [];

  try {
    await other.initialize(project);

    await git(project, 'init', '-q', '-b', 'feat/x');

    await git(project, 'commit', '-q', '--allow-empty', '-m', 'one');

    agent.gate = gate;
    const sending = other.send('Start');

    await within(gate.entered, 2000, 'the other turn');

    assert.equal(
      await coordinator.cleanUpMerge(pullRequest('0'.repeat(40))),
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
      await coordinator.cleanUpMerge(pullRequest('0'.repeat(40))),
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

test('a blocked merge cleanup retries after a peer turn ends without a repository update', async () => {
  const { coordinator, root, project, store, memory } = await fixture();
  const agent = new FixtureAgent('a');

  const peer = new Coordinator(store, memory, [
    { adapter: agent, executable: 'a' },
  ]);

  const gate = new TurnGate();
  let stop = () => {};
  let sending: Promise<void> | undefined;

  try {
    const origin = join(root, 'origin.git');

    await git(root, 'init', '--bare', origin);

    await git(root, 'clone', origin, project);

    await git(project, 'commit', '--allow-empty', '-m', 'base');

    await git(project, 'push', '-u', 'origin', 'main');

    await git(project, 'switch', '-c', 'feat/x');

    await git(project, 'commit', '--allow-empty', '-m', 'feature');

    await git(project, 'push', '-u', 'origin', 'feat/x');

    const tip = await git(project, 'rev-parse', 'HEAD');
    const merger = join(root, 'merger');

    await git(root, 'clone', origin, merger);

    await git(merger, 'merge', '--no-ff', '-m', 'merge', 'origin/feat/x');

    await git(merger, 'push', 'origin', 'main');

    await git(merger, 'push', 'origin', '--delete', 'feat/x');

    const merged = await git(merger, 'rev-parse', 'HEAD');

    await peer.initialize(project);

    agent.gate = gate;
    sending = peer.send('Read without changing the checkout');

    await within(gate.entered, 3000, 'the peer turn');

    const repository = {
      snapshot: repositoryRead({
        pullRequest: pullRequest(tip),
      }) satisfies Repository,
      subscribe: () => () => {},
    };

    const first =
      Promise.withResolvers<Awaited<ReturnType<Coordinator['cleanUpMerge']>>>();

    const completed = Promise.withResolvers<void>();
    const statuses: string[] = [];
    const cleanup = coordinator.cleanUpMerge.bind(coordinator);

    coordinator.cleanUpMerge = async (...args) => {
      statuses.push(await git(project, 'status', '--porcelain=v2', '--branch'));

      const acted = await cleanup(...args);

      first.resolve(acted);

      if (acted) completed.resolve();

      return acted;
    };

    stop = watchMerges(repository, coordinator);

    assert.equal(
      await within(first.promise, 5000, 'the blocked cleanup'),
      false,
    );

    gate.open();

    await sending;

    await within(completed.promise, 15_000, 'automatic cleanup');

    assert.equal(statuses.length, 2);

    assert.equal(statuses[1], statuses[0]);

    assert.equal(await git(project, 'branch', '--show-current'), 'main');

    assert.equal(await git(project, 'rev-parse', 'HEAD'), merged);

    await assert.rejects(
      git(project, 'show-ref', '--verify', '--quiet', 'refs/heads/feat/x'),
      { code: 1 },
    );

    assert.deepEqual(notices(coordinator), [
      '#7 merged: switched to main and pulled, deleted branch feat/x.',
    ]);
  } finally {
    stop();

    gate.open();

    await sending;

    await peer.close();

    await coordinator.close();
  }
});

test("a merge cleanup waits for another Witch's turn anywhere in its checkout, but not in a sibling directory that shares its name's prefix", async () => {
  const { coordinator, store, memory, project } = await fixture();

  const other = new Coordinator(store, memory, [
    { adapter: new FixtureAgent('a'), executable: 'a' },
  ]);

  const left: ConversationStore[] = [];

  try {
    await git(project, 'init', '-q', '-b', 'feat/x');

    await git(project, 'commit', '-q', '--allow-empty', '-m', 'one');

    await mkdir(join(project, 'src'));

    await other.initialize(join(project, 'src'));

    const live = (await identifyProcess(process.pid))!;

    const running = async (cwd: string) => {
      const files = await store.create(record(randomUUID(), cwd));

      left.push(files);

      files.record.activity = activity();
      files.record.process = live;

      await files.save(files.record);

      return files;
    };

    await running(`${project}-sibling`);

    for (const [cleaner, cwd] of [
      [coordinator, join(project, 'src')],
      [other, project],
    ] as const) {
      const files = await running(cwd);

      assert.equal(
        await cleaner.cleanUpMerge(pullRequest('0'.repeat(40))),
        false,
      );

      delete files.record.activity;

      await files.save(files.record);

      assert.equal(
        await cleaner.cleanUpMerge(pullRequest('0'.repeat(40))),
        true,
      );
    }
  } finally {
    for (const files of left) await files.close();

    await other.close();

    await coordinator.close();
  }
});

test("a merge cleanup waits while a conversation record can't be read", async () => {
  const { coordinator, store, project } = await fixture();

  try {
    await git(project, 'init', '-q', '-b', 'feat/x');

    await git(project, 'commit', '-q', '--allow-empty', '-m', 'one');

    const broken = join(store.root, 'conversations', randomUUID());

    await mkdir(broken);

    await writeFile(join(broken, 'state.json'), '{');

    assert.equal(
      await coordinator.cleanUpMerge(pullRequest('0'.repeat(40))),
      false,
    );

    assert.deepEqual(notices(coordinator), []);

    await rm(broken, { recursive: true });

    assert.equal(
      await coordinator.cleanUpMerge(pullRequest('0'.repeat(40))),
      true,
    );
  } finally {
    await coordinator.close();
  }
});

test('a merge cleanup leaves a checkout that changed alone, and says nothing', async () => {
  const { coordinator, project } = await fixture();

  try {
    await git(project, 'init', '-q', '-b', 'feat/x');

    await writeFile(join(project, 'a.txt'), 'a\n');

    await git(project, 'add', '.');

    await git(project, 'commit', '-q', '-m', 'one');

    await writeFile(join(project, 'a.txt'), 'b\n');

    assert.equal(
      await coordinator.cleanUpMerge(pullRequest('0'.repeat(40))),
      'changed',
    );

    assert.deepEqual(notices(coordinator), []);
  } finally {
    await coordinator.close();
  }
});

test('a partial cleanup failure reaches the coordinator without a success notice', async () => {
  const { coordinator, root, project } = await fixture();
  const previousPath = process.env.PATH;

  try {
    const { origin, tip } = await mergedOrigin(root, project);
    const expectedRevision = await git(origin, 'rev-parse', 'main');
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
      coordinator.cleanUpMerge(pullRequest(tip)),
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

    assert.equal(await git(project, 'branch', '--show-current'), 'main');

    assert.equal(
      await git(project, 'branch', '--format=%(refname:short)'),
      'main',
    );

    assert.equal(await git(project, 'rev-parse', 'HEAD'), expectedRevision);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;

    await coordinator.close();
  }
});

test('merge cleanup preserves its notice when the install is absent, belongs to another project, is on another branch, has diverged or is locked', async () => {
  for (const variant of ['b', 'a', 'diverged', 'none', 'busy'] as const) {
    const { coordinator, root, project } = await fixture();
    const previousPath = process.env.PATH;
    let lock: FileHandle | undefined;

    try {
      const a = join(root, 'a.git');

      await git(root, 'init', '-q', '--bare', a);

      await git(root, 'clone', '-q', a, project);

      await writeFile(join(project, 'a.txt'), 'a\n');

      await git(project, 'add', '.');

      await git(project, 'commit', '-q', '-m', 'base');

      await git(project, 'push', '-q', '-u', 'origin', 'main');

      await git(project, 'switch', '-q', '-c', 'feat/x');

      await writeFile(join(project, 'x.txt'), 'x\n');

      await git(project, 'add', '.');

      await git(project, 'commit', '-q', '-m', 'x');

      await git(project, 'push', '-q', '-u', 'origin', 'feat/x');

      const tip = await git(project, 'rev-parse', 'HEAD');
      const merger = join(root, 'merger');

      await git(root, 'clone', '-q', a, merger);

      await git(merger, 'merge', '-q', '--no-ff', 'origin/feat/x');

      await git(merger, 'push', '-q');

      await git(merger, 'push', '-q', 'origin', '--delete', 'feat/x');

      const install = join(root, 'install');

      if (variant === 'b') {
        const b = join(root, 'b.git');

        await git(root, 'init', '-q', '--bare', b);

        await git(root, 'clone', '-q', b, install);
      } else if (variant !== 'none') {
        await git(root, 'clone', '-q', a, install);

        if (variant === 'a')
          await git(install, 'switch', '-q', '-c', 'elsewhere');
        else if (variant === 'diverged') {
          // a commit the merge doesn't have, so the install can't fast-forward
          await git(install, 'reset', '-q', '--hard', 'HEAD~1');

          await git(install, 'commit', '-q', '--allow-empty', '-m', 'local');
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

        lock = await openLocked(
          join(install, '.git'),
          constants.O_RDONLY | constants.O_NONBLOCK,
        );
      }

      const cleanup = coordinator.cleanUpMerge(
        pullRequest(tip),
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

test("a merge cleanup stops before switching when another Witch's turn starts in its checkout during the fetch", async () => {
  const { coordinator, store, memory, root, project } = await fixture();
  const agent = new FixtureAgent('a');

  const other = new Coordinator(store, memory, [
    { adapter: agent, executable: 'a' },
  ]);

  const gate = new TurnGate();
  const previousPath = process.env.PATH;
  let sending: Promise<void> | undefined;

  try {
    const { tip } = await mergedOrigin(root, project);

    await other.initialize(project);

    const bin = join(root, 'bin');

    const realGit = (
      await promisify(execFile)('/usr/bin/which', ['git'])
    ).stdout.trim();

    await mkdir(bin);

    // a node shim's startup on every git call would push the peer's turn past its deadline under load
    await writeFile(
      join(bin, 'git'),
      `#!/bin/sh
for arg; do
  if [ "$arg" = fetch ]; then
    : > '${join(root, 'fetching')}'
    while [ ! -e '${join(root, 'release')}' ]; do sleep 0.02; done
  fi
done
exec '${realGit}' "$@"
`,
      { mode: 0o755 },
    );

    process.env.PATH = `${bin}:${previousPath}`;
    const cleanup = coordinator.cleanUpMerge(pullRequest(tip));

    await until('the fetch', () =>
      readFile(join(root, 'fetching')).then(
        () => true,
        () => false,
      ),
    );

    agent.gate = gate;
    sending = other.send('Start');

    await within(gate.entered, 2000, 'the other turn');

    await writeFile(join(root, 'release'), '');

    assert.equal(await cleanup, false);

    assert.deepEqual(notices(coordinator), []);

    assert.equal(await git(project, 'branch', '--show-current'), 'feat/x');

    assert.equal(await git(project, 'rev-parse', 'feat/x'), tip);
  } finally {
    await writeFile(join(root, 'release'), '');

    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;

    gate.open();

    if (sending) await within(sending, 2000, 'the other turn');

    await other.close();

    await coordinator.close();
  }
});

/**
 * with `worktree`, the project is a linked worktree of `install`, a clone that holds `main`. with `slowReconcile`, the
 * first Git command of the reconcile after the interrupt outlasts its deadline.
 */
async function interruptedCleanup(
  stage: string,
  register: RegisterCleanup,
  worktree = false,
  slowReconcile = false,
) {
  const { coordinator, root, project } = await fixture();

  const { origin, install, base, tip } = await mergedOrigin(
    root,
    project,
    worktree,
  );

  await git(project, 'branch', 'feat/y', 'main');

  await git(project, 'config', 'branch.feat/y.remote', 'origin');

  await git(project, 'config', 'branch.feat/y.merge', 'refs/heads/feat/y');

  const later = join(root, 'later');
  let expectedHead = tip;

  if (stage === 'advanced') {
    await git(root, 'clone', origin, later);

    await git(later, 'commit', '--allow-empty', '-m', 'later remote commit');

    expectedHead = await git(later, 'rev-parse', 'HEAD');
  }

  const previousPath = process.env.PATH;

  const realGit = (
    await promisify(execFile)('/usr/bin/which', ['git'])
  ).stdout.trim();

  const bin = join(root, 'bin');
  const ready = join(root, 'ready.json');
  const log = join(root, 'commands.jsonl');

  await mkdir(bin);

  for (const tool of ['git', 'pnpm'])
    await writeFile(
      join(bin, tool),
      `#!${process.execPath}
const { spawn, spawnSync } = require('node:child_process');
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const tool = ${JSON.stringify(tool)};
const stage = ${JSON.stringify(stage)};
appendFileSync(${JSON.stringify(log)}, JSON.stringify([tool, ...args]) + '\\n');
const gate = () => {
  process.on('SIGTERM', () => {});
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", ${JSON.stringify(ready)}], {stdio:'ignore'});
  writeFileSync(${JSON.stringify(ready)}, JSON.stringify([process.pid, child.pid]));
  setInterval(() => {}, 1000);
};
const first = !existsSync(${JSON.stringify(ready)});
const reconciling = ${JSON.stringify(slowReconcile)} && tool === 'git' && !first &&
  (stage === 'install' ? args[0] === 'rev-parse' && args[1] === 'HEAD' :
    args.includes('--no-optional-locks') && args.includes('status'));
if (stage === 'advanced' && tool === 'git' && args.includes('fetch')) {
  const file = ${JSON.stringify(join(root, 'fetch-count'))};
  const n = existsSync(file) ? Number(readFileSync(file, 'utf8')) + 1 : 1;
  writeFileSync(file, String(n));
  if (n === 3 && spawnSync(${JSON.stringify(realGit)}, ['-C', ${JSON.stringify(later)}, 'push', 'origin', 'main'], {stdio:'inherit'}).status !== 0)
    process.exit(1);
}
if (first && stage === 'fetch' && tool === 'git' && args.includes('fetch')) gate();
else if (reconciling) setTimeout(() => process.exit(1), 10_000);
else {
  const status = tool === 'git' ? spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'}).status ?? 1 : 0;
  const hold = tool === 'pnpm' ? args[0] === (stage === 'advanced' ? 'install' : stage) :
    (stage === 'switch' && args[0] === 'switch') ||
    (stage === 'delete' && args[0] === 'update-ref') ||
    (stage === 'config' && args[0] === 'config' && args[1] === '--remove-section') ||
    (stage === 'pull' && args[0] === 'merge') ||
    (stage === 'prune' && args[0] === 'branch' && args[1] === '-d');
  if (status === 0 && first && hold) gate();
  else process.exit(status);
}
`,
      { mode: 0o755 },
    );

  process.env.PATH = `${bin}:${previousPath}`;
  let pids: number[] = [];

  register(async () => {
    for (const line of await ps(
      'pid=,command=',
      pids.length ? pids : [process.pid],
    )) {
      if (!line.includes(bin) && !line.includes(ready)) continue;

      try {
        process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }

    await coordinator.close();

    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  const entered = async () => {
    await until(
      `the ${stage} command`,
      async () => {
        pids = await readFile(ready, 'utf8')
          .then((text) => JSON.parse(text) as number[])
          .catch(() => []);

        return pids.length > 0;
      },
      500,
    );
  };

  return {
    coordinator,
    project,
    install,
    tip,
    base,
    expectedHead,
    entered,
    stopped: async () =>
      assert.deepEqual(
        (await ps('pid=,stat=', pids)).filter(
          (line) => !line.trim().split(/\s+/)[1]?.startsWith('Z'),
        ),
        [],
      ),
    commands: async () =>
      (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]),
  };
}

for (const [stage, worktree] of [
  ...[
    'fetch',
    'switch',
    'delete',
    'config',
    'pull',
    'prune',
    'install',
    'build',
    'advanced',
  ].map((stage) => [stage, false] as const),
  ['install', true] as const,
])
  test(`an interrupted ${stage === 'advanced' ? 'install after its own checkout update' : stage}${worktree ? " of a worktree's launcher" : ''} resumes cleanup without repeating completed deletion or checkout steps`, async (t) => {
    const {
      coordinator,
      project,
      install,
      tip,
      expectedHead,
      entered,
      stopped,
      commands,
    } = await interruptedCleanup(stage, t.onTestFinished, worktree);

    const repository: { snapshot: Repository; subscribe: () => () => void } = {
      snapshot: repositoryRead({ pullRequest: pullRequest(tip) }),
      subscribe: () => () => {},
    };

    const results: Awaited<ReturnType<Coordinator['cleanUpMerge']>>[] = [];
    const cleanup = coordinator.cleanUpMerge.bind(coordinator);

    coordinator.cleanUpMerge = async (...args) => {
      const result = await cleanup(...args);

      if (result === 'interrupted') await stopped();

      results.push(result);

      return result;
    };

    const stop = watchMerges(repository, coordinator, install);

    try {
      await entered();

      repository.snapshot.branch = await git(
        project,
        'branch',
        '--show-current',
      );

      if (repository.snapshot.branch === 'main')
        delete repository.snapshot.pullRequest;

      await within(coordinator.interrupt(), 5000, 'cleanup cancellation');

      await until(
        'resumed cleanup completion',
        () => results.includes(true),
        500,
      );

      assert.deepEqual(results, ['interrupted', true]);

      assert.equal(coordinator.snapshot.error, undefined);

      assert.equal(
        await git(project, 'branch', '--show-current'),
        worktree ? '' : 'main',
      );

      assert.equal(await git(project, 'rev-parse', 'HEAD'), expectedHead);

      // the launcher, still on main, is pulled before its rebuild
      assert.equal(await git(install, 'rev-parse', 'HEAD'), expectedHead);

      assert.equal(
        await git(
          project,
          'for-each-ref',
          '--format=%(refname:short)',
          'refs/heads',
        ),
        'main',
      );

      const calls = await commands();

      for (const command of ['switch', 'update-ref'])
        assert.equal(
          calls.filter(([tool, name]) => tool === 'git' && name === command)
            .length,
          1,
          command,
        );

      assert.equal(
        calls.filter(
          ([tool, name, option]) =>
            tool === 'git' &&
            name === 'config' &&
            option === '--remove-section',
        ).length,
        1,
      );

      assert.equal(
        calls.filter(
          ([tool, name, option]) =>
            tool === 'git' && name === 'branch' && option === '-d',
        ).length,
        1,
      );

      assert.deepEqual(
        calls.filter(([tool]) => tool === 'pnpm'),
        stage === 'install' || stage === 'advanced'
          ? [
              ['pnpm', 'install', '--frozen-lockfile'],
              ['pnpm', 'install', '--frozen-lockfile'],
              ['pnpm', 'build'],
            ]
          : stage === 'build'
            ? [
                ['pnpm', 'install', '--frozen-lockfile'],
                ['pnpm', 'build'],
                ['pnpm', 'build'],
              ]
            : [
                ['pnpm', 'install', '--frozen-lockfile'],
                ['pnpm', 'build'],
              ],
      );
    } finally {
      stop();
    }
  });

for (const stage of ['delete', 'install'])
  test(`an interrupted ${stage} whose reconcile times out names what's left and doesn't resume`, async (t) => {
    const { coordinator, install, tip, entered, stopped, commands } =
      await interruptedCleanup(stage, t.onTestFinished, false, true);

    const results: Awaited<ReturnType<Coordinator['cleanUpMerge']>>[] = [];
    const cleanup = coordinator.cleanUpMerge.bind(coordinator);

    coordinator.cleanUpMerge = async (...args) => {
      const result = await cleanup(...args);

      results.push(result);

      return result;
    };

    const stop = watchMerges(
      {
        snapshot: repositoryRead({ pullRequest: pullRequest(tip) }),
        subscribe: () => () => {},
      },
      coordinator,
      install,
    );

    try {
      await entered();

      await within(coordinator.interrupt(), 5000, 'cleanup cancellation');

      await until('cleanup settles', () => results.length > 0, 500);

      await stopped();

      assert.deepEqual(results, [true]);

      assert.equal(coordinator.snapshot.error, undefined);

      assert.equal(coordinator.snapshot.phase, 'idle');

      assert.deepEqual(
        notices(coordinator),
        stage === 'delete'
          ? [
              'Merge cleanup interrupted.',
              "Witch couldn't confirm how far merge cleanup got, so it won't resume. Left to check: deleting feat/x with its config and plans, fast-forwarding main, pruning merged branches and whether Witch's checkout needs updating and rebuilding.",
            ]
          : [
              '#7 merged: switched to main and pulled, deleted branches feat/x and feat/y.',
              'Merge cleanup interrupted.',
              "Witch couldn't confirm how far merge cleanup got, so it won't resume. Left to check: updating and rebuilding Witch's checkout.",
            ],
      );

      const calls = await commands();

      assert.equal(
        calls.filter(([tool, name]) => tool === 'git' && name === 'update-ref')
          .length,
        1,
      );

      assert.equal(
        calls.filter(
          ([tool, name, option]) =>
            tool === 'git' && name === 'branch' && option === '-d',
        ).length,
        stage === 'delete' ? 0 : 1,
      );

      assert.deepEqual(
        calls.filter(([tool]) => tool === 'pnpm'),
        stage === 'delete' ? [] : [['pnpm', 'install', '--frozen-lockfile']],
      );
    } finally {
      stop();
    }
  });

for (const changed of ['edit', 'branch', 'commit', 'recreated branch'])
  test(`a ${changed} after cancellation prevents unsafe cleanup continuation`, async (t) => {
    const { coordinator, project, tip, entered, stopped, commands } =
      await interruptedCleanup('install', t.onTestFinished);

    const progress: MergeCleanup = {};
    const request = pullRequest(tip);
    const first = coordinator.cleanUpMerge(request, project, progress);

    await entered();

    await within(coordinator.interrupt(), 5000, 'cleanup cancellation');

    assert.equal(await first, 'interrupted');

    await stopped();

    if (changed === 'edit') {
      await writeFile(join(project, 'added.txt'), 'keep this');

      await git(project, 'add', 'added.txt');
    } else if (changed === 'branch')
      await git(project, 'switch', '-c', 'feat/new');
    else if (changed === 'commit')
      await git(project, 'commit', '--allow-empty', '-m', 'new work');
    else await git(project, 'branch', 'feat/x');

    const before = await git(project, 'status', '--porcelain=v2', '--branch');

    assert.equal(
      await coordinator.cleanUpMerge(request, project, progress),
      'changed',
    );

    assert.equal(
      await git(project, 'status', '--porcelain=v2', '--branch'),
      before,
    );

    if (changed === 'recreated branch')
      assert.equal(await git(project, 'rev-parse', 'feat/x'), tip);

    assert.equal(
      (await commands()).filter(([tool]) => tool === 'pnpm').length,
      1,
    );
  });

for (const restart of [false, true])
  test(`${restart ? 'restart' : 'close'} stops an in-flight cleanup install and its children within five seconds`, async (t) => {
    const { coordinator, project, tip, entered, stopped, commands } =
      await interruptedCleanup('install', t.onTestFinished);

    const cleanup = coordinator.cleanUpMerge(pullRequest(tip), project);

    await entered();

    await within(
      coordinator.close({ restart }),
      5000,
      'closing during cleanup',
    );

    assert.equal(await cleanup, 'interrupted');

    await stopped();

    assert.deepEqual(
      (await commands()).filter(([tool]) => tool === 'pnpm'),
      [['pnpm', 'install', '--frozen-lockfile']],
    );
  });

for (const stage of ['delete', 'prune'])
  test(`cancellation checkpoints a completed ${stage} before queued work can recreate the same ref`, async (t) => {
    const { coordinator, project, tip, base, entered, stopped, commands } =
      await interruptedCleanup(stage, t.onTestFinished);

    const progress: MergeCleanup = {};
    const request = pullRequest(tip);
    const first = coordinator.cleanUpMerge(request, project, progress);

    await entered();

    await within(coordinator.interrupt(), 5000, 'cleanup cancellation');

    assert.equal(await first, 'interrupted');

    await stopped();

    const name = stage === 'delete' ? 'feat/x' : 'feat/y';
    const head = stage === 'delete' ? tip : base;

    await git(project, 'branch', name, head);

    await git(project, 'config', `branch.${name}.remote`, 'origin');

    await git(project, 'config', `branch.${name}.merge`, `refs/heads/${name}`);

    assert.equal(
      await coordinator.cleanUpMerge(request, project, progress),
      stage === 'delete' ? 'changed' : true,
    );

    assert.equal(await git(project, 'rev-parse', name), head);

    assert.equal(
      await git(project, 'config', `branch.${name}.merge`),
      `refs/heads/${name}`,
    );

    const command = stage === 'delete' ? 'update-ref' : 'branch';

    assert.equal(
      (await commands()).filter(
        ([tool, name, option]) =>
          tool === 'git' && name === command && option === '-d',
      ).length,
      1,
    );
  });
