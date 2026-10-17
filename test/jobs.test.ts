import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { JobWatch, parseDetails, parseProcesses } from '../src/core/jobs.js';
import type { Job, Row } from '../src/core/jobs.js';
import { until } from './fixtures/within.js';

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
  leadsSession: false,
  identity: '100000 a',
};

/** an agent's command led by `group`, as the process table shows it. */
function commandRows(group: number, identity: string): Row[] {
  return [
    agentRow,
    {
      pid: group,
      ppid: agentRow.pid,
      pgid: group,
      leadsSession: true,
      identity,
    },
  ];
}

/** describes each process as leading a group of its own. */
async function leaders(pids: number[]) {
  return pids.map((pid) => ({
    pid,
    pgid: pid,
    cpu: 0,
    startedAt: 0,
    command: '',
  }));
}

await test("jobs are the groups an agent's commands start, one stays listed after its leader exits, and stop kills a member that ignores SIGTERM and leaves other groups alone", async () => {
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
    // the running command's busy process starts two seconds after the others
    const list = await listed(jobs, (found) =>
      found.some(({ group, cpu }) => group === running && cpu > 50),
    );
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
    // about the busy process's one core
    assert.ok(list.find(({ group }) => group === running)!.cpu < 150);
    for (const { startedAt } of list) {
      // lstart has whole seconds
      assert.ok(startedAt >= spawnedAt - 1000);
      assert.ok(startedAt < spawnedAt + 1000);
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

await test("a group that a process its command's shell left behind starts or moves to is a job that stops", async () => {
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

await test("a group that a process below its command's leader moves to is a job", async () => {
  const jobs = new JobWatch({
    interval: 60_000,
    processes: async () => [
      ...commandRows(4242, '4242 a'),
      {
        pid: 4243,
        ppid: 4242,
        pgid: 4242,
        leadsSession: false,
        identity: '4243 a',
      },
      {
        pid: 4244,
        ppid: 4243,
        pgid: 4244,
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

await test("a later group given a tracked group's id is not a job", async () => {
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
    // the command's group ended and a process outside the agents' commands was given its id
    rows = [
      {
        pid: 4242,
        ppid: 1,
        pgid: 4242,
        leadsSession: true,
        identity: '4242 b',
      },
    ];
    assert.deepEqual(await jobs.list(), []);
  } finally {
    jobs.close();
  }
});

await test('a process given the pid of one that exited has another identity', () => {
  const [exited, later] = parseProcesses([
    '  501     1   501 Ss   Thu Oct 15 18:50:27 2026',
    '  501     1   501 Ss   Thu Oct 15 19:02:03 2026',
  ]);
  assert.notEqual(later?.identity, exited?.identity);
});

await test("a job listed while a read gives its id to the agent's next command can't stop that command", async () => {
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

await test('a job listed during a slower read keeps its generation', async () => {
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

await test('a process that left its tracked group before ps describes it is not a job', async () => {
  // the read saw 4243 in the leader's group, which it has since left for a group of its own
  const jobs = new JobWatch({
    interval: 60_000,
    processes: async () => [
      ...commandRows(4242, '4242 a'),
      {
        pid: 4243,
        ppid: 4242,
        pgid: 4242,
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

await test('a time zone change keeps a job and its generation', async () => {
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

await test('a job lists with its command intact under any locale', async () => {
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
  const locale = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
  // German writes lstart's names and %cpu's decimal its own way. LC_ALL reaches ps unless it's removed, and LANG
  // fills in the categories left unset
  process.env.LC_ALL = process.env.LANG = 'de_DE.UTF-8';
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

await test("a job's CPU is the sum of its processes'", async () => {
  const jobs = new JobWatch({
    interval: 60_000,
    processes: async () => [
      ...commandRows(4242, '4242 a'),
      {
        pid: 4243,
        ppid: 4242,
        pgid: 4242,
        leadsSession: false,
        identity: '4243 a',
      },
    ],
    describe: async () => [
      { pid: 4242, pgid: 4242, cpu: 30, startedAt: 0, command: 'make -j2' },
      { pid: 4243, pgid: 4242, cpu: 40, startedAt: 0, command: 'cc a.c' },
    ],
  });
  try {
    assert.deepEqual(
      (await jobs.list()).map(({ cpu }) => cpu),
      [70],
    );
  } finally {
    jobs.close();
  }
});

await test('a start date parses whether or not ps pads its day', () => {
  assert.deepEqual(
    parseDetails([
      '  501   501   0.0 Fri Oct  9 22:34:18 2026     sleep 60',
      '  502   502   0.0 Thu Oct 15 18:50:27 2026     sleep 61',
    ]).map(({ startedAt }) => startedAt),
    [Date.UTC(2026, 9, 9, 22, 34, 18), Date.UTC(2026, 9, 15, 18, 50, 27)],
  );
});

await test('a command holding a line separator is described', () => {
  assert.deepEqual(
    parseDetails([
      '  501   501   0.0 Thu Oct 15 18:50:27 2026     node -e a\u2028b',
    ]).map(({ command }) => command),
    ['node -e a\u2028b'],
  );
});

await test('a failed background read keeps the jobs it had', async () => {
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
        leadsSession: true,
        identity: '4242 a',
      },
    ];
    assert.deepEqual(await jobs.list(), before);
  } finally {
    jobs.close();
  }
});

await test('a job whose processes exit after a read lists as nothing and stops without an error', async () => {
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

await test('a job whose processes exited is gone before they are reaped', async () => {
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

await test('stop sends SIGTERM before SIGKILL', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'witch-jobs-'));
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
    await rm(cwd, { recursive: true, force: true });
  }
});

await test('stop rejects while reads still show a job it signalled', async () => {
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
