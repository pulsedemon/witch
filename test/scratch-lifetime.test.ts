import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { ProcessIdentity } from '../src/core/state.js';
import { ScratchSpace } from '../src/persistence/scratch.js';
import { scratch } from './fixtures/scratch.js';
import { until, within } from './fixtures/within.js';

const execute = promisify(execFile);
const fixture = join(import.meta.dirname, 'fixtures/scratch-lifetime.ts');
const loader = import.meta.resolve('tsx');
const bootA = '11111111-1111-4111-8111-111111111111';
const bootB = '22222222-2222-4222-8222-222222222222';
const firstBoot = { boot: async () => bootA };
const laterBoot = { boot: async () => bootB };

async function runFixture(parent: string, mode = 'restart', ...args: string[]) {
  const { stdout } = await execute(
    process.execPath,
    ['--import', loader, fixture, mode, parent, ...args],
    { env: { ...process.env, NODE_TEST_CONTEXT: undefined }, timeout: 20_000 },
  );
  return stdout
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          directory: string;
          identity?: ProcessIdentity;
          worker?: number;
        },
    );
}

await test('scratch resumes in place, stays private and survives clean close', async () => {
  const parent = await scratch('witch-scratch-');
  const [before, after] = await runFixture(parent);
  assert.ok(before);
  assert.ok(before.identity);
  assert.deepEqual(after, before);
  const marker = join(before.directory, 'marker');
  assert.equal(await readFile(marker, 'utf8'), 'before restart');
  const fresh = await ScratchSpace.open(parent);
  try {
    assert.equal((await stat(fresh.directory)).mode & 0o777, 0o700);
    const freshMarker = join(fresh.directory, 'marker');
    await writeFile(freshMarker, 'fresh scratch');
    await fresh.close();
    assert.equal(await readFile(freshMarker, 'utf8'), 'fresh scratch');
    assert.equal(await readFile(marker, 'utf8'), 'before restart');
  } finally {
    await fresh.close();
  }
});

await test('retained scratch survives its boot and is swept after a different boot', async () => {
  const parent = await scratch('witch-scratch-');
  const retained = await ScratchSpace.open(parent, firstBoot);
  await writeFile(join(retained.directory, 'marker'), 'survivor');
  const locked = join(retained.directory, 'readonly');
  await mkdir(locked);
  await writeFile(join(locked, 'file'), 'contents');
  await chmod(locked, 0o500);
  await retained.close();
  const unrelated = join(parent, 'notes');
  await mkdir(unrelated);
  await writeFile(join(unrelated, 'marker'), 'leave me');
  const outside = await scratch('witch-scratch-outside-');
  await writeFile(join(outside, 'marker'), 'outside');
  const link = join(parent, randomUUID());
  await symlink(outside, link);
  const same = await ScratchSpace.open(parent, firstBoot);
  await same.close();
  assert.equal(
    await readFile(join(retained.directory, 'marker'), 'utf8'),
    'survivor',
  );
  const later = await ScratchSpace.open(parent, laterBoot);
  try {
    assert.equal(existsSync(retained.directory), false);
    assert.equal(existsSync(same.directory), false);
    assert.equal(await readFile(join(unrelated, 'marker'), 'utf8'), 'leave me');
    assert.equal(await readFile(join(link, 'marker'), 'utf8'), 'outside');
    assert.equal(existsSync(join(outside, '.witch-scratch.json')), false);
  } finally {
    await later.close();
  }
});

await test("a held directory remains untouched during another instance's sweep", async () => {
  const parent = await scratch('witch-scratch-');
  const child = spawn(
    process.execPath,
    ['--import', loader, fixture, 'hold', parent, bootA],
    {
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  );
  const ended = once(child, 'close');
  const output = createInterface({ input: child.stdout });
  try {
    const [directory] = (await within(
      once(output, 'line'),
      5000,
      'scratch lock',
    )) as [string];
    const contender = await ScratchSpace.open(parent, laterBoot);
    await contender.close();
    assert.equal(await readFile(join(directory, 'marker'), 'utf8'), 'held');
    child.stdin.end('release');
    const [code] = await within(ended, 5000, 'scratch holder exit');
    assert.equal(code, 0);
    const later = await ScratchSpace.open(parent, laterBoot);
    await later.close();
    assert.equal(existsSync(directory), false);
  } finally {
    output.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await ended;
  }
});

await test('the first restart adopts its numeric scratch without moving files', async () => {
  const parent = await scratch('witch-scratch-');
  const live = join(parent, String(process.pid));
  await mkdir(live);
  await writeFile(join(live, 'marker'), 'another live owner');
  const [before, after] = await runFixture(parent, 'legacy');
  assert.ok(before);
  assert.ok(before.identity);
  assert.equal(before.directory, join(parent, String(before.identity.pid)));
  assert.deepEqual(after, before);
  assert.equal(
    await readFile(join(before.directory, 'marker'), 'utf8'),
    'before restart',
  );
  assert.equal(
    await readFile(join(live, 'marker'), 'utf8'),
    'another live owner',
  );
  assert.equal(existsSync(join(live, '.witch-scratch.json')), false);
});

for (const [mode, restarts] of [
  ['survivor', 0],
  ['survivor', 1],
  ['survivor', 2],
  ['survivor-legacy', 2],
] as const) {
  await test(`scratch remains usable by a worker and its later child after ${mode} with ${restarts} restarts`, async () => {
    const parent = await scratch('witch-scratch-worker-');
    const gone = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
        throw error;
      }
    };
    try {
      const reports = await runFixture(parent, mode, String(restarts));
      const first = reports[0]!;
      assert.equal(reports.length, restarts + 1);
      assert.ok(first.worker);
      assert.ok(first.identity);
      assert.equal(gone(first.worker), false);
      for (const report of reports) {
        assert.equal(report.directory, first.directory);
        assert.deepEqual(report.identity, first.identity);
      }
      await writeFile(join(parent, 'release-worker'), 'release');
      await until('worker marker read', () =>
        existsSync(join(parent, 'worker.result')),
      );
      await until('original worker exit', () => gone(first.worker!));
      assert.equal(
        await readFile(join(parent, 'worker.result'), 'utf8'),
        'before restart',
      );
      const descendant = Number(
        await readFile(join(parent, 'descendant.pid'), 'utf8'),
      );
      assert.equal(gone(descendant), false);
      const next = await ScratchSpace.open(join(parent, 'scratch'));
      await next.close();
      await writeFile(join(parent, 'release-descendant'), 'release');
      await until('descendant marker read', () =>
        existsSync(join(parent, 'descendant.result')),
      );
      await until('descendant exit', () => gone(descendant));
      assert.equal(
        await readFile(join(parent, 'descendant.result'), 'utf8'),
        'before restart',
      );
    } finally {
      for (const name of ['worker', 'descendant']) {
        await writeFile(join(parent, `release-${name}`), 'release');
        const file = join(parent, `${name}.pid`);
        if (existsSync(file)) {
          const pid = Number(await readFile(file, 'utf8'));
          await until(`${name} cleanup`, () => gone(pid));
        }
      }
    }
  });
}

await test('uncertain legacy scratch establishes a boot boundary without deleting data', async (t) => {
  const parent = await scratch('witch-scratch-');
  const child = spawn('/usr/bin/true');
  await once(child, 'exit');
  const abandoned = join(parent, String(child.pid));
  const incomplete = join(parent, randomUUID());
  const invalid = join(parent, randomUUID());
  const denied = join(parent, '100001');
  for (const directory of [abandoned, incomplete, invalid, denied]) {
    await mkdir(directory);
    await writeFile(join(directory, 'marker'), directory);
  }
  await writeFile(join(invalid, '.witch-scratch.json'), '{invalid');
  const kill = process.kill.bind(process);
  t.mock.method(
    process,
    'kill',
    (pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 100001)
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return kill(pid, signal);
    },
  );
  const observed = await ScratchSpace.open(parent, firstBoot);
  await observed.close();
  for (const directory of [abandoned, incomplete, invalid, denied])
    assert.equal(await readFile(join(directory, 'marker'), 'utf8'), directory);
  for (const directory of [abandoned, incomplete])
    assert.deepEqual(
      JSON.parse(
        await readFile(join(directory, '.witch-scratch.json'), 'utf8'),
      ),
      { version: 1, boot: bootA },
    );
  assert.equal(existsSync(join(denied, '.witch-scratch.json')), false);
  const later = await ScratchSpace.open(parent, laterBoot);
  await later.close();
  assert.equal(existsSync(abandoned), false);
  assert.equal(existsSync(incomplete), false);
  for (const directory of [invalid, denied])
    assert.equal(await readFile(join(directory, 'marker'), 'utf8'), directory);
});

await test('scratch resume rejects a different owner or an invalid location', async () => {
  const parent = await scratch('witch-scratch-');
  const original = await ScratchSpace.open(parent, firstBoot);
  await writeFile(join(original.directory, 'marker'), 'untouched');
  await assert.rejects(
    ScratchSpace.open(parent, { ...firstBoot, resume: original.directory }),
  );
  await original.close();
  const recordFile = join(original.directory, '.witch-scratch.json');
  const record = JSON.parse(await readFile(recordFile, 'utf8')) as {
    version: number;
    boot: string;
    owner: ProcessIdentity;
  };
  for (const owner of [
    { ...record.owner, pid: record.owner.pid + 1 },
    { ...record.owner, started: 'different process' },
  ]) {
    await writeFile(recordFile, JSON.stringify({ ...record, owner }));
    await assert.rejects(
      ScratchSpace.open(parent, { ...firstBoot, resume: original.directory }),
      /does not belong/,
    );
  }
  await writeFile(recordFile, JSON.stringify(record));
  await assert.rejects(
    ScratchSpace.open(parent, { ...laterBoot, resume: original.directory }),
    /does not belong/,
  );
  const link = join(parent, randomUUID());
  await symlink(original.directory, link);
  await assert.rejects(
    ScratchSpace.open(parent, { ...firstBoot, resume: link }),
  );
  const outside = await ScratchSpace.open(
    await scratch('witch-outside-'),
    firstBoot,
  );
  await writeFile(join(outside.directory, 'marker'), 'outside');
  await outside.close();
  await assert.rejects(
    ScratchSpace.open(parent, { ...firstBoot, resume: outside.directory }),
    /direct child/,
  );
  const names = await readdir(parent);
  await assert.rejects(
    ScratchSpace.open(parent, {
      ...firstBoot,
      resume: join(parent, randomUUID()),
    }),
  );
  assert.deepEqual(await readdir(parent), names);
  assert.equal(
    await readFile(join(original.directory, 'marker'), 'utf8'),
    'untouched',
  );
  assert.equal(
    await readFile(join(outside.directory, 'marker'), 'utf8'),
    'outside',
  );
});
