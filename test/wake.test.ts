import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { running } from '../src/agents/shutdown.js';
import { initialSnapshot } from '../src/core/snapshot.js';
import type { Snapshot } from '../src/core/snapshot.js';
import { keepAwake } from '../src/core/wake.js';
import type { WakeOptions } from '../src/core/wake.js';
import { notices, record, unitFixture } from './fixtures/coordinator.js';
import { scratch } from './fixtures/scratch.js';
import { until, within } from './fixtures/within.js';

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

/** a real coordinator whose familiar and brew events drive the watcher, with every holder it launches recorded. */
async function fixture(
  options: WakeOptions = {},
  launch: Launch | 'default' = idler,
) {
  const { coordinator, a } = await unitFixture();
  const emit = a.sessions[0]!.options.onEvent;
  const worker = {
    id: 'impl',
    name: 'implementation',
    kind: '',
    runtime: 'codex',
    run: 'one',
  };
  const holders: {
    child: ChildProcess;
    /** each signal the watcher or the test asked for, in order. */
    signals: (NodeJS.Signals | number)[];
    closed: Promise<void>;
  }[] = [];
  const failures: Error[] = [];
  const counts = { launches: 0 };
  let stop = () => {};
  const tracked = (start: Launch) => (pid: number) => {
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
  };
  return {
    coordinator,
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
      for (const { child } of holders)
        if (running(child)) child.kill('SIGKILL');
      stop();
      await Promise.all(
        holders.map(({ closed }) => within(closed, 5000, 'a wake child')),
      );
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

test('a failure before the first conversation loads is reported again when it loads', () => {
  const listeners = new Set<() => void>();
  const coordinator = {
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
  assert.equal(coordinator.snapshot.phase, 'starting');
  assert.equal(coordinator.snapshot.conversation, undefined);
  const failures: Error[] = [];
  let launches = 0;
  const stop = keepAwake(
    coordinator,
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
    coordinator.publish({ conversation, items: [] });
    assert.equal(failures.length, 2);
    assert.deepEqual(
      coordinator.snapshot.items.map(({ text }) => text),
      [prefix + 'no launch'],
    );
    coordinator.publish({ conversation });
    assert.equal(failures.length, 2);
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

test.skipIf(process.platform !== 'darwin')(
  'the default holder prevents idle sleep for its pid and ends with it',
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
      wake.familiar('running');
      const [type] = await eventually('one holder', 1);
      assert.match(
        type!,
        /PreventUserIdleSystemSleep named: "caffeinate command-line tool"/,
      );
      wake.familiar('completed');
      await eventually('no holder at idle', 0);

      wake.familiar('running');
      await eventually('one holder again', 1);
      watched.kill('SIGKILL');
      await eventually('no holder once the watched process died', 0);
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
      await eventually('no holder left behind', 0);
    }
  },
);
