import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test, vi } from 'vitest';
import type { Coordinator } from '../../../src/core/coordinator.js';
import type { MergeEvent } from '../../../src/core/repository/merge-events.js';
import { watchConflicts } from '../../../src/core/repository/pr-repair.js';
import { RepositoryWatch } from '../../../src/core/repository/repository.js';
import type {
  Conflict,
  Repository,
} from '../../../src/core/repository/repository.js';
import type { Snapshot } from '../../../src/core/snapshot.js';
import type { RegisterCleanup } from '../../fixtures/cleanup.js';
import { until } from '../../fixtures/within.js';
import { pullRequest, repositoryRead } from '../../fixtures/repository.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const pr = pullRequest;
const status = repositoryRead;

const merge = (
  id: string,
  base: string,
  observedAt = '2026-10-30T00:00:00.000Z',
): MergeEvent => ({
  id,
  project: 'p',
  source: 's',
  observedAt,
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
    notice: (
      text: string,
      { cwd, save }: Parameters<Coordinator['notice']>[1] = {},
    ) => {
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
    pullRequestReadAt: undefined as number | undefined,
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

test('a pull request read that failed gets one unsaved notice per failure, again after a read that works and in a new transcript', async (t) => {
  const stub = stubRepository();
  const { notices, publish } = fixture(t.onTestFinished, stub.repository);

  const failed = (failure = 'number: missing') =>
    status({ pullRequestFailure: failure });

  const text = "Can't read this branch's pull request: number: missing";
  const conversation = { id: 'c', cwd: '/w' } as never;
  publish({ conversation: undefined });
  await stub.publish(failed());
  assert.equal(notices.length, 0, 'no conversation is open');
  publish({ conversation });
  await tick();
  assert.deepEqual(notices, [{ text, save: false }]);
  await stub.publish(failed());
  assert.equal(notices.length, 1, 'the same failure again');
  await stub.publish(status());
  await stub.publish(failed());
  assert.equal(notices.length, 1, 'gh had no answer in between');
  await stub.publish(status({ pullRequest: pr() }));
  await stub.publish(failed());
  assert.equal(notices.length, 2, 'the failure came back after a read worked');
  // both publications land before the scheduled check runs
  void stub.publish(status({ pullRequest: pr() }));
  await stub.publish(failed());
  assert.equal(notices.length, 3, 'a read worked between two checks');
  await stub.publish(failed('url: missing'));
  assert.equal(notices.at(-1)!.text.endsWith('url: missing'), true);
  assert.equal(notices.length, 4, 'a different failure');
  publish({ conversation: { id: 'd', cwd: '/w' } as never, items: [] });
  await tick();
  assert.equal(notices.length, 5, 'a newly opened conversation');
});

test('a failure beside a pull request that was read gets one notice until a read has none', async (t) => {
  const stub = stubRepository();
  const { notices } = fixture(t.onTestFinished, stub.repository);

  const partial = (fields: Partial<Repository> = {}) =>
    status({
      pullRequest: pr(),
      pullRequestFailure: 'spawn gh EMFILE',
      ...fields,
    });

  await stub.publish(partial());
  await stub.publish(partial({ modified: 1 }));

  assert.deepEqual(
    notices.map(({ text }) => text),
    ["Can't read this branch's pull request: spawn gh EMFILE"],
    'the same failure at the next status',
  );

  await stub.publish(status({ pullRequest: pr() }));
  await stub.publish(partial());

  assert.equal(
    notices.length,
    2,
    'the failure came back after a read without one',
  );
});

test("a failed read of a followed pull request is reported once, with or without the branch's own", async (t) => {
  const text =
    "Can't read a pull request this checkout left: #4: number: missing";

  const left = (fields: Partial<Repository> = {}) =>
    status({
      branch: 'main',
      followed: [pr({ number: 4 })],
      followedFailure: '#4: number: missing',
      ...fields,
    });

  {
    const stub = stubRepository();
    const { notices } = fixture(t.onTestFinished, stub.repository);
    await stub.publish(left());
    await stub.publish(left({ modified: 1 }));
    assert.deepEqual(notices, [{ text, save: false }]);
    await stub.publish(left({ followedFailure: undefined }));
    assert.equal(notices.length, 1, 'a followed read without one');
    await stub.publish(left());
    assert.equal(notices.length, 2, 'the failure came back');
  }

  const stub = stubRepository();
  const { notices } = fixture(t.onTestFinished, stub.repository);
  await stub.publish(left({ pullRequestFailure: 'spawn gh EMFILE' }));

  await stub.publish(
    left({ pullRequestFailure: 'spawn gh EMFILE', modified: 1 }),
  );

  assert.deepEqual(
    notices.map(({ text }) => text),
    ["Can't read this branch's pull request: spawn gh EMFILE", text],
  );
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
  const before = '1969-12-31T23:59:59.000Z';
  await merged([merge('old', 'main', before)]);
  await step();
  assert.equal(reads, 1, 'a merge recorded before the first read');
  mergeable = 'CONFLICTING';
  await merged([merge('old', 'main'), merge('other', 'release')]);
  await step();
  assert.equal(reads, 1, 'a merge into another base');

  await merged([
    merge('old', 'main', before),
    merge('other', 'release'),
    merge('new', 'main'),
  ]);

  await step();
  // the base tip's read follows the pull request's, so the conflict can land after the read starts
  await until('conflict', () => coordinator.conflict?.baseTip === 'f00');
  assert.equal(reads, 2);
  assert.equal(coordinator.conflict?.pullRequest.mergeable, 'CONFLICTING');

  await merged([
    merge('old', 'main', before),
    merge('other', 'release'),
    merge('new', 'main'),
  ]);

  await step();
  assert.equal(reads, 2, 'a repeated event');
});

const at = (milliseconds: number) => new Date(milliseconds).toISOString();

for (const [name, observed, expected] of [
  ['a merge observed after the first open read started refreshes it', 2000, 1],
  ['a merge observed before the first open read started does not', 500, 0],
] as const)
  test(name, async (t) => {
    const stub = stubRepository();
    const { merged } = fixture(t.onTestFinished, stub.repository);
    stub.repository.pullRequestReadAt = 1000;
    await stub.publish(status({ pullRequest: pr() }));
    // the first coordination notification after the read
    await merged([merge('m', 'main', at(observed))]);
    assert.equal(stub.refreshes(), expected);
  });

test('a merge delivered before the open read publishes refreshes it once it does', async (t) => {
  const stub = stubRepository();
  const { merged } = fixture(t.onTestFinished, stub.repository);
  stub.repository.pullRequestReadAt = 1000;
  await merged([merge('m', 'main', at(1500))]);
  assert.equal(stub.refreshes(), 0);
  await stub.publish(status({ pullRequest: pr() }));
  assert.equal(stub.refreshes(), 1);
});

test('a merge delivered before the conversation opens refreshes the pull request once it does', async (t) => {
  const stub = stubRepository();

  const { coordinator, merged, publish } = fixture(
    t.onTestFinished,
    stub.repository,
  );

  const conversation = coordinator.snapshot.conversation;
  publish({ conversation: undefined });
  stub.repository.pullRequestReadAt = 1000;
  await stub.publish(status({ pullRequest: pr() }));
  await merged([merge('m', 'main', at(2000))]);
  assert.equal(stub.refreshes(), 0);
  publish({ conversation });
  await tick();
  assert.equal(stub.refreshes(), 1);
});
