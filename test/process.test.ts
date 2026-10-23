import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { ProcessIdentity } from '../src/core/state.js';
import {
  identifyProcess,
  identifyProcesses,
} from '../src/persistence/process.js';
import { countProbes } from './fixtures/probes.js';

await test('process identities preserve native start strings across a batch', async (t) => {
  const live = spawn('/bin/sleep', ['30']);
  const ended = once(live, 'close');
  t.after(async () => {
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
  assert.deepEqual(batch, { value: expected, ps: 1, perl: 0 });
  assert.deepEqual(await identifyProcess(live.pid!), expected.get(live.pid!));
  assert.equal(await identifyProcess(exited.pid!), undefined);
  assert.deepEqual(await countProbes(() => identifyProcesses([exited.pid!])), {
    value: new Map(),
    ps: 1,
    perl: 0,
  });
  assert.deepEqual(await countProbes(() => identifyProcesses([])), {
    value: new Map(),
    ps: 0,
    perl: 0,
  });
});
