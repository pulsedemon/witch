import assert from 'node:assert/strict';

import { writeFile } from 'node:fs/promises';

import { join } from 'node:path';

import { test, vi } from 'vitest';

import { JobWatch } from '../src/core/jobs.js';

import type { Row } from '../src/core/jobs.js';

import { scratch } from './fixtures/scratch.js';

import { agentRow, commandRows, leaders, orphanRow } from './fixtures/jobs.js';

for (const admission of ['direct', 'handed', 'reported', 'marked']) {
  test.each([
    { name: 'tmux', args: ['tmux'] },
    { name: 'zellij', args: ['zellij'] },
    { name: 'emacs', args: ['emacs', '--daemon'] },
    { name: 'emacs-31.1', args: ['emacs', '-Q', '--bg-daemon=work'] },
    { name: 'Emacs', args: ['Emacs', '--fg-daemon'] },
  ])(
    `$name trees stay out of ${admission} admission`,
    async ({ name, args }) => {
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
        arguments: async (pids) =>
          new Map(
            pids.map((pid) => [
              pid,
              pid === server.pid ? args : [`${name}-helper`, '--daemon'],
            ]),
          ),
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
