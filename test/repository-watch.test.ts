import assert from 'node:assert/strict';

import { execFile } from 'node:child_process';

import { mkdir, rename, writeFile } from 'node:fs/promises';

import { dirname, join } from 'node:path';

import { setTimeout as delay } from 'node:timers/promises';

import { promisify } from 'node:util';

import { test, vi } from 'vitest';

import { RepositoryWatch } from '../src/core/repository.js';

import type { Run } from '../src/core/repository.js';

import { scratch } from './fixtures/scratch.js';

import { until } from './fixtures/within.js';

const execute = promisify(execFile);

// only macOS watches; Linux polls, as the polling tests in repository.test.ts cover
const watching = test.skipIf(process.platform !== 'darwin');

const git = (cwd: string, ...args: string[]) =>
  execute('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
  });

/** macOS reports changes made just before a watch starts, so setup ends with a pause. */
const quiet = () => delay(150);

async function workTree(): Promise<string> {
  const work = join(await scratch('witch-repository-watch-'), 'work');

  await git(dirname(work), 'init', '--quiet', '-b', 'main', work);

  await writeFile(join(work, 'tracked.txt'), 'a\n');

  await git(work, 'add', '.');

  await git(work, 'commit', '--quiet', '-m', 'first');

  return work;
}

/** delegates Git to `execFile` and refuses gh, counting status reads as they start and finish. */
function counting(hold?: (started: number) => Promise<void> | undefined) {
  const status = { started: 0, finished: 0 };

  const run: Run = async (command, args, options) => {
    if (command === 'gh') throw new Error('no pull requests found');

    const read = args.includes('status');

    const started = read ? ++status.started : 0;

    const { stdout } = await execute(command, args, options);

    if (read) {
      await hold?.(started);

      status.finished++;
    }

    return { stdout };
  };

  return { run, status };
}

/** the read the widened watch schedules once `rev-parse` answers. */
const widened = (status: { finished: number }) =>
  until('read after the watch widens', () => status.finished >= 2);

/** waits until no status read has started for `window` ms; a watch that polls or wakes itself never gets there. */
async function settled(status: { started: number }, window = 300) {
  let reads = status.started;

  let since = performance.now();

  await until('status reads to stop', () => {
    if (status.started !== reads) {
      reads = status.started;

      since = performance.now();
    }

    return performance.now() - since >= window;
  });
}

watching(
  'a quiet work tree runs no status reads between changes, and a change is read promptly',
  async (t) => {
    const work = await workTree();

    await quiet();

    const { run, status } = counting();

    const watch = new RepositoryWatch(work, run, undefined, { interval: 50 });

    t.onTestFinished(() => watch.close());

    await widened(status);

    // macOS can still report the new tree's setup after the watch opens, which is a change to read
    await settled(status);

    await writeFile(join(work, 'new.txt'), 'n\n');

    await until('untracked file', () => watch.snapshot?.untracked === 1);
  },
);

watching(
  'a burst of changes reads at most once per interval and shows the final state',
  async (t) => {
    const work = await workTree();

    await quiet();

    const finishes: number[] = [];

    const { run, status } = counting(() => {
      finishes.push(performance.now());

      return undefined;
    });

    const watch = new RepositoryWatch(work, run, undefined, { interval: 400 });

    t.onTestFinished(() => watch.close());

    await widened(status);

    const first = performance.now();

    for (let index = 0; index < 30; index++) {
      await writeFile(join(work, `burst-${index}.txt`), 'x\n');

      await delay(10);
    }

    await until('every burst file', () => watch.snapshot?.untracked === 30);

    // a read is counted as it finishes, a few milliseconds after it starts
    // reads start at least 400 ms apart, so no more than two finish in any 450 ms
    const early = finishes.filter((at) => at > first && at < first + 450);

    assert.ok(early.length <= 2, `${early.length} reads in 450 ms`);
  },
);

watching('a change during a read is read after it', async (t) => {
  const work = await workTree();

  await quiet();

  const reading = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();

  const { run, status } = counting((started) => {
    if (started !== 2) return undefined;

    reading.resolve();

    return release.promise;
  });

  const watch = new RepositoryWatch(work, run, undefined, { interval: 50 });

  t.onTestFinished(() => watch.close());

  await reading.promise;

  await writeFile(join(work, 'during.txt'), 'd\n');

  // the change's event arrives within milliseconds, while the read is still held
  await delay(150);

  release.resolve();

  await until('change read after the held read', () => status.finished >= 2);

  assert.equal(watch.snapshot?.untracked, 0);

  await until('change during the read', () => watch.snapshot?.untracked === 1);
});

watching(
  'the pull request rereads 90 seconds after the last read without a status change',
  async (t) => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'Date'],
      now: 0,
    });

    const directory = await scratch('witch-repository-pr-');

    await mkdir(join(directory, '.git'));

    await quiet();

    let statuses = 0,
      reads = 0;

    const watch = new RepositoryWatch(
      directory,
      async (command, args) => {
        if (command === 'gh') {
          reads++;

          return {
            stdout: JSON.stringify({
              number: 4,
              url: 'https://x.test/4',
              state: 'OPEN',
              statusCheckRollup: [],
              headRefName: 'main',
              headRefOid: 'a1b2c3',
              baseRefName: 'develop',
              mergeable: 'MERGEABLE',
            }),
          };
        }

        if (args.includes('rev-parse'))
          return {
            stdout: `${directory}\n${directory}/.git\n${directory}/.git\n`,
          };

        if (args.includes('status')) statuses++;

        return { stdout: '# branch.head main\n' };
      },
      undefined,
      { interval: 50 },
    );

    t.onTestFinished(() => watch.close());

    await until('first pull request read', () => reads === 1);

    await until('read after the watch widens', () => statuses === 2);

    vi.advanceTimersByTime(85_000);

    await delay(20);

    assert.equal(reads, 1);

    vi.advanceTimersByTime(5000);

    await until('pull request reread', () => reads === 2);

    assert.equal(statuses, 2);
  },
);

watching("a linked worktree's staged change is read", async (t) => {
  const work = await workTree();

  const linked = join(dirname(work), 'linked');

  await git(work, 'worktree', 'add', '--quiet', linked);

  await quiet();

  const { run, status } = counting();

  const watch = new RepositoryWatch(linked, run, undefined, { interval: 50 });

  t.onTestFinished(() => watch.close());

  await widened(status);

  await writeFile(join(linked, 'tracked.txt'), 'changed\n');

  await until('modified file', () => watch.snapshot?.modified === 1);

  // the index lives in the main repository's Git dir, outside the worktree
  await git(linked, 'add', 'tracked.txt');

  await until('staged file', () => watch.snapshot?.staged === 1);
});

watching('a plain directory that becomes a repository gains Git', async (t) => {
  const directory = await scratch('witch-repository-plain-');

  const initialized = await scratch('witch-repository-initialized-');

  await git(initialized, 'init', '--quiet', '-b', 'main');

  await quiet();

  const { run, status } = counting();

  const watch = new RepositoryWatch(directory, run, undefined, {
    interval: 50,
  });

  t.onTestFinished(() => watch.close());

  await until('first read', () => status.started >= 1);

  await delay(100);

  assert.equal(watch.snapshot, undefined);

  // a top-level event must arrive with a usable repository; later writes inside .git need the minute retry
  await rename(join(initialized, '.git'), join(directory, '.git'));

  await until('Git after init', () => watch.snapshot?.branch === 'main');
});

watching(
  'a directory whose parent becomes a repository gains Git at the minute retry',
  async (t) => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'performance'],
    });

    const parent = await scratch('witch-repository-parent-');

    const directory = join(parent, 'sub');

    await mkdir(directory);

    await quiet();

    let failures = 0;

    const watch = new RepositoryWatch(
      directory,
      async (command, args, options) => {
        if (command === 'gh') throw new Error('no pull requests found');

        try {
          return await execute(command, args, options);
        } catch (error) {
          failures++;

          throw error;
        }
      },
      undefined,
      { interval: 50 },
    );

    t.onTestFinished(() => watch.close());

    await until('failed first read', () => failures === 1);

    // the watch sees nothing above its directory
    await git(parent, 'init', '--quiet', '-b', 'main');

    vi.advanceTimersByTime(59_000);

    await delay(100);

    assert.equal(watch.snapshot, undefined);

    vi.advanceTimersByTime(1000);

    await until('Git after the retry', () => watch.snapshot?.branch === 'main');
  },
);

watching(
  'a change whose event is lost is read a minute after the last read',
  async (t) => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'performance'],
    });

    const work = await workTree();

    await quiet();

    const { run, status } = counting();

    const watch = new RepositoryWatch(work, run, undefined, { interval: 50 });

    t.onTestFinished(() => watch.close());

    await widened(status);

    // FSEvents can drop an event under load without flagging it
    for (const watcher of watch['watchers']!)
      watcher.removeAllListeners('change');

    // a read the setup's late events scheduled would see the change
    await until(
      'no read pending',
      () => watch['scheduled'] === undefined && !watch['refreshing'],
    );

    await writeFile(join(work, 'lost.txt'), 'l\n');

    vi.advanceTimersByTime(59_000);

    await delay(100);

    assert.equal(watch.snapshot?.untracked, 0);

    vi.advanceTimersByTime(1000);

    await until('lost change', () => watch.snapshot?.untracked === 1);
  },
);

watching(
  'a read the minute timer starts drops a change read still waiting',
  async (t) => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'performance'],
    });

    const work = await workTree();

    await quiet();

    const { run, status } = counting();

    const watch = new RepositoryWatch(work, run, undefined, { interval: 50 });

    t.onTestFinished(() => watch.close());

    await widened(status);

    await until(
      'no read pending',
      () => watch['scheduled'] === undefined && !watch['refreshing'],
    );

    vi.advanceTimersByTime(59_975);

    // an event just before the minute waits the 100 ms debounce
    watch['changed']();

    assert.notEqual(watch['scheduled'], undefined);

    const reads = status.started;

    vi.advanceTimersByTime(25);

    assert.equal(watch['scheduled'], undefined);

    await until('minute read', () => status.started === reads + 1);
  },
);

watching(
  'a watch opened in a subdirectory reads changes elsewhere in the work tree',
  async (t) => {
    const work = await workTree();

    await mkdir(join(work, 'src'));

    await writeFile(join(work, 'src', 'keep.txt'), 'k\n');

    await git(work, 'add', '.');

    await git(work, 'commit', '--quiet', '-m', 'src');

    await quiet();

    const { run, status } = counting();

    const watch = new RepositoryWatch(join(work, 'src'), run, undefined, {
      interval: 50,
    });

    t.onTestFinished(() => watch.close());

    await widened(status);

    await writeFile(join(work, 'other.txt'), 'o\n');

    await until(
      'change outside the cwd',
      () => watch.snapshot?.untracked === 1,
    );
  },
);

watching(
  'a failed read is retried without a change, but a plain directory waits for the minute retry',
  async (t) => {
    const directory = await scratch('witch-repository-retry-');

    await mkdir(join(directory, '.git'));

    const plain = await scratch('witch-repository-plain-');

    await quiet();

    let statuses = 0;

    const watch = new RepositoryWatch(
      directory,
      async (command, args) => {
        if (command === 'gh') throw new Error('no pull requests found');

        if (args.includes('rev-parse'))
          return {
            stdout: `${directory}\n${directory}/.git\n${directory}/.git\n`,
          };

        if (args.includes('status') && ++statuses === 1)
          throw Object.assign(new Error('git timed out'), {
            killed: true,
            code: null,
          });

        return { stdout: '# branch.head main\n' };
      },
      undefined,
      { interval: 50 },
    );

    t.onTestFinished(() => watch.close());

    await until('retried read', () => watch.snapshot?.branch === 'main');

    const reads = { started: 0 };

    const outside = new RepositoryWatch(
      plain,
      async () => {
        reads.started++;

        throw Object.assign(new Error('not a git repository'), { code: 128 });
      },
      undefined,
      { interval: 50 },
    );

    t.onTestFinished(() => outside.close());

    await until('first read outside a repository', () => reads.started >= 1);

    // macOS can still report the directory's setup after the watch opens, which is a change to read
    await settled(reads);
  },
);

watching('a closed watch reads nothing more', async (t) => {
  const work = await workTree();

  await quiet();

  // a pending read would block the next change's read, so each close is checked alone
  for (const pending of [true, false]) {
    const { run, status } = counting();

    const watch = new RepositoryWatch(work, run, undefined, { interval: 50 });

    t.onTestFinished(() => watch.close());

    await widened(status);

    if (pending) {
      await writeFile(join(work, 'pending.txt'), 'p\n');

      await until('a scheduled read', () => watch['scheduled'] !== undefined);
    }

    watch.close();

    await writeFile(join(work, `after-${pending}.txt`), 'a\n');

    await delay(300);

    assert.equal(status.started, 2);
  }
});

watching('a watch whose watcher fails polls', async (t) => {
  const work = await workTree();

  await quiet();

  const { run, status } = counting();

  const watch = new RepositoryWatch(work, run, undefined, { interval: 50 });

  t.onTestFinished(() => watch.close());

  await widened(status);

  watch['watchers']![0]!.emit('error', new Error('watch failed'));

  await until('reads with no change', () => status.finished >= 5);
});

watching(
  'a watch that cannot widen polls, since its top-level watch misses changes below it',
  async (t) => {
    const directory = await scratch('witch-repository-widen-');

    await quiet();

    // Git fails to answer, or answers a root that cannot be watched
    for (const root of [undefined, join(directory, 'gone')]) {
      let statuses = 0;

      const watch = new RepositoryWatch(
        directory,
        async (command, args) => {
          if (command === 'gh') throw new Error('no pull requests found');

          if (args.includes('rev-parse')) {
            if (!root) throw new Error('rev-parse failed');

            return { stdout: `${root}\n` };
          }

          if (args.includes('status')) statuses++;

          return { stdout: '# branch.head main\n' };
        },
        undefined,
        { interval: 50 },
      );

      t.onTestFinished(() => watch.close());

      await until('reads with no change', () => statuses >= 4);
    }
  },
);

watching(
  'pushing an already observed local commit refreshes the conflict before the normal GitHub poll',
  async (t) => {
    const work = await workTree();

    const remote = join(dirname(work), 'remote.git');

    await git(dirname(work), 'init', '--bare', '--quiet', '-b', 'main', remote);

    await git(work, 'remote', 'add', 'origin', remote);

    await git(work, 'push', '--quiet', '-u', 'origin', 'HEAD');

    const a = (await git(work, 'rev-parse', 'HEAD')).stdout.trim();

    await quiet();

    const watch = new RepositoryWatch(
      work,
      async (command, args, options) => {
        if (command !== 'gh') return execute(command, args, options);

        if (args[0] === 'api') return { stdout: `${a}\n` };

        const head = (
          await git(remote, 'rev-parse', 'refs/heads/main')
        ).stdout.trim();

        return {
          stdout: JSON.stringify({
            number: 7,
            url: 'https://github.com/o/r/pull/7',
            state: 'OPEN',
            headRefName: 'main',
            headRefOid: head,
            baseRefName: 'develop',
            mergeable: head === a ? 'CONFLICTING' : 'MERGEABLE',
            statusCheckRollup: [],
          }),
        };
      },
      undefined,
      { interval: 50 },
    );

    t.onTestFinished(() => watch.close());

    await until('original conflict', () => !!watch.snapshot?.conflict);

    await git(work, 'commit', '--allow-empty', '--quiet', '-m', 'resolution');

    const b = (await git(work, 'rev-parse', 'HEAD')).stdout.trim();

    await until(
      'local commit observed',
      () => watch.snapshot?.commit === b && watch.snapshot.ahead === 1,
    );

    await git(work, 'push', '--quiet');

    await until(
      'pushed resolution',
      () =>
        watch.snapshot?.pullRequest?.commit === b &&
        watch.snapshot.conflict === undefined,
    );

    assert.equal(watch.snapshot?.pullRequest?.mergeable, 'MERGEABLE');

    assert.equal(watch.snapshot?.ahead, 0);
  },
);
