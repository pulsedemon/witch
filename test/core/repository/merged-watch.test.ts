import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { Coordinator } from '../../../src/core/coordinator.js';
import type { Snapshot } from '../../../src/core/snapshot.js';
import { runCommand } from '../../../src/core/repository/command.js';
import { watchMerges } from '../../../src/core/repository/merge-watch.js';
import { cleanUpMerge } from '../../../src/core/repository/merged.js';
import type { MergeCleanup } from '../../../src/core/repository/merged.js';
import { RepositoryWatch } from '../../../src/core/repository/repository.js';
import type {
  PullRequest,
  Repository,
} from '../../../src/core/repository/repository.js';
import type { RegisterCleanup } from '../../fixtures/cleanup.js';
import { git } from '../../fixtures/git.js';
import { branches, idle, merge, merged } from '../../fixtures/merged.js';
import { configureGitEnvironment } from '../../fixtures/merged-environment.js';
import { repositoryRead, view } from '../../fixtures/repository.js';
import { until } from '../../fixtures/within.js';

configureGitEnvironment();
const tick = () => new Promise((resolve) => setImmediate(resolve));

const status = (
  pullRequest?: PullRequest,
  fields: Partial<Repository> = {},
): Repository => repositoryRead({ pullRequest, ...fields });

const pr = (
  state: PullRequest['state'],
  commit: string,
  branch = 'feat/x',
): PullRequest => ({
  number: 7,
  url: 'https://x.test/7',
  state,
  branch,
  commit,
  base: 'main',
});

function fixture(register: RegisterCleanup) {
  const listeners = {
    repository: new Set<() => void>(),
    coordinator: new Set<() => void>(),
  };

  const unfollowed: string[] = [];

  const repository = {
    snapshot: undefined as Repository | undefined,
    subscribe: (listener: () => void) => {
      listeners.repository.add(listener);

      return () => listeners.repository.delete(listener);
    },
    // as the real watch does, a removal publishes and nothing else does
    unfollow: (url: string) => {
      unfollowed.push(url);
      const followed = repository.snapshot?.followed;

      if (!followed?.some((entry) => entry.url === url)) return;

      const rest = followed.filter((entry) => entry.url !== url);
      repository.snapshot = { ...repository.snapshot!, followed: rest };

      if (!rest.length) delete repository.snapshot.followed;

      for (const listener of listeners.repository) listener();
    },
  };

  const calls: [PullRequest, string | undefined][] = [];

  type Result = Awaited<ReturnType<Coordinator['cleanUpMerge']>>;

  let pending: PromiseWithResolvers<Result> | undefined;
  const progress: MergeCleanup[] = [];
  const notices: string[] = [];

  const coordinator = {
    snapshot: {
      phase: 'idle',
      queue: [],
      conversation: { id: 'c' },
    } as unknown as Snapshot,
    // as the real one does, a notice publishes, and only a saved one reaches the transcript's record
    notice: (text: string, _cwd?: string, save = true) => {
      if (save) notices.push(text);

      publishCoordinator({});
    },
    subscribe: (listener: () => void) => {
      listeners.coordinator.add(listener);

      return () => listeners.coordinator.delete(listener);
    },
    // as operate does, the cleanup holds the phase until it settles
    cleanUpMerge: (
      merged: PullRequest,
      install?: string,
      remaining: MergeCleanup = {},
    ) => {
      calls.push([merged, install]);
      progress.push(remaining);
      publishCoordinator({ phase: 'cleaning' });
      pending = Promise.withResolvers<Result>();

      return pending.promise;
    },
  };

  const publishRepository = async (snapshot = repository.snapshot) => {
    repository.snapshot = snapshot;

    for (const listener of listeners.repository) listener();

    await tick();
  };

  function publishCoordinator(update: Partial<Snapshot>) {
    coordinator.snapshot = { ...coordinator.snapshot, ...update };

    for (const listener of listeners.coordinator) listener();
  }

  const publish = async (update: Partial<Snapshot> = {}) => {
    publishCoordinator(update);
    await tick();
  };

  const settle = async (value: Result | Error) => {
    publishCoordinator({ phase: 'idle' });

    if (value instanceof Error) pending!.reject(value);
    else pending!.resolve(value);

    await tick();
  };

  const stop = watchMerges(repository, coordinator, '/install');
  register(stop);

  return {
    calls,
    notices,
    progress,
    unfollowed,
    publishRepository,
    publish,
    settle,
    stop,
  };
}

test('the watch cleans up after each merged commit once, only on its branch, clean and idle', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const { calls, publishRepository, publish, settle, stop } = fixture(
    t.onTestFinished,
  );

  await publishRepository(status(pr('OPEN', 'c1')));
  assert.equal(calls.length, 0, 'an open pull request');
  await publishRepository(status(pr('MERGED', 'c1'), { modified: 1 }));
  assert.equal(calls.length, 0, 'a modified checkout');
  await publishRepository(status(pr('MERGED', 'c1')));
  assert.deepEqual(calls, [[pr('MERGED', 'c1'), '/install']], 'a clean one');
  await publishRepository();
  await publish();
  assert.equal(calls.length, 1, 'publishes while the cleanup runs');
  await settle(true);
  vi.advanceTimersByTime(10_000);
  await publishRepository();
  await publish();
  assert.equal(calls.length, 1, 'publishes after it acted');
  await publish({ phase: 'running' });
  await publishRepository(status(pr('MERGED', 'c2')));
  assert.equal(calls.length, 1, 'a turn running');
  await publish({ phase: 'idle', error: 'boom' });
  assert.equal(calls.length, 1, 'an error shown');
  await publish({ error: undefined, queue: ['queued'] });
  assert.equal(calls.length, 1, 'a queued prompt');
  await publish({ queue: [] });
  assert.equal(calls.length, 2, 'idle, with no error or queue');
  await settle(false);
  await publish();
  assert.equal(calls.length, 2, 'a coordinator publish after nothing was done');
  await publishRepository();
  assert.equal(calls.length, 3, 'the next status publish');
  await settle(new Error('failed'));
  vi.advanceTimersByTime(10_000);
  await publishRepository();
  assert.equal(calls.length, 3, 'a status publish after a failure');
  await publishRepository(status(pr('MERGED', 'c3', 'feat/y')));
  assert.equal(calls.length, 3, "another branch's pull request");
  stop();
  await publishRepository(status(pr('MERGED', 'c4')));
  await publish();
  assert.equal(calls.length, 3, 'after the stop');
});

test('deferred cleanups retry without repository updates and settle after acting', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const { calls, publishRepository, publish, settle } = fixture(
    t.onTestFinished,
  );

  await publishRepository(status(pr('MERGED', 'c1')));

  for (const expected of [2, 3]) {
    await settle(false);
    await publish();
    vi.advanceTimersByTime(4999);
    await tick();
    assert.equal(calls.length, expected - 1);
    vi.advanceTimersByTime(1);
    await tick();
    assert.equal(calls.length, expected);
    assert.deepEqual(calls.at(-1), [pr('MERGED', 'c1'), '/install']);
    vi.advanceTimersByTime(10_000);
    await tick();
    assert.equal(calls.length, expected, 'a cleanup still running');
  }

  await settle(true);
  vi.advanceTimersByTime(10_000);
  await publish();
  assert.equal(calls.length, 3);
});

test('an expired retry waits for the local turn and queue to finish', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const { calls, publishRepository, publish, settle } = fixture(
    t.onTestFinished,
  );

  await publishRepository(status(pr('MERGED', 'c1')));
  await settle(false);
  await publish({ phase: 'running' });
  vi.advanceTimersByTime(5000);
  await tick();
  assert.equal(calls.length, 1);
  await publish({ phase: 'idle', queue: ['queued'] });
  assert.equal(calls.length, 1);
  await publish({ queue: [] });
  assert.equal(calls.length, 2);
  await settle(true);
});

test('a repository update replaces the pending retry', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { calls, publishRepository, settle } = fixture(t.onTestFinished);
  await publishRepository(status(pr('MERGED', 'c1')));
  await settle(false);
  vi.advanceTimersByTime(1000);
  await publishRepository();
  assert.equal(calls.length, 2);
  await settle(false);
  vi.advanceTimersByTime(4000);
  await tick();
  assert.equal(calls.length, 2);
  vi.advanceTimersByTime(1000);
  await tick();
  assert.equal(calls.length, 3);
  await settle(true);
});

test('a cleanup that finds a change the status line missed waits for its next update, not the timer', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const { calls, publishRepository, publish, settle } = fixture(
    t.onTestFinished,
  );

  await publishRepository(status(pr('MERGED', 'c1')));
  await settle('changed');
  await publish();
  vi.advanceTimersByTime(10_000);
  await tick();
  assert.equal(calls.length, 1);
  await publishRepository();
  assert.equal(calls.length, 2);
  await settle(true);
});

for (const pending of ['retry', 'cleanup', 'interrupted'] as const)
  test(`stopping the watch with a pending ${pending} prevents later cleanup`, async (t) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const { calls, publishRepository, publish, settle, stop } = fixture(
      t.onTestFinished,
    );

    await publishRepository(status(pr('MERGED', 'c1')));

    if (pending === 'retry') await settle(false);

    stop();

    if (pending === 'cleanup') await settle(false);

    if (pending === 'interrupted') await settle('interrupted');

    vi.advanceTimersByTime(10_000);
    await tick();
    await publishRepository();
    await publish();
    assert.equal(calls.length, 1);
  });

test('an interrupted cleanup keeps its progress after the repository leaves the merged branch', async (t) => {
  const { calls, progress, publishRepository, publish, settle } = fixture(
    t.onTestFinished,
  );

  await publishRepository(status(pr('MERGED', 'c1')));
  progress[0]!.moved = true;
  await publishRepository(status(undefined, { branch: 'main' }));
  await settle('interrupted');
  await publish();

  assert.deepEqual(calls, [
    [pr('MERGED', 'c1'), '/install'],
    [pr('MERGED', 'c1'), '/install'],
  ]);

  assert.equal(progress[1], progress[0]);
  assert.equal(progress[1]!.moved, true);
  await settle(true);
});

test('changing conversations drops an interrupted cleanup before it resumes', async (t) => {
  const { calls, publishRepository, publish, settle } = fixture(
    t.onTestFinished,
  );

  await publishRepository(status(pr('MERGED', 'c1')));
  await publishRepository(status(undefined, { branch: 'main' }));

  await publish({
    conversation: {
      id: 'next',
      title: 'Next',
      cwd: '/next',
      agent: 'a',
      sessions: {},
      createdAt: '',
    },
  });

  await settle('interrupted');
  await publish();
  assert.equal(calls.length, 1);
});

/** pull request `number`'s merge at `commit`, as `followed` holds it with the checkout on `main`. */
const left = (commit: string, number = 7): PullRequest => ({
  ...pr('MERGED', commit),
  number,
  url: `https://x.test/${number}`,
});

const following = (...followed: PullRequest[]) =>
  status(undefined, { branch: 'main', followed });

test("a followed pull request's merge is cleaned up off its branch and unfollowed once it settles", async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const { calls, unfollowed, publishRepository, settle } = fixture(
    t.onTestFinished,
  );

  await publishRepository(following(left('c1')));
  assert.deepEqual(calls, [[left('c1'), '/install']]);
  await settle('changed');
  await publishRepository();
  assert.equal(calls.length, 2);
  await settle(false);
  vi.advanceTimersByTime(5000);
  await tick();
  assert.equal(calls.length, 3);
  await settle('interrupted');
  assert.equal(calls.length, 4);
  assert.deepEqual(unfollowed, []);
  await settle(true);
  assert.deepEqual(unfollowed, ['https://x.test/7']);
  await publishRepository(following(left('c2')));
  assert.equal(calls.length, 5);
  await settle(new Error('failed'));
  assert.deepEqual(unfollowed, ['https://x.test/7', 'https://x.test/7']);
  await publishRepository();
  assert.equal(calls.length, 5);
});

test('a followed cleanup that finds a change after a repository publish during its run runs again without another', async (t) => {
  const { calls, publishRepository, settle } = fixture(t.onTestFinished);
  await publishRepository(following(left('c1')));
  await publishRepository();
  await settle('changed');
  assert.equal(calls.length, 2);
  await settle(true);
});

test('a merge read on its branch during a turn is still cleaned up once the turn leaves the branch', async (t) => {
  const { calls, publishRepository, publish, settle } = fixture(
    t.onTestFinished,
  );

  await publish({ phase: 'running' });
  await publishRepository(status(pr('MERGED', 'c1')));
  await publishRepository(following(left('c1')));
  assert.equal(calls.length, 0);
  await publish({ phase: 'idle' });
  assert.deepEqual(calls, [[left('c1'), '/install']]);
  await settle(true);
});

test("a merge cleaned up on its branch and then followed after the cleanup's own switch is unfollowed without a second cleanup", async (t) => {
  const { calls, unfollowed, publishRepository, settle } = fixture(
    t.onTestFinished,
  );

  await publishRepository(status(pr('MERGED', 'c1')));
  await settle(true);
  await publishRepository(following(left('c1')));
  assert.equal(calls.length, 1);
  assert.deepEqual(unfollowed, ['https://x.test/7', 'https://x.test/7']);
});

const urls = (calls: [PullRequest, string | undefined][]) =>
  calls.map(([{ url }]) => url.slice(-1));

test('each merged pull request keeps its own wait, retry and progress', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  {
    const { calls, publishRepository, settle } = fixture(t.onTestFinished);
    await publishRepository(following(left('c1'), left('c2', 8)));
    await settle('changed');
    await settle(false);
    vi.advanceTimersByTime(5000);
    await tick();
    assert.deepEqual(urls(calls), ['7', '8', '8'], "A 'changed', B false");
    await settle(false);
    await publishRepository();
    assert.deepEqual(urls(calls), ['7', '8', '8', '7']);
    await settle(true);
  }

  {
    const { calls, publishRepository, settle } = fixture(t.onTestFinished);
    await publishRepository(following(left('c1'), left('c2', 8)));
    await settle(false);
    await settle('changed');
    vi.advanceTimersByTime(5000);
    await tick();
    assert.deepEqual(urls(calls), ['7', '8', '7'], "A false, B 'changed'");
    await settle(true);
  }

  {
    const { calls, progress, unfollowed, publishRepository, settle } = fixture(
      t.onTestFinished,
    );

    await publishRepository(following(left('c1'), left('c2', 8)));
    await settle('interrupted');
    await settle('changed');
    await settle(true);
    assert.deepEqual(unfollowed, ['https://x.test/8']);
    assert.deepEqual(urls(calls), ['7', '7', '8', '7'], 'B true');
    assert.equal(progress[3], progress[0]);
    await settle(true);
  }

  {
    const { calls, progress, publishRepository, settle } = fixture(
      t.onTestFinished,
    );

    await publishRepository(following(left('c1'), left('c2', 8)));
    await settle('interrupted');
    await settle(false);
    await settle('interrupted');
    await settle(false);
    vi.advanceTimersByTime(5000);
    await tick();
    await settle(false);
    await tick();
    assert.deepEqual(urls(calls), ['7', '7', '8', '8', '7', '8']);

    const runs = (url: string) =>
      progress.filter((_, index) => urls(calls)[index] === url);

    assert.notEqual(progress[2], progress[0]);
    assert.ok(runs('7').every((each) => each === progress[0]));
    assert.ok(runs('8').every((each) => each === progress[2]));
    await settle(true);
  }

  {
    const { calls, unfollowed, publishRepository, settle } = fixture(
      t.onTestFinished,
    );

    await publishRepository(following(left('c1'), left('c1', 8)));
    await settle(true);
    await settle(true);
    assert.deepEqual(urls(calls), ['7', '8'], 'one head commit');
    assert.deepEqual(unfollowed, ['https://x.test/7', 'https://x.test/8']);
  }
});

test('a merge that lands with the checkout on the base is cleaned up through the watch', async (t) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { checkout, other, tip } = await merged();
  let state = 'OPEN';

  const answer = () =>
    view({
      number: 7,
      url: 'https://x.test/7',
      state,
      headRefOid: tip,
      baseRefName: 'main',
      statusCheckRollup: [],
    });

  const watch = new RepositoryWatch(
    checkout,
    async (command, args, options) => {
      if (command !== 'gh') return runCommand(command, args, options);

      const selector = args[2] === '--json' ? undefined : args[2];

      // gh reads the checked-out branch's pull request, and lists only open ones by name
      if (
        selector === 'https://x.test/7' ||
        (selector === undefined &&
          (await git(checkout, 'branch', '--show-current')) === 'feat/x') ||
        (selector === 'feat/x' && state === 'OPEN')
      )
        return { stdout: answer() };

      throw Object.assign(new Error('no pull requests found'), { code: 1 });
    },
    undefined,
    { interval: 50 },
  );

  t.onTestFinished(() => watch.close());

  const stop = watchMerges(watch, {
    snapshot: { phase: 'idle', queue: [] } as unknown as Snapshot,
    subscribe: () => () => {},
    notice: () => {},
    cleanUpMerge: async (pullRequest, _install, progress = {}) => {
      const result = await cleanUpMerge(checkout, pullRequest, idle, {
        progress,
      });

      return typeof result === 'object' ? true : (result ?? false);
    },
  });

  t.onTestFinished(stop);
  await until("the branch's pull request", () => !!watch.snapshot?.pullRequest);
  await git(checkout, 'switch', 'main');

  await until(
    'the pull request followed from main',
    () =>
      watch.snapshot?.branch === 'main' &&
      watch.snapshot.followed?.length === 1,
  );

  await merge(other, 'feat/x');
  state = 'MERGED';
  vi.setSystemTime(Date.now() + 90_000);

  await until(
    'the cleanup',
    async () =>
      watch.snapshot?.followed === undefined &&
      !(await branches(checkout)).includes('feat/x'),
  );

  assert.equal(
    await git(checkout, 'rev-parse', 'main'),
    await git(other, 'rev-parse', 'HEAD'),
  );
});

const waits = (reason: string, number = 7) =>
  `#${number} merged, but its cleanup is waiting: ${reason}.`;

const running = "the conversation's phase is running";

const elsewhere =
  "the checkout isn't in the state the cleanup needs, so it waits for a repository update";

const advance = async (ms: number) => {
  vi.advanceTimersByTime(ms);
  await tick();
};

const conversation = (id: string): Snapshot['conversation'] => ({
  id,
  title: '',
  cwd: '/x',
  agent: 'a',
  sessions: {},
  createdAt: '',
});

test('a merge held for 15 s says why, and each new reason of the same hold is said once', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const { calls, notices, publishRepository, publish, settle } = fixture(
    t.onTestFinished,
  );

  await publish({ phase: 'running' });
  await publishRepository(status(pr('MERGED', 'c1')));
  await advance(14_999);
  assert.deepEqual(notices, []);
  await advance(1);
  assert.deepEqual(notices, [waits(running)]);
  await advance(60_000);
  assert.equal(notices.length, 1);
  await publish({ phase: 'idle', queue: ['q'] });
  assert.equal(notices.at(-1), waits('a prompt is queued'));
  await publish({ error: 'boom\nmore' });
  assert.equal(notices.at(-1), waits('an error is showing: boom'));
  await publishRepository(status(pr('MERGED', 'c1'), { modified: 1 }));
  await publish({ error: undefined, queue: [] });
  assert.equal(notices.at(-1), waits('the checkout has uncommitted changes'));
  assert.equal(notices.length, 4);
  await publish({ phase: 'running' });
  await publishRepository(status(pr('MERGED', 'c1')));
  await advance(15_000);
  assert.equal(notices.length, 4, 'a reason already said');
  assert.equal(calls.length, 0);
  await publish({ phase: 'idle' });
  assert.equal(calls.length, 1);
  await settle(true);
  await advance(60_000);
  assert.equal(notices.length, 4);
});

test('a hold that ends within 15 s says nothing, and reasons that change within it share its 15 s', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  {
    const { calls, notices, publishRepository, publish, settle } = fixture(
      t.onTestFinished,
    );

    await publish({ phase: 'running' });
    await publishRepository(status(pr('MERGED', 'c1')));
    await advance(10_000);
    await publish({ phase: 'idle' });
    assert.equal(calls.length, 1);
    await settle(true);
    await advance(20_000);
    assert.deepEqual(notices, []);
  }

  {
    const { notices, publishRepository, publish } = fixture(t.onTestFinished);
    await publish({ phase: 'running' });
    await publishRepository(status(pr('MERGED', 'c1')));
    await advance(10_000);
    await publish({ phase: 'idle', queue: ['q'] });
    await advance(4999);
    assert.deepEqual(notices, []);
    await advance(1);
    assert.deepEqual(notices, [waits('a prompt is queued')]);
  }
});

test('each merged pull request held for the same reason says so', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { notices, publishRepository, publish } = fixture(t.onTestFinished);
  await publish({ phase: 'running' });
  await publishRepository(following(left('c1'), left('c2', 8)));
  await advance(15_000);
  assert.deepEqual(notices, [waits(running), waits(running, 8)]);
});

test("repository updates during one long turn don't postpone its hold notice", async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { notices, publishRepository, publish } = fixture(t.onTestFinished);
  await publish({ phase: 'running' });
  await publishRepository(status(pr('MERGED', 'c1')));

  for (const untracked of [1, 2]) {
    await advance(5000);
    await publishRepository(status(pr('MERGED', 'c1'), { untracked }));
  }

  await advance(4999);
  assert.deepEqual(notices, []);
  await advance(1);
  assert.deepEqual(notices, [waits(running)]);
});

test('a running cleanup is never reported as waiting, and a second merge behind it says so after 15 s', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const { calls, notices, publishRepository, settle } = fixture(
    t.onTestFinished,
  );

  await publishRepository(following(left('c1'), left('c2', 8)));
  // clears the running cleanup's wait, as its own switch does
  await publishRepository();
  await advance(15_000);
  assert.deepEqual(notices, [waits("the conversation's phase is cleaning", 8)]);
  await advance(60_000);
  assert.equal(notices.length, 1);
  await settle(true);
  assert.deepEqual(urls(calls), ['7', '8']);
  await settle(true);
});

test('a cleanup deferred three times running says why, whatever the reasons, once per reason', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const locked = 'another Witch is updating this checkout';
  const unreadable = "a conversation record can't be read";

  {
    const { notices, progress, publishRepository, settle } = fixture(
      t.onTestFinished,
    );

    const defer = async (reason?: string) => {
      if (reason) progress.at(-1)!.deferred = reason;

      await settle(false);
      const told = [...notices];
      await advance(5000);

      return told;
    };

    await publishRepository(status(pr('MERGED', 'c1')));
    assert.deepEqual(await defer(locked), []);
    assert.deepEqual(await defer(locked), []);
    assert.deepEqual(await defer(locked), [waits(locked)]);
    assert.deepEqual(await defer(locked), [waits(locked)]);

    assert.deepEqual(await defer(unreadable), [
      waits(locked),
      waits(unreadable),
    ]);

    assert.equal((await defer(locked)).length, 2);
    assert.equal((await defer()).length, 2, 'a deferral that gave no reason');
    await settle(true);
    assert.equal(progress.length, 8);
  }

  {
    const { notices, progress, publishRepository, settle } = fixture(
      t.onTestFinished,
    );

    await publishRepository(status(pr('MERGED', 'c1')));

    for (const reason of [locked, unreadable]) {
      progress.at(-1)!.deferred = reason;
      await settle(false);
      await advance(5000);
    }

    assert.deepEqual(notices, []);
    progress.at(-1)!.deferred = locked;
    await settle(false);
    assert.deepEqual(notices, [waits(locked)]);
  }

  // an interrupted attempt ends the run of deferrals
  {
    const { notices, progress, publishRepository, settle } = fixture(
      t.onTestFinished,
    );

    await publishRepository(status(pr('MERGED', 'c1')));

    for (let attempt = 0; attempt < 2; attempt++) {
      progress.at(-1)!.deferred = locked;
      await settle(false);
      await advance(5000);
    }

    await settle('interrupted');
    assert.equal(progress.length, 4, 'the interrupted cleanup resumes');
    progress.at(-1)!.deferred = locked;
    await settle(false);
    assert.deepEqual(notices, []);
  }
});

test('a cleanup that found the checkout in another state says so after 15 s and runs again at the next repository update', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  {
    const { calls, notices, publishRepository, settle } = fixture(
      t.onTestFinished,
    );

    await publishRepository(status(pr('MERGED', 'c1')));
    await settle('changed');
    await advance(14_999);
    assert.deepEqual(notices, []);
    await advance(1);
    assert.deepEqual(notices, [waits(elsewhere)]);
    await publishRepository();
    assert.equal(calls.length, 2);
    await settle(true);
    await advance(60_000);
    assert.equal(notices.length, 1);
  }

  {
    const { notices, publishRepository, settle } = fixture(t.onTestFinished);
    await publishRepository(status(pr('MERGED', 'c1')));

    for (let attempt = 0; attempt < 2; attempt++) {
      await settle('changed');
      await advance(5000);
      await publishRepository();
    }

    assert.deepEqual(notices, [], 'updates less than 15 s apart');
    await settle('changed');
    assert.deepEqual(notices, [waits(elsewhere)]);
  }
});

test('a cleanup that ends after the watch stopped starts no hold', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const { notices, publishRepository, settle, stop } = fixture(
    t.onTestFinished,
  );

  await publishRepository(status(pr('MERGED', 'c1')));
  stop();
  await settle('changed');
  assert.equal(vi.getTimerCount(), 0);
  await advance(60_000);
  assert.deepEqual(notices, []);
});

test('no hold is reported while a conversation opens or closes, for a conversation that left or for a state that just ended', async (t) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  {
    const { notices, publishRepository, publish } = fixture(t.onTestFinished);
    await publish({ conversation: undefined, phase: 'starting' });
    await publishRepository(status(pr('MERGED', 'c1')));
    await advance(60_000);
    assert.deepEqual(notices, []);
  }

  // an open conversation whose files are still opening holds nothing, so its 15 s starts when they are open
  {
    const { notices, publishRepository, publish } = fixture(t.onTestFinished);
    await publish({ phase: 'starting' });
    await publishRepository(status(pr('MERGED', 'c1')));
    await advance(60_000);
    assert.deepEqual(notices, []);
    await publish({ phase: 'running' });
    await advance(14_999);
    assert.deepEqual(notices, []);
    await advance(1);
    assert.deepEqual(notices, [waits(running)]);
  }

  {
    const { notices, publishRepository, publish } = fixture(t.onTestFinished);
    await publish({ phase: 'running' });
    await publishRepository(status(pr('MERGED', 'c1')));
    await advance(14_999);
    await publish({ phase: 'closing' });
    await advance(60_000);
    assert.deepEqual(notices, []);
  }

  // a wait for a repository update keeps its hold through closing, and still posts nothing
  {
    const { notices, publishRepository, publish, settle } = fixture(
      t.onTestFinished,
    );

    await publishRepository(status(pr('MERGED', 'c1')));
    await settle('changed');
    await publish({ phase: 'closing' });
    await advance(60_000);
    assert.deepEqual(notices, []);
  }

  {
    const { notices, publishRepository, publish, settle } = fixture(
      t.onTestFinished,
    );

    await publishRepository(status(pr('MERGED', 'c1')));
    await settle('changed');
    await advance(10_000);
    await publish({ conversation: conversation('other') });
    await advance(14_999);
    assert.deepEqual(notices, [], "the new conversation's own 15 s");
    await advance(1);
    assert.deepEqual(notices, [waits(elsewhere)]);
  }

  // the state changes in the turn the timer expires, before the watch's next check
  {
    const { notices, publishRepository, publish } = fixture(t.onTestFinished);
    await publish({ phase: 'running' });
    await publishRepository(status(pr('MERGED', 'c1')));
    await advance(14_999);
    const published = publish({ conversation: conversation('other') });
    vi.advanceTimersByTime(1);
    await published;
    await tick();
    assert.deepEqual(notices, []);
  }

  {
    const { calls, notices, publishRepository, publish, settle } = fixture(
      t.onTestFinished,
    );

    await publish({ phase: 'running' });
    await publishRepository(status(pr('MERGED', 'c1')));
    await advance(14_999);
    const published = publish({ phase: 'idle' });
    vi.advanceTimersByTime(1);
    await published;
    await tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(notices, []);
    await settle(true);
  }

  {
    const { notices, publishRepository, publish } = fixture(t.onTestFinished);
    await publish({ phase: 'running' });
    await publishRepository(status(pr('MERGED', 'c1')));
    await advance(10_000);
    await publishRepository(status(undefined, { branch: 'main' }));
    await advance(60_000);
    assert.deepEqual(notices, []);
  }
});
