import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.tsx', import.meta.url));

for (const [args, expected] of [
  [['--state-dir'], /--state-dir/],
  [['--state-dir', ''], /--state-dir/],
  [['--state-dir', '--continue'], /--state-dir/],
  [['-v'], /^witch: Unknown option '-v'/],
] as const) {
  await test(`witch ${JSON.stringify(args)} exits 1 with a one-line error before opening the store`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'witch-cli-'));
    const child = spawn(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), cli, ...args],
      { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let error = '';
    child.stderr.on('data', (chunk: Buffer) => {
      error += chunk.toString();
    });
    const [code] = await once(child, 'close');
    assert.equal(code, 1);
    assert.match(error, /^witch: /);
    assert.match(error, expected);
    assert.doesNotMatch(error, /\n\s+at /);
    assert.doesNotMatch(error, /interactive terminal/);
    assert.deepEqual(await readdir(directory), []);
  });
}
