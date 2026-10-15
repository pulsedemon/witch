import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { JobWatch } from '../src/core/jobs.js';
import type { Job, Row } from '../src/core/jobs.js';

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
    while (!gone(stuck)) await delay(20);
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
    for (const { startedAt } of list) {
      // lstart has whole seconds
      assert.ok(startedAt >= spawnedAt - 1000);
      assert.ok(startedAt <= Date.now());
    }
    await jobs.stop({ group: server, generation: 1 });
    assert.doesNotThrow(() => process.kill(-server, 0));
    for (const job of list) await jobs.stop(job);
    assert.deepEqual(await jobs.list(), []);
    for (const { group } of list)
      assert.throws(() => process.kill(-group, 0), { code: 'ESRCH' });
    // as a job chosen in a picker opened before it ended
    await jobs.stop(list.find(({ group }) => group === stuck)!);
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

await test("a group that a process its command's shell left behind starts or moves to is a job", async () => {
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
    assert.deepEqual(
      list
        .filter(({ group }) => group !== command)
        .map((job) => job.command)
        .sort(),
      [
        'perl -e setpgrp(0, 0); sleep 1 while getppid() != 1 witch-jobs-fixture',
        `perl -e sleep 1; setpgrp(0, 0); sleep 1 while kill 0, ${agent.pid} witch-jobs-fixture`,
      ],
    );
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

await test("a later group given a tracked group's id is not a job", async () => {
  const sleep = spawn('/bin/sleep', ['64.5'], {
    detached: true,
    stdio: 'ignore',
  });
  const group = sleep.pid!;
  // above macOS's highest pid, so ps never describes it
  const agent = 100_000;
  let rows: Row[] = [
    {
      pid: agent,
      ppid: process.pid,
      pgid: agent,
      leadsSession: false,
      identity: `${agent} a`,
    },
    {
      pid: group,
      ppid: agent,
      pgid: group,
      leadsSession: true,
      identity: `${group} a`,
    },
  ];
  const jobs = new JobWatch({ interval: 60_000, processes: async () => rows });
  try {
    assert.deepEqual(
      (await jobs.list()).map((job) => job.group),
      [group],
    );
    // the command's group ended and a process outside the agents' commands was given its id
    rows = [
      {
        pid: group,
        ppid: 1,
        pgid: group,
        leadsSession: true,
        identity: `${group} b`,
      },
    ];
    assert.deepEqual(await jobs.list(), []);
  } finally {
    sleep.kill('SIGKILL');
    jobs.close();
  }
});

await test('stop leaves alone a later agent command given the id of the job it was listed for', async () => {
  const sleep = spawn('/bin/sleep', ['65.5'], {
    detached: true,
    stdio: 'ignore',
  });
  const group = sleep.pid!;
  // above macOS's highest pid, so ps never describes it
  const agent = 100_000;
  const command = (identity: string): Row[] => [
    {
      pid: agent,
      ppid: process.pid,
      pgid: agent,
      leadsSession: false,
      identity: `${agent} a`,
    },
    { pid: group, ppid: agent, pgid: group, leadsSession: true, identity },
  ];
  let rows = command(`${group} a`);
  const jobs = new JobWatch({ interval: 60_000, processes: async () => rows });
  try {
    const [job] = await jobs.list();
    assert.equal(job?.group, group);
    // the listed command ended and the agent's next one was given its id, as a picker left open could see
    rows = command(`${group} b`);
    assert.deepEqual(
      (await jobs.list()).map((later) => later.group),
      [group],
    );
    await jobs.stop(job);
    assert.doesNotThrow(() => process.kill(-group, 0));
  } finally {
    sleep.kill('SIGKILL');
    jobs.close();
  }
});

await test("a job listed while a read gives its id to the agent's next command can't stop that command", async () => {
  const sleep = spawn('/bin/sleep', ['66.5'], {
    detached: true,
    stdio: 'ignore',
  });
  const group = sleep.pid!;
  // above macOS's highest pid, so ps never describes it
  const agent = 100_000;
  const command = (identity: string): Row[] => [
    {
      pid: agent,
      ppid: process.pid,
      pgid: agent,
      leadsSession: false,
      identity: `${agent} a`,
    },
    { pid: group, ppid: agent, pgid: group, leadsSession: true, identity },
  ];
  let rows = command(`${group} a`);
  const jobs = new JobWatch({ interval: 60_000, processes: async () => rows });
  try {
    const listing = jobs.list();
    // the listing has read and waits on ps for the details
    await new Promise(setImmediate);
    rows = command(`${group} b`);
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

await test('a process that left its tracked group before ps describes it is not a job', async () => {
  const [leader, moved] = ['67.5', '68.5'].map((seconds) =>
    spawn('/bin/sleep', [seconds], { detached: true, stdio: 'ignore' }),
  ) as [ChildProcess, ChildProcess];
  // above macOS's highest pid, so ps never describes it
  const agent = 100_000;
  // the read saw the second in the leader's group, which it has since left for a session of its own
  const rows: Row[] = [
    {
      pid: agent,
      ppid: process.pid,
      pgid: agent,
      leadsSession: false,
      identity: `${agent} a`,
    },
    {
      pid: leader.pid!,
      ppid: agent,
      pgid: leader.pid!,
      leadsSession: true,
      identity: `${leader.pid} a`,
    },
    {
      pid: moved.pid!,
      ppid: leader.pid!,
      pgid: leader.pid!,
      leadsSession: false,
      identity: `${moved.pid} a`,
    },
  ];
  const jobs = new JobWatch({ interval: 60_000, processes: async () => rows });
  try {
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [leader.pid],
    );
  } finally {
    leader.kill('SIGKILL');
    moved.kill('SIGKILL');
    jobs.close();
  }
});

await test('a time zone change keeps an orphaned job and its generation', async () => {
  const jobs = new JobWatch({ interval: 50 });
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
    // only the background poll sees the stuck command under the agent, since its member is orphaned before the first list
    await delay(500);
    process.kill(stuck, 'SIGKILL');
    while (!gone(stuck)) await delay(20);
    const before = (
      await listed(jobs, (found) => found.some(({ group }) => group === stuck))
    ).find(({ group }) => group === stuck)!;
    // as a laptop's automatic time zone does mid-session
    process.env.TZ = 'Pacific/Kiritimati';
    const after = (await jobs.list()).find(({ group }) => group === stuck);
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
