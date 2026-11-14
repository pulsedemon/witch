import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import { promisify } from 'node:util';
import type { ProcessIdentity } from '../src/core/state.js';
import {
  bootSession,
  identifyProcess,
  identifyProcesses,
  processArguments,
  stopLeftProcesses,
} from '../src/persistence/process.js';
import { countProbes } from './fixtures/probes.js';
import { within } from './fixtures/within.js';

test('process arguments preserve boundaries and omit exited processes', async (t) => {
  const args = [
    '-e',
    'setInterval(() => {}, 1000)',
    '--',
    'two words',
    '',
    ' --daemon ',
    '雪\nline',
    '--batch',
    '',
  ];

  const child = spawn(process.execPath, args, {
    stdio: 'ignore',
    env: { ...process.env, WITCH_ARGUMENTS_PROBE: 'must stay out of argv' },
  });

  const ended = once(child, 'close');

  const empty = spawn('/bin/sleep', ['30'], {
    argv0: '',
    stdio: 'ignore',
    env: { WITCH_ARGUMENTS_PROBE: 'must stay out of argv' },
  });

  const emptyEnded = once(empty, 'close');

  t.onTestFinished(async () => {
    child.kill();

    empty.kill();

    await ended;

    await emptyEnded;
  });

  await Promise.all([once(child, 'spawn'), once(empty, 'spawn')]);

  assert.deepEqual(
    await processArguments([child.pid!, empty.pid!]),
    new Map([
      [child.pid!, [process.execPath, ...args]],
      [empty.pid!, ['', '30']],
    ]),
  );

  child.kill();

  await ended;

  assert.deepEqual(await processArguments([child.pid!]), new Map());

  assert.deepEqual(await processArguments([]), new Map());
});

test('boot identity comes from the native boot session', async () => {
  const expected =
    process.platform === 'linux'
      ? await readFile('/proc/sys/kernel/random/boot_id', 'utf8')
      : (
          await promisify(execFile)('/usr/sbin/sysctl', [
            '-n',
            'kern.bootsessionuuid',
          ])
        ).stdout;

  assert.equal(await bootSession(), expected.trim());
});

test('process identities preserve native start strings across a batch', async (t) => {
  const live = spawn('/bin/sleep', ['30']);

  const ended = once(live, 'close');

  t.onTestFinished(async () => {
    live.kill();

    await ended;
  });

  await once(live, 'spawn');

  const exited = spawn(process.execPath, ['-e', '']);

  await once(exited, 'close');

  const expected = new Map<number, ProcessIdentity>();

  for (const pid of [live.pid!, process.pid]) {
    const { stdout } = await promisify(execFile)(
      '/bin/ps',
      ['-p', String(pid), '-o', 'lstart='],
      {
        env: {
          ...process.env,
          LC_ALL: undefined,
          LC_TIME: 'C',
          LC_NUMERIC: 'C',
          TZ: 'UTC',
        },
      },
    );

    expected.set(pid, { pid, started: stdout.trim() });
  }

  const batch = await countProbes(() =>
    identifyProcesses([live.pid!, exited.pid!, process.pid, live.pid!]),
  );

  assert.deepEqual(batch, { value: expected, ps: 1, perl: 0, git: 0, sh: 0 });

  // the batch included this process, so later reads answer it without a probe
  assert.deepEqual(await countProbes(() => identifyProcesses([process.pid])), {
    value: new Map([[process.pid, expected.get(process.pid)!]]),
    ps: 0,
    perl: 0,
    git: 0,
    sh: 0,
  });

  assert.deepEqual(
    await countProbes(() => identifyProcesses([live.pid!, process.pid])),
    { value: expected, ps: 1, perl: 0, git: 0, sh: 0 },
  );

  assert.deepEqual(await identifyProcess(live.pid!), expected.get(live.pid!));

  assert.equal(await identifyProcess(exited.pid!), undefined);

  assert.deepEqual(await countProbes(() => identifyProcesses([exited.pid!])), {
    value: new Map(),
    ps: 1,
    perl: 0,
    git: 0,
    sh: 0,
  });

  assert.deepEqual(await countProbes(() => identifyProcesses([])), {
    value: new Map(),
    ps: 0,
    perl: 0,
    git: 0,
    sh: 0,
  });
});

test('a left process that refuses to stop still lets the others stop, then fails', async () => {
  const start = async (script: string) => {
    const child = spawn(process.execPath, ['-e', script]);

    await once(child.stdout, 'data');

    return child;
  };

  const stubborn = await start(
    "process.on('SIGTERM', () => {}); console.log('ready'); setTimeout(() => {}, 60_000);",
  );

  const usage = await start(
    "console.log('ready'); setTimeout(() => {}, 60_000);",
  );

  try {
    const exited = once(usage, 'exit');

    await assert.rejects(
      stopLeftProcesses({
        process: await identifyProcess(stubborn.pid!),
        usageProcess: await identifyProcess(usage.pid!),
      }),
      /has not stopped/,
    );

    await within(exited, 1000, 'the usage process stopping');
  } finally {
    stubborn.kill('SIGKILL');

    usage.kill('SIGKILL');
  }
});
