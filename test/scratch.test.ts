import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { scratch } from './fixtures/scratch.js';
import { within } from './fixtures/within.js';

const fixture = fileURLToPath(
  new URL('fixtures/scratch-run.ts', import.meta.url),
);

function launch(cwd: string, tmp: string, ...args: string[]) {
  const child = spawn(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), fixture, ...args],
    {
      cwd,
      // inherited, the runner's context makes the child report in its binary protocol
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, TMPDIR: tmp },
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );

  const paths: string[] = [];

  const reported = Promise.withResolvers<string>();

  let partial = '';

  child.stdout.on('data', (chunk: Buffer) => {
    const lines = (partial + chunk.toString()).split('\n');

    partial = lines.pop()!;

    for (const line of lines)
      if (line.startsWith('scratch ')) paths.push(line.slice(8));

    if (paths.length) reported.resolve(paths[0]!);
  });

  const closed = once(child, 'close') as Promise<[number | null]>;

  return { child, paths, reported: reported.promise, closed };
}

test("a file's scratch directories share one parent named for its process and outlive each of its tests, then go when it ends, a failed test included", async () => {
  const root = await scratch('witch-scratch-');

  const tmp = join(root, 'tmp');

  await mkdir(tmp);

  const run = launch(root, tmp, 'fail');

  const [code] = await within(run.closed, 10_000, 'the run');

  const [a, b, c] = run.paths;

  assert.equal(code, 1);

  assert.equal(run.paths.length, 3);

  assert.equal(dirname(a!), dirname(b!));

  assert.equal(dirname(a!), dirname(c!));

  assert.equal(dirname(dirname(a!)), join(tmp, 'witch-tests'));

  assert.match(
    basename(dirname(a!)),
    new RegExp(`^${run.child.pid}-[0-9A-Za-z]{6}$`),
  );

  assert.ok(basename(a!).startsWith('witch-a-'));

  assert.equal(existsSync(dirname(a!)), false);
});

test("the next run removes a killed run's scratch directories, locked ones included, and leaves a live or root-owned process's as they are, a linked directory and the rest of the temp dir", async () => {
  const root = await scratch('witch-scratch-');

  const tmp = join(root, 'tmp');

  const outside = join(root, 'outside');

  const live = join(tmp, 'witch-tests', `${process.pid}-live01`);

  const rooted = join(tmp, 'witch-tests', '1-other1');

  const rest = join(tmp, 'witch-other-abcdef');

  for (const directory of [outside, live, rooted, rest]) {
    await mkdir(directory, { recursive: true });

    await writeFile(join(directory, 'keep'), '');
  }

  await chmod(outside, 0o500);

  await chmod(live, 0o500);

  const hang = launch(root, tmp, 'hang', outside);

  try {
    const killed = await within(
      hang.reported,
      10_000,
      "the killed run's directory",
    );

    hang.child.kill('SIGKILL');

    await within(hang.closed, 10_000, 'the killed run');

    assert.ok(existsSync(killed));

    const next = launch(root, tmp, 'fail');

    const [code] = await within(next.closed, 10_000, 'the next run');

    assert.equal(code, 1);

    assert.equal(next.paths.length, 3);

    assert.equal(existsSync(dirname(killed)), false);

    for (const directory of [outside, live, rooted, rest])
      assert.ok(existsSync(join(directory, 'keep')), directory);

    assert.equal((await stat(outside)).mode & 0o777, 0o500);

    assert.equal((await stat(live)).mode & 0o777, 0o500);
  } finally {
    hang.child.kill('SIGKILL');

    await chmod(outside, 0o700);

    // gone if the sweep wrongly removed it, which the assertion above reports
    await chmod(live, 0o700).catch(() => {});
  }
});
