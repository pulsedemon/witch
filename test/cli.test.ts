import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scratch } from './fixtures/scratch.js';

const cli = fileURLToPath(new URL('../src/cli.tsx', import.meta.url));

/** runs the CLI in an empty directory that is also its HOME, so a store opened at the default ~/.witch shows in `files`. */
async function run(args: readonly string[]) {
  const directory = await scratch('witch-cli-');
  const child = spawn(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), cli, ...args],
    {
      cwd: directory,
      env: { ...process.env, HOME: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = await once(child, 'close');
  return { code, stdout, stderr, files: await readdir(directory) };
}

for (const [args, expected] of [
  [['--state-dir'], /--state-dir/],
  [['--state-dir', ''], /--state-dir/],
  [['--state-dir', '--continue'], /--state-dir/],
  [['-v'], /^witch: Unknown option '-v'/],
  [['hi'], /^witch: Witch needs an interactive terminal\.\n$/],
] as const) {
  await test(`witch ${JSON.stringify(args)} exits 1 with a one-line error before opening the store`, async () => {
    const { code, stderr, files } = await run(args);
    assert.equal(code, 1);
    assert.match(stderr, /^witch: /);
    assert.match(stderr, expected);
    assert.doesNotMatch(stderr, /\n\s+at /);
    assert.deepEqual(files, []);
  });
}

await test('witch --help with stdout piped prints the usage and exits 0 before opening the store', async () => {
  const { code, stdout, files } = await run(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /^Usage: witch /);
  assert.deepEqual(files, []);
});
