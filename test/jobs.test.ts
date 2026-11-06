import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { runShell } from '../src/agents/user-shell.js';
import { JobWatch, parseDetails, parseProcesses } from '../src/core/jobs.js';
import type { Job, Row } from '../src/core/jobs.js';
import { ps } from '../src/persistence/process.js';
import { scratch } from './fixtures/scratch.js';
import { until, within } from './fixtures/within.js';

/** lists until `ready` holds, failing after five seconds. */
async function listed(
  jobs: JobWatch,
  ready: (list: Job[]) => boolean,
): Promise<Job[]> {
  for (const end = Date.now() + 5000; Date.now() < end;) {
    const list = await jobs.list();
    if (ready(list)) return list;
    await delay(20);
  }
  assert.fail('timed out waiting for the jobs');
}

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** an agent whose pid is above macOS's highest, since a command with the agent's pid would be its own parent and never end a read. */
const agentRow: Row = {
  pid: 100_000,
  ppid: process.pid,
  pgid: 100_000,
  name: 'node',
  leadsSession: false,
  identity: '100000 a',
};

function commandRows(group: number, identity: string): Row[] {
  return [
    agentRow,
    {
      pid: group,
      ppid: agentRow.pid,
      pgid: group,
      name: 'sh',
      leadsSession: true,
      identity,
    },
  ];
}

/** describes each process as the leader of `pgid`, or of its own group without one. */
const groupLeaders = (pgid?: number) => async (pids: number[]) =>
  pids.map((pid) => ({
    pid,
    pgid: pgid ?? pid,
    cpu: 0,
    startedAt: 0,
    command: '',
  }));
const leaders = groupLeaders();

test("jobs are the groups an agent's commands start, one stays listed after its leader exits, and stop kills a member that ignores SIGTERM and leaves other groups alone", async () => {
  const jobs = new JobWatch({ interval: 50, grace: 300 });
  const spawnedAt = Date.now();
  // this test stands in for Witch, so its child stands in for an agent
  const agent = spawn(
    process.execPath,
    [join(import.meta.dirname, 'fixtures/process-tree.mjs')],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const [stuck, running, server] = String((await once(agent.stdout, 'data'))[0])
    .trim()
    .split(' ')
    .map(Number) as [number, number, number];
  try {
    // only the background poll sees the stuck command under the agent, since its member is orphaned before the first list
    await delay(500);
    process.kill(stuck, 'SIGKILL');
    await until('the stuck command to be gone', () => gone(stuck));
    const list = await listed(jobs, (found) => found.length >= 3);
    const commands = new Map(
      list.map(({ group, command }) => [group, command]),
    );
    assert.equal(commands.get(stuck), 'sleep 60.5');
    assert.equal(commands.get(running), 'sleep 61.5');
    // the MCP server and its helper are not jobs
    assert.deepEqual([...commands.values()].sort(), [
      'perl -e setpgrp(0, 0); sleep 1 while getppid() != 1 witch-jobs-fixture',
      'sleep 60.5',
      'sleep 61.5',
    ]);
    if (process.platform === 'linux') {
      const { stdout } = await promisify(execFile)(
        '/bin/ps',
        ['-A', '-o', 'pgid=,stat=,lstart='],
        { env: { ...process.env, LC_ALL: 'C.UTF-8', TZ: 'UTC' } },
      );
      for (const { group, startedAt } of list) {
        const starts = stdout.split('\n').flatMap((line) => {
          const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
          return match &&
            Number(match[1]) === group &&
            !match[2]!.startsWith('Z')
            ? [Date.parse(`${match[3]!} UTC`)]
            : [];
        });
        assert.ok(starts.length > 0);
        assert.equal(startedAt, Math.min(...starts));
      }
    } else {
      for (const { startedAt } of list) {
        // lstart has whole seconds
        assert.ok(startedAt >= spawnedAt - 1000);
        assert.ok(startedAt < spawnedAt + 1000);
      }
    }
    await jobs.stop({ group: server, generation: 1 });
    assert.doesNotThrow(() => process.kill(-server, 0));
    for (const job of list) await jobs.stop(job);
    for (const { group } of list)
      assert.throws(() => process.kill(-group, 0), { code: 'ESRCH' });
  } finally {
    agent.kill('SIGKILL');
    for (const group of [stuck, running])
      try {
        process.kill(-group, 'SIGKILL');
      } catch {
        // stopped by the test
      }
    jobs.close();
  }
});

test('the process-tree fixture and its MCP helpers exit after their test parent is killed', async () => {
  const cwd = await scratch('witch-jobs-fixture-');
  const parent = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import { spawn } from 'node:child_process';
        import { createInterface } from 'node:readline';
        const fixture = spawn(process.execPath, [process.argv[1]], {
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        createInterface({ input: fixture.stdout }).once('line', (line) => {
          process.send([fixture.pid, ...line.trim().split(' ').map(Number)]);
        });
        process.once('disconnect', () => process.exit(0));
      `,
      join(import.meta.dirname, 'fixtures/process-tree.mjs'),
    ],
    {
      cwd,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
  const exited = once(parent, 'exit');
  const owned = new Set<number>();
  try {
    const [ids] = (await within(
      once(parent, 'message'),
      3000,
      'fixture startup',
    )) as [[number, number, number, number]];
    const [fixture, , , server] = ids;
    owned.add(fixture);
    let helper: number | undefined;
    await until('the complete fixture tree', async () => {
      const rows = (await ps('pid=,ppid=')).map((line) =>
        line.trim().split(/\s+/).map(Number),
      );
      for (let size = 0; size !== owned.size;) {
        size = owned.size;
        for (const [pid, ppid] of rows) if (owned.has(ppid!)) owned.add(pid!);
      }
      helper = rows.find(([, ppid]) => ppid === server)?.[0];
      return owned.size === 8 && helper !== undefined;
    });
    await delay(1500);
    assert.equal((await ps('pid=', [...owned])).length, owned.size);
    assert.equal(parent.exitCode, null);
    assert.equal(parent.signalCode, null);

    parent.kill('SIGKILL');
    await exited;
    for (const pid of [fixture, server, helper!])
      await until(
        `process ${pid} to exit after its parent`,
        async () => (await ps('pid=', [pid])).length === 0,
      );
  } finally {
    parent.kill('SIGKILL');
    await exited;
    for (const pid of [...owned].reverse())
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
      }
    if (owned.size)
      await until(
        'fixture cleanup',
        async () => (await ps('pid=', [...owned])).length === 0,
      );
  }
});

test("a group that a process its command's shell left behind starts or moves to is a job that stops", async () => {
  const jobs = new JobWatch({ interval: 50 });
  const agent = spawn(
    process.execPath,
    [join(import.meta.dirname, 'fixtures/orphan-group.mjs')],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const command = Number(String((await once(agent.stdout, 'data'))[0]).trim());
  try {
    const list = await listed(jobs, (found) => found.length >= 3);
    // the groups formed after the shell exited, so only the processes it left lead to them
    assert.ok(gone(command));
    // the subshell starts its perl a second after the other, so it lists last
    assert.deepEqual(
      list.filter(({ group }) => group !== command).map((job) => job.command),
      [
        `perl -e sleep 1; setpgrp(0, 0); sleep 1 while kill 0, ${agent.pid} witch-jobs-fixture`,
        'perl -e setpgrp(0, 0); sleep 1 while getppid() != 1 witch-jobs-fixture',
      ],
    );
    for (const job of list) await jobs.stop(job);
    assert.deepEqual(await jobs.list(), []);
  } finally {
    agent.kill('SIGKILL');
    try {
      process.kill(-command, 'SIGKILL');
    } catch {
      // already empty
    }
    jobs.close();
  }
});

test("a group that a process below its command's leader moves to is a job", async () => {
  const jobs = new JobWatch({
    interval: 60_000,
    processes: async () => [
      ...commandRows(4242, '4242 a'),
      {
        pid: 4243,
        ppid: 4242,
        pgid: 4242,
        name: 'node',
        leadsSession: false,
        identity: '4243 a',
      },
      {
        pid: 4244,
        ppid: 4243,
        pgid: 4244,
        name: 'node',
        leadsSession: false,
        identity: '4244 a',
      },
    ],
    describe: async () => [
      {
        pid: 4242,
        pgid: 4242,
        cpu: 0,
        startedAt: 0,
        command: 'sh -c pnpm dev',
      },
      {
        pid: 4244,
        pgid: 4244,
        cpu: 0,
        startedAt: 0,
        command: 'esbuild --service',
      },
    ],
  });
  try {
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [4242, 4244],
    );
  } finally {
    jobs.close();
  }
});

test("a later group given a tracked group's id is not a job", async () => {
  let rows = commandRows(4242, '4242 a');
  const jobs = new JobWatch({
    interval: 60_000,
    processes: async () => rows,
    describe: leaders,
  });
  try {
    assert.deepEqual(
      (await jobs.list()).map((job) => job.group),
      [4242],
    );
    rows = [
      {
        pid: 4242,
        ppid: 1,
        pgid: 4242,
        name: 'sh',
        leadsSession: true,
        identity: '4242 b',
      },
    ];
    assert.deepEqual(await jobs.list(), []);
  } finally {
    jobs.close();
  }
});

test('a process given the pid of one that exited has another identity', () => {
  const [exited, later] = parseProcesses([
    '  501     1   501 Ss   Thu Oct 15 18:50:27 2026 sh',
    '  501     1   501 Ss   Thu Oct 15 19:02:03 2026 sh',
  ]);
  assert.notEqual(later?.identity, exited?.identity);
});

test("a job listed while a read gives its id to the agent's next command can't stop that command", async () => {
  const sleep = spawn('/bin/sleep', ['66.5'], {
    detached: true,
    stdio: 'ignore',
  });
  const group = sleep.pid!;
  let rows = commandRows(group, `${group} a`);
  const jobs = new JobWatch({ interval: 60_000, processes: async () => rows });
  try {
    const listing = jobs.list();
    // the listing has read and waits on ps for the details
    await new Promise(setImmediate);
    rows = commandRows(group, `${group} b`);
    assert.deepEqual(
      (await jobs.list()).map((later) => later.group),
      [group],
    );
    const [job] = await listing;
    assert.equal(job?.group, group);
    await jobs.stop(job);
    assert.doesNotThrow(() => process.kill(-group, 0));
  } finally {
    sleep.kill('SIGKILL');
    jobs.close();
  }
});

test('a job listed during a slower read keeps its generation', async () => {
  let reads = 0;
  const jobs = new JobWatch({
    interval: 60_000,
    processes: async () => {
      // the first read is slow and saw the table before the agent's next command started
      if (!reads++) {
        await delay(100);
        return commandRows(4242, '4242 a');
      }
      return [...commandRows(4242, '4242 a'), commandRows(4343, '4343 a')[1]!];
    },
    describe: leaders,
  });
  try {
    const overlapping = (await Promise.all([jobs.list(), jobs.list()])).flat();
    const later = await jobs.list();
    for (const job of overlapping)
      assert.equal(
        later.find(({ group }) => group === job.group)?.generation,
        job.generation,
      );
  } finally {
    jobs.close();
  }
});

test('a process that left its tracked group before ps describes it is not a job', async () => {
  const jobs = new JobWatch({
    interval: 60_000,
    processes: async () => [
      ...commandRows(4242, '4242 a'),
      {
        pid: 4243,
        ppid: 4242,
        pgid: 4242,
        name: 'node',
        leadsSession: false,
        identity: '4243 a',
      },
    ],
    describe: leaders,
  });
  try {
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [4242],
    );
  } finally {
    jobs.close();
  }
});

test('a time zone change keeps a job and its generation', async () => {
  const jobs = new JobWatch({ interval: 60_000 });
  const agent = spawn(
    process.execPath,
    [join(import.meta.dirname, 'fixtures/process-tree.mjs')],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const [stuck, running] = String((await once(agent.stdout, 'data'))[0])
    .trim()
    .split(' ')
    .map(Number) as [number, number];
  const zone = process.env.TZ;
  try {
    const before = (
      await listed(jobs, (found) =>
        found.some(
          ({ group, command }) => group === running && command === 'sleep 61.5',
        ),
      )
    ).find(({ group }) => group === running)!;
    // as a laptop's automatic time zone does mid-session
    process.env.TZ = 'Pacific/Kiritimati';
    const after = (await jobs.list()).find(({ group }) => group === running);
    assert.deepEqual(after, { ...before, cpu: after?.cpu });
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
    agent.kill('SIGKILL');
    for (const group of [stuck, running])
      try {
        process.kill(-group, 'SIGKILL');
      } catch {
        // already empty
      }
    jobs.close();
  }
});

test('a job lists with its command intact under any locale', async () => {
  const sleep = spawn('/bin/sleep', ['69.5'], {
    argv0: 'slëep',
    detached: true,
    stdio: 'ignore',
  });
  const group = sleep.pid!;
  const jobs = new JobWatch({
    interval: 60_000,
    processes: async () => commandRows(group, `${group} a`),
  });
  const locale = {
    LC_ALL: process.env.LC_ALL,
    LANG: process.env.LANG,
    LC_TIME: process.env.LC_TIME,
  };
  process.env.LC_ALL = process.env.LANG = process.env.LC_TIME = 'de_DE.UTF-8';
  try {
    assert.deepEqual(
      (await jobs.list()).map((job) => job.command),
      ['slëep 69.5'],
    );
  } finally {
    for (const [name, value] of Object.entries(locale))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    sleep.kill('SIGKILL');
    jobs.close();
  }
});

test("a job sums parsed CPU and keeps its earliest start and oldest non-leader's command", async () => {
  const jobs = new JobWatch({
    interval: 60_000,
    processes: async () => [
      ...commandRows(4242, '4242 a'),
      {
        pid: 4243,
        ppid: 4242,
        pgid: 4242,
        name: 'node',
        leadsSession: false,
        identity: '4243 a',
      },
      {
        pid: 4244,
        ppid: 4242,
        pgid: 4242,
        name: 'node',
        leadsSession: false,
        identity: '4244 a',
      },
    ],
    describe: async () =>
      parseDetails([
        '  4244  4242   6.0 Thu Oct 15 18:50:29 2026     cc b.c',
        '  4242  4242  30.5 Thu Oct 15 18:50:27 2026     make -j2',
        '  4243  4242  40.5 Thu Oct 15 18:50:28 2026     cc a.c',
      ]),
  });
  try {
    assert.deepEqual(
      (await jobs.list()).map(({ cpu, command, startedAt }) => ({
        cpu,
        command,
        startedAt,
      })),
      [
        {
          cpu: 77,
          command: 'cc a.c',
          startedAt: Date.UTC(2026, 9, 15, 18, 50, 27),
        },
      ],
    );
  } finally {
    jobs.close();
  }
});

test('a start date parses whether or not ps pads its day', () => {
  assert.deepEqual(
    parseDetails([
      '  501   501   0.0 Fri Oct  9 22:34:18 2026     sleep 60',
      '  502   502   0.0 Thu Oct 15 18:50:27 2026     sleep 61',
    ]).map(({ startedAt }) => startedAt),
    [Date.UTC(2026, 9, 9, 22, 34, 18), Date.UTC(2026, 9, 15, 18, 50, 27)],
  );
});

test('a command holding a line separator is described', () => {
  assert.deepEqual(
    parseDetails([
      '  501   501   0.0 Thu Oct 15 18:50:27 2026     node -e a\u2028b',
    ]).map(({ command }) => command),
    ['node -e a\u2028b'],
  );
});

test('a failed background read keeps the jobs it had', async () => {
  let rows: Row[] | undefined = commandRows(4242, '4242 a');
  let failures = 0;
  const jobs = new JobWatch({
    interval: 20,
    processes: async () => {
      if (rows) return rows;
      failures++;
      throw new Error('ps failed');
    },
    describe: leaders,
  });
  try {
    const before = await jobs.list();
    rows = undefined;
    // the timer reads again after a failed read
    await until('a second failed read', () => failures > 1);
    // the agent exited, leaving its command to launchd
    rows = [
      {
        pid: 4242,
        ppid: 1,
        pgid: 4242,
        name: 'sh',
        leadsSession: true,
        identity: '4242 a',
      },
    ];
    assert.deepEqual(await jobs.list(), before);
  } finally {
    jobs.close();
  }
});

test('a failed ps listing of every process rejects rather than listing none', async () => {
  // an unknown keyword exits 1, as a listed pid that is gone does
  await assert.rejects(ps('bogus='), { code: 1 });
});

test('a job whose processes exit after a read lists as nothing and stops without an error', async () => {
  const sleep = spawn('/bin/sleep', ['72.5'], {
    detached: true,
    stdio: 'ignore',
  });
  const group = sleep.pid!;
  // how many more reads still show the command, as one taken just before it exits does
  let stale = Infinity;
  const jobs = new JobWatch({
    interval: 60_000,
    processes: async () =>
      stale-- > 0 ? commandRows(group, `${group} a`) : [agentRow],
  });
  try {
    const [job] = await jobs.list();
    assert.equal(job?.group, group);
    sleep.kill('SIGKILL');
    await once(sleep, 'exit');
    // ps describes none of the read's processes
    assert.deepEqual(await jobs.list(), []);
    // the signal finds the group empty, and the read after it no longer shows the command
    stale = 1;
    await jobs.stop(job!);
  } finally {
    jobs.close();
  }
});

test('a job whose processes exited is gone before they are reaped', async () => {
  const jobs = new JobWatch({ interval: 60_000 });
  // an agent that never reaps its command
  const agent = spawn(
    '/usr/bin/perl',
    [
      '-e',
      'use POSIX; $| = 1; my $pid = fork; if (!$pid) { setsid(); sleep 1 while getppid() != 1; exit } print "$pid\\n"; sleep 1 while getppid() != 1',
      'witch-jobs-fixture',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const command = Number(String((await once(agent.stdout, 'data'))[0]).trim());
  try {
    const [job] = await listed(jobs, (found) => found.length > 0);
    assert.equal(job?.group, command);
    process.kill(command, 'SIGKILL');
    await listed(jobs, (found) => !found.length);
    await jobs.stop(job!);
  } finally {
    agent.kill('SIGKILL');
    jobs.close();
  }
});

test('stop sends SIGTERM before SIGKILL', async () => {
  const cwd = await scratch('witch-jobs-');
  const shell = spawn(
    '/bin/sh',
    ['-c', 'trap "touch term; exit" TERM; touch ready; sleep 73.5 & wait'],
    { cwd, detached: true, stdio: 'ignore' },
  );
  const group = shell.pid!;
  const jobs = new JobWatch({
    interval: 60_000,
    processes: async () =>
      shell.exitCode === null && shell.signalCode === null
        ? commandRows(group, `${group} a`)
        : [agentRow],
  });
  try {
    // a signal before the trap is set would kill the shell outright
    await until('the trap', () => existsSync(join(cwd, 'ready')));
    const [job] = await jobs.list();
    await jobs.stop(job!);
    assert.ok(existsSync(join(cwd, 'term')));
  } finally {
    try {
      process.kill(-group, 'SIGKILL');
    } catch {
      // stopped by the test
    }
    jobs.close();
  }
});

test('stop rejects while reads still show a job it signalled', async () => {
  // the echo comes after the trap, so SIGTERM can't arrive first
  const sleep = spawn(
    '/bin/sh',
    ['-c', 'trap "" TERM; echo; exec sleep 74.5'],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  await once(sleep.stdout, 'data');
  const group = sleep.pid!;
  const jobs = new JobWatch({
    interval: 60_000,
    grace: 100,
    processes: async () => commandRows(group, `${group} a`),
  });
  try {
    const [job] = await jobs.list();
    await assert.rejects(jobs.stop(job!), {
      message: `Job ${group} has not stopped.`,
    });
    // SIGKILL ended the group, so the next signal fails
    await assert.rejects(jobs.stop(job!), { code: 'ESRCH' });
  } finally {
    sleep.kill('SIGKILL');
    jobs.close();
  }
});

test("a ! command's group handed to track is a job from the first read, though its shell has already exited, and stops", async () => {
  const jobs = new JobWatch({ interval: 60_000 });
  try {
    await runShell('sleep 60.271 &', {
      cwd: await scratch('witch-jobs-'),
      signal: new AbortController().signal,
      onOutput: () => {},
      onSpawn: (pid) => jobs.track(pid),
    });
    const list = await jobs.list();
    assert.deepEqual(
      list.map(({ command }) => command),
      ['sleep 60.271'],
    );
    await jobs.stop(list[0]!);
    assert.deepEqual(await jobs.list(), []);
  } finally {
    // pkill exits 1 once stop has killed the sleep
    await promisify(execFile)('pkill', ['-f', 'sleep 60.271']).catch(() => {});
    jobs.close();
  }
});

test('a group handed to track while a read runs is a job at the next read and after, along with the groups its process starts', async () => {
  // a `!` command's shell is Witch's own child, which a read never walks from by identity as it does an orphan.
  // pids above 99999 can't be this test's
  const shell: Row = {
    pid: 100000,
    ppid: process.pid,
    pgid: 100000,
    name: 'sh',
    leadsSession: true,
    identity: '100000 a',
  };
  const first = Promise.withResolvers<Row[]>();
  const tables = [
    first.promise,
    Promise.resolve<Row[]>([
      shell,
      {
        pid: 100001,
        ppid: 100000,
        pgid: 100001,
        name: 'node',
        leadsSession: false,
        identity: '100001 a',
      },
    ]),
    // a new child, so only the walk from the handed group reaches its group
    Promise.resolve<Row[]>([
      shell,
      {
        pid: 100002,
        ppid: 100000,
        pgid: 100002,
        name: 'node',
        leadsSession: false,
        identity: '100002 a',
      },
    ]),
  ];
  const jobs = new JobWatch({
    interval: 60_000,
    processes: () => tables.shift()!,
    describe: leaders,
  });
  try {
    const listing = jobs.list();
    jobs.track(100000);
    first.resolve([]);
    await listing;
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [100000, 100001],
    );
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [100000, 100002],
    );
  } finally {
    jobs.close();
  }
});

test('a handed group stays a job while any process holds its id, and once a read finds it empty, a later group given its id is not', async () => {
  // each orphan is new to its read, so only the handed group reaches it
  const orphan = (pid: number) => orphanRow(pid, 100000);
  const tables = [[orphan(100001)], [orphan(100002)], [], [orphan(100000)]];
  const jobs = new JobWatch({
    interval: 60_000,
    processes: async () => tables.shift()!,
    describe: groupLeaders(100000),
  });
  try {
    jobs.track(100000);
    await jobs.list();
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [100000],
    );
    await jobs.list();
    assert.deepEqual(await jobs.list(), []);
  } finally {
    jobs.close();
  }
});

test('a shell that reports its pid makes its group a job after it exits, and its report is consumed', async () => {
  const directory = await scratch('witch-jobs-');
  const jobs = new JobWatch({ directory, interval: 60_000 });
  // as Claude Code runs a Bash command after its CLAUDE_ENV_FILE
  const shell = spawn(
    '/bin/zsh',
    [
      '-c',
      `${await readFile(jobs.script!, 'utf8')}\n: && /usr/bin/perl -e 'sleep 60.31' witch-jobs-fixture &`,
    ],
    { detached: true, stdio: 'ignore' },
  );
  const group = shell.pid!;
  try {
    await once(shell, 'exit');
    // just after the shell exits, its `&` child can still be the forked zsh, whose command line holds the perl's
    const list = await listed(jobs, (found) =>
      found.some(
        ({ command }) =>
          command === '/usr/bin/perl -e sleep 60.31 witch-jobs-fixture',
      ),
    );
    assert.deepEqual(
      list.map(({ group }) => group),
      [group],
    );
    assert.deepEqual(await readdir(directory), ['env']);
    await jobs.stop(list[0]!);
    assert.deepEqual(await jobs.list(), []);
  } finally {
    try {
      process.kill(-group, 'SIGKILL');
    } catch {
      // stopped by the test
    }
    jobs.close();
  }
});

test("the report script, run ahead of a command by zsh or bash, reports that shell's pid, marks the command and drops CLAUDE_ENV_FILE, and the command runs unchanged when it can't write its report, even under errexit", async () => {
  const directory = await scratch("witch-jobs-'q-");
  const jobs = new JobWatch({ directory, interval: 60_000 });
  const text = await readFile(jobs.script!, 'utf8');
  const run = async (shell: string, command: string, prelude = '') => {
    const running = promisify(execFile)(
      shell,
      ['-c', `${prelude}${text}\n: && ${command}`],
      {
        env: { ...process.env, CLAUDE_ENV_FILE: jobs.script },
      },
    );
    return { pid: running.child.pid, ...(await running) };
  };
  const shells = ['/bin/zsh', '/bin/bash'];
  try {
    for (const shell of shells) {
      const { pid, stdout } = await run(
        shell,
        `printf '%s|%s|%s' $$ "$WITCH_JOBS" "\${CLAUDE_ENV_FILE-unset}"`,
      );
      assert.equal(stdout, `${pid}|${directory}|unset`, shell);
      assert.ok(existsSync(join(directory, String(pid))), shell);
    }
    await chmod(directory, 0o555);
    try {
      // Claude's snapshot replays errexit from the user's shell
      for (const shell of shells)
        for (const prelude of ['', 'set -e\n']) {
          const { stdout, stderr } = await run(shell, 'echo ran', prelude);
          assert.deepEqual(
            { stdout, stderr },
            { stdout: 'ran\n', stderr: '' },
            `${shell} ${prelude}`,
          );
        }
    } finally {
      await chmod(directory, 0o755);
    }
  } finally {
    jobs.close();
  }
});

test('a report from a pid that leads no group adds no job, though the group it sits in runs', async () => {
  const directory = await scratch('witch-jobs-');
  const jobs = new JobWatch({
    directory,
    interval: 60_000,
    processes: async () => [
      agentRow,
      {
        pid: 100005,
        ppid: 100000,
        pgid: 100000,
        name: 'node',
        leadsSession: false,
        identity: '100005 a',
      },
    ],
    describe: leaders,
  });
  try {
    await writeFile(join(directory, '100005'), '');
    assert.deepEqual(await jobs.list(), []);
  } finally {
    jobs.close();
  }
});

test("a report written while a read's ps runs is a job at the next read, and stays one after its shell exits", async () => {
  const directory = await scratch('witch-jobs-');
  const tables: (() => Promise<Row[]>)[] = [
    async () => {
      await writeFile(join(directory, '100000'), '');
      return [];
    },
    async () => [
      {
        pid: 100000,
        ppid: 1,
        pgid: 100000,
        name: 'sh',
        leadsSession: true,
        identity: '100000 a',
      },
    ],
    // the shell has exited, and only the process it left holds its group
    async () => [
      {
        pid: 100002,
        ppid: 1,
        pgid: 100000,
        name: 'node',
        leadsSession: false,
        identity: '100002 a',
      },
    ],
  ];
  const jobs = new JobWatch({
    directory,
    interval: 60_000,
    processes: () => tables.shift()!(),
    describe: groupLeaders(100000),
    marked: async () => new Map(),
  });
  try {
    assert.deepEqual(await jobs.list(), []);
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [100000],
    );
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [100000],
    );
  } finally {
    jobs.close();
  }
});

test('a removed report directory leaves the jobs the walk reaches', async () => {
  const directory = await scratch('witch-jobs-');
  const jobs = new JobWatch({
    directory,
    interval: 60_000,
    processes: async () => commandRows(100001, '100001 a'),
    describe: leaders,
  });
  try {
    await rm(directory, { recursive: true });
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [100001],
    );
  } finally {
    jobs.close();
  }
});

test("the first read only learns the processes, so the terminal Witch runs in isn't a job though processes below it carry the mark", async () => {
  const jobs = new JobWatch({
    directory: await scratch('witch-jobs-'),
    interval: 60_000,
    processes: async () => [
      {
        pid: 100010,
        ppid: 1,
        pgid: 100010,
        name: 'sh',
        leadsSession: true,
        identity: '100010 a',
      },
      {
        pid: process.pid,
        ppid: 100010,
        pgid: process.pid,
        name: 'node',
        leadsSession: false,
        identity: `${process.pid} a`,
      },
      agentRow,
    ],
    describe: leaders,
    marked: async (pids) =>
      new Map(
        pids
          .filter((pid) => pid === agentRow.pid)
          .map((pid) => [pid, undefined]),
      ),
  });
  try {
    assert.deepEqual(await jobs.list(), []);
  } finally {
    jobs.close();
  }
});

test("a marked process orphaned in Witch's own group doesn't make that group a job", async () => {
  const witch: Row = {
    pid: process.pid,
    ppid: 100030,
    pgid: 100020,
    name: 'node',
    leadsSession: false,
    identity: `${process.pid} a`,
  };
  const tables = [
    [witch],
    [
      witch,
      {
        pid: 100021,
        ppid: 1,
        pgid: 100020,
        name: 'node',
        leadsSession: false,
        identity: '100021 a',
      },
    ],
  ];
  const jobs = new JobWatch({
    directory: await scratch('witch-jobs-'),
    interval: 60_000,
    processes: async () => tables.shift()!,
    describe: groupLeaders(100020),
    marked: async (pids) =>
      new Map(
        pids.filter((pid) => pid === 100021).map((pid) => [pid, undefined]),
      ),
  });
  try {
    await jobs.list();
    assert.deepEqual(await jobs.list(), []);
  } finally {
    jobs.close();
  }
});

/** a process launchd adopted, alone in a group of its own unless given `pgid`. */
function orphanRow(pid: number, pgid = pid): Row {
  return {
    pid,
    ppid: 1,
    pgid,
    name: 'node',
    leadsSession: false,
    identity: `${pid} a`,
  };
}

test("a launchd child the last read didn't list is a job when it or a process below it carries the mark, and one the last read listed isn't checked", async () => {
  const now = new Set<number>();
  const old = orphanRow(100001);
  const later = [
    old,
    orphanRow(100002),
    {
      pid: 100003,
      ppid: 100002,
      pgid: 100003,
      name: 'node',
      leadsSession: false,
      identity: '100003 a',
    },
    orphanRow(100004),
    orphanRow(100005),
  ];
  const tables = [[old], later, later];
  const jobs = new JobWatch({
    directory: await scratch('witch-jobs-'),
    interval: 60_000,
    processes: async () => tables.shift()!,
    describe: leaders,
    marked: async (pids) =>
      new Map(
        pids.filter((pid) => now.has(pid)).map((pid) => [pid, undefined]),
      ),
  });
  try {
    await jobs.list();
    for (const pid of [100001, 100003, 100004]) now.add(pid);
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [100003, 100004],
    );
    // the last read listed it, so it isn't checked
    now.add(100005);
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [100003, 100004],
    );
  } finally {
    jobs.close();
  }
});

test('a failed mark check fails the read, and the next read checks the same processes', async () => {
  const later = [orphanRow(100001), orphanRow(100004)];
  const tables = [[], later, later];
  let checks = 0;
  const jobs = new JobWatch({
    directory: await scratch('witch-jobs-'),
    interval: 60_000,
    processes: async () => tables.shift()!,
    describe: leaders,
    marked: async (pids) => {
      if (!checks++) throw new Error('ps failed');
      return new Map(
        pids.filter((pid) => pid === 100004).map((pid) => [pid, undefined]),
      );
    },
  });
  try {
    await jobs.list();
    await assert.rejects(jobs.list(), { message: 'ps failed' });
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [100004],
    );
  } finally {
    jobs.close();
  }
});

test("a launchd child carrying another instance's mark, or one extending this mark's path, is not a job", async () => {
  const directory = await scratch('witch-jobs-');
  const cwd = await scratch('witch-jobs-');
  const jobs = new JobWatch({ directory, interval: 60_000 });
  /** a node that writes `name` into cwd once it runs, left to launchd by its shell. */
  const orphan = (name: string, env: NodeJS.ProcessEnv) =>
    spawn(
      '/bin/sh',
      [
        '-c',
        `"$0" -e "require('fs').writeFileSync('${name}', ''); setTimeout(() => {}, 60000)" witch-jobs-fixture-${name} &`,
        process.execPath,
      ],
      { cwd, detached: true, stdio: 'ignore', env },
    );
  await jobs.list();
  const shells = [
    orphan('a', { ...process.env, ...jobs.environment }),
    orphan('b', { ...process.env, WITCH_JOBS: `${directory}x` }),
  ];
  try {
    await Promise.all(shells.map((shell) => once(shell, 'exit')));
    await until('both nodes', () =>
      ['a', 'b'].every((name) => existsSync(join(cwd, name))),
    );
    assert.deepEqual(
      (await jobs.list()).map(({ command }) => command.split(' ').at(-1)),
      ['witch-jobs-fixture-a'],
    );
  } finally {
    for (const shell of shells)
      try {
        process.kill(-shell.pid!, 'SIGKILL');
      } catch {
        // already empty
      }
    jobs.close();
  }
});

test('process names do not alter start identities', () => {
  const rows = parseProcesses([
    '100101 1 100101 Ss Fri Oct  9 22:34:18 2026 tmux',
    '100102 1 100102 S Tue Oct 20 22:34:18 2026 node',
    '100103 1 100103 Z Tue Oct 20 22:34:18 2026 node',
  ]);
  assert.deepEqual(
    rows.map(({ identity, name }) => ({ identity, name })),
    [
      { identity: '100101 Fri Oct 9 22:34:18 2026', name: 'tmux' },
      { identity: '100102 Tue Oct 20 22:34:18 2026', name: 'node' },
    ],
  );
  assert.equal(
    parseProcesses(['100101 1 100101 Ss Fri Oct  9 22:34:18 2026 node'])[0]!
      .identity,
    rows[0]!.identity,
  );
});

for (const admission of ['direct', 'handed', 'reported', 'marked']) {
  test.each(['tmux', 'zellij'])(
    `%s trees stay out of ${admission} admission`,
    async (name) => {
      const directory = await scratch(`witch-jobs-${name}-`);
      const server = {
        ...orphanRow(100101),
        ppid:
          admission === 'direct'
            ? agentRow.pid
            : admission === 'marked'
              ? 1
              : process.pid,
        name,
        leadsSession: admission === 'direct',
      };
      const pane = { ...orphanRow(100102), ppid: server.pid };
      const ordinary = {
        ...orphanRow(100103),
        ppid: admission === 'marked' ? 1 : agentRow.pid,
        name: `${name}-helper`,
        leadsSession: admission !== 'marked',
      };
      let rows: Row[] = [];
      const jobs = new JobWatch({
        directory,
        interval: 60_000,
        processes: async () => rows,
        describe: leaders,
        marked: async (pids) =>
          new Map(
            (admission === 'marked' ? pids : []).map((pid) => [pid, undefined]),
          ),
      });
      try {
        await jobs.list();
        rows = [agentRow, server, pane, ordinary];
        if (admission === 'handed') jobs.track(server.pgid);
        if (admission === 'reported')
          await writeFile(join(directory, String(server.pid)), '');
        assert.deepEqual(
          (await jobs.list()).map(({ group }) => group),
          [100103],
        );
        if (admission === 'marked') {
          rows.push({ ...orphanRow(100104), ppid: server.pid });
          assert.deepEqual(
            (await jobs.list()).map(({ group }) => group),
            [100103],
          );
        }
      } finally {
        jobs.close();
      }
    },
  );
}

test('a mixed group preserves ordinary ownership while excluding tmux', async () => {
  const command = commandRows(100201, '100201 a')[1]!;
  const orphan = { ...command, ppid: 1 };
  const tmux = {
    ...orphanRow(100202),
    ppid: orphan.pid,
    pgid: orphan.pgid,
    name: 'tmux',
  };
  const pane = { ...orphanRow(100203), ppid: tmux.pid };
  const child = { ...orphanRow(100204), ppid: orphan.pid };
  const later = { ...orphanRow(100205), ppid: orphan.pid };
  let rows = [agentRow, command];
  const jobs = new JobWatch({
    interval: 60_000,
    grace: 1,
    processes: async () => rows,
    describe: async (pids) =>
      rows
        .filter(({ pid }) => pids.includes(pid))
        .map(({ pid, pgid, name }) => ({
          pid,
          pgid,
          command: name,
          cpu: 0,
          startedAt: 0,
        })),
  });
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
    const parents = new Set(
      rows.filter(({ pgid }) => pgid === -pid).map(({ pid }) => pid),
    );
    rows = rows
      .filter(({ pgid }) => pgid !== -pid)
      .map((row) => (parents.has(row.ppid) ? { ...row, ppid: 1 } : row));
    return true;
  });
  try {
    const [original] = await jobs.list();
    assert.ok(original);
    rows = [orphan];
    assert.equal((await jobs.list())[0]!.generation, original.generation);
    rows = [orphan, tmux, pane, child];
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [100204],
    );
    await jobs.stop(original);
    assert.equal(kill.mock.calls.length, 0);
    rows = [orphan, child];
    const restored = (await jobs.list()).find(({ group }) => group === 100201);
    assert.ok(restored, 'ordinary orphan returns after tmux exits');
    assert.notEqual(restored.generation, original.generation);
    await jobs.stop(original);
    assert.equal(kill.mock.calls.length, 0);
    rows = [orphan, child, later];
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [100201, 100204, 100205],
    );
    await jobs.stop(restored);
    assert.deepEqual(kill.mock.calls, [[-100201, 'SIGTERM']]);
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [100204, 100205],
    );
  } finally {
    jobs.close();
  }
});

test("an enclosing tmux leaves this Witch's own agent jobs available", async () => {
  const server = { ...orphanRow(100301), name: 'tmux' };
  const jobs = new JobWatch({
    interval: 60_000,
    processes: async () => [
      server,
      { ...orphanRow(100302), ppid: server.pid },
      { ...orphanRow(process.pid), ppid: server.pid },
      ...commandRows(100303, '100303 a'),
      { ...commandRows(100304, '100304 a')[1]!, name: 'tmux' },
      { ...orphanRow(100305), ppid: 100304 },
    ],
    describe: leaders,
  });
  try {
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [100303],
    );
  } finally {
    jobs.close();
  }
});

test('observed tmux descendants stay excluded after reparenting and group changes', async () => {
  let rows: Row[] = [];
  const jobs = new JobWatch({
    directory: await scratch('witch-jobs-tmux-'),
    interval: 60_000,
    processes: async () => rows,
    describe: async (pids) =>
      rows
        .filter(({ pid }) => pids.includes(pid))
        .map(({ pid, pgid, name }) => ({
          pid,
          pgid,
          command: name,
          cpu: 0,
          startedAt: 0,
        })),
    marked: async (pids) => new Map(pids.map((pid) => [pid, undefined])),
  });
  try {
    await jobs.list();
    rows = [
      { ...orphanRow(100401), name: 'tmux' },
      { ...orphanRow(100402), ppid: 100401 },
    ];
    assert.deepEqual(await jobs.list(), []);
    rows = [{ ...orphanRow(100402), pgid: 100403 }];
    jobs.track(100403);
    assert.deepEqual(await jobs.list(), []);
    rows = [{ ...orphanRow(100402), identity: '100402 b' }];
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [100402],
    );
  } finally {
    jobs.close();
  }
});

test('a stale selection cannot stop a group that became tmux', async () => {
  let rows = commandRows(100501, '100501 a');
  const jobs = new JobWatch({
    interval: 60_000,
    processes: async () => rows,
    describe: leaders,
  });
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    rows = [];
    return true;
  });
  try {
    const [original] = await jobs.list();
    assert.ok(original);
    rows = [agentRow, { ...rows[1]!, name: 'tmux' }];
    await jobs.stop(original);
    assert.equal(kill.mock.calls.length, 0);
    assert.deepEqual(await jobs.list(), []);
  } finally {
    jobs.close();
  }
});

test('a failed read does not commit partial tmux exclusions', async () => {
  const original = commandRows(100601, '100601 a');
  let rows = original;
  let fail = false;
  const jobs = new JobWatch({
    directory: await scratch('witch-jobs-tmux-'),
    interval: 60_000,
    processes: async () => rows,
    describe: leaders,
    marked: async () => {
      if (fail) throw new Error('mark failed');
      return new Map();
    },
  });
  try {
    const [before] = await jobs.list();
    assert.ok(before);
    rows = [agentRow, { ...original[1]!, name: 'tmux' }, orphanRow(100602)];
    fail = true;
    await assert.rejects(jobs.list(), { message: 'mark failed' });
    rows = original;
    fail = false;
    assert.deepEqual(await jobs.list(), [before]);
  } finally {
    jobs.close();
  }
});
