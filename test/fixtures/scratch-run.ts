import { existsSync } from 'node:fs';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { scratch } from './scratch.js';

// a test process for test/scratch.test.ts, which reads the `scratch <path>` lines it prints
const [mode, outside] = process.argv.slice(2);

const report = (directory: string) =>
  process.stdout.write(`scratch ${directory}\n`);

if (mode === 'hang') {
  const directory = await scratch('witch-killed-');
  await mkdir(join(directory, 'locked', 'inner'), { recursive: true });
  await writeFile(join(directory, 'locked', 'inner', 'f'), '');
  await chmod(join(directory, 'locked'), 0o000);
  await symlink(outside!, join(directory, 'link'));
  report(directory);
  setInterval(() => {}, 1000);
} else {
  let first = '';

  await test('makes two directories at once', async () => {
    const made = await Promise.all([scratch('witch-a-'), scratch('witch-b-')]);
    first = made[0];

    for (const directory of made) report(directory);
  });

  await test('makes another after the first test has ended, then fails', async () => {
    await delay(50);

    if (!existsSync(first)) throw new Error('removed early');

    report(await scratch('witch-c-'));

    throw new Error('fails on purpose');
  });
}
