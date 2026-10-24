import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { partitionTests, testWorkers } from './test-suite.js';

const files = (await readdir('test'))
  .filter((file) => file.endsWith('.test.ts'))
  .sort()
  .map((file) => `test/${file}`);
const selected = partitionTests(files);
const vitest = fileURLToPath(
  new URL('./vitest.mjs', import.meta.resolve('vitest/package.json')),
);

const commands = [[vitest, 'run', ...selected.vitest]];
if (selected.node.length)
  commands.push([
    '--import',
    './scripts/register.mjs',
    '--test',
    `--test-concurrency=${testWorkers}`,
    ...selected.node,
  ]);

for (const args of commands) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
