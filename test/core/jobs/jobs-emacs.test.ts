import assert from 'node:assert/strict';
import { test } from 'vitest';
import { JobWatch } from '../../../src/core/jobs/jobs.js';
import type { Row } from '../../../src/core/jobs/jobs.js';

test.each([
  { args: ['--fg-daemon', '--eval', '(message " --batch ")'], managed: false },
  {
    args: ['--daemon=work', '--eval', '(message " --script ")'],
    managed: false,
  },
  { args: ['--batch', '--eval', '(message " --daemon ")'], managed: true },
  { args: ['--script', 'check.el', ' --daemon '], managed: true },
  { args: ['-x', 'check.el', ' --daemon '], managed: true },
  { args: ['-Q', 'notes.txt'], managed: true },
  { args: ['--fg-daemon=work', '-L', '--batch'], managed: false },
  { args: ['--fg-daemo=work'], managed: false },
  { args: ['--dae=work'], managed: false },
  { args: ['--bg-daemo=work'], managed: false },
  { args: ['--fg-daemon', '--directory=--batch'], managed: false },
  { args: ['--fg-daemon', '--direc', '--batch'], managed: false },
  { args: ['-Q', '-L', '--daemon'], managed: true },
  { args: ['-Q', '--', '--daemon'], managed: true },
  { args: ['--fg-daemon', '--', '--batch'], managed: false },
  { args: ['--ba', '--daemon=work'], managed: false },
  { args: ['-daemon=work'], managed: true },
])(
  'Emacs arguments $args leave managed=$managed',
  async ({ args, managed }) => {
    const row: Row = {
      pid: 5100105,
      ppid: process.pid,
      pgid: 5100105,
      name: 'emacs-31.1',
      leadsSession: true,
      identity: '5100105 a',
    };

    const jobs = new JobWatch({
      interval: 60_000,
      processes: async () => [row],
      arguments: async (pids) =>
        new Map(pids.map((pid) => [pid, ['emacs', ...args]])),
      describe: async (pids) =>
        pids.map((pid) => ({
          pid,
          pgid: pid,
          cpu: 0,
          startedAt: 0,
          command: '',
        })),
    });

    try {
      jobs.track(row.pgid);

      assert.deepEqual(
        (await jobs.list()).map(({ group }) => group),
        managed ? [5100105] : [],
      );
    } finally {
      jobs.close();
    }
  },
);
