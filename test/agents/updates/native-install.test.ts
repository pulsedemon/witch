import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { scratch } from '../../fixtures/scratch.js';
import { until } from '../../fixtures/within.js';

const execute = promisify(execFile);

test('Claude installation preserves native argument ordering and retains installer diagnostics', async () => {
  const directory = await scratch('native-installer-');
  const home = join(directory, 'home');
  const root = join(home, '.local/share/claude');
  const executable = join(root, 'versions', '1.0.0');
  const launcher = join(home, '.local/bin/claude');
  const operation = join(directory, 'operation');
  const shell = join(directory, 'user-shell');
  await mkdir(dirname(executable), { recursive: true });
  await mkdir(dirname(launcher), { recursive: true });
  await mkdir(operation);

  await writeFile(
    shell,
    '#!/bin/sh\nprintf touched > shell-read\nexec /bin/sh "$@"\n',
    { mode: 0o700 },
  );

  await writeFile(
    executable,
    '#!/bin/sh\nprintf "%s\\n" "$@" > arguments\nprintf "%s\\n" "$TMPDIR" > temporary\nprintf "native-install-output\\n"\n',
  );

  await chmod(executable, 0o700);
  await symlink(executable, launcher);
  const installation = join(directory, 'installation.json');

  await writeFile(
    installation,
    JSON.stringify({
      runtime: 'claude',
      root,
      launcher,
      executable,
      version: '1.0.0',
    }),
  );

  const run = (target = '2.0.0', timeout = 10000) =>
    execute(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        new URL('../../fixtures/native-install.mjs', import.meta.url).pathname,
        installation,
        operation,
        target,
        String(timeout),
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          HOME: home,
          ZDOTDIR: join(home, 'zsh'),
          SHELL: shell,
        },
      },
    );

  await run();

  await assert.rejects(access(join(operation, 'shell-read')), {
    code: 'ENOENT',
  });

  assert.deepEqual(
    (await readFile(join(operation, 'arguments'), 'utf8')).trim().split('\n'),
    ['--settings', '{"disableAllHooks":true}', 'install', '2.0.0'],
  );

  assert.equal(
    (await readFile(join(operation, 'temporary'), 'utf8')).trim(),
    join(operation, 'tmp'),
  );

  assert.match(
    await readFile(join(operation, 'claude-2.0.0-install.log'), 'utf8'),
    /native-install-output/,
  );

  await run('1.0.0');

  assert.deepEqual(
    (await readFile(join(operation, 'arguments'), 'utf8')).trim().split('\n'),
    ['--settings', '{"disableAllHooks":true}', 'install', '1.0.0', '--force'],
  );

  await writeFile(
    executable,
    '#!/bin/sh\nprintf "specific native failure\\n" >&2\nexit 17\n',
  );

  await assert.rejects(
    run(),
    /exited 17[\s\S]*specific native failure[\s\S]*Installer log:/,
  );

  await writeFile(
    executable,
    `#!/bin/sh\nprintf 'early recovery diagnostic\n${'x'.repeat(6500)}\nlast failure line\n'\nexit 17\n`,
  );

  await assert.rejects(run('1.0.0'), (error: unknown) => {
    assert.match(String(error), /exited 17/);
    assert.doesNotMatch(String(error), /early recovery diagnostic/);

    return true;
  });

  await writeFile(
    executable,
    "#!/bin/sh\nprintf 'recovery retry completed\n'\n",
  );

  await run('1.0.0');

  const retained = await readFile(
    join(operation, 'claude-1.0.0-install.log'),
    'utf8',
  );

  assert.match(retained, /early recovery diagnostic/);
  assert.match(retained, /recovery retry completed/);

  await writeFile(
    executable,
    '#!/bin/sh\nsleep 10 &\nprintf "%s" "$!" > child-pid\nprintf "installer waiting\\n"\nwait\n',
  );

  await assert.rejects(
    run('2.0.0', 150),
    /interrupted[\s\S]*installer waiting/,
  );

  const child = Number(await readFile(join(operation, 'child-pid'), 'utf8'));

  await until('installer descendants stopped', () => {
    try {
      process.kill(child, 0);

      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  });

  await mkdir(join(home, 'zsh'));
  await writeFile(join(home, 'zsh/.zshrc'), 'alias claude="legacy-claude"\n');
  await assert.rejects(run(), /would edit.*\.zshrc/);

  assert.equal(
    await readFile(join(home, 'zsh/.zshrc'), 'utf8'),
    'alias claude="legacy-claude"\n',
  );
});
