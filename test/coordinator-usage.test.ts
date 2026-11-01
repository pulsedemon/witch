import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'vitest';
import { identifyProcess } from '../src/persistence/process.js';
import { fixture, readRecord } from './fixtures/coordinator.js';
import { until } from './fixtures/within.js';

test('usage process registration preserves the main identity and ignores reports after its conversation closes', async () => {
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

test('connect reads the other runtime, and each turn carries the account usage without resending the fixed instructions', async () => {
  const weekly = [{ window: '7D', percent: 40, observedAt: Date.now() }];
  const f = await fixture(undefined, (_a, b) => {
    b.accountReading = { limits: weekly };
  });
  try {
    await until(
      'the other runtime',
      () => f.coordinator.snapshot.accounts.b?.limits === weekly,
    );
    assert.equal(f.b.accountReads.length, 1);
    assert.equal(f.b.sessions.length, 0);
    f.a.turnUsage = {
      account: {
        limits: [{ window: '5H', percent: 30, observedAt: Date.now() }],
      },
    };
    await f.coordinator.send('First');
    const first = f.a.inputs.at(-1)!.context!;
    assert.match(first, /You are running inside Witch/);
    assert.match(first, /\nAccount usage: b 7D 40%\. /);
    assert.deepEqual(
      f.coordinator.snapshot.accounts.a?.limits,
      f.a.turnUsage.account?.limits,
    );
    await f.coordinator.send('Second');
    const second = f.a.inputs.at(-1)!.context!;
    assert.doesNotMatch(second, /You are running inside Witch/);
    assert.match(second, /^Account usage: a 5H 30%; b 7D 40%\. /m);
    assert.equal(f.b.accountReads.length, 1);
  } finally {
    await f.coordinator.close();
  }
});

test('new credit observations reach each next turn without resending fixed instructions', async () => {
  const f = await fixture();
  try {
    const account = {
      limits: [{ window: '7D', percent: 100, observedAt: Date.now() }],
      funding: {
        kind: 'credits' as const,
        balance: '12345.678900',
        unlimited: false,
        available: true,
        observedAt: Date.now(),
      },
    };
    f.coordinator.accountUsage.report('a', account);
    await f.coordinator.send('First');
    assert.match(f.a.inputs.at(-1)!.context!, /7D 100%, 12345\.678900 credits/);
    f.coordinator.accountUsage.report('a', {
      ...account,
      funding: {
        ...account.funding,
        balance: '9.876500',
        observedAt: Date.now(),
      },
    });
    await f.coordinator.send('Second');
    const context = f.a.inputs.at(-1)!.context!;
    assert.match(context, /7D 100%, 9\.876500 credits/);
    assert.doesNotMatch(context, /12345\.678900|You are running inside Witch/);
  } finally {
    await f.coordinator.close();
  }
});
