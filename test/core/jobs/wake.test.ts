import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { running } from '../../../src/agents/shutdown.js';
import { JobWatch } from '../../../src/core/jobs/jobs.js';
import type { Row } from '../../../src/core/jobs/jobs.js';
import { initialSnapshot } from '../../../src/core/snapshot.js';
import type { Snapshot } from '../../../src/core/snapshot.js';
import { keepAwake } from '../../../src/core/jobs/wake.js';
import type { WakeOptions } from '../../../src/core/jobs/wake.js';
import { notices, record, unitFixture } from '../../fixtures/coordinator.js';
import { git } from '../../fixtures/git.js';
import { pullRequest } from '../../fixtures/merged.js';
import { scratch } from '../../fixtures/scratch.js';
import { until, within } from '../../fixtures/within.js';

type Launch = NonNullable<WakeOptions['launch']>;

const prefix = "Witch can't keep the Mac awake until it restarts: ";

/** a process that runs until it is signalled, standing in for caffeinate or for Witch. */
const idler = () =>
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });

/** settles on `close`, which a failed spawn emits too; registered at creation so no event is missed. */
const closing = (child: ChildProcess) =>
  new Promise<void>((resolve) => child.once('close', () => resolve()));

/** a group the watch tracks once handed over, standing in for a server a command left behind. */
const job: Row = {
  pid: 4242,
  ppid: 1,
  pgid: 4242,
  name: 'node',
  leadsSession: true,
  identity: '4242 a',
};

/** a watch over `rows`, read only when a test lists it. */
function jobWatch(rows: Row[]) {
  return new JobWatch({
    interval: 60_000,
    processes: async () => [...rows],
    describe: async (pids) =>
      pids.map((pid) => ({
        pid,
        pgid: pid,
        cpu: 0,
        startedAt: 0,
        command: 'node server',
      })),
  });
}

/** a watch that never has a job. */
const noJobs = { live: false, subscribe: () => () => {} };

/** records every holder a launcher starts. */
function recorder() {
  const holders: {
    child: ChildProcess;
    /** each signal the watcher or the test asked for, in order. */
    signals: (NodeJS.Signals | number)[];
    closed: Promise<void>;
  }[] = [];

  const counts = { launches: 0 };

  return {
    holders,
    counts,
    tracked: (start: Launch) => (pid: number) => {
      counts.launches++;
      const child = start(pid);
      const signals: (NodeJS.Signals | number)[] = [];
      const kill = child.kill.bind(child);

      child.kill = (signal) => {
        signals.push(signal ?? 'SIGTERM');

        return kill(signal);
      };

      holders.push({ child, signals, closed: closing(child) });

      return child;
    },
    async reap() {
      for (const { child } of holders)
        if (running(child)) child.kill('SIGKILL');

      await Promise.all(
        holders.map(({ closed }) => within(closed, 5000, 'a wake child')),
      );
    },
  };
}

/** a coordinator reduced to its snapshot, for a phase or flag a real one reaches only inside an operation. */
function snapshotCoordinator() {
  const listeners = new Set<() => void>();

  return {
    snapshot: initialSnapshot([]),
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => void listeners.delete(listener);
    },
    publish(update: Partial<Snapshot>) {
      this.snapshot = { ...this.snapshot, ...update };

      for (const listener of listeners) listener();
    },
  };
}

/** a real coordinator whose familiar and brew events drive the watcher, with every holder it launches recorded. */
async function fixture(
  options: WakeOptions = {},
  launch: Launch | 'default' = idler,
) {
  const { coordinator, a, project, jobs } = await unitFixture();
  const emit = a.sessions[0]!.options.onEvent;

  const worker = {
    id: 'impl',
    name: 'implementation',
    kind: '',
    runtime: 'codex',
    run: 'one',
  };

  const { holders, counts, tracked, reap } = recorder();
  const failures: Error[] = [];
  const rows: Row[] = [];
  const watch = jobWatch(rows);
  let stop = () => {};

  return {
    coordinator,
    project,
    /** the stand-in the coordinator reports its activity to. */
    jobs,
    watch,
    rows,
    holders,
    failures,
    counts,
    familiar(status: 'running' | 'completed') {
      emit({
        type: 'subagent',
        subagent: {
          ...worker,
          status,
          ...(status === 'completed' && { report: 'Done.' }),
        },
      });
    },
    brew(status: 'running' | 'completed') {
      emit({
        type: 'command',
        command: { id: 'server', description: 'dev server', status },
      });
    },
    start() {
      stop = keepAwake(
        coordinator,
        watch,
        (error) => {
          failures.push(error);
          coordinator.notice(error.message, undefined, false);
        },
        {
          platform: 'darwin',
          ...options,
          ...(launch !== 'default' && { launch: tracked(launch) }),
        },
      );

      return stop;
    },
    async close() {
      stop();
      watch.close();
      await reap();
      await coordinator.close();
    },
  };
}

test('a working session holds one wake child and an idle one holds none', async () => {
  const wake = await fixture();

  try {
    wake.familiar('running');
    const stop = wake.start();
    assert.equal(wake.holders.length, 1);
    wake.familiar('running');
    assert.equal(wake.holders.length, 1);
    wake.familiar('completed');
    wake.familiar('running');
    assert.equal(wake.holders.length, 2);
    const [first, second] = wake.holders;
    await within(first!.closed, 5000, 'the first holder');
    assert.deepEqual(first!.signals, ['SIGTERM']);
    assert.equal(first!.child.signalCode, 'SIGTERM');
    assert.deepEqual(second!.signals, []);
    assert.deepEqual(wake.failures, []);
    wake.familiar('completed');
    assert.deepEqual(second!.signals, ['SIGTERM']);
    await within(second!.closed, 5000, 'the second holder');
    wake.brew('running');
    assert.equal(wake.holders.length, 3);
    wake.brew('completed');
    await within(wake.holders[2]!.closed, 5000, 'the third holder');
    assert.deepEqual(wake.holders[2]!.signals, ['SIGTERM']);
    wake.familiar('running');
    assert.equal(wake.holders.length, 4);
    stop();
    stop();
    await within(wake.holders[3]!.closed, 5000, 'the fourth holder');
    assert.deepEqual(wake.holders[3]!.signals, ['SIGTERM']);
    assert.deepEqual(wake.failures, []);
    wake.familiar('completed');
    wake.familiar('running');
    assert.equal(wake.holders.length, 4);
  } finally {
    await wake.close();
  }
});

test.each<{
  name: string;
  launch: (missing: string) => Launch;
  ends?: string;
  kill?: true;
}>([
  {
    name: 'cannot spawn',
    launch: (missing) => () => spawn(missing, { stdio: 'ignore' }),
  },
  {
    name: 'throws at launch',
    launch: () => () => {
      throw new Error('no launch');
    },
    ends: 'no launch',
  },
  {
    name: 'is killed',
    launch: () => idler,
    ends: 'caffeinate was stopped by SIGKILL',
    kill: true,
  },
])(
  'a wake child that $name is reported, not replaced, and still on screen in the next conversation',
  async ({ launch, ends, kill }) => {
    const wake = await fixture(
      {},
      launch(join(await scratch('witch-wake-'), 'missing')),
    );

    const shown = (message: string) =>
      notices(wake.coordinator).filter((text) => text === message);

    try {
      wake.start();
      wake.familiar('running');

      if (kill) wake.holders[0]!.child.kill('SIGKILL');

      await until('the wake failure', () => wake.failures.length === 1);
      const { message } = wake.failures[0]!;
      assert.ok(message.startsWith(prefix), message);

      if (ends) assert.equal(message, prefix + ends);

      assert.deepEqual(shown(message), [message]);
      wake.watch.track(job.pgid);
      wake.rows.push(job);
      await wake.watch.list();
      wake.rows.length = 0;
      await wake.watch.list();
      assert.equal(wake.counts.launches, 1);
      assert.equal(wake.failures.length, 1);
      wake.familiar('completed');
      wake.familiar('running');
      assert.equal(wake.counts.launches, 1);
      assert.equal(wake.failures.length, 1);
      wake.familiar('completed');
      await wake.coordinator.newConversation();
      assert.deepEqual(shown(message), [message]);
      assert.deepEqual(wake.failures, [wake.failures[0], wake.failures[0]]);
      assert.equal(wake.counts.launches, 1);
    } finally {
      await wake.close();
    }
  },
);

test('a startup failure is kept once on first load and reported in a later conversation', () => {
  const coordinator = snapshotCoordinator();
  assert.equal(coordinator.snapshot.phase, 'starting');
  assert.equal(coordinator.snapshot.conversation, undefined);
  const failures: Error[] = [];
  let launches = 0;

  const stop = keepAwake(
    coordinator,
    noJobs,
    (error) => {
      failures.push(error);

      // a notice publishes, which runs the watcher again before this returns
      coordinator.publish({
        items: [
          ...coordinator.snapshot.items,
          {
            id: String(failures.length),
            kind: 'notice',
            text: error.message,
            cwd: '/project',
          },
        ],
      });
    },
    {
      platform: 'darwin',
      launch: () => {
        launches++;

        throw new Error('no launch');
      },
    },
  );

  try {
    assert.equal(failures.length, 1);
    coordinator.publish({ draft: 'typing' });
    assert.equal(failures.length, 1);
    const conversation = record('first', '/project');
    coordinator.publish({ conversation });
    assert.equal(failures.length, 1);

    assert.deepEqual(
      coordinator.snapshot.items.map(({ text }) => text),
      [prefix + 'no launch'],
    );

    coordinator.publish({ conversation });
    assert.equal(failures.length, 1);

    coordinator.publish({
      conversation: record('second', '/project'),
      items: [],
    });

    assert.equal(failures.length, 2);

    assert.deepEqual(
      coordinator.snapshot.items.map(({ text }) => text),
      [prefix + 'no launch'],
    );

    assert.equal(launches, 1);
  } finally {
    stop();
  }
});

test('a holder that never spawned is not signalled', async () => {
  const missing = join(await scratch('witch-wake-'), 'missing');

  // a guard that let this kill through would signal an unset pid, so the real method never runs here
  const wake = await fixture({}, () =>
    Object.assign(spawn(missing, { stdio: 'ignore' }), { kill: () => true }),
  );

  try {
    const stop = wake.start();
    wake.familiar('running');
    wake.familiar('completed');
    stop();
    await within(wake.holders[0]!.closed, 5000, 'the failed spawn');
    assert.deepEqual(wake.holders[0]!.signals, []);
    assert.deepEqual(wake.failures, []);
  } finally {
    await wake.close();
  }
});

test('nothing is launched off macOS', async () => {
  // linux ci takes the default platform; macOS has to name another one
  const wake = await fixture(
    process.platform === 'darwin'
      ? { platform: 'linux' }
      : { platform: undefined },
  );

  try {
    wake.start();
    wake.familiar('running');
    assert.equal(wake.counts.launches, 0);
  } finally {
    await wake.close();
  }
});

test('merge cleanup holds the wake child', async () => {
  const wake = await fixture();

  try {
    await git(wake.project, 'init', '-q', '-b', 'feat/x');
    await git(wake.project, 'commit', '-q', '--allow-empty', '-m', 'one');
    wake.start();
    assert.equal(wake.holders.length, 0);
    const cleaning: { holders: number; signals: unknown[] }[] = [];

    wake.coordinator.subscribe(() => {
      if (wake.coordinator.snapshot.phase === 'cleaning')
        cleaning.push({
          holders: wake.holders.length,
          signals: [...(wake.holders[0]?.signals ?? [])],
        });
    });

    await wake.coordinator.cleanUpMerge(pullRequest('0'.repeat(40)));
    assert.ok(cleaning.length > 0);

    assert.deepEqual(
      cleaning,
      cleaning.map(() => ({ holders: 1, signals: [] })),
    );

    assert.equal(wake.coordinator.snapshot.phase, 'idle');
    assert.deepEqual(wake.holders[0]!.signals, ['SIGTERM']);
  } finally {
    await wake.close();
  }
});

test('closing holds the wake child, which the watcher never signals', async () => {
  const wake = await fixture();

  try {
    wake.start();
    assert.equal(wake.holders.length, 0);
    await wake.coordinator.close();
    assert.equal(wake.holders.length, 1);
    assert.deepEqual(wake.holders[0]!.signals, []);
    assert.ok(running(wake.holders[0]!.child));
  } finally {
    await wake.close();
  }
});

test('a failure reported after closing began leaves the wake child held', async () => {
  const coordinator = snapshotCoordinator();
  const { holders, tracked, reap } = recorder();

  const stop = keepAwake(coordinator, noJobs, assert.fail, {
    platform: 'darwin',
    launch: tracked(idler),
  });

  try {
    coordinator.publish({ phase: 'idle' });
    coordinator.publish({ phase: 'closing' });
    coordinator.publish({ phase: 'error', error: 'Restart Witch: disk full' });
    assert.equal(holders.length, 2);
    assert.deepEqual(holders[1]!.signals, []);
    assert.ok(running(holders[1]!.child));
  } finally {
    stop();
    await reap();
  }
});

test('automatic work holds an idle session', async () => {
  const coordinator = snapshotCoordinator();
  const { holders, tracked, reap } = recorder();

  const stop = keepAwake(coordinator, noJobs, assert.fail, {
    platform: 'darwin',
    launch: tracked(idler),
  });

  try {
    coordinator.publish({ phase: 'idle' });
    assert.deepEqual(holders[0]!.signals, ['SIGTERM']);
    coordinator.publish({ automatic: true });
    assert.equal(holders.length, 2);
    assert.deepEqual(holders[1]!.signals, []);
    coordinator.publish({ automatic: false });
    assert.deepEqual(holders[1]!.signals, ['SIGTERM']);
  } finally {
    stop();
    await reap();
  }
});

test('a tracked job holds an idle session and releases when it ends', async () => {
  const wake = await fixture();

  try {
    wake.start();
    wake.watch.track(job.pgid);
    wake.rows.push(job);

    assert.deepEqual(
      (await wake.watch.list()).map(({ group }) => group),
      [job.pgid],
    );

    assert.equal(wake.holders.length, 1);
    assert.deepEqual(wake.holders[0]!.signals, []);
    wake.rows.length = 0;
    await wake.watch.list();
    assert.deepEqual(wake.holders[0]!.signals, ['SIGTERM']);
  } finally {
    await wake.close();
  }
});

test("the hold has no gap between a turn's end and the read that finds its job", async () => {
  const wake = await fixture();

  try {
    wake.jobs.setActive = (value) => wake.watch.setActive(value);
    wake.start();
    wake.familiar('running');
    assert.equal(wake.holders.length, 1);
    wake.watch.track(job.pgid);
    wake.rows.push(job);
    wake.familiar('completed');
    await wake.watch.list();
    assert.equal(wake.holders.length, 1);
    assert.deepEqual(wake.holders[0]!.signals, []);
    wake.rows.length = 0;
    await wake.watch.list();
    assert.deepEqual(wake.holders[0]!.signals, ['SIGTERM']);
    wake.familiar('running');
    wake.familiar('completed');
    assert.equal(wake.holders.length, 2);
    assert.deepEqual(wake.holders[1]!.signals, []);
    await wake.watch.list();
    assert.deepEqual(wake.holders[1]!.signals, ['SIGTERM']);
  } finally {
    await wake.close();
  }
});

test.skipIf(process.platform !== 'darwin')(
  'the default holder prevents system and display idle sleep for its pid and ends with it',
  async () => {
    const watched = idler();
    const closed = closing(watched);
    const wake = await fixture({ pid: watched.pid }, 'default');
    const named = new RegExp(`Process ID ${watched.pid}\\b`);

    /** the line before each assertion detail naming the watched pid, which states the assertion's type. */
    const held = async () => {
      const { stdout } = await promisify(execFile)(
        '/usr/bin/pmset',
        ['-g', 'assertions'],
        { timeout: 2000 },
      );

      const lines = stdout.split('\n');

      return lines.flatMap((line, index) =>
        named.test(line) ? [lines[index - 1] ?? ''] : [],
      );
    };

    /** `until` counts attempts, and each of these reads spawns a process, so this one keeps to elapsed time. */
    const eventually = async (what: string, count: number) => {
      const deadline = performance.now() + 10_000;
      let seen: string[] = [];

      while (performance.now() < deadline) {
        seen = await held();

        if (seen.length === count) return seen;

        await delay(50);
      }

      return assert.fail(`timed out waiting for ${what}: ${seen.join(' | ')}`);
    };

    try {
      wake.start();
      await eventually('no assertions before work', 0);
      wake.familiar('running');

      const types = (await eventually('both idle-sleep assertions', 2)).join(
        '\n',
      );

      assert.match(
        types,
        /PreventUserIdleSystemSleep named: "caffeinate command-line tool"/,
      );

      assert.match(
        types,
        /PreventUserIdleDisplaySleep named: "caffeinate command-line tool"/,
      );

      // in Witch's group, a hangup from a closing terminal would end the holder while Witch still shuts down
      const holder = (
        await promisify(execFile)('/usr/bin/pgrep', [
          '-f',
          `caffeinate -d -i -w ${watched.pid}$`,
        ])
      ).stdout.trim();

      const { stdout: group } = await promisify(execFile)('/bin/ps', [
        '-o',
        'pgid=',
        '-p',
        holder,
      ]);

      assert.equal(group.trim(), holder);
      wake.familiar('completed');
      await eventually('no assertions at idle', 0);
      wake.familiar('running');
      await eventually('both idle-sleep assertions again', 2);
      watched.kill('SIGKILL');
      await eventually('no assertions once the watched process died', 0);

      await until(
        'the holder to report its exit',
        () => wake.failures.length === 1,
      );

      assert.equal(
        wake.failures[0]!.message,
        prefix + 'caffeinate exited with code 0',
      );
    } finally {
      if (running(watched)) watched.kill('SIGKILL');

      await within(closed, 5000, 'the watched process');
      await wake.close();
      await eventually('no assertions left behind', 0);
    }
  },
);
