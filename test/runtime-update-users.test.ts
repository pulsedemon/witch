import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { runtimeUpdateUsers } from '../src/core/runtime-update-users.js';
import { scratch } from './fixtures/scratch.js';
import { until } from './fixtures/within.js';

test('process inspection distinguishes old Witch, participating Witch and an installer helper', async () => {
  const directory = await scratch('runtime-users-');
  const state = join(directory, 'admission');
  const root = join(directory, 'native');
  const entry = join(directory, 'src', 'cli.tsx');
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    '{"name":"witch","type":"module"}',
  );
  await writeFile(
    entry,
    `import {registerNativeParticipant} from ${JSON.stringify(new URL('../src/agents/native-launch.ts', import.meta.url).href)};
let release;
process.stdin.on('data', () => { release = registerNativeParticipant(process.argv[2]); console.log('registered'); });
process.stdin.on('end', () => release?.());
console.log('ready');
`,
  );
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      'src/cli.tsx',
      state,
      '--',
      '--help',
    ],
    { stdio: 'pipe', cwd: directory },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  const ended = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  try {
    await until('old Witch fixture', () => output.includes('ready'));
    const own = async () =>
      (await runtimeUpdateUsers(root, state)).filter(
        ({ pid }) => pid === child.pid,
      );
    assert.match((await own())[0]!.reason, /does not participate/);
    await mkdir(join(state, 'participants'), { recursive: true });
    await writeFile(join(state, 'participants', `${child.pid}.json`), '{}');
    assert.equal(
      (await own()).length,
      1,
      'an unlocked stale participant file cannot admit the old process',
    );
    child.stdin.write('register\n');
    await until('registered Witch fixture', () =>
      output.includes('registered'),
    );
    assert.deepEqual(await own(), []);
    const native = await runtimeUpdateUsers(dirname(process.execPath), state);
    assert.ok(
      native.some(
        ({ pid, reason }) =>
          pid === child.pid && reason === 'Native installation is in use',
      ),
    );
    child.stdin.end();
    assert.equal(await ended, 0);
    assert.deepEqual(await own(), []);
  } finally {
    child.kill('SIGKILL');
    await ended.catch(() => {});
  }
  const helper = spawn(
    process.execPath,
    [
      '-e',
      'process.stdin.resume()',
      join(state, 'operations', 'pending', 'install.sh'),
    ],
    { stdio: 'pipe' },
  );
  const helperEnded = new Promise<number | null>((resolve, reject) => {
    helper.once('error', reject);
    helper.once('close', resolve);
  });
  try {
    await until('installer helper', async () =>
      (await runtimeUpdateUsers(root, state)).some(
        ({ pid, reason }) => pid === helper.pid && reason.includes('helper'),
      ),
    );
  } finally {
    helper.stdin.end();
    await helperEnded;
  }
});
