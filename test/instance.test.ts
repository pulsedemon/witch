import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scratch } from './fixtures/scratch.js';

const instance = fileURLToPath(
  new URL('../src/persistence/instance.ts', import.meta.url),
);

await test("an instance directory goes when its process exits, read-only contents included, and so do those of processes that are gone, while a live process's stays", async () => {
  const parent = await scratch('witch-instance-');
  const exited = spawn('/usr/bin/true');
  await once(exited, 'exit');
  await mkdir(join(parent, String(exited.pid)));
  await mkdir(join(parent, String(process.pid)));
  await mkdir(join(parent, 'notes'));
  const script = `
    import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { instanceDirectory } from ${JSON.stringify(instance)};
    const directory = instanceDirectory(${JSON.stringify(parent)});
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
  assert.deepEqual((await readdir(parent)).sort(), [
    String(process.pid),
    'notes',
  ]);
});
