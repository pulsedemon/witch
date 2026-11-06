import assert from 'node:assert/strict';
import { test } from 'vitest';
import { JobWatch } from '../src/core/jobs.js';
import type { Row } from '../src/core/jobs.js';

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
])(
  'Emacs arguments $args leave managed=$managed',
  async ({ args, managed }) => {
    const row: Row = {
      pid: 100105,
      ppid: process.pid,
      pgid: 100105,
      name: 'emacs-31.1',
      leadsSession: true,
      identity: '100105 a',
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
        managed ? [100105] : [],
      );
    } finally {
      jobs.close();
    }
  },
);
