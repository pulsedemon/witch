import assert from 'node:assert/strict';

import { spawn } from 'node:child_process';

import { once } from 'node:events';

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

import { join } from 'node:path';

import { test } from 'vitest';

import { fileURLToPath } from 'node:url';

import { scratch } from './fixtures/scratch.js';

const instance = fileURLToPath(
  new URL('../src/persistence/instance.ts', import.meta.url),
);

test("an instance directory goes when its process exits, read-only contents included, and so do those of processes that are gone or of an earlier process with its pid, while live and unprobeable processes' directories stay", async () => {
  const parent = await scratch('witch-instance-');

  const exited = spawn('/usr/bin/true');

  await once(exited, 'exit');

  await mkdir(join(parent, String(exited.pid)));

  await mkdir(join(parent, String(process.pid)));

  await mkdir(join(parent, 'notes'));

  await mkdir(join(parent, '100001'));

  await writeFile(join(parent, '100001', 'marker'), 'kept');

  const script = `
    import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { instanceDirectory } from ${JSON.stringify(instance)};
    // what the process this one replaced with execve left
    mkdirSync(join(${JSON.stringify(parent)}, String(process.pid), 'stale'), { recursive: true });
    const kill = process.kill.bind(process);
    process.kill = (pid, signal) => {
      if (pid === 100001) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return kill(pid, signal);
    };
    const directory = instanceDirectory(${JSON.stringify(parent)});
    if (existsSync(join(directory, 'stale'))) throw new Error('stale');
    mkdirSync(join(directory, 'locked'));
    writeFileSync(join(directory, 'locked', 'file'), 'x');
    chmodSync(join(directory, 'locked'), 0o500);
    console.log(directory);
  `;

  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '--eval',
      script,
    ],
    {
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );

  let stdout = '';

  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  const [code] = await once(child, 'close');

  assert.equal(code, 0);

  assert.equal(stdout.trim(), join(parent, String(child.pid)));

  assert.deepEqual(
    (await readdir(parent)).sort(),
    ['100001', String(process.pid), 'notes'].sort(),
  );

  assert.equal(
    await readFile(join(parent, '100001', 'marker'), 'utf8'),
    'kept',
  );
});
