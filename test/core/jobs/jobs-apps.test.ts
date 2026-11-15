import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { JobWatch } from '../../../src/core/jobs/jobs.js';
import type { Row } from '../../../src/core/jobs/jobs.js';
import * as processes from '../../../src/persistence/process.js';
import { scratch } from '../../fixtures/scratch.js';
import { until } from '../../fixtures/within.js';

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

test('marked app roots exclude their trees, while commands and tools stay jobs', async () => {
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
  const unmarkedApp = orphanRow(100718);
  const markedChild = { ...orphanRow(100719), ppid: unmarkedApp.pid };

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
    unmarkedApp,
    markedChild,
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
    [unmarkedApp.pid, '/Applications/Terminal.app/Contents/MacOS/Terminal'],
    [markedChild.pid, '/usr/local/bin/node'],
  ]);

  const tables = [[], later];
  const lookedUp: number[] = [];

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
    marked: async (pids) =>
      new Map(
        pids
          .filter((pid) => pid !== terminal.pid && pid !== unmarkedApp.pid)
          .map((pid) => [pid, undefined]),
      ),
    executables: async (pids) => {
      lookedUp.push(...pids);

      return new Map([...paths].filter(([pid]) => pids.includes(pid)));
    },
  });

  try {
    await jobs.list();

    assert.deepEqual(
      (await jobs.list()).map(({ group }) => group),
      [100704, 100706, 100709, 100711, 100712, 100715, 100719],
    );

    assert.deepEqual(
      new Set(lookedUp),
      new Set([
        app.pid,
        direct.pid,
        plain.pid,
        crashHandler.pid,
        xcodePython.pid,
        frameworkPython.pid,
        jdk.pid,
        codeHelper.pid,
        job.pid,
      ]),
    );
  } finally {
    jobs.close();
  }
});

for (const joins of ['later', 'in the read that opens the app']) {
  test(`a marked process that joins the group of an opened app or its terminal ${joins} brings back neither the app nor its terminals`, async () => {
    const app = orphanRow(100801);
    const terminal = { ...orphanRow(100802), ppid: app.pid };

    const strays = [
      { ...orphanRow(100803), pgid: app.pid },
      { ...orphanRow(100804), pgid: terminal.pid },
    ];

    const tables = [
      [],
      joins === 'later' ? [app, terminal] : [app, terminal, ...strays],
      [app, terminal, ...strays],
      [app, terminal, ...strays],
    ];

    const lookedUp: number[] = [];
    const directory = await scratch('witch-jobs-');

    const environment = vi
      .spyOn(processes, 'ps')
      .mockImplementation(async (_format, pids) =>
        pids!.map(
          (pid) =>
            `${pid} node WITCH_JOBS=${directory} XPC_SERVICE_NAME=${pid === app.pid || pid === terminal.pid ? 'application.com.witch-test.editor.2' : '0'}`,
        ),
      );

    const jobs = new JobWatch({
      directory,
      interval: 60_000,
      processes: async () => tables.shift()!,
      describe: async (pids) =>
        [app, terminal, ...strays]
          .filter(({ pid }) => pids.includes(pid))
          .map(({ pid, pgid }) => ({
            pid,
            pgid,
            cpu: 0,
            startedAt: 0,
            command: '',
          })),
      executables: async (pids) => {
        lookedUp.push(...pids);

        const paths = new Map([
          [app.pid, '/Applications/Code.app/Contents/MacOS/Code'],
          ...strays.map(({ pid }) => [pid, '/usr/local/bin/node'] as const),
        ]);

        return new Map([...paths].filter(([pid]) => pids.includes(pid)));
      },
    });

    try {
      await jobs.list();

      for (let read = 0; read < 3; read++)
        assert.deepEqual(
          (await jobs.list()).map(({ group }) => group),
          [],
        );

      assert.deepEqual(
        new Set(lookedUp),
        new Set([app.pid, ...strays.map(({ pid }) => pid)]),
      );
    } finally {
      jobs.close();
      environment.mockRestore();
    }
  });
}

test('an excluded app keeps an inactive watch reading', async () => {
  const app = orphanRow(100901);
  const terminal = { ...orphanRow(100902), ppid: app.pid };
  let rows: Row[] = [];
  let reads = 0;

  const jobs = new JobWatch({
    directory: await scratch('witch-jobs-'),
    interval: 20,
    settle: 0,
    processes: async () => {
      reads++;

      return rows;
    },
    describe: async (pids) =>
      pids.map((pid) => ({
        pid,
        pgid: pid,
        cpu: 0,
        startedAt: 0,
        command: '',
      })),
    marked: async (pids) => new Map(pids.map((pid) => [pid, undefined])),
    executables: async (pids) => {
      assert.deepEqual(pids, [app.pid]);

      return new Map([[app.pid, '/Applications/Code.app/Contents/MacOS/Code']]);
    },
  });

  try {
    await jobs.list();
    rows = [app, terminal];
    assert.deepEqual(await jobs.list(), []);
    jobs.setActive(false);
    const count = reads;

    // waits on the count, not a fixed window, so a loaded machine cannot fail it
    await until(
      'three reads after the watch went inactive',
      () => reads >= count + 3,
    );
  } finally {
    jobs.close();
  }
});

test.skipIf(process.platform !== 'darwin')(
  'an app executable is excluded by its path, while a plain executable naming the same bundle stays a job',
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
          `perl -e 'setpgrp(0, 0); exec @ARGV' "$0" -e "require('fs').writeFileSync('${name}', String(process.pid)); setTimeout(() => {}, 60000)" "$1" witch-jobs-fixture-${name} &`,
          executable,
          join(bundle, 'Code'),
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

for (const service of [undefined, 'application.com.witch-test.host.1']) {
  test(`orphans from another app stay outside jobs when Witch's application service is ${service ?? 'absent'}`, async () => {
    const directory = await scratch('witch-jobs-');

    const services = new Map([
      [100951, 'application.com.witch-test.editor.2'],
      [100952, undefined],
      [100953, '0'],
      [100955, '0'],
      ...(service ? [[100954, service] as const] : []),
    ]);

    let rows: Row[] = [];

    const environment = vi
      .spyOn(processes, 'ps')
      .mockImplementation(async (format, pids, options) => {
        assert.equal(format, 'pid=,command=');
        assert.equal(options?.environment, true);

        return pids!.map((pid) => {
          const application = services.get(pid);

          const argument =
            pid === 100955
              ? ' XPC_SERVICE_NAME=application.com.witch-test.argument'
              : '';

          return `${pid} node${argument} WITCH_JOBS=${directory}${application ? ` XPC_SERVICE_NAME=${application}` : ''}`;
        });
      });

    const jobs = new JobWatch({
      directory,
      interval: 60_000,
      processes: async () => rows,
      describe: async (pids) =>
        pids.map((pid) => ({
          pid,
          pgid: pid,
          cpu: 0,
          startedAt: 0,
          command: 'node',
        })),
      executables: async (pids) =>
        new Map(pids.map((pid) => [pid, '/usr/local/bin/node'])),
    });

    const original = process.env.XPC_SERVICE_NAME;

    if (service === undefined) delete process.env.XPC_SERVICE_NAME;
    else process.env.XPC_SERVICE_NAME = service;

    try {
      await jobs.list();
      rows = [...services.keys()].map(orphanRow);

      assert.deepEqual(
        (await jobs.list()).map(({ group }) => group),
        service ? [100952, 100953, 100955, 100954] : [100952, 100953, 100955],
      );
    } finally {
      if (original === undefined) delete process.env.XPC_SERVICE_NAME;
      else process.env.XPC_SERVICE_NAME = original;

      jobs.close();
      environment.mockRestore();
    }
  });
}
