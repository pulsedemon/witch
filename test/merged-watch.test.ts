import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { Coordinator } from '../src/core/coordinator.js';
import type { Snapshot } from '../src/core/snapshot.js';
import { watchMerges } from '../src/core/merged.js';
import type { MergeCleanup } from '../src/core/merged.js';
import type { PullRequest, Repository } from '../src/core/repository.js';
import type { RegisterCleanup } from './fixtures/cleanup.js';
import { repositoryRead } from './fixtures/repository.js';

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
  const repository = {
    snapshot: undefined as Repository | undefined,
    subscribe: (listener: () => void) => {
      listeners.repository.add(listener);
      return () => listeners.repository.delete(listener);
    },
  };
  const calls: [PullRequest, string | undefined][] = [];
  type Result = Awaited<ReturnType<Coordinator['cleanUpMerge']>>;
  let pending: PromiseWithResolvers<Result> | undefined;
  const progress: MergeCleanup[] = [];
  const coordinator = {
    snapshot: { phase: 'idle', queue: [] } as unknown as Snapshot,
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
  return { calls, progress, publishRepository, publish, settle, stop };
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
