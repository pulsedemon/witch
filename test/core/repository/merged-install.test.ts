import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { chmod, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { quote } from '../../../src/shell.js';
import { runCommand } from '../../../src/core/repository/command.js';
import { cleanUpMerge } from '../../../src/core/repository/merged.js';
import { refreshInstall } from '../../../src/core/repository/install-refresh.js';
import type { Run } from '../../../src/core/repository/repository.js';
import { openLocked } from '../../../src/persistence/lock.js';
import { scratch } from '../../fixtures/scratch.js';
import { idle, merged, pullRequest, write } from '../../fixtures/merged.js';
import { git } from '../../fixtures/git.js';
import { exists, within } from '../../fixtures/within.js';
import {
  configureGitEnvironment,
  execute,
} from '../../fixtures/merged-environment.js';

configureGitEnvironment();

test('the install pulls, installs and builds when clean on the base, and stays put otherwise', async () => {
  const { root, origin, other } = await merged({ 'a.txt': 'a\n' });
  const install = join(root, 'install');
  await git(root, 'clone', origin, install);
  await git(other, 'commit', '--allow-empty', '-m', 'ahead');
  await git(other, 'push');
  const calls: [string, string[], { cwd: string; timeout: number }][] = [];

  const run = async (
    command: string,
    args: string[],
    options: { cwd: string; timeout: number },
  ) => {
    calls.push([command, args, options]);

    return { stdout: '' };
  };

  const head = await git(origin, 'rev-parse', 'main');

  assert.equal(
    await refreshInstall(install, 'main', run),
    `Rebuilt Witch at ${head.slice(0, 7)}, for its next start.`,
  );

  assert.equal(await git(install, 'rev-parse', 'HEAD'), head);

  assert.deepEqual(calls, [
    [
      'pnpm',
      ['install', '--frozen-lockfile'],
      { cwd: install, timeout: 300_000 },
    ],
    ['pnpm', ['build'], { cwd: install, timeout: 300_000 }],
  ]);

  const kept = `Witch's checkout at ${install} isn't clean on main, so it wasn't rebuilt.`;
  await writeFile(join(install, 'a.txt'), 'changed\n');
  assert.equal(await refreshInstall(install, 'main', run), kept);
  await git(install, 'checkout', '--', 'a.txt');
  await git(install, 'switch', '-c', 'elsewhere');
  assert.equal(await refreshInstall(install, 'main', run), kept);
  assert.equal(calls.length, 2);
  assert.equal(await git(install, 'rev-parse', 'HEAD'), head);
  await git(install, 'switch', 'main');

  assert.equal(
    await refreshInstall(install, 'main', run),
    `Rebuilt Witch at ${head.slice(0, 7)}, for its next start.`,
  );

  assert.deepEqual(calls.slice(2), [
    [
      'pnpm',
      ['install', '--frozen-lockfile'],
      { cwd: install, timeout: 300_000 },
    ],
    ['pnpm', ['build'], { cwd: install, timeout: 300_000 }],
  ]);
});

test('a busy install is skipped before fetching', async () => {
  const { root, origin } = await merged();
  const install = join(root, 'install');
  await git(root, 'clone', origin, install);
  const fetchMarker = join(root, 'fetches');
  const pack = join(root, 'upload-pack');

  await write(
    pack,
    `#!/bin/sh\nprintf 'fetch\\n' >> '${fetchMarker}'\nexec git upload-pack "$@"\n`,
  );

  await chmod(pack, 0o755);
  await git(install, 'config', 'remote.origin.uploadpack', pack);

  const lock = await openLocked(
    join(install, '.git'),
    constants.O_RDONLY | constants.O_NONBLOCK,
  );

  const calls: string[][] = [];

  try {
    const result = await within(
      refreshInstall(install, 'main', async (_, args) => {
        calls.push(args);

        return { stdout: '' };
      }),
      5000,
      'the busy install',
    );

    assert.equal(
      result,
      `Witch's checkout at ${install} is busy, so it wasn't rebuilt.`,
    );

    assert.deepEqual(calls, []);
    assert.equal(await exists(fetchMarker), false);
  } finally {
    await lock.close();
  }
});

test('an install stays locked through install and build, aliases share it, and another install can refresh', async () => {
  const { root, origin } = await merged();
  const install = join(root, 'install');
  const independent = join(root, 'independent');
  const alias = join(root, 'alias');
  await git(root, 'clone', origin, install);
  await git(root, 'clone', origin, independent);
  await symlink(install, alias);
  const head = await git(origin, 'rev-parse', 'main');
  const rebuilt = `Rebuilt Witch at ${head.slice(0, 7)}, for its next start.`;
  const request = { ...pullRequest(head), branch: 'main' };

  const gates = {
    install: {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    },
    build: {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    },
  };

  const leaderCalls: string[][] = [];

  const refreshing = refreshInstall(install, 'main', async (_, args) => {
    leaderCalls.push(args);
    const gate = args[0] === 'install' ? gates.install : gates.build;
    gate.entered.resolve();
    await gate.release.promise;

    return { stdout: '' };
  });

  void refreshing.catch(() => {});
  const calls: string[][] = [];
  const contenders: Promise<string>[] = [];

  const run: Run = async (_, args) => {
    calls.push(args);

    return { stdout: '' };
  };

  try {
    for (const [stage, target] of [
      ['install', alias],
      ['build', install],
    ] as const) {
      await within(gates[stage].entered.promise, 5000, `the held ${stage}`);
      const waiting = Promise.withResolvers<void>();

      const contender = refreshInstall(target, 'main', run, {
        notice: () => waiting.resolve(),
      });

      void contender.catch(() => {});
      contenders.push(contender);
      await within(waiting.promise, 5000, 'the waiting contender');
      assert.deepEqual(calls, []);
      assert.equal(await cleanUpMerge(install, request, idle), undefined);

      if (stage === 'install') {
        const independentCalls: string[][] = [];

        assert.equal(
          await within(
            refreshInstall(independent, 'main', async (_, args) => {
              independentCalls.push(args);

              return { stdout: '' };
            }),
            5000,
            'the independent install',
          ),
          rebuilt,
        );

        assert.equal(await git(independent, 'rev-parse', 'HEAD'), head);

        assert.deepEqual(independentCalls, [
          ['install', '--frozen-lockfile'],
          ['build'],
        ]);
      }

      gates[stage].release.resolve();
    }

    assert.equal(await refreshing, rebuilt);
    assert.deepEqual(await Promise.all(contenders), [rebuilt, rebuilt]);

    assert.deepEqual(leaderCalls, [
      ['install', '--frozen-lockfile'],
      ['build'],
    ]);

    assert.deepEqual(await cleanUpMerge(install, request, idle), {
      text: '#7 merged, but main is still on its remote, so it stays.',
      cleaned: false,
    });

    assert.equal(await refreshInstall(install, 'main', run), rebuilt);
    assert.deepEqual(calls, [['install', '--frozen-lockfile'], ['build']]);
  } finally {
    gates.install.release.resolve();
    gates.build.release.resolve();
    await refreshing;
    await Promise.allSettled(contenders);
  }
});

test('an install stays locked through revision reporting and releases on success or failure', async () => {
  const { root, origin } = await merged();
  const install = join(root, 'install');
  await git(root, 'clone', origin, install);
  const head = await git(origin, 'rev-parse', '--short', 'main');
  const directory = join(install, '.git');
  const marker = join(root, 'revision-lock');
  const bin = join(root, 'bin');
  const realGit = (await execute('/usr/bin/which', ['git'])).stdout.trim();
  const previousPath = process.env.PATH;

  for (const failing of [false, true]) {
    await write(
      join(bin, 'git'),
      `#!/bin/sh
exec ${[
        process.execPath,
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(
          new URL('../../fixtures/revision-lock.mts', import.meta.url),
        ),
        directory,
        marker,
        realGit,
        String(failing),
      ]
        .map(quote)
        .join(' ')} "$@"
`,
    );

    await chmod(join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${previousPath}`;

    try {
      const result = refreshInstall(install, 'main', async () => ({
        stdout: '',
      }));

      if (failing)
        await assert.rejects(result, (error: unknown) => {
          assert.ok(error instanceof Error);

          assert.ok(
            error.message.startsWith(
              `Witch's checkout at ${install} wasn't rebuilt:`,
            ),
          );

          assert.match(error.message, /revision unavailable/);
          assert.equal((error.cause as { code: number }).code, 23);

          return true;
        });
      else
        assert.equal(
          await result,
          `Rebuilt Witch at ${head}, for its next start.`,
        );

      assert.equal(await readFile(marker, 'utf8'), 'EAGAIN');

      const lock = await openLocked(
        directory,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );

      await lock.close();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }
});

test('an install lock lookup failure keeps the install context', async () => {
  const install = await scratch('witch-invalid-install-');
  const calls: string[][] = [];

  await assert.rejects(
    refreshInstall(install, 'main', async (_, args) => {
      calls.push(args);

      return { stdout: '' };
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);

      assert.ok(
        error.message.startsWith(
          `Witch's checkout at ${install} wasn't rebuilt:`,
        ),
      );

      return true;
    },
  );

  assert.deepEqual(calls, []);
});

test('an install lock open failure keeps its cause and install context', async () => {
  const { root, origin } = await merged();
  const install = join(root, 'install');
  await git(root, 'clone', origin, install);
  const directory = join(install, '.git');
  const calls: string[][] = [];
  await chmod(directory, 0o111);

  try {
    await assert.rejects(
      refreshInstall(install, 'main', async (_, args) => {
        calls.push(args);

        return { stdout: '' };
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);

        assert.ok(
          error.message.startsWith(
            `Witch's checkout at ${install} wasn't rebuilt:`,
          ),
        );

        assert.equal((error.cause as NodeJS.ErrnoException).code, 'EACCES');

        return true;
      },
    );

    assert.deepEqual(calls, []);
  } finally {
    await chmod(directory, 0o755);
  }
});

test("a failed rebuild names the install and keeps tsc's errors", async () => {
  const { root, origin } = await merged();
  const install = join(root, 'install');
  await git(root, 'clone', origin, install);

  const run = async (_: string, args: string[]) => {
    if (args[0] !== 'build') return { stdout: '' };

    // as execFile rejects, with the command's stdout beside the message
    throw Object.assign(new Error('Command failed: pnpm build\n'), {
      stdout:
        "src/a.ts(1,7): error TS2322: Type 'number' is not assignable to type 'string'.\n",
    });
  };

  await assert.rejects(refreshInstall(install, 'main', run), {
    message: `Witch's checkout at ${install} wasn't rebuilt: Command failed: pnpm build\nsrc/a.ts(1,7): error TS2322: Type 'number' is not assignable to type 'string'.`,
  });

  await assert.rejects(
    refreshInstall(install, 'main', (_, args, options) =>
      args[0] === 'build'
        ? runCommand(
            process.execPath,
            [
              '-e',
              "process.stdout.write('build stdout'); process.stderr.write('build stderr'); setTimeout(() => process.exit(29), 10000)",
            ],
            { ...options, timeout: 1500 },
          )
        : Promise.resolve({ stdout: '' }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);

      assert.ok(
        error.message.startsWith(
          `Witch's checkout at ${install} wasn't rebuilt: Timed out after 1500 ms: Command failed:`,
        ),
      );

      assert.match(error.message, /build stderr\nbuild stdout$/);
      assert.equal((error.cause as { killed: boolean }).killed, true);

      return true;
    },
  );

  const head = await git(origin, 'rev-parse', 'main');
  const calls: string[][] = [];

  assert.equal(
    await refreshInstall(install, 'main', async (_, args) => {
      calls.push(args);

      return { stdout: '' };
    }),
    `Rebuilt Witch at ${head.slice(0, 7)}, for its next start.`,
  );

  assert.deepEqual(calls, [['install', '--frozen-lockfile'], ['build']]);
});

test("an edit made during the install's fetch keeps it from being pulled and built", async () => {
  const { root, origin, other } = await merged({ 'a.txt': 'a\n' });
  const install = join(root, 'install');
  await git(root, 'clone', origin, install);
  const head = await git(install, 'rev-parse', 'HEAD');
  await git(other, 'commit', '--allow-empty', '-m', 'ahead');
  await git(other, 'push');
  // runs in the fetch, as an edit from another terminal could
  const pack = join(root, 'upload-pack');

  await write(
    pack,
    `#!/bin/sh\necho edited > '${install}/a.txt'\nexec git upload-pack "$@"\n`,
  );

  await execute('chmod', ['+x', pack]);
  await git(install, 'config', 'remote.origin.uploadpack', pack);
  const calls: string[][] = [];

  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args]);

    return { stdout: '' };
  };

  assert.equal(
    await refreshInstall(install, 'main', run),
    `Witch's checkout at ${install} isn't clean on main, so it wasn't rebuilt.`,
  );

  assert.deepEqual(calls, []);
  assert.equal(await git(install, 'rev-parse', 'HEAD'), head);
});

test('a branch switched to during the install fetch is left as it was and skips rebuilding', async () => {
  const { root, origin, other } = await merged();
  const install = join(root, 'install');
  await git(root, 'clone', origin, install);
  await git(install, 'branch', '--track', 'elsewhere', 'origin/main');
  const before = await git(install, 'rev-parse', 'HEAD');
  await git(other, 'commit', '--allow-empty', '-m', 'ahead');
  await git(other, 'push');
  const pack = join(root, 'upload-pack');

  await write(
    pack,
    `#!/bin/sh\ngit -C ${quote(install)} switch -q elsewhere\nexec git upload-pack "$@"\n`,
  );

  await chmod(pack, 0o755);
  await git(install, 'config', 'remote.origin.uploadpack', pack);
  const calls: string[][] = [];

  const result = await refreshInstall(
    install,
    'main',
    async (command, args) => {
      calls.push([command, ...args]);

      return { stdout: '' };
    },
  );

  assert.equal(
    result,
    `Witch's checkout at ${install} isn't clean on main, so it wasn't rebuilt.`,
  );

  assert.deepEqual(calls, []);
  assert.equal(await git(install, 'branch', '--show-current'), 'elsewhere');

  for (const ref of ['HEAD', 'main'])
    assert.equal(await git(install, 'rev-parse', ref), before);
});

test("an ignored file the install's incoming commits would start tracking stops its rebuild before overwriting it", async () => {
  const { root, origin, other } = await merged({}, ['secret.txt']);
  const install = join(root, 'install');
  await git(root, 'clone', origin, install);
  const head = await git(install, 'rev-parse', 'HEAD');
  await writeFile(join(other, 'secret.txt'), 'theirs');
  await git(other, 'add', '-f', 'secret.txt');
  await git(other, 'commit', '-m', 'secret');
  await git(other, 'push');
  await writeFile(join(install, 'secret.txt'), 'mine');
  const calls: string[][] = [];

  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args]);

    return { stdout: '' };
  };

  await assert.rejects(refreshInstall(install, 'main', run));
  assert.equal(await readFile(join(install, 'secret.txt'), 'utf8'), 'mine');
  assert.deepEqual(calls, []);
  assert.equal(await git(install, 'rev-parse', 'HEAD'), head);
});
