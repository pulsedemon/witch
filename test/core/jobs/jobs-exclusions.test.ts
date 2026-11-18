import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { JobWatch } from '../../../src/core/jobs/jobs.js';
import type { Row } from '../../../src/core/jobs/jobs.js';
import { scratch } from '../../fixtures/scratch.js';
import {
  agentRow,
  commandRows,
  leaders,
  orphanRow,
} from '../../fixtures/jobs.js';

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
        ...orphanRow(5100101),
        ppid:
          admission === 'direct'
            ? agentRow.pid
            : admission === 'marked'
              ? 1
              : process.pid,
        name,
        leadsSession: admission === 'direct',
      };

      const pane = { ...orphanRow(5100102), ppid: server.pid };

      const ordinary = {
        ...orphanRow(5100103),
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
          [5100103],
        );

        if (admission === 'marked') {
          rows.push({ ...orphanRow(5100104), ppid: server.pid });

          assert.deepEqual(
            (await jobs.list()).map(({ group }) => group),
            [5100103],
          );
        }
      } finally {
        jobs.close();
      }
    },
  );
}

test('a mixed group preserves ordinary ownership while excluding tmux', async () => {
  const command = commandRows(5100201, '5100201 a')[1]!;
  const orphan = { ...command, ppid: 1 };

  const tmux = {
    ...orphanRow(5100202),
    ppid: orphan.pid,
    pgid: orphan.pgid,
    name: 'tmux',
  };

  const pane = { ...orphanRow(5100203), ppid: tmux.pid };
  const child = { ...orphanRow(5100204), ppid: orphan.pid };
  const later = { ...orphanRow(5100205), ppid: orphan.pid };
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
      [5100204],
    );

    await jobs.stop(original);
    assert.equal(kill.mock.calls.length, 0);
    rows = [orphan, child];
    const restored = (await jobs.list()).find(({ group }) => group === 5100201);
    assert.ok(restored, 'ordinary orphan returns after tmux exits');
    assert.notEqual(restored.generation, original.generation);
    await jobs.stop(original);
    assert.equal(kill.mock.calls.length, 0);
    rows = [orphan, child, later];

    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [5100201, 5100204, 5100205],
    );

    await jobs.stop(restored);
    assert.deepEqual(kill.mock.calls, [[-5100201, 'SIGTERM']]);

    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [5100204, 5100205],
    );
  } finally {
    jobs.close();
  }
});

test("an enclosing tmux leaves this Witch's own agent jobs available", async () => {
  const server = { ...orphanRow(5100301), name: 'tmux' };

  const jobs = new JobWatch({
    interval: 60_000,
    processes: async () => [
      server,
      { ...orphanRow(5100302), ppid: server.pid },
      { ...orphanRow(process.pid), ppid: server.pid },
      ...commandRows(5100303, '5100303 a'),
      { ...commandRows(5100304, '5100304 a')[1]!, name: 'tmux' },
      { ...orphanRow(5100305), ppid: 5100304 },
    ],
    describe: leaders,
  });

  try {
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [5100303],
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
      { ...orphanRow(5100401), name: 'tmux' },
      { ...orphanRow(5100402), ppid: 5100401 },
    ];

    assert.deepEqual(await jobs.list(), []);
    rows = [{ ...orphanRow(5100402), pgid: 5100403 }];
    jobs.track(5100403);
    assert.deepEqual(await jobs.list(), []);
    rows = [{ ...orphanRow(5100402), identity: '5100402 b' }];

    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [5100402],
    );
  } finally {
    jobs.close();
  }
});

test('a stale selection cannot stop a group that became tmux', async () => {
  let rows = commandRows(5100501, '5100501 a');

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
  const original = commandRows(5100601, '5100601 a');
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
    rows = [agentRow, { ...original[1]!, name: 'tmux' }, orphanRow(5100602)];
    fail = true;
    await assert.rejects(jobs.list(), { message: 'mark failed' });
    rows = original;
    fail = false;
    assert.deepEqual(await jobs.list(), [before]);
  } finally {
    jobs.close();
  }
});
