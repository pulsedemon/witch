import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test, vi } from 'vitest';
import { JobWatch } from '../src/core/jobs.js';
import type { Row } from '../src/core/jobs.js';
import { scratch } from './fixtures/scratch.js';
import { until } from './fixtures/within.js';

/** the read count once it has stayed put for 100 ms, failing after a second. */
async function stopped(reads: () => number): Promise<number> {
  for (const end = Date.now() + 1000; Date.now() < end;) {
    const count = reads();
    await delay(100);
    if (reads() === count) return count;
  }
  assert.fail('the reads never stopped');
}

async function leaders(pids: number[]) {
  return pids.map((pid) => ({
    pid,
    pgid: pid,
    cpu: 0,
    startedAt: 0,
    command: '',
  }));
}

function orphanRow(pid: number): Row {
  return {
    pid,
    ppid: 1,
    pgid: pid,
    name: 'node',
    leadsSession: false,
    identity: `${pid} a`,
  };
}

test('an inactive watch stops reading once a fresh read finds nothing it tracks, and activity resumes it', async () => {
  let reads = 0;
  const jobs = new JobWatch({
    interval: 20,
    settle: 0,
    processes: async () => {
      if (!reads++) throw new Error('ps failed');
      return [];
    },
  });
  try {
    jobs.setActive(false);
    // the failed read leaves no baseline, so only the read after it pauses
    const count = await stopped(() => reads);
    assert.equal(count, 2);
    jobs.setActive(true);
    await until('a read', () => reads > count, 5);
  } finally {
    jobs.close();
  }
});

test('an active watch keeps reading with nothing tracked', async () => {
  let reads = 0;
  const jobs = new JobWatch({
    interval: 20,
    settle: 0,
    processes: async () => {
      reads++;
      return [];
    },
  });
  try {
    await delay(200);
    assert.ok(reads >= 5, `${reads} reads`);
  } finally {
    jobs.close();
  }
});

test('an inactive watch keeps reading for settle after activity or its last job ends', async () => {
  const reads: number[] = [];
  let rows: Row[] = [];
  const jobs = new JobWatch({
    interval: 20,
    settle: 200,
    processes: async () => {
      reads.push(performance.now());
      return rows;
    },
  });
  try {
    const ended = performance.now();
    jobs.setActive(false);
    await stopped(() => reads.length);
    assert.ok(reads.at(-1)! - ended >= 150);
    const job = orphanRow(100951);
    rows = [job];
    const before = reads.length;
    jobs.track(job.pgid);
    await until('a read that finds the job', () => reads.length > before);
    rows = [];
    const gone = reads.length;
    await stopped(() => reads.length);
    assert.ok(reads.at(-1)! - reads[gone]! >= 150);
  } finally {
    jobs.close();
  }
});

test('a read that began before activity ended does not pause the watch', async () => {
  // with the clock frozen, only the activity count tells the held read from a later one
  vi.useFakeTimers({ toFake: ['performance'] });
  const held = Promise.withResolvers<void>();
  let reads = 0;
  const jobs = new JobWatch({
    interval: 20,
    settle: 0,
    processes: async () => {
      reads++;
      await held.promise;
      return [];
    },
  });
  try {
    await until('a held read', () => reads > 0);
    jobs.setActive(false);
    held.resolve();
    assert.ok((await stopped(() => reads)) > 1);
  } finally {
    jobs.close();
  }
});

test('a tracked group keeps an inactive watch reading', async () => {
  const job = orphanRow(100961);
  let reads = 0;
  const jobs = new JobWatch({
    interval: 20,
    settle: 0,
    processes: async () => {
      reads++;
      return [job];
    },
  });
  try {
    jobs.track(job.pgid);
    jobs.setActive(false);
    const count = reads;
    await delay(150);
    assert.ok(reads >= count + 3);
  } finally {
    jobs.close();
  }
});

test('a job list while paused finds an orphan and resumes the reads', async () => {
  let rows: Row[] = [];
  let reads = 0;
  const jobs = new JobWatch({
    directory: await scratch('witch-jobs-'),
    interval: 20,
    settle: 0,
    processes: async () => {
      reads++;
      return rows;
    },
    describe: leaders,
    marked: async (pids) => pids,
    executables: async () => new Map(),
  });
  try {
    jobs.setActive(false);
    const count = await stopped(() => reads);
    rows = [orphanRow(100971)];
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [100971],
    );
    await until('a timer read', () => reads > count + 1, 5);
  } finally {
    jobs.close();
  }
});
