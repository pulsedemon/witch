import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import {
  RepositoryWatch,
  parseStatus,
} from '../../../src/core/repository/repository.js';
import type { Run } from '../../../src/core/repository/repository.js';
import { view } from '../../fixtures/repository.js';
import { until } from '../../fixtures/within.js';

/** a watch on `main` whose pull request reads answer with `answer`, recording each tip lookup's arguments. */
function conflictWatch(options: {
  answer: () => object | Error;
  tip?: () => string | Error;
  branch?: () => string;
  project?: () => Promise<string>;
}) {
  const reads = { pr: 0, tips: [] as string[][] };

  const watch = new RepositoryWatch(
    '/work',
    async (command, args) => {
      if (command !== 'gh')
        return { stdout: `# branch.head ${options.branch?.() ?? 'main'}\n` };

      if (args.includes('graphql'))
        throw new Error('configuration unavailable');

      if (args[0] === 'api') {
        reads.tips.push(args);
        const tip = options.tip?.() ?? 'f00';

        if (tip instanceof Error) throw tip;

        return { stdout: `${tip}\n` };
      }

      reads.pr++;
      const answer = options.answer();

      if (answer instanceof Error) throw answer;

      return {
        stdout: view({
          url: 'https://github.com/o/r/pull/4',
          state: 'OPEN',
          statusCheckRollup: [],
          ...answer,
        }),
      };
    },
    options.project,
  );

  return { watch, reads };
}

test("a conflicting read records its base's tip, and only a mergeable or closed read clears it", async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });

  let answer: object | Error = { mergeable: 'CONFLICTING' };
  let tip: string | Error = 'f00';

  const { watch, reads } = conflictWatch({
    answer: () => answer,
    tip: () => tip,
  });

  // a function, so an assertion that it's unset doesn't narrow later reads
  const conflict = () => watch.snapshot?.conflict;

  const read = async (next: object | Error) => {
    answer = next;
    watch.refreshPullRequest();
    vi.advanceTimersByTime(5000);
    await delay(20);
  };

  try {
    await delay(20);

    assert.deepEqual(reads.tips, [
      [
        'api',
        '--hostname',
        'github.com',
        'repos/o/r/commits/develop',
        '--jq',
        '.sha',
      ],
    ]);

    assert.equal(conflict()?.baseTip, 'f00');
    assert.equal(conflict()?.pullRequest.commit, 'a1b2c3');
    await read({ mergeable: 'UNKNOWN' });
    assert.equal(watch.snapshot?.pullRequest?.mergeable, 'UNKNOWN');
    assert.equal(conflict()?.baseTip, 'f00');
    await read(new Error('network'));
    assert.equal(watch.snapshot?.pullRequest, undefined);
    assert.equal(conflict()?.baseTip, 'f00');
    await read({ mergeable: 'UNKNOWN' });
    assert.equal(conflict()?.baseTip, 'f00');
    assert.equal(reads.tips.length, 1);
    await read({ mergeable: 'UNKNOWN', headRefOid: 'd4e5f6' });
    assert.equal(conflict()?.pullRequest.commit, 'a1b2c3', 'a pushed head');
    tip = new Error('not found');
    await read({ mergeable: 'CONFLICTING' });
    assert.ok(conflict());
    assert.equal(conflict()?.baseTip, undefined);
    await read({ mergeable: 'UNKNOWN', baseRefName: 'main' });
    assert.equal(conflict()?.pullRequest.base, 'develop', 'a new base');
    await read({ mergeable: 'MERGEABLE' });
    assert.equal(conflict(), undefined);
    await read({ mergeable: 'CONFLICTING' });
    await read({ state: 'MERGED' });
    assert.equal(conflict(), undefined);
    assert.equal(reads.tips.length, 3);
  } finally {
    watch.close();
  }
});

test('an uncomputed mergeability is read again after 10 seconds, while a status read in between keeps a conflict', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });

  let answer: object = { mergeable: 'CONFLICTING' };
  const { watch, reads } = conflictWatch({ answer: () => answer });

  try {
    await delay(20);
    answer = { mergeable: 'UNKNOWN' };
    watch.refreshPullRequest();
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(reads.pr, 2);
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(reads.pr, 2);
    assert.ok(watch.snapshot?.conflict);
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(reads.pr, 3);
  } finally {
    watch.close();
  }
});

test('another local branch leaves a conflict out of the snapshot, and a read for another project leaves it in place', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });

  let branch = 'main';
  let answer: object | Error = { mergeable: 'CONFLICTING' };
  let project = 'a';
  let asked = 0;

  const { watch } = conflictWatch({
    answer: () => answer,
    branch: () => branch,
    // the second call checks the project hasn't changed while gh ran
    project: async () => (asked++ % 2 ? project : 'a'),
  });

  try {
    await delay(20);
    assert.ok(watch.snapshot?.conflict);
    project = 'b';
    answer = { mergeable: 'MERGEABLE' };
    watch.refreshPullRequest();
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.ok(watch.snapshot?.conflict);
    project = 'a';
    answer = new Error('no pull requests found');
    branch = 'feat/y';
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(watch.snapshot?.branch, 'feat/y');
    assert.equal(watch.snapshot?.conflict, undefined);
  } finally {
    watch.close();
  }
});

test('a refresh asked for while a pull request read runs reads again once it ends', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });

  const gh: PromiseWithResolvers<{ stdout: string }>[] = [];

  const watch = new RepositoryWatch('/work', (command) => {
    if (command !== 'gh')
      return Promise.resolve({ stdout: '# branch.head main\n' });

    const read = Promise.withResolvers<{ stdout: string }>();
    gh.push(read);

    return read.promise;
  });

  try {
    await delay(20);
    assert.equal(gh.length, 1);
    watch.refreshPullRequest();
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(gh.length, 1);
    gh[0]!.resolve({ stdout: view({ state: 'OPEN', statusCheckRollup: [] }) });
    await delay(20);
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(gh.length, 2);
  } finally {
    watch.close();
  }
});

test('a detached head reads no pull request', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });

  const calls: Parameters<Run>[] = [];

  const watch = new RepositoryWatch('/work', async (...args) => {
    calls.push(args);

    return { stdout: '# branch.head (detached)\n' };
  });

  try {
    await delay(20);
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(watch.snapshot?.branch, 'HEAD');
    assert.equal(calls.length, 4);

    for (const [command, args, { cwd, timeout, env }] of calls) {
      assert.equal(command, 'git');
      assert.equal(cwd, '/work');
      assert.equal(timeout, 10_000);

      assert.deepEqual(
        args,
        args.includes('status')
          ? [
              '-c',
              'core.fsmonitor=false',
              '--no-optional-locks',
              'status',
              '--porcelain=v2',
              '--branch',
              '--ignore-submodules=dirty',
            ]
          : ['config', '-z', '--name-only', '--show-scope', '--list'],
      );

      if (args.includes('status')) {
        assert.equal(env?.GIT_NO_LAZY_FETCH, '1');
        assert.equal(env?.GIT_ALLOW_PROTOCOL, '');
      }
    }

    assert.equal(calls.filter(([, args]) => args.includes('status')).length, 2);
  } finally {
    watch.close();
  }
});

test('a cached pull request keeps its observed project until a fresh scoped read', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });

  let project = 'project-a';

  const watch = new RepositoryWatch(
    '/work',
    async (command) => ({
      stdout:
        command === 'gh' ? view({ state: 'MERGED' }) : '# branch.head feat/x\n',
    }),
    async () => project,
  );

  try {
    await until(
      'initial scoped observation',
      () => watch.snapshot?.pullRequestProject === 'project-a',
    );

    project = 'project-b';
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(watch.snapshot?.pullRequestProject, 'project-a');
    vi.advanceTimersByTime(85_000);

    await until(
      'fresh scoped observation',
      () => watch.snapshot?.pullRequestProject === 'project-b',
    );

    assert.equal(watch.snapshot?.pullRequest?.state, 'MERGED');
  } finally {
    watch.close();
  }
});

test('a project change during a pull request read invalidates the observation', async () => {
  let project = 'project-a';
  let scopeReads = 0;

  const watch = new RepositoryWatch(
    '/work',
    async (command) => {
      if (command === 'git') return { stdout: '# branch.head feat/x\n' };

      project = 'project-b';

      return { stdout: view({ state: 'MERGED' }) };
    },
    async () => {
      scopeReads++;

      return project;
    },
  );

  try {
    await until('scope recheck', () => scopeReads === 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(watch.snapshot?.pullRequest, undefined);
  } finally {
    watch.close();
  }
});

test('head and upstream status changes refresh the pull request, while file edits keep its cache', async (t) => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });

  let commit = 'a1b2c3',
    ahead = 0,
    upstream = 'origin/feat/x',
    dirty = false;

  let reads = 0;

  const watch = new RepositoryWatch('/work', async (command) => {
    if (command === 'gh') {
      reads++;

      return { stdout: view({ state: 'OPEN', headRefOid: commit }) };
    }

    return {
      stdout: `# branch.head feat/x\n# branch.oid ${commit}\n# branch.upstream ${upstream}\n# branch.ab +${ahead} -0\n${dirty ? '? file.txt\n' : ''}`,
    };
  });

  t.onTestFinished(() => watch.close());

  await until(
    'initial pull request',
    () => reads === 1 && !!watch.snapshot?.pullRequest,
  );

  const step = async () => {
    vi.advanceTimersByTime(5000);
    await delay(20);
  };

  dirty = true;
  await step();
  assert.equal(watch.snapshot?.untracked, 1);
  assert.equal(reads, 1);
  commit = 'd4e5f6';
  ahead = 1;
  await step();
  assert.equal(watch.snapshot?.pullRequest?.commit, 'd4e5f6');
  assert.equal(reads, 2);
  ahead = 0;
  await step();
  assert.equal(watch.snapshot?.ahead, 0);
  assert.equal(reads, 3, 'pushing the already observed commit');
  upstream = 'other/feat/x';
  await step();
  assert.equal(watch.snapshot?.upstream, 'other/feat/x');
  assert.equal(reads, 4);
  await step();
  assert.equal(reads, 4, 'unchanged status');

  assert.equal(
    parseStatus('# branch.head new\n# branch.oid (initial)\n').commit,
    undefined,
  );
});

test('an awaited admission refresh reads after an older request and publishes before it resolves', async (t) => {
  const pending = Promise.withResolvers<{ stdout: string }>();
  let reads = 0;

  const watch = new RepositoryWatch('/work', async (command) => {
    if (command !== 'gh')
      return { stdout: '# branch.head feat/x\n# branch.oid a1b2c3\n' };

    if (++reads === 1) return pending.promise;

    return { stdout: view({ state: 'OPEN', mergeable: 'MERGEABLE' }) };
  });

  t.onTestFinished(() => watch.close());
  await until('old read', () => reads === 1);
  let finished = false;

  const fresh = watch.readPullRequest().then(() => {
    finished = true;
  });

  await delay(20);
  assert.equal(finished, false);
  assert.equal(reads, 1);
  pending.resolve({ stdout: view({ state: 'OPEN', mergeable: 'UNKNOWN' }) });
  await fresh;
  assert.equal(reads, 2);
  assert.equal(watch.snapshot?.pullRequest?.mergeable, 'MERGEABLE');
  assert.equal(watch.snapshot?.commit, 'a1b2c3');
});

test('an awaited refresh retains a confirmed conflict on failure or UNKNOWN without retaining repair eligibility', async (t) => {
  let answer: object | Error = { mergeable: 'CONFLICTING' };
  const { watch, reads } = conflictWatch({ answer: () => answer });
  t.onTestFinished(() => watch.close());
  await until('conflict', () => !!watch.snapshot?.conflict);
  const conflict = watch.snapshot!.conflict;
  const current = () => watch.snapshot?.pullRequest;
  answer = new Error('network unavailable');
  await watch.readPullRequest();
  assert.equal(current(), undefined);
  assert.deepEqual(watch.snapshot?.conflict, conflict);
  answer = { mergeable: 'UNKNOWN' };
  await watch.readPullRequest();
  assert.equal(current()?.mergeable, 'UNKNOWN');
  assert.deepEqual(watch.snapshot?.conflict, conflict);
  answer = { mergeable: 'MERGEABLE' };
  await watch.readPullRequest();
  assert.equal(watch.snapshot?.conflict, undefined);
  assert.equal(reads.pr, 4);
});

test('a head change during the base-tip lookup cannot publish the old conflicting read', async (t) => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });

  let commit = 'a1b2c3';
  const tip = Promise.withResolvers<{ stdout: string }>();
  let lookingUp = false;

  const watch = new RepositoryWatch('/work', async (command, args) => {
    if (command !== 'gh')
      return { stdout: `# branch.head feat/x\n# branch.oid ${commit}\n` };

    if (args[0] === 'api') {
      lookingUp = true;

      return tip.promise;
    }

    return {
      stdout: view({
        state: 'OPEN',
        url: 'https://github.com/o/r/pull/4',
        headRefOid: commit,
        mergeable: commit === 'a1b2c3' ? 'CONFLICTING' : 'MERGEABLE',
      }),
    };
  });

  t.onTestFinished(() => watch.close());
  const conflicts: string[] = [];

  watch.subscribe(() => {
    if (watch.snapshot?.conflict)
      conflicts.push(watch.snapshot.conflict.pullRequest.commit);
  });

  await until('base-tip read', () => lookingUp);
  commit = 'd4e5f6';
  vi.advanceTimersByTime(5000);
  await until('new local head', () => watch.snapshot?.commit === commit);
  tip.resolve({ stdout: 'f00\n' });
  await watch.readPullRequest();
  assert.deepEqual(conflicts, []);
  assert.equal(watch.snapshot?.pullRequest?.commit, 'd4e5f6');
  assert.equal(watch.snapshot?.conflict, undefined);
});

for (const kind of ['status', 'pull request'] as const) {
  test(`closing during a ${kind} read prevents later publication or refresh`, async (t) => {
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<{ stdout: string }>();
    const reads = { status: 0, pullRequest: 0 };

    const watch = new RepositoryWatch('/work', async (command, args) => {
      if (args.includes('status')) reads.status++;

      if (command === 'gh' && args[0] === 'pr') reads.pullRequest++;

      if (
        (kind === 'status' && args.includes('status')) ||
        (kind === 'pull request' && command === 'gh')
      ) {
        entered.resolve();

        return response.promise;
      }

      return {
        stdout:
          command === 'gh'
            ? view({ state: 'OPEN' })
            : '# branch.head feat/x\n# branch.oid a1b2c3\n',
      };
    });

    t.onTestFinished(() => watch.close());
    let publications = 0;
    watch.subscribe(() => publications++);
    await entered.promise;
    const snapshot = watch.snapshot;
    const before = publications;
    const reading = watch.readPullRequest();
    watch.close();
    const readsAtClose = { ...reads };

    response.resolve({
      stdout:
        kind === 'status'
          ? '# branch.head feat/x\n# branch.oid a1b2c3\n'
          : view({ state: 'OPEN' }),
    });

    await reading;
    assert.equal(watch.snapshot, snapshot);
    assert.equal(publications, before);
    assert.deepEqual(reads, readsAtClose);
  });
}

for (const change of ['head', 'upstream status'] as const) {
  test(`status recovery refreshes a cached conflict after the ${change} changes`, async (t) => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'Date'],
      now: 0,
    });

    let fail = false,
      reads = 0;

    let commit = 'a1b2c3',
      ahead = 1,
      mergeable = 'CONFLICTING';

    const watch = new RepositoryWatch('/work', async (command, args) => {
      if (command !== 'gh') {
        if (args.includes('status') && fail)
          throw Object.assign(new Error('status unavailable'), { code: 128 });

        return {
          stdout: `# branch.head feat/x\n# branch.oid ${commit}\n# branch.upstream origin/feat/x\n# branch.ab +${ahead} -0\n`,
        };
      }

      if (args[0] === 'api') return { stdout: 'f00\n' };

      reads++;

      return {
        stdout: view({
          state: 'OPEN',
          url: 'https://github.com/o/r/pull/4',
          headRefOid: commit,
          mergeable,
        }),
      };
    });

    t.onTestFinished(() => watch.close());
    await until('initial conflict', () => !!watch.snapshot?.conflict);
    assert.equal(reads, 1);
    fail = true;
    vi.advanceTimersByTime(5000);
    await until('failed local read', () => watch.snapshot === undefined);

    if (change === 'head') commit = 'd4e5f6';
    else ahead = 0;

    mergeable = 'MERGEABLE';
    fail = false;
    vi.advanceTimersByTime(5000);

    await until(
      'resolution after recovery',
      () => watch.snapshot?.pullRequest?.mergeable === 'MERGEABLE',
    );

    assert.equal(watch.snapshot?.conflict, undefined);

    assert.equal(
      watch.snapshot?.pullRequest?.commit,
      change === 'head' ? 'd4e5f6' : 'a1b2c3',
    );

    assert.equal(reads, 2);
  });
}
