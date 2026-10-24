import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { vitestFiles } from '../scripts/test-suite.js';
import { scratch } from './fixtures/scratch.js';
import { until, within } from './fixtures/within.js';

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

async function fixture(sharedTmp?: string) {
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
    'test/fixtures/cleanup.ts',
  ]) {
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(repository, file), target);
  }
  await symlink(join(repository, 'node_modules'), join(root, 'node_modules'));
  const tmp = sharedTmp ?? join(root, 'tmp');
  await mkdir(tmp, { recursive: true });
  for (const file of vitestFiles)
    await writeFile(join(root, file), suite('vitest', file));
  const markers = join(root, 'markers');
  await writeFile(markers, '');
  const native = join(root, 'test/native.test.ts');
  await writeFile(native, suite('node:test', 'native'));
  return {
    root,
    native,
    tmp,
    markers,
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

test('the mixed runner executes each discovered file once, finishing Vitest before Node, and discovers newly added files', async () => {
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
  test(`a ${runner} assertion fails the mixed command without hiding its diagnostic`, async () => {
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

test('a missing migrated file fails before either runner can silently omit it', async () => {
  const f = await fixture();
  await rm(join(f.root, vitestFiles[0]!));
  const result = await f.run();
  assert.equal(result.code, 1, result.output);
  assert.ok(
    result.output.includes(`Missing migrated test files: ${vitestFiles[0]}`),
  );
  assert.deepEqual(result.markers, []);
});

test('an empty Node complement does not rediscover migrated files or fixtures', async () => {
  const f = await fixture();
  await rm(f.native);
  const result = await f.run();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(
    result.markers.sort(),
    vitestFiles.flatMap((file) => [`${file}:start`, `${file}:end`]).sort(),
  );
});

for (const failure of [false, true])
  test(`Vitest removes a ${failure ? 'failing' : 'passing'} file's scratch after its last case`, async () => {
    const f = await fixture();
    await writeFile(
      join(f.root, vitestFiles[0]!),
      `import assert from 'node:assert/strict';
import { appendFileSync, existsSync } from 'node:fs';
import { test } from 'vitest';
import { scratch } from './fixtures/scratch.js';
const report = path => appendFileSync(process.env.MARKERS, 'scratch:' + path + '\\n');
let first;
test('first allocations survive the case', async () => {
  const paths = await Promise.all([scratch('a-'), scratch('b-')]);
  first = paths[0];
  paths.forEach(report);
});
test('later case retains earlier scratch', async () => {
  assert.equal(existsSync(first), true);
  report(await scratch('c-'));
  ${failure ? "assert.fail('scratch failure sentinel');" : ''}
});
`,
    );
    const result = await f.run();
    assert.equal(result.code, failure ? 1 : 0, result.output);
    if (failure) assert.ok(result.output.includes('scratch failure sentinel'));
    const paths = result.markers
      .filter((line) => line.startsWith('scratch:'))
      .map((line) => line.slice('scratch:'.length));
    assert.equal(paths.length, 3, result.output);
    assert.equal(new Set(paths).size, 3);
    assert.equal(new Set(paths.map((path) => dirname(path))).size, 1);
    assert.equal(existsSync(dirname(paths[0]!)), false);
  });

test('a later Vitest run recovers killed-worker scratch while another live run retains its files', async () => {
  const killed = await fixture();
  const live = await fixture(killed.tmp);
  const recovery = await fixture(killed.tmp);
  const held = `import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import { scratch } from './fixtures/scratch.js';
test('holds scratch until released', async () => {
  const directory = await scratch('held-');
  appendFileSync(process.env.MARKERS, 'held:' + JSON.stringify({directory, pid: process.pid}) + '\\n');
  while (!existsSync('release')) await delay(20);
});
`;
  for (const f of [killed, live])
    await writeFile(join(f.root, vitestFiles[0]!), held);
  const owner = async (f: typeof killed) => {
    let value: { directory: string; pid: number } | undefined;
    await until('held Vitest scratch', async () => {
      const line = (await readFile(f.markers, 'utf8'))
        .split('\n')
        .find((line) => line.startsWith('held:'));
      if (line) value = JSON.parse(line.slice('held:'.length)) as typeof value;
      return value !== undefined;
    });
    return value!;
  };
  let dying: ReturnType<typeof killed.run> | undefined;
  let surviving: ReturnType<typeof live.run> | undefined;
  try {
    dying = killed.run();
    const dead = await owner(killed);
    surviving = live.run();
    const survivor = await owner(live);
    process.kill(dead.pid, 'SIGKILL');
    const failed = await dying;
    assert.equal(failed.code, 1, failed.output);
    assert.equal(existsSync(dead.directory), true);
    assert.equal(existsSync(survivor.directory), true);
    await writeFile(
      join(recovery.root, vitestFiles[0]!),
      `import { test } from 'vitest';
import { scratch } from './fixtures/scratch.js';
test('recovers a dead worker', async () => { await scratch('next-'); });
`,
    );
    const recovered = await recovery.run();
    assert.equal(recovered.code, 0, recovered.output);
    assert.equal(existsSync(dirname(dead.directory)), false);
    assert.equal(existsSync(survivor.directory), true);
    await writeFile(join(live.root, 'release'), 'release');
    const finished = await surviving;
    assert.equal(finished.code, 0, finished.output);
    assert.equal(existsSync(dirname(survivor.directory)), false);
  } finally {
    for (const f of [killed, live])
      await writeFile(join(f.root, 'release'), 'release');
    await Promise.allSettled([dying, surviving]);
  }
});

for (const failure of [false, true])
  test(`setup restores clocks and spies after resource cleanup in a ${failure ? 'failing' : 'passing'} case`, async () => {
    const f = await fixture();
    await writeFile(
      join(f.root, vitestFiles[0]!),
      `import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { test, vi } from 'vitest';
const realDate = Date;
const target = { value: () => 'original' };
const report = value => appendFileSync(process.env.MARKERS, 'setup:' + JSON.stringify(value) + '\\n');
test('resource cleanup retains its mock state', async context => {
  vi.useFakeTimers({ toFake: ['Date'], now: 1000 });
  vi.spyOn(target, 'value').mockReturnValue('mocked');
  context.onTestFinished(() => report({phase:'resource', value:target.value(), now:Date.now()}));
  await new Promise(resolve => setTimeout(resolve, 10));
  ${failure ? "assert.fail('setup failure sentinel');" : ''}
});
test('the following case sees restored state', () => report({phase:'next', value:target.value(), sameDate:Date===realDate}));
`,
    );
    const result = await f.run();
    assert.equal(result.code, failure ? 1 : 0, result.output);
    if (failure) assert.ok(result.output.includes('setup failure sentinel'));
    assert.deepEqual(
      result.markers
        .filter((line) => line.startsWith('setup:'))
        .map((line) => JSON.parse(line.slice('setup:'.length)) as unknown),
      [
        { phase: 'resource', value: 'mocked', now: 1000 },
        { phase: 'next', value: 'original', sameDate: true },
      ],
    );
  });

for (const [clock, toFake] of [
  ['Date', ['Date']],
  ['timeouts', ['setTimeout', 'clearTimeout']],
  ['intervals', ['setInterval', 'clearInterval']],
] as const)
  for (const failure of [false, true])
    test(`ordered cleanup restores ${clock} after a ${failure ? 'failing' : 'passing'} case`, async () => {
      const f = await fixture();
      await writeFile(
        join(f.root, vitestFiles[0]!),
        `import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { test, vi } from 'vitest';
import { orderedCleanup } from './fixtures/cleanup.js';
const original = { Date, setTimeout, clearTimeout, setInterval, clearInterval };
const target = { value: () => 'original' };
const report = value => appendFileSync(process.env.MARKERS, 'ordered:' + JSON.stringify(value) + '\\n');
test('dependent resources close before restoration', context => {
  const cleanup = orderedCleanup(context.onTestFinished);
  vi.useFakeTimers({ toFake: ${JSON.stringify(toFake)}, now: 1000 });
  vi.spyOn(target, 'value').mockReturnValue('mocked');
  let firstClosed = false;
  let callbacks = 0;
  ${clock === 'Date' ? '' : `const timer = ${clock === 'timeouts' ? 'setTimeout' : 'setInterval'}(() => callbacks++, 20);`}
  cleanup(async () => {
    await new Promise(resolve => original.setTimeout(resolve, 10));
    firstClosed = true;
    report({ phase: 'first', value: target.value() });
  });
  cleanup(async () => {
    await new Promise(resolve => original.setTimeout(resolve, 10));
    assert.equal(firstClosed, true, 'first resource must finish before the dependent release');
    ${clock === 'Date' ? '' : `${clock === 'timeouts' ? 'clearTimeout' : 'clearInterval'}(timer);`}
    vi.advanceTimersByTime(100);
    report({ phase: 'second', value: target.value(), callbacks });
  });
  ${failure ? "assert.fail('ordered cleanup sentinel');" : ''}
});
test('the following case sees restored globals', () => {
  for (const [name, value] of Object.entries(original)) assert.equal(globalThis[name], value, name);
  report({ phase: 'next', value: target.value() });
});
`,
      );
      const result = await f.run();
      assert.equal(result.code, failure ? 1 : 0, result.output);
      if (failure)
        assert.ok(result.output.includes('ordered cleanup sentinel'));
      assert.deepEqual(
        result.markers
          .filter((line) => line.startsWith('ordered:'))
          .map((line) => JSON.parse(line.slice('ordered:'.length)) as unknown),
        [
          { phase: 'first', value: 'mocked' },
          { phase: 'second', value: 'mocked', callbacks: 0 },
          { phase: 'next', value: 'original' },
        ],
      );
    });
