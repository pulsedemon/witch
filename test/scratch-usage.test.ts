import assert from 'node:assert/strict';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  classifyScratch,
  inspectScratch,
} from '../src/persistence/scratch-usage.js';
import type {
  ScratchCandidate,
  ScratchObservation,
  ScratchUse,
} from '../src/persistence/scratch-usage.js';
import { scratch } from './fixtures/scratch.js';

const directory = '/fixture/scratch/root space';
const early = 'Sat Oct 24 05:00:00 2026';
const started = 'Sat Oct 24 06:00:00 2026';
const late = 'Sat Oct 24 07:00:00 2026';
const owner = { pid: 900001, started };
const current = process.pid;

function row(
  pid: number,
  ppid: number,
  start = early,
  name = 'node',
  uid = process.getuid!(),
) {
  return `${pid} ${ppid} ${uid} S ${start} ${name}`;
}

function reference(pid: number, fd: string, path: string, type = 'DIR') {
  return `p${pid}\0\nf${fd}\0t${type}\0n${path}\0\n`;
}

function observation(): ScratchObservation {
  return {
    before: [row(current, 1)],
    after: [row(current, 1)],
    commands: [`${current} node`],
    files:
      reference(current, 'cwd', '/fixture/project') +
      reference(current, '7', directory),
  };
}

function add(
  seen: ScratchObservation,
  pid: number,
  ppid: number,
  start: string,
  name = 'node',
) {
  const line = row(pid, ppid, start, name);
  seen.before = [...seen.before, line];
  seen.after = [...seen.after, line];
  seen.commands = [...seen.commands, `${pid} ${name}`];
  seen.files += reference(pid, 'cwd', '/fixture/project');
}

const cases: {
  name: string;
  expected: ScratchUse;
  change(seen: ScratchObservation, candidate: ScratchCandidate): void;
}[] = [
  {
    name: 'an exited owner with no remaining users',
    expected: 'unused',
    change() {},
  },
  {
    name: 'the exact live owner in its restart unlock window',
    expected: 'used',
    change(seen) {
      add(seen, owner.pid, current, started);
    },
  },
  {
    name: 'a later unrelated process reusing the owner pid',
    expected: 'unused',
    change(seen) {
      add(seen, owner.pid, current, late);
    },
  },
  {
    name: 'an orphaned opaque reader with no open scratch file',
    expected: 'unknown',
    change(seen) {
      add(seen, 900002, 1, late, 'zsh');
    },
  },
  {
    name: 'a visible inherited directory on an orphan',
    expected: 'used',
    change(seen) {
      add(seen, 900002, 1, late);
      seen.commands = [...seen.commands, `900002 node TMPDIR=${directory}`];
    },
  },
  {
    name: 'an older tmux server that can accept later work',
    expected: 'unknown',
    change(seen) {
      add(seen, 900002, 1, early, 'tmux');
    },
  },
  {
    name: 'a signed system uid in native process output',
    expected: 'unused',
    change(seen) {
      const system = row(900002, 1, early, 'dhcp6d', -2);
      seen.before = [...seen.before, system];
      seen.after = [...seen.after, system];
    },
  },
  {
    name: 'an independent process born after observation',
    expected: 'unused',
    change(seen) {
      seen.after = [...seen.after, row(900002, current, late, 'sleep')];
    },
  },
  {
    name: 'an orphan born after observation',
    expected: 'unknown',
    change(seen) {
      seen.after = [...seen.after, row(900002, 1, late, 'zsh')];
    },
  },
  {
    name: 'a possible reader disappearing during observation',
    expected: 'unknown',
    change(seen) {
      seen.before = [...seen.before, row(900002, 1, late)];
    },
  },
  {
    name: 'a process reparented during observation',
    expected: 'unknown',
    change(seen) {
      add(seen, 900002, current, late);
      seen.after = [row(current, 1), row(900002, 1, late)];
    },
  },
  {
    name: 'a missing live process in successful lsof output',
    expected: 'unknown',
    change(seen) {
      add(seen, 900002, current, early);
      seen.files = reference(current, 'cwd', '/fixture/project');
    },
  },
  {
    name: 'an inaccessible cwd in lsof output',
    expected: 'unknown',
    change(seen) {
      seen.files += reference(current, 'cwd', '(Permission denied)', 'unknown');
    },
  },
  ...[
    ['descriptor-list failure', 'ferr\0nFD info error: Permission denied\0\n'],
    [
      'fileport-list failure',
      'ferr\0nFILEPORT info error: Permission denied\0\n',
    ],
    ['untyped vnode permission failure', 'f99\0nno more information\0\n'],
    ['revoked vnode', 'f99\0n(revoked)\0\n'],
    [
      'thread-directory failure',
      'ftwd\0nthread info error: Permission denied\0\n',
    ],
    ['regular file without a path', 'f99\0tREG\0\n'],
  ].map(([name, fields]) => ({
    name: `a ${name} in lsof output`,
    expected: 'unknown' as const,
    change(seen: ScratchObservation) {
      seen.files += `p${current}\0\n${fields}`;
    },
  })),
  {
    name: 'a known pipe without a filesystem path',
    expected: 'unused',
    change(seen) {
      seen.files += `p${current}\0\nf99\0tPIPE\0\n`;
    },
  },
  {
    name: 'truncated file output',
    expected: 'unknown',
    change(seen) {
      seen.files = seen.files.slice(0, -2);
    },
  },
  {
    name: 'malformed process output',
    expected: 'unknown',
    change(seen) {
      seen.after = ['incomplete'];
    },
  },
  {
    name: 'a root without a recorded owner in the same boot',
    expected: 'unknown',
    change(_seen, candidate) {
      delete candidate.owner;
    },
  },
  {
    name: 'a root whose earlier tmux user has disappeared',
    expected: 'unknown',
    change(_seen, candidate) {
      candidate.requiresBoot = true;
    },
  },
  {
    name: 'legacy metadata without an initial ownership observation',
    expected: 'unknown',
    change(_seen, candidate) {
      delete candidate.requiresBoot;
    },
  },
  {
    name: 'an unused legacy root after a different boot',
    expected: 'unused',
    change(_seen, candidate) {
      delete candidate.owner;
      candidate.previousBoot = true;
    },
  },
  {
    name: 'another descriptor held by the inspecting process',
    expected: 'used',
    change(seen) {
      seen.files += reference(current, '8', directory);
    },
  },
  {
    name: 'the inspecting process working inside the root',
    expected: 'used',
    change(seen) {
      seen.files += reference(current, 'cwd', `${directory}/child`);
    },
  },
  {
    name: 'a mapped file beneath the root',
    expected: 'used',
    change(seen) {
      seen.files += reference(current, 'txt', `${directory}/mapped`, 'REG');
    },
  },
  {
    name: 'a similarly named sibling directory',
    expected: 'unused',
    change(seen) {
      seen.files += reference(current, '8', `${directory}-other`);
      seen.commands = [`${current} node TMPDIR=${directory}-other`];
    },
  },
  {
    name: 'a real path after an earlier sibling path in a command',
    expected: 'used',
    change(seen) {
      seen.commands = [
        `${current} node FIRST=${directory}-other TMPDIR=${directory}`,
      ];
    },
  },
];

for (const { name, expected, change } of cases) {
  test(`scratch usage classifies ${name}`, () => {
    const candidate: ScratchCandidate = {
      directory,
      owner,
      previousBoot: false,
      requiresBoot: false,
      lockFd: 7,
    };
    const seen = observation();
    change(seen, candidate);
    assert.deepEqual(
      classifyScratch([candidate], seen),
      new Map([[directory, expected]]),
    );
  });
}

test('scratch inspection finds a real open file without modifying candidate contents', async () => {
  const root = await scratch('witch-usage-');
  const directory = join(root, 'root with spaces');
  await mkdir(directory);
  const marker = join(directory, 'marker');
  await writeFile(marker, 'still needed');
  const lock = await open(directory, 'r');
  const file = await open(marker, 'r');
  try {
    assert.deepEqual(
      await inspectScratch([
        { directory, previousBoot: true, lockFd: lock.fd },
      ]),
      new Map([[directory, 'used']]),
    );
    assert.equal(await file.readFile('utf8'), 'still needed');
    assert.deepEqual(await inspectScratch([]), new Map());
  } finally {
    await file.close();
    await lock.close();
  }
});
