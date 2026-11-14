import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

import { JobWatch, jobCheckpointSchema } from '../src/core/jobs.js';

import type { JobCheckpoint, Row } from '../src/core/jobs.js';

import { scratch } from './fixtures/scratch.js';

import { within } from './fixtures/within.js';

import { orderedCleanup } from './fixtures/cleanup.js';

import type { RegisterCleanup } from './fixtures/cleanup.js';

const agent: Row = {
  pid: 100000,
  ppid: process.pid,
  pgid: 100000,
  name: 'node',
  leadsSession: false,
  identity: '100000 agent',
};

const command: Row = {
  pid: 100010,
  ppid: agent.pid,
  pgid: 100010,
  name: 'sh',
  leadsSession: true,
  identity: '100010 command',
};

const worker: Row = {
  pid: 100011,
  ppid: command.pid,
  pgid: command.pgid,
  name: 'node',
  leadsSession: false,
  identity: '100011 worker',
};

const unrelated: Row = {
  pid: 100020,
  ppid: 1,
  pgid: 100020,
  name: 'node',
  leadsSession: true,
  identity: '100020 unrelated',
};

const tmux: Row = {
  ...unrelated,
  pid: 100040,
  pgid: worker.pgid,
  name: 'tmux',
  leadsSession: false,
  identity: '100040 tmux',
};

const pane: Row = {
  ...unrelated,
  pid: 100041,
  ppid: tmux.pid,
  pgid: 100041,
  leadsSession: false,
  identity: '100041 pane',
};

function watcher(
  register: RegisterCleanup,
  rows: () => Row[],
  resume?: JobCheckpoint,
  options: ConstructorParameters<typeof JobWatch>[0] = {},
): JobWatch {
  const watch = new JobWatch({
    interval: 60_000,
    processes: async () => rows(),
    describe: async (pids) =>
      rows()
        .filter(({ pid }) => pids.includes(pid))
        .map(({ pid, pgid, name }) => ({
          pid,
          pgid,
          command: name,
          cpu: 0,
          startedAt: 0,
        })),
    resume,
    ...options,
  });

  register(() => watch.close());

  return watch;
}

async function checkpoint(watch: JobWatch): Promise<JobCheckpoint> {
  return jobCheckpointSchema.parse(
    JSON.parse(JSON.stringify(await watch.checkpoint())),
  );
}

async function groups(watch: JobWatch): Promise<number[]> {
  return (await watch.list()).map(({ group }) => group);
}

test('known orphan ownership survives repeated checkpoints', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  let rows = [agent, command, worker, unrelated];

  const original = watcher(cleanup, () => rows);

  assert.deepEqual(await groups(original), [100010]);

  rows = [{ ...worker, ppid: 1 }, unrelated];

  const saved = await checkpoint(original);

  const restored = watcher(cleanup, () => rows, saved);

  assert.deepEqual(await groups(restored), [100010]);

  const twiceRestored = watcher(
    cleanup,
    () => rows,
    await checkpoint(restored),
  );

  assert.deepEqual(await groups(twiceRestored), [100010]);

  assert.deepEqual(await groups(watcher(cleanup, () => rows)), []);

  rows = [{ ...worker, ppid: 1, pgid: 100030 }, unrelated];

  assert.deepEqual(await groups(watcher(cleanup, () => rows, saved)), [100030]);
});

test('restored jobs stop only their current generation', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  let rows = [agent, command, worker, unrelated];

  const original = watcher(cleanup, () => rows);

  await original.list();

  rows = [{ ...worker, ppid: 1 }, unrelated];

  const saved = await checkpoint(original);

  const restored = watcher(cleanup, () => rows, saved);

  const [job] = await restored.list();

  assert.ok(job);

  const signals: Parameters<typeof process.kill>[] = [];

  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    signals.push([pid, signal]);

    rows = rows.filter(({ pgid }) => pgid !== -pid);

    return true;
  });

  await restored.stop(job);

  assert.deepEqual(signals, [[-100010, 'SIGTERM']]);

  assert.deepEqual(rows, [unrelated]);

  rows = [{ ...worker, ppid: 1, identity: '100011 replacement' }, unrelated];

  assert.deepEqual(await watcher(cleanup, () => rows, saved).list(), []);

  rows = [{ ...worker, ppid: 1 }, unrelated];

  const selected = watcher(cleanup, () => rows, saved);

  const [oldSelection] = await selected.list();

  assert.ok(oldSelection);

  rows = [{ ...worker, ppid: 1, identity: '100011 replacement' }, unrelated];

  signals.length = 0;

  await selected.stop(oldSelection);

  assert.deepEqual(signals, []);

  assert.equal(rows.length, 2);
});

test('a checkpoint keeps ordinary members of withheld tmux groups', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  let rows = [agent, command, worker];

  const original = watcher(cleanup, () => rows);

  await original.list();

  rows = [{ ...worker, ppid: 1 }, tmux];

  assert.deepEqual(await groups(original), []);

  const restored = watcher(cleanup, () => rows, await checkpoint(original));

  assert.deepEqual(await groups(restored), []);

  rows = [{ ...worker, ppid: 1 }];

  assert.deepEqual(await groups(restored), [100010]);

  const [job] = await restored.list();

  assert.ok(job);

  const signals: number[] = [];

  vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
    signals.push(pid);

    rows = rows.filter(({ pgid }) => pgid !== -pid);

    return true;
  });

  await restored.stop(job);

  assert.deepEqual(signals, [-100010]);

  assert.deepEqual(rows, []);
});

test('a checkpoint keeps exclusions after tmux descendants reparent', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  let rows = [agent, command, worker, tmux, pane];

  const original = watcher(cleanup, () => rows);

  assert.deepEqual(await groups(original), []);

  rows = [
    { ...worker, ppid: 1 },
    { ...pane, ppid: 1, pgid: 100042 },
  ];

  original.track(100042);

  const restored = watcher(cleanup, () => rows, await checkpoint(original));

  assert.deepEqual(await groups(restored), [100010]);

  rows = [
    { ...worker, ppid: 1 },
    { ...pane, ppid: 1, pgid: 100010 },
  ];

  assert.deepEqual(await groups(restored), []);

  rows = [
    { ...worker, ppid: 1 },
    { ...pane, ppid: 1, identity: '100041 replacement' },
  ];

  restored.track(pane.pgid);

  assert.deepEqual(await groups(restored), [100010, 100041]);
});

test('restoration does not adopt pre-existing marked or foreign workers', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  let rows = [agent, command, worker];

  const original = watcher(cleanup, () => rows);

  await original.list();

  rows = [{ ...worker, ppid: 1 }];

  const saved = await checkpoint(original);

  const own = {
    ...agent,
    pid: process.pid,
    ppid: 1,
    pgid: 100050,
    identity: `${process.pid} own`,
  };

  rows = [
    ...rows,
    unrelated,
    { ...unrelated, pid: 100021, pgid: 100021, identity: '100021 foreign' },
    own,
    { ...agent, pgid: own.pgid },
    { ...command, pgid: own.pgid, leadsSession: false },
  ];

  let markReads = 0;

  const restored = watcher(cleanup, () => rows, saved, {
    directory: await scratch('witch-jobs-restart-'),
    marked: async (pids) => {
      markReads++;

      return new Map(pids.map((pid) => [pid, undefined]));
    },
  });

  restored.track(own.pgid);

  assert.deepEqual(await groups(restored), [100010]);

  assert.deepEqual(await groups(restored), [100010]);

  assert.equal(markReads, 0);
});

test('checkpoint waits for a fresh read after a pending poll', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const member = { ...worker, ppid: 1 };

  for (const ending of [false, true]) {
    const entered = Promise.withResolvers<void>();

    const old = Promise.withResolvers<Row[]>();

    let reads = 0;

    const rows = ending ? [] : [member];

    const watch = watcher(cleanup, () => rows, undefined, {
      processes: async () => {
        if (++reads === 1) {
          entered.resolve();

          return old.promise;
        }

        return rows;
      },
    });

    if (ending) watch.track(member.pgid);

    const polling = watch.list();

    try {
      await within(entered.promise, 2000, 'pending job poll');

      if (!ending) watch.track(member.pgid);

      const capturing = checkpoint(watch);

      old.resolve(ending ? [member] : []);

      const saved = await capturing;

      await polling;

      if (ending) assert.deepEqual(saved.members, []);

      const restored = watcher(cleanup, () => rows, saved);

      assert.deepEqual(await groups(restored), ending ? [] : [100010]);
    } finally {
      old.resolve([]);

      await polling;
    }
  }
});

test('checkpoint rejects failed pending and fresh reads', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  for (const pendingFails of [false, true]) {
    const failure = new Error('checkpoint process read failed');

    const entered = Promise.withResolvers<void>();

    const old = Promise.withResolvers<Row[]>();

    let reads = 0;

    const watch = watcher(cleanup, () => [], undefined, {
      processes: async () => {
        if (++reads === 1) {
          entered.resolve();

          return old.promise;
        }

        throw failure;
      },
    });

    const polling = watch.list();

    const polled = pendingFails
      ? assert.rejects(polling, (error) => error === failure)
      : polling;

    try {
      await within(entered.promise, 2000, 'pending job poll');

      const rejected = assert.rejects(
        watch.checkpoint(),
        (error) => error === failure,
      );

      if (pendingFails) old.reject(failure);
      else old.resolve([]);

      await rejected;

      await polled;
    } finally {
      old.resolve([]);

      await polled;
    }
  }
});
