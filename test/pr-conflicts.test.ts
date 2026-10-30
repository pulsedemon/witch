import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test, vi } from 'vitest';
import type { MergeEvent } from '../src/core/merge-events.js';
import { watchConflicts } from '../src/core/pr-conflicts.js';
import { RepositoryWatch } from '../src/core/repository.js';
import type {
  Conflict,
  PullRequest,
  Repository,
} from '../src/core/repository.js';
import type { Snapshot } from '../src/core/snapshot.js';
import type { RegisterCleanup } from './fixtures/cleanup.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const pr = (fields: Partial<PullRequest> = {}): PullRequest => ({
  number: 7,
  url: 'https://github.com/o/r/pull/7',
  state: 'OPEN',
  branch: 'feat/x',
  commit: 'a1b2c3',
  base: 'main',
  checks: 'passing',
  ...fields,
});
const status = (fields: Partial<Repository> = {}): Repository => ({
  branch: 'feat/x',
  ahead: 0,
  behind: 0,
  staged: 0,
  modified: 0,
  conflicts: 0,
  untracked: 0,
  ...fields,
});
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
  let events: MergeEvent[] = [];
  const coordinator = {
    snapshot: {
      conversation: { id: 'c', cwd: '/w' },
      items: [],
    } as unknown as Snapshot,
    conflict: undefined as Conflict | undefined,
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
      mergeEvents: () => events,
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
  return { coordinator, notices, publish, merged };
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
  const { coordinator, notices, publish } = fixture(
    t.onTestFinished,
    stub.repository,
  );
  const conflict = { pullRequest: pr({ mergeable: 'CONFLICTING' }) };
  await stub.publish(status({ pullRequest: conflict.pullRequest, conflict }));
  assert.deepEqual(coordinator.conflict, conflict);
  assert.deepEqual(notices, [
    {
      text: 'Pull request conflict: [#7](https://github.com/o/r/pull/7) at a1b2c3 conflicts with main.',
      save: false,
    },
  ]);
  await stub.publish(status({ pullRequest: conflict.pullRequest, conflict }));
  assert.equal(notices.length, 1);
  publish({ conversation: { id: 'd', cwd: '/w' } as never, items: [] });
  await tick();
  assert.equal(notices.length, 2, 'a newly opened conversation');
  await stub.publish(undefined);
  assert.deepEqual(coordinator.conflict, conflict);
  await stub.publish(status({ pullRequest: pr({ mergeable: 'MERGEABLE' }) }));
  assert.equal(coordinator.conflict, undefined);
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
  await delay(20);
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
  assert.equal(reads, 2);
  assert.equal(coordinator.conflict?.pullRequest.mergeable, 'CONFLICTING');
  assert.equal(coordinator.conflict.baseTip, 'f00');
  await merged([
    merge('old', 'main'),
    merge('other', 'release'),
    merge('new', 'main'),
  ]);
  await step();
  assert.equal(reads, 2, 'a repeated event');
});
