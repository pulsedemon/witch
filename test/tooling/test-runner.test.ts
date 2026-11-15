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
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import stripAnsi from 'strip-ansi';
import { scratch } from '../fixtures/scratch.js';
import { until, within } from '../fixtures/within.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const suiteFiles = ['test/first.test.ts', 'test/second.test.ts'];

function suite(label: string, failure = '') {
  return `import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
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
    'test/fixtures/vitest-setup.ts',
    'test/fixtures/cli-build.ts',
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

  for (const file of suiteFiles) await writeFile(join(root, file), suite(file));

  const markers = join(root, 'markers');
  await writeFile(markers, '');

  async function start(args: string[]) {
    await writeFile(markers, '');

    const child = spawn('pnpm', args, {
      cwd: root,
      env: {
        ...process.env,
        NO_COLOR: undefined,
        FORCE_COLOR: '1',
        TMPDIR: tmp,
        MARKERS: markers,
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';

    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

    const closed = once(child, 'close') as Promise<
      [number | null, NodeJS.Signals | null]
    >;

    return {
      closed,
      output: () => stripAnsi(output),
      async stop() {
        if (child.exitCode === null && child.signalCode === null)
          process.kill(-child.pid!, 'SIGKILL');

        await closed;
      },
    };
  }

  return {
    root,
    tmp,
    markers,
    start,
    async run() {
      const running = await start(['test']);

      try {
        const [code, signal] = await within(
          running.closed,
          60_000,
          'test command',
        );

        const output = running.output();
        assert.equal(signal, null, output);

        return {
          code,
          output,
          markers: (await readFile(markers, 'utf8'))
            .split('\n')
            .filter(Boolean),
        };
      } finally {
        await running.stop();
      }
    },
  };
}

test('the test command executes each file once and discovers newly added nested files', async () => {
  const f = await fixture();

  for (const added of [false, true]) {
    if (added) {
      const nested = join(f.root, 'test/core/nested');
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, 'added.test.ts'), suite('added'));
    }

    const result = await f.run();
    assert.equal(result.code, 0, result.output);
    const labels = added ? [...suiteFiles, 'added'] : suiteFiles;

    assert.deepEqual(
      result.markers.sort(),
      labels.flatMap((label) => [`${label}:start`, `${label}:end`]).sort(),
    );
  }
});

test('an assertion fails the test command without hiding its diagnostic', async () => {
  const f = await fixture();

  await writeFile(
    join(f.root, suiteFiles[0]!),
    suite('failing', 'assertion sentinel'),
  );

  const result = await f.run();
  assert.equal(result.code, 1, result.output);
  assert.ok(result.output.includes('assertion sentinel'), result.output);
  assert.equal(result.markers.includes('failing:start'), true);
  assert.equal(result.markers.includes('failing:end'), false);
});

test('an empty discovered suite fails the test command', async () => {
  const f = await fixture();

  for (const file of suiteFiles) await rm(join(f.root, file));

  const result = await f.run();
  assert.equal(result.code, 1, result.output);
  assert.ok(result.output.includes('No test files found'), result.output);
  assert.deepEqual(result.markers, []);
});

test('suite discovery excludes child fixtures', async () => {
  const f = await fixture();

  await writeFile(
    join(f.root, 'test/fixtures/child.test.ts'),
    suite('child', 'child fixture was collected'),
  );

  const result = await f.run();
  assert.equal(result.code, 0, result.output);

  assert.deepEqual(
    result.markers.sort(),
    suiteFiles.flatMap((file) => [`${file}:start`, `${file}:end`]).sort(),
  );
});

for (const failure of [false, true])
  test(`Vitest removes a ${failure ? 'failing' : 'passing'} file's scratch after its last case`, async () => {
    const f = await fixture();

    await writeFile(
      join(f.root, suiteFiles[0]!),
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

  // a sibling suite's setup would sweep the killed worker's scratch before the run checks it
  for (const f of [killed, live]) {
    await writeFile(join(f.root, suiteFiles[0]!), held);
    await rm(join(f.root, suiteFiles[1]!));
  }

  // starting a nested run under load outlasts a short poll, so this waits until that run ends or holds scratch
  const owner = async (f: typeof killed, running: ReturnType<typeof f.run>) => {
    let ended: string | undefined;

    void running.then(
      (result) => {
        ended = result.output;
      },
      (error: unknown) => {
        ended = String(error);
      },
    );

    for (;;) {
      const line = (await readFile(f.markers, 'utf8'))
        .split('\n')
        .find((line) => line.startsWith('held:'));

      if (line)
        return JSON.parse(line.slice('held:'.length)) as {
          directory: string;
          pid: number;
        };

      if (ended !== undefined)
        assert.fail(`Vitest run ended without holding scratch:\n${ended}`);

      await delay(20);
    }
  };

  let dying: ReturnType<typeof killed.run> | undefined;
  let surviving: ReturnType<typeof live.run> | undefined;

  try {
    dying = killed.run();
    const dead = await owner(killed, dying);
    surviving = live.run();
    const survivor = await owner(live, surviving);
    process.kill(dead.pid, 'SIGKILL');
    const failed = await dying;
    assert.equal(failed.code, 1, failed.output);
    assert.equal(existsSync(dead.directory), true);
    assert.equal(existsSync(survivor.directory), true);

    await writeFile(
      join(recovery.root, suiteFiles[0]!),
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
      join(f.root, suiteFiles[0]!),
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
        join(f.root, suiteFiles[0]!),
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

test('a child-only fixture edit reruns the selected watch suite', async () => {
  const f = await fixture();
  const child = join(f.root, 'test/fixtures/child.mjs');
  const ready = "process.stdout.write('ready');\n";
  await writeFile(child, ready);

  await writeFile(
    join(f.root, suiteFiles[0]!),
    `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
test('observes the child result', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/child.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  appendFileSync(process.env.MARKERS, 'watch:' + result.stdout + '\\n');
  assert.equal(result.stdout, 'ready', 'child fixture sentinel');
});
`,
  );

  const watching = await f.start([
    'exec',
    'vitest',
    '--watch',
    suiteFiles[0]!,
    '--clearScreen=false',
  ]);

  let offset = 0;

  async function completed(expected: 'PASS' | 'FAIL') {
    await until(
      'completed watch run',
      () =>
        watching
          .output()
          .slice(offset)
          .includes('press h to show help, press q to quit'),
      500,
    ).catch((error: unknown) => {
      throw new Error(watching.output(), { cause: error });
    });

    const output = watching.output().slice(offset);
    assert.ok(output.includes(expected), output);

    if (expected === 'FAIL')
      assert.ok(output.includes('child fixture sentinel'), output);

    offset = watching.output().length;
  }

  try {
    await completed('PASS');
    await writeFile(child, "process.stdout.write('changed');\n");
    await completed('FAIL');
    await writeFile(child, ready);
    await completed('PASS');

    assert.deepEqual((await readFile(f.markers, 'utf8')).trim().split('\n'), [
      'watch:ready',
      'watch:changed',
      'watch:ready',
    ]);
  } finally {
    await watching.stop();
  }
});
