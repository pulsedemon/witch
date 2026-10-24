import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { vitestFiles } from '../scripts/test-suite.js';
import { scratch } from './fixtures/scratch.js';
import { within } from './fixtures/within.js';

const repository = fileURLToPath(new URL('../', import.meta.url));

function suite(runner: 'vitest' | 'node:test', label: string, failure = '') {
  return `import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from '${runner}';
test(${JSON.stringify(label)}, async () => {
  appendFileSync(process.env.MARKERS, ${JSON.stringify(`${label}:start\n`)});
  await delay(20);
  ${failure ? `assert.fail(${JSON.stringify(failure)});` : ''}
  appendFileSync(process.env.MARKERS, ${JSON.stringify(`${label}:end\n`)});
});
`;
}

async function fixture() {
  const root = await scratch('witch-test-runner-');
  for (const file of [
    'package.json',
    'babel.config.js',
    'vitest.config.ts',
    'scripts/test.ts',
    'scripts/test-suite.ts',
    'scripts/register.mjs',
    'test/fixtures/vitest-setup.ts',
    'test/fixtures/scratch.ts',
  ]) {
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(repository, file), target);
  }
  await symlink(join(repository, 'node_modules'), join(root, 'node_modules'));
  const tmp = join(root, 'tmp');
  await mkdir(tmp);
  for (const file of vitestFiles)
    await writeFile(join(root, file), suite('vitest', file));
  const markers = join(root, 'markers');
  const native = join(root, 'test/native.test.ts');
  await writeFile(native, suite('node:test', 'native'));
  return {
    root,
    native,
    async run() {
      await writeFile(markers, '');
      const child = spawn(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), 'scripts/test.ts'],
        {
          cwd: root,
          env: {
            ...process.env,
            NODE_TEST_CONTEXT: undefined,
            TMPDIR: tmp,
            MARKERS: markers,
          },
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
      const closed = once(child, 'close') as Promise<
        [number | null, NodeJS.Signals | null]
      >;
      try {
        const [code, signal] = await within(closed, 60_000, 'mixed runner');
        assert.equal(signal, null, output);
        return {
          code,
          output,
          markers: (await readFile(markers, 'utf8'))
            .split('\n')
            .filter(Boolean),
        };
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          process.kill(-child.pid!, 'SIGKILL');
        await closed;
      }
    },
  };
}

await test('the mixed runner executes each discovered file once, finishing Vitest before Node, and discovers newly added files', async () => {
  const f = await fixture();
  for (const added of [false, true]) {
    if (added)
      await writeFile(
        join(f.root, 'test/added.test.ts'),
        suite('node:test', 'added'),
      );
    const result = await f.run();
    assert.equal(result.code, 0, result.output);
    const migrated = vitestFiles.flatMap((file) => [
      `${file}:start`,
      `${file}:end`,
    ]);
    const native = added
      ? ['native:start', 'native:end', 'added:start', 'added:end']
      : ['native:start', 'native:end'];
    assert.deepEqual(
      [...result.markers].sort(),
      [...migrated, ...native].sort(),
    );
    assert.deepEqual(
      result.markers.slice(0, migrated.length).sort(),
      migrated.sort(),
    );
  }
});

for (const runner of ['vitest', 'node:test'] as const)
  await test(`a ${runner} assertion fails the mixed command without hiding its diagnostic`, async () => {
    const f = await fixture();
    const file = runner === 'vitest' ? join(f.root, vitestFiles[0]!) : f.native;
    await writeFile(file, suite(runner, 'failing', `${runner} sentinel`));
    const result = await f.run();
    assert.equal(result.code, 1, result.output);
    assert.ok(result.output.includes(`${runner} sentinel`), result.output);
    assert.equal(result.markers.includes('failing:end'), false);
    if (runner === 'vitest')
      assert.equal(result.markers.includes('native:start'), false);
    else
      for (const migrated of vitestFiles)
        assert.ok(result.markers.includes(`${migrated}:end`), result.output);
  });

await test('a missing migrated file fails before either runner can silently omit it', async () => {
  const f = await fixture();
  await rm(join(f.root, vitestFiles[0]!));
  const result = await f.run();
  assert.equal(result.code, 1, result.output);
  assert.ok(
    result.output.includes(`Missing migrated test files: ${vitestFiles[0]}`),
  );
  assert.deepEqual(result.markers, []);
});

await test('an empty Node complement does not rediscover migrated files or fixtures', async () => {
  const f = await fixture();
  await rm(f.native);
  const result = await f.run();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(
    result.markers.sort(),
    vitestFiles.flatMap((file) => [`${file}:start`, `${file}:end`]).sort(),
  );
});
