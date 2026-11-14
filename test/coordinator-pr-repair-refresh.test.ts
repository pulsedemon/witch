import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { watchConflicts } from '../src/core/pr-repair.js';
import { RepositoryWatch } from '../src/core/repository.js';
import { statusLines } from '../src/ui/status-rows.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import { git, unitCoordinationFixture } from './fixtures/coordination.js';
import { until, within } from './fixtures/within.js';
import { record as savedRecord } from './fixtures/copilot-reviews.js';
import { head, repairPrefix, setup } from './fixtures/pr-repair.js';

test('fresh resolution or an uncertain read skips the cached conflict without recording an attempt', async (t) => {
  const s = await setup(t);

  const old = s.read();

  let reads = 0;

  for (const fresh of [
    s.read({ mergeable: 'MERGEABLE' }),
    s.read({ commit: head(2), mergeable: 'MERGEABLE' }),
    s.read({ mergeable: 'UNKNOWN' }, s.pullRequest()),
    { ...old, pullRequest: undefined },
    { ...old, commit: head(2) },
  ]) {
    const before = reads;

    s.c.repair.setRefresh(async () => {
      reads++;

      s.observe(fresh);
    });

    s.observe(old);

    await until(
      'fresh observation',
      () => reads === before + 1 && !s.c.repair.ready(),
    );

    await s.c.send('check status');

    await until(
      'user turn',
      () =>
        s.x.a.inputs.filter(({ prompt }) => prompt === 'check status')
          .length ===
        before + 1,
    );

    await s.idle();

    assert.equal(s.repairs().length, 0);

    assert.equal((await s.record()).conflictRepairs, undefined);

    assert.equal(reads, before + 1, 'no admission retry loop');
  }

  s.c.repair.setRefresh(async () => {});

  s.observe(s.read({ commit: head(2) }));

  await until('recovered conflict', () => s.repairs().length === 1);

  await s.idle();

  assert.deepEqual((await s.record()).conflictRepairs, [
    { url: s.pullRequest().url, commit: head(2), base: 'main' },
  ]);
});

test('fresh conflict admission uses the refreshed base tip and starts once', async (t) => {
  const s = await setup(t);

  let reads = 0;

  s.c.repair.setRefresh(async () => {
    reads++;

    s.observe({
      ...s.read(),
      conflict: { pullRequest: s.pullRequest(), baseTip: 'new-tip' },
    });
  });

  s.observe(s.read());

  await until('repair', () => s.repairs().length === 1);

  await s.idle();

  assert.match(s.repairs()[0]!.prompt, /whose tip was new-tip/);

  s.observe(s.read());

  await s.c.send('continue');

  await s.idle();

  assert.equal(s.repairs().length, 1);

  assert.equal(reads, 1);
});

test('a user turn queued during the freshness read runs before a new admission', async (t) => {
  const s = await setup(t);

  const entered = Promise.withResolvers<void>();

  const released = Promise.withResolvers<void>();

  t.onTestFinished(() => released.resolve());

  let reads = 0;

  s.c.repair.setRefresh(async () => {
    reads++;

    entered.resolve();

    await released.promise;
  });

  s.observe(s.read());

  await within(entered.promise, 5000, 'fresh read');

  await s.c.send('queued during read');

  released.resolve();

  await until('repair', () => s.repairs().length === 1);

  await s.idle();

  assert.equal(s.x.a.inputs[0]!.prompt, 'queued during read');

  assert.equal(reads, 2, 'a new admission after the user turn reads again');
});

test('unbinding the conflict watch during its refresh prevents admission', async (t) => {
  const s = await setup(t);

  const entered = Promise.withResolvers<void>();

  const released = Promise.withResolvers<void>();

  const repository = {
    snapshot: s.read(),
    subscribe: () => () => {},
    refreshPullRequest: () => {},
    pullRequestReadAt: 0,
    readPullRequest: async () => {
      entered.resolve();

      await released.promise;
    },
  };

  s.x.coordination.updateRepository(repository.snapshot);

  const stop = watchConflicts(repository, s.c);

  t.onTestFinished(() => {
    stop();

    released.resolve();
  });

  await within(entered.promise, 5000, 'fresh read');

  stop();

  released.resolve();

  await s.c.send('after disposal');

  await until('user input', () =>
    s.x.a.inputs.some(({ prompt }) => prompt === 'after disposal'),
  );

  assert.equal(s.c.repair.ready(), false);

  assert.equal(s.repairs().length, 0);

  assert.equal((await s.record()).conflictRepairs, undefined);
});

for (const mergeable of ['MERGEABLE', 'CONFLICTING'] as const) {
  test(`the wired watch reads the pushed head before admission: ${mergeable}`, async (t) => {
    const register = orderedCleanup(t.onTestFinished);

    const f = await unitCoordinationFixture(register, async (references) => ({
      assigned: references,
    }));

    const x = await f.start();

    const c = x.coordinator;

    const cwd = c.snapshot.conversation!.cwd;

    const project = (await f.memory.scopePaths(cwd)).project;

    await git('-C', cwd, 'checkout', '-b', 'feat/x');

    const commit = async (message: string) => {
      await git(
        '-C',
        cwd,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '--allow-empty',
        '-m',
        message,
      );

      return (await git('-C', cwd, 'rev-parse', 'HEAD')).stdout.trim();
    };

    const a = await commit('A');

    const url = 'https://github.com/o/r/pull/7';

    await x.claim(url, 'repair test');

    const release = c.holdPromptDelivery();

    register(release);

    let current = a;

    const watch = new RepositoryWatch(
      cwd,
      async (command, args, options) => {
        if (command !== 'gh') return git('-C', options.cwd, ...args);

        if (args[0] === 'api') return { stdout: `${a}\n` };

        return {
          stdout: JSON.stringify({
            number: 7,
            url,
            state: 'OPEN',
            headRefName: 'feat/x',
            headRefOid: current,
            baseRefName: 'main',
            mergeable: current === a ? 'CONFLICTING' : mergeable,
            statusCheckRollup: [],
          }),
        };
      },
      async () => project,
    );

    register(() => watch.close());

    register(
      watch.subscribe(() => x.coordination.updateRepository(watch.snapshot)),
    );

    register(watchConflicts(watch, c));

    await until('cached conflict', () => !!c.conflict);

    assert.match(
      statusLines(
        { cwd, usage: {}, repository: watch.snapshot },
        Date.now(),
      ).join(' '),
      /CONFLICT/,
    );

    current = await commit('B');

    release();

    const repairs = () =>
      x.a.inputs.filter(({ prompt }) => prompt.startsWith(repairPrefix));

    if (mergeable === 'CONFLICTING') {
      await until('fresh repair', () => repairs().length === 1);

      await until('idle', () => c.snapshot.phase === 'idle');

      assert.match(
        repairs()[0]!.prompt,
        new RegExp(`head ${current} conflicts`),
      );

      assert.deepEqual((await savedRecord(f, x)).conflictRepairs, [
        { url, commit: current, base: 'main' },
      ]);
    } else {
      await until('resolution', () => c.conflict === undefined);

      await c.send('continue');

      await until(
        'user input completed',
        () =>
          x.a.inputs.some(({ prompt }) => prompt === 'continue') &&
          c.snapshot.phase === 'idle',
      );

      assert.equal(repairs().length, 0);

      assert.equal((await savedRecord(f, x)).conflictRepairs, undefined);

      assert.doesNotMatch(
        x.a.inputs.at(-1)!.context ?? '',
        /Witch confirmed on GitHub/,
      );

      assert.doesNotMatch(
        statusLines(
          { cwd, usage: {}, repository: watch.snapshot },
          Date.now(),
        ).join(' '),
        /CONFLICT/,
      );
    }
  });
}

test('a status failure during the fresh GitHub read cannot restore cached conflict admission', async (t) => {
  const s = await setup(t);

  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

  const entered = Promise.withResolvers<void>();

  const released = Promise.withResolvers<void>();

  let reads = 0,
    failStatus = false;

  const watch = new RepositoryWatch(
    '/work',
    async (command, args) => {
      if (command !== 'gh') {
        if (args.includes('status') && failStatus)
          throw Object.assign(new Error('status unavailable'), { code: 128 });

        return { stdout: `# branch.head feat/x\n# branch.oid ${head(1)}\n` };
      }

      if (args[0] === 'api') return { stdout: 'f00\n' };

      if (++reads === 2) {
        entered.resolve();

        await released.promise;
      }

      return {
        stdout: JSON.stringify({
          number: 7,
          url: s.pullRequest().url,
          state: 'OPEN',
          headRefName: 'feat/x',
          headRefOid: head(1),
          baseRefName: 'main',
          mergeable: reads === 1 ? 'CONFLICTING' : 'MERGEABLE',
          statusCheckRollup: [],
        }),
      };
    },
    async () => s.read().pullRequestProject!,
  );

  const stopRepository = watch.subscribe(() =>
    s.x.coordination.updateRepository(watch.snapshot),
  );

  const stopConflicts = watchConflicts(watch, s.c);

  try {
    await within(entered.promise, 5000, 'fresh read');

    failStatus = true;

    vi.advanceTimersByTime(5000);

    await until('status loss', () => watch.snapshot === undefined);

    failStatus = false;

    released.resolve();

    await until(
      'recovered local status',
      () => watch.snapshot?.commit === head(1),
    );

    await s.c.send('after status recovery');

    await until(
      'user input completed',
      () =>
        s.x.a.inputs.some(({ prompt }) => prompt === 'after status recovery') &&
        s.c.snapshot.phase === 'idle',
    );

    assert.equal(s.repairs().length, 0);

    assert.equal((await s.record()).conflictRepairs, undefined);

    vi.advanceTimersByTime(5000);

    await until(
      'automatic confirmed resolution',
      () => s.c.conflict === undefined,
    );

    assert.equal(watch.snapshot?.pullRequest?.mergeable, 'MERGEABLE');

    assert.equal(
      reads,
      3,
      'one automatic recovery read, with no admission retry loop',
    );

    assert.equal(s.repairs().length, 0);
  } finally {
    released.resolve();

    stopConflicts();

    stopRepository();

    watch.close();
  }
});
