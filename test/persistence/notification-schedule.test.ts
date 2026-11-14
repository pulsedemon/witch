import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { promisify } from 'node:util';
import { openLocked } from '../../src/persistence/lock.js';
import { NotificationSchedule } from '../../src/persistence/notifications.js';
import { scratch } from '../fixtures/scratch.js';

async function fixture() {
  const directory = join(
    await scratch('witch-notifications-'),
    'notifications',
  );

  const schedule = await NotificationSchedule.open(directory);
  const file = join(directory, 'schedule.json');
  const output: string[] = [];

  const write = (data: string) => {
    output.push(data);
  };

  return { directory, schedule, file, output, write };
}

test('notification intervals follow the last actual write across schedule instances', async () => {
  const { directory, schedule, file, output, write } = await fixture();
  let now = 10_000_000_000n;
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => now);

  assert.equal(
    await schedule.attempt(
      () => 'first',
      (data) => {
        write(data);
        now += 1_000_000n;
      },
    ),
    undefined,
  );

  const original = await readFile(file, 'utf8');

  assert.deepEqual(JSON.parse(original), {
    boot: JSON.parse(original).boot,
    sentAt: 10_001,
    digest: createHash('sha256').update('first').digest('hex'),
  });

  assert.equal((await stat(directory)).mode & 0o777, 0o700);

  for (const name of ['lock', 'schedule.json'])
    assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);

  const second = await NotificationSchedule.open(directory);
  now += 1_199_000_000n;
  assert.equal(await second.attempt(() => 'second', write), 1);
  assert.equal(await readFile(file, 'utf8'), original);
  now += 1_000_000n;
  assert.equal(await second.attempt(() => 'second', write), undefined);
  now += 6_199_000_000n;
  assert.equal(await schedule.attempt(() => 'second', write), 1);
  now += 1_000_000n;
  assert.equal(await schedule.attempt(() => 'second', write), undefined);
  assert.deepEqual(output, ['first', 'second', 'second']);
});

test('a competing lock defers notification output until it is released', async () => {
  const { directory, schedule, output, write } = await fixture();

  const lock = await openLocked(
    join(directory, 'lock'),
    constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK,
    { mode: 0o600 },
  );

  try {
    assert.equal(
      await schedule.attempt(
        () => assert.fail('read eligibility while locked'),
        write,
      ),
      25,
    );

    assert.deepEqual(output, []);
  } finally {
    await lock.close();
  }

  assert.equal(await schedule.attempt(() => 'available', write), undefined);
  assert.deepEqual(output, ['available']);
});

test('another process reads the prior send before deciding its interval', async () => {
  const { directory, schedule, write } = await fixture();
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => 40_000_000n);
  await schedule.attempt(() => 'prior', write);

  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      `import { NotificationSchedule } from ${JSON.stringify(new URL('../../src/persistence/notifications.ts', import.meta.url).href)};
     process.hrtime.bigint = () => 240_000_000n;
     const schedule = await NotificationSchedule.open(process.argv[1]);
     console.log(await schedule.attempt(() => 'next', () => { throw new Error('early write'); }));`,
      directory,
    ],
    { env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  );

  assert.equal(stdout.trim(), '1000');
});

test('a previous boot cannot delay a notification on the current boot', async () => {
  const { schedule, file, output, write } = await fixture();
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => 100_000_000n);
  await schedule.attempt(() => 'first', write);
  const previous = JSON.parse(await readFile(file, 'utf8'));

  await writeFile(
    file,
    JSON.stringify({ ...previous, boot: randomUUID(), sentAt: 1_000_000 }),
  );

  assert.equal(await schedule.attempt(() => 'first', write), undefined);
  assert.deepEqual(output, ['first', 'first']);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).boot, previous.boot);
});

test('cancellation during an asynchronous attempt leaves the schedule unchanged', async () => {
  const { schedule, file, output, write } = await fixture();
  let eligible = true;

  const attempt = schedule.attempt(
    () => (eligible ? 'stale' : undefined),
    write,
  );

  eligible = false;
  assert.equal(await attempt, undefined);
  assert.deepEqual(output, []);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('invalid schedule data rejects and releases the lock on every attempt', async () => {
  const { schedule, file, output, write } = await fixture();

  for (const value of ['{', '{"boot":"invalid","sentAt":0,"digest":"bad"}']) {
    await writeFile(file, value);

    for (let retry = 0; retry < 2; retry++)
      await assert.rejects(schedule.attempt(() => 'message', write));

    assert.deepEqual(output, []);
    assert.equal(await readFile(file, 'utf8'), value);
  }
});

test('a failed output does not record a send or retain the lock', async () => {
  const { schedule, file, output, write } = await fixture();

  await assert.rejects(
    schedule.attempt(
      () => 'failed',
      () => {
        throw new Error('closed output');
      },
    ),
    /closed output/,
  );

  await assert.rejects(readFile(file), { code: 'ENOENT' });
  assert.equal(await schedule.attempt(() => 'after failure', write), undefined);
  assert.deepEqual(output, ['after failure']);
});
