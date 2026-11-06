import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test, vi } from 'vitest';
import type { MergeEvent } from '../src/core/merge-events.js';
import { watchConflicts } from '../src/core/pr-repair.js';
import { RepositoryWatch } from '../src/core/repository.js';
import type { Conflict, Repository } from '../src/core/repository.js';
import type { Snapshot } from '../src/core/snapshot.js';
import type { RegisterCleanup } from './fixtures/cleanup.js';
import { until } from './fixtures/within.js';
import { pullRequest, repositoryRead } from './fixtures/repository.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const pr = pullRequest;
const status = repositoryRead;
const merge = (id: string, base: string): MergeEvent => ({
  id,
  project: 'p',
  source: 's',
  observedAt: '2026-10-30T00:00:00.000Z',
  pullRequest: { ...pr({ branch: id, base }), state: 'MERGED' },
  recipients: ['c'],
});

/** a coordinator whose `notice` adds an unsaved row and publishes, as the real one does. */
function fixture(
  register: RegisterCleanup,
  repository: Parameters<typeof watchConflicts>[0],
) {
  const listeners = new Set<() => void>();
  const coordinationListeners = new Set<() => void>();
  const notices: { text: string; save: boolean | undefined }[] = [];
  const observed: (Repository | undefined)[] = [];
  let events: MergeEvent[] = [];
  const coordinator = {
    snapshot: {
      conversation: { id: 'c', cwd: '/w' },
      items: [],
    } as unknown as Snapshot,
    conflict: undefined as Conflict | undefined,
    repair: {
      setRefresh: () => {},
      observe: (repository: Repository | undefined) =>
        observed.push(repository),
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notice: (text: string, cwd?: string, save?: boolean) => {
      notices.push({ text, save });
      publish({
        items: [
          ...coordinator.snapshot.items,
          { id: String(notices.length), kind: 'notice', text, cwd: cwd! },
        ],
      });
    },
    coordination: {
      subscribe: (listener: () => void) => {
        coordinationListeners.add(listener);
        return () => coordinationListeners.delete(listener);
      },
      events: { mergeEvents: () => events },
    },
  };
  function publish(update: Partial<Snapshot>) {
    coordinator.snapshot = { ...coordinator.snapshot, ...update };
    for (const listener of listeners) listener();
  }
  const merged = async (next: MergeEvent[]) => {
    events = next;
    for (const listener of coordinationListeners) listener();
    await tick();
  };
  register(
    watchConflicts(
      repository,
      coordinator as unknown as Parameters<typeof watchConflicts>[1],
    ),
  );
  return { coordinator, notices, observed, publish, merged };
}

function stubRepository() {
  const listeners = new Set<() => void>();
  let refreshes = 0;
  const repository = {
    snapshot: undefined as Repository | undefined,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refreshPullRequest: () => refreshes++,
    readPullRequest: async () => {},
  };
  const publish = async (snapshot: Repository | undefined) => {
    repository.snapshot = snapshot;
    for (const listener of listeners) listener();
    await tick();
  };
  return { repository, publish, refreshes: () => refreshes };
}

test('a conflict reaches the coordinator with one unsaved notice per conversation, outlasts a failed status read and clears on a fresh one', async (t) => {
  const stub = stubRepository();
  const { coordinator, notices, observed, publish } = fixture(
    t.onTestFinished,
    stub.repository,
  );
  const conflict = { pullRequest: pr({ mergeable: 'CONFLICTING' }) };
  const conflicted = status({ pullRequest: conflict.pullRequest, conflict });
  await stub.publish(conflicted);
  assert.deepEqual(coordinator.conflict, conflict);
  assert.equal(observed.at(-1), conflicted);
  assert.deepEqual(notices, [
    {
      text: 'Pull request conflict: [#7](https://github.com/o/r/pull/7) at a1b2c3 conflicts with main.',
      save: false,
    },
  ]);
  await stub.publish(status({ pullRequest: conflict.pullRequest, conflict }));
  assert.equal(notices.length, 1);
  observed.length = 0;
  publish({ conversation: { id: 'd', cwd: '/w' } as never, items: [] });
  await tick();
  assert.equal(notices.length, 2, 'a newly opened conversation');
  assert.deepEqual(observed, [conflicted], 'a coordinator publication');
  await stub.publish(undefined);
  assert.deepEqual(coordinator.conflict, conflict);
  assert.equal(observed.at(-1), undefined);
  const mergeable = status({ pullRequest: pr({ mergeable: 'MERGEABLE' }) });
  await stub.publish(mergeable);
  assert.equal(coordinator.conflict, undefined);
  assert.equal(observed.at(-1), mergeable);
});

test('a merge into the pull request base reads it again, and a pull request that turns conflicting reaches the coordinator', async (t) => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });
  let mergeable = 'MERGEABLE';
  let reads = 0;
  const watch = new RepositoryWatch('/work', async (command, args) => {
    if (command !== 'gh') return { stdout: '# branch.head feat/x\n' };
    if (args[0] === 'api') return { stdout: 'f00\n' };
    reads++;
    return {
      stdout: JSON.stringify({
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        state: 'OPEN',
        headRefName: 'feat/x',
        headRefOid: 'a1b2c3',
        baseRefName: 'main',
        mergeable,
        statusCheckRollup: [],
      }),
    };
  });
  t.onTestFinished(() => watch.close());
  const { coordinator, merged } = fixture(t.onTestFinished, watch);
  const step = async () => {
    vi.advanceTimersByTime(5000);
    await delay(20);
  };
  await until('first pull request read', () => !!watch.snapshot?.pullRequest);
  assert.equal(reads, 1);
  await merged([merge('old', 'main')]);
  await step();
  assert.equal(reads, 1, 'a merge recorded before the first read');
  mergeable = 'CONFLICTING';
  await merged([merge('old', 'main'), merge('other', 'release')]);
  await step();
  assert.equal(reads, 1, 'a merge into another base');
  await merged([
    merge('old', 'main'),
    merge('other', 'release'),
    merge('new', 'main'),
  ]);
  await step();
  // the base tip's read follows the pull request's, so the conflict can land after the read starts
  await until('conflict', () => coordinator.conflict?.baseTip === 'f00');
  assert.equal(reads, 2);
  assert.equal(coordinator.conflict?.pullRequest.mergeable, 'CONFLICTING');
  await merged([
    merge('old', 'main'),
    merge('other', 'release'),
    merge('new', 'main'),
  ]);
  await step();
  assert.equal(reads, 2, 'a repeated event');
});
