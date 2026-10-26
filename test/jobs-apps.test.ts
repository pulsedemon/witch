import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { JobWatch } from '../src/core/jobs.js';
import type { Row } from '../src/core/jobs.js';
import { scratch } from './fixtures/scratch.js';
import { until } from './fixtures/within.js';

/** a process launchd adopted, alone in a group of its own. */
function orphanRow(pid: number): Row {
  return {
    pid,
    ppid: 1,
    pgid: pid,
    name: 'node',
    leadsSession: false,
    identity: `${pid} a`,
  };
}

test("a marked app opened in a group of its own is not a job, nor is anything below it or a helper launchd adopted from its frameworks, though a bundle's main executable run in its command's group, or a tool inside a bundle or a framework, is", async () => {
  const app = orphanRow(100701);
  const helper = { ...orphanRow(100702), ppid: app.pid, pgid: app.pid };
  const terminal = { ...orphanRow(100703), ppid: helper.pid };
  const direct = { ...orphanRow(100705), pgid: 100704 };
  const plain = orphanRow(100706);
  const crashHandler = { ...orphanRow(100708), pgid: 100707 };
  const xcodePython = orphanRow(100709);
  const frameworkPython = orphanRow(100711);
  const jdk = orphanRow(100712);
  const codeHelper = { ...orphanRow(100714), pgid: 100713 };
  const job = orphanRow(100715);
  const browser = { ...orphanRow(100716), ppid: job.pid, pgid: job.pid };
  const renderer = { ...orphanRow(100717), ppid: browser.pid, pgid: job.pid };
  const later = [
    app,
    helper,
    terminal,
    direct,
    plain,
    crashHandler,
    xcodePython,
    frameworkPython,
    jdk,
    codeHelper,
    job,
    browser,
    renderer,
  ];
  const paths = new Map([
    [app.pid, '/Applications/Code.app/Contents/MacOS/Code'],
    [direct.pid, '/Applications/Chrome.app/Contents/MacOS/Chrome'],
    [plain.pid, '/usr/local/bin/node'],
    [
      crashHandler.pid,
      '/Applications/Code.app/Contents/Frameworks/Helpers/crashpad_handler',
    ],
    [
      xcodePython.pid,
      '/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python',
    ],
    [
      frameworkPython.pid,
      '/opt/homebrew/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python',
    ],
    [jdk.pid, '/Applications/IDEA.app/Contents/jbr/Contents/Home/bin/java'],
    [
      codeHelper.pid,
      '/Applications/Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
    ],
    [job.pid, '/usr/local/bin/node'],
    [browser.pid, '/Applications/Chromium.app/Contents/MacOS/Chromium'],
    [
      renderer.pid,
      '/Applications/Chromium.app/Contents/Frameworks/Chromium Helper (Renderer).app/Contents/MacOS/Chromium Helper (Renderer)',
    ],
  ]);
  const tables = [[], later];
  const jobs = new JobWatch({
    directory: await scratch('witch-jobs-'),
    interval: 60_000,
    processes: async () => tables.shift()!,
    describe: async (pids) =>
      later
        .filter(({ pid }) => pids.includes(pid))
        .map(({ pid, pgid }) => ({
          pid,
          pgid,
          cpu: 0,
          startedAt: 0,
          command: '',
        })),
    marked: async (pids) => pids.filter((pid) => pid !== terminal.pid),
    executables: async () => paths,
  });
  try {
    await jobs.list();
    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [100704, 100706, 100709, 100711, 100712, 100715],
    );
  } finally {
    jobs.close();
  }
});

for (const joins of ['later', 'in the read that opens the app']) {
  test(`a marked process that joins an opened app's group ${joins} brings back neither the app nor its terminals`, async () => {
    const app = orphanRow(100801);
    const terminal = { ...orphanRow(100802), ppid: app.pid };
    const stray = { ...orphanRow(100803), pgid: app.pid };
    const tables = [
      [],
      joins === 'later' ? [app, terminal] : [app, terminal, stray],
      [app, terminal, stray],
      [app, terminal, stray],
    ];
    const jobs = new JobWatch({
      directory: await scratch('witch-jobs-'),
      interval: 60_000,
      processes: async () => tables.shift()!,
      describe: async (pids) =>
        [app, terminal, stray]
          .filter(({ pid }) => pids.includes(pid))
          .map(({ pid, pgid }) => ({
            pid,
            pgid,
            cpu: 0,
            startedAt: 0,
            command: '',
          })),
      marked: async (pids) => pids,
      executables: async () =>
        new Map([
          [app.pid, '/Applications/Code.app/Contents/MacOS/Code'],
          [stray.pid, '/usr/local/bin/node'],
        ]),
    });
    try {
      await jobs.list();
      for (let read = 0; read < 3; read++)
        assert.deepEqual(
          (await jobs.list()).map(({ group }) => group),
          [],
        );
    } finally {
      jobs.close();
    }
  });
}

test.skipIf(process.platform !== 'darwin')(
  'a marked launchd child leading its own group from an app bundle is not a job, and one outside a bundle is',
  async () => {
    const directory = await scratch('witch-jobs-');
    const cwd = await scratch('witch-jobs-');
    const bundle = join(cwd, 'Visual Studio Code.app/Contents/MacOS');
    await mkdir(bundle, { recursive: true });
    await symlink(process.execPath, join(bundle, 'Code'));
    const jobs = new JobWatch({ directory, interval: 60_000 });
    /** a node leading its own group that writes its pid into `name` in cwd once it runs, left to launchd by its shell. */
    const leader = (name: string, executable: string) =>
      spawn(
        '/bin/sh',
        [
          '-c',
          `perl -e 'setpgrp(0, 0); exec @ARGV' "$0" -e "require('fs').writeFileSync('${name}', String(process.pid)); setTimeout(() => {}, 60000)" witch-jobs-fixture-${name} &`,
          executable,
        ],
        {
          cwd,
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ...jobs.environment },
        },
      );
    await jobs.list();
    const shells = [
      leader('app', join(bundle, 'Code')),
      leader('plain', process.execPath),
    ];
    try {
      await Promise.all(shells.map((shell) => once(shell, 'exit')));
      await until('both nodes', () =>
        ['app', 'plain'].every((name) => existsSync(join(cwd, name))),
      );
      assert.deepEqual(
        (await jobs.list()).map(({ command }) => command.split(' ').at(-1)),
        ['witch-jobs-fixture-plain'],
      );
    } finally {
      for (const name of ['app', 'plain'])
        try {
          const pid = Number(await readFile(join(cwd, name), 'utf8'));
          // an empty file reads as 0, and kill(-0) signals the runner's own group
          if (pid) process.kill(-pid);
        } catch {
          // never started, or already gone
        }
      jobs.close();
    }
  },
);
