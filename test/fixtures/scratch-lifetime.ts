import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants, existsSync, writeSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runShell } from '../../src/agents/user-shell.js';
import { JobWatch } from '../../src/core/jobs.js';
import { instanceDirectory } from '../../src/persistence/instance.js';
import { writeJson } from '../../src/persistence/json.js';
import { openLocked } from '../../src/persistence/lock.js';
import { identifyProcess } from '../../src/persistence/process.js';
import { ScratchSpace } from '../../src/persistence/scratch.js';
import { until } from './within.js';

const [mode, parent, value] = process.argv.slice(2) as [string, string, string];
const deadline = setTimeout(() => process.exit(1), 30_000);
try {
  if (mode === 'worker' || mode === 'descendant') {
    while (!existsSync(join(parent, `release-${mode}`))) await delay(20);
    if (mode === 'worker') {
      const child = spawn(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          process.argv[1]!,
          'descendant',
          parent,
          value,
        ],
        { detached: true, stdio: 'ignore' },
      );
      child.unref();
      await writeFile(join(parent, 'descendant.pid'), String(child.pid));
    }
    await writeFile(join(parent, `${mode}.result`), await readFile(value));
  } else if (mode.startsWith('survivor')) {
    const resumed = mode === 'survivor-resumed';
    const space =
      mode === 'survivor-legacy'
        ? undefined
        : await ScratchSpace.open(join(parent, 'scratch'), {
            resume: resumed ? process.argv[5]! : undefined,
          });
    const directory =
      space?.directory ?? instanceDirectory(join(parent, 'scratch'));
    const jobs = new JobWatch({
      directory: instanceDirectory(join(parent, 'jobs')),
      interval: 60_000,
    });
    process.env.TMPDIR = directory;
    const marker = join(directory, 'marker');
    let worker = Number(process.argv[6]);
    let group = Number(process.argv[7]);
    try {
      if (!resumed) {
        await writeFile(marker, 'before restart');
        const words = [
          process.execPath,
          '--import',
          import.meta.resolve('tsx'),
          process.argv[1]!,
          'worker',
          parent,
          marker,
        ];
        const command = words
          .map((word) => `'${word.replaceAll("'", "'\\''")}'`)
          .join(' ');
        const result = await runShell(
          `${command} >/dev/null 2>&1 & printf '%s' "$!"`,
          {
            cwd: parent,
            env: jobs.environment,
            signal: new AbortController().signal,
            onOutput() {},
            onSpawn(pid) {
              group = pid;
              jobs.track(pid);
            },
          },
        );
        worker = Number(result.output);
        await writeFile(join(parent, 'worker.pid'), String(worker));
        await until('original worker listing', async () =>
          (await jobs.list()).some((job) => job.group === group),
        );
      }
      writeSync(
        1,
        `${JSON.stringify({ directory, worker, identity: await identifyProcess(process.pid) })}\n`,
      );
      const restarts = Number(value);
      jobs.close();
      if (restarts > 0) {
        await space?.close();
        process.execve!(
          process.execPath,
          [
            process.execPath,
            ...process.execArgv,
            process.argv[1]!,
            'survivor-resumed',
            parent,
            String(restarts - 1),
            directory,
            String(worker),
            String(group),
          ],
          process.env,
        );
      }
      if (!space) throw new Error('legacy fixture must restart');
      process.kill(worker, 0);
    } finally {
      jobs.close();
      await space?.close();
    }
  } else if (mode === 'hold-unowned') {
    const lock = await openLocked(
      parent,
      constants.O_RDONLY |
        constants.O_DIRECTORY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
    );
    try {
      await writeJson(join(parent, '.witch-scratch.json'), {
        version: 1,
        boot: value,
      });
      writeSync(1, `${parent}\n`);
      await once(process.stdin, 'data');
    } finally {
      await lock.close();
    }
  } else if (mode === 'hold') {
    const space = await ScratchSpace.open(parent, { boot: async () => value });
    try {
      await writeFile(join(space.directory, 'marker'), 'held');
      writeSync(1, `${space.directory}\n`);
      await once(process.stdin, 'data');
    } finally {
      await space.close();
    }
  } else {
    const space =
      mode === 'resumed'
        ? await ScratchSpace.open(parent, { resume: value })
        : mode === 'legacy'
          ? undefined
          : await ScratchSpace.open(parent);
    const directory = space?.directory ?? join(parent, String(process.pid));
    if (mode !== 'resumed') {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'marker'), 'before restart');
    }
    writeSync(
      1,
      `${JSON.stringify({
        directory,
        identity: await identifyProcess(process.pid),
      })}\n`,
    );
    await space?.close();
    if (mode !== 'resumed')
      process.execve!(
        process.execPath,
        [
          process.execPath,
          ...process.execArgv,
          process.argv[1]!,
          'resumed',
          parent,
          directory,
        ],
        process.env,
      );
  }
} finally {
  clearTimeout(deadline);
  process.stdin.pause();
}
