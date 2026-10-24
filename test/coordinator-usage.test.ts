import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { identifyProcess } from '../src/persistence/process.js';
import { fixture, readRecord } from './fixtures/coordinator.js';

await test('usage process registration preserves the main identity and ignores reports after its conversation closes', async () => {
  const { coordinator, a, root, tracked } = await fixture();
  const helper = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    const id = coordinator.snapshot.conversation!.id;
    const before = await readRecord(root, id);
    const report = a.sessions[0]!.options.onUsageProcess!;
    await report(helper.pid);
    const registered = await readRecord(root, id);
    assert.deepEqual(
      registered.usageProcess,
      await identifyProcess(helper.pid!),
    );
    assert.deepEqual(registered.process, before.process);
    assert.deepEqual(tracked, []);
    await report(undefined);
    const cleared = await readRecord(root, id);
    assert.equal(cleared.usageProcess, undefined);
    assert.deepEqual(cleared.process, before.process);
    await coordinator.close();
    await report(helper.pid);
    assert.equal((await readRecord(root, id)).usageProcess, undefined);
  } finally {
    const closed = once(helper, 'close');
    helper.kill('SIGKILL');
    await closed;
    await coordinator.close();
  }
});
