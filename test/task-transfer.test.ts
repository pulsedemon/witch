import assert from 'node:assert/strict';
import type { TestContext } from 'vitest';
import { test, vi } from 'vitest';
import { callControl } from '../src/persistence/control.js';
import { TurnGate } from './fixtures/agent.js';
import {
  coordinationFixture,
  pauseDiscovery,
} from './fixtures/coordination.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import { until, within } from './fixtures/within.js';

async function transfer(t: TestContext) {
  const cleanup = orderedCleanup(t.onTestFinished);
  const ticks = pauseDiscovery(vi.spyOn);
  const f = await coordinationFixture(cleanup);
  const a = await f.start(),
    b = await f.start('B');
  assert.equal((await a.claim('task:shared', 'Shared work')).kind, 'claimed');
  const requested = () =>
    until('transfer request', async () =>
      (await f.registry.claims()).some((claim) => claim.transfer),
    );
  return {
    ...f,
    a,
    b,
    requested,
    /** runs A's periodic tick once B's request is recorded, the only reader an owner whose model cannot act has. */
    answer: async () => {
      await requested();
      ticks[0]!();
    },
  };
}

test('an idle owner hands over its task without a model turn, and its next context names the move', async (t) => {
  const { a, b, answer, registry } = await transfer(t);
  a.a.failNext = true;
  await a.coordinator.send('turn that fails');
  assert.equal(a.coordinator.snapshot.phase, 'idle');
  const [before] = await registry.claims();
  const turns = a.a.inputs.length;
  await Promise.all([b.coordination.takeTask('task:shared'), answer()]);
  const taker = b.coordinator.snapshot.conversation!.id;
  const owned = b.coordination.snapshot.ownClaim!;
  assert.deepEqual(
    [owned.id, owned.references, owned.summary, owned.owner.conversation],
    [before!.id, before!.references, 'Shared work', taker],
  );
  assert.equal(a.a.inputs.length, turns);
  assert.match(
    (await a.coordination.context()).context,
    new RegExp(
      `The user moved ${before!.references[0]} to conversation ${taker}\\. Do not continue that task\\.`,
    ),
  );
  const release = await callControl(await a.binding(), {
    kind: 'release',
    claim: before!.id,
  });
  assert.deepEqual(
    release.kind === 'error' && release.message,
    'Only the owning conversation can release this task.',
  );
  assert.equal((await a.claim('task:shared', 'Shared work')).kind, 'conflict');
});

test('a running turn, a running brew and memory recovery each refuse with their next action', async (t) => {
  const { a, b, answer, registry } = await transfer(t);
  const before = await registry.claims();
  const refuses = async (reason: RegExp) => {
    const taking = b.coordination.takeTask('task:shared');
    await answer();
    await assert.rejects(taking, (error: Error) => {
      assert.match(error.message, /still holds task:shared\. /);
      assert.match(error.message, reason);
      return true;
    });
    assert.deepEqual(await registry.claims(), before);
  };

  const gate = new TurnGate();
  a.a.gate = gate;
  const sending = a.coordinator.send('Held work');
  await within(gate.entered, 5000, 'held turn');
  await refuses(
    /It is running\. Wait for it to go idle or stop its turn there/,
  );
  gate.open();
  await sending;

  const emit = a.a.sessions.at(-1)!.options.onEvent;
  emit({
    type: 'command',
    command: { id: 'brew', description: 'Work', status: 'running' },
  });
  await refuses(/It has running familiars or brews\. Stop them there/);
  emit({
    type: 'command',
    command: { id: 'brew', description: 'Work', status: 'completed' },
  });

  a.a.interruptNext = true;
  await a.coordinator.send('remember-port');
  assert.equal(a.coordinator.snapshot.phase, 'recovery');
  await refuses(/It has unresolved memory recovery\. Resolve it there/);
});

test('an owner that never reads the ledger times out and leaves no request', async (t) => {
  const { b, registry } = await transfer(t);
  const before = await registry.claims();
  await assert.rejects(
    b.coordination.takeTask('task:shared', 3000),
    /did not answer\. Restart Witch in that conversation or close it, then run \/task take again\./,
  );
  assert.deepEqual(await registry.claims(), before);
  assert.equal(b.coordination.snapshot.error, undefined);
});

test('a requester that switches conversations stops waiting and withdraws its request', async (t) => {
  const { b, requested, registry } = await transfer(t);
  const before = await registry.claims();
  const started = Date.now();
  const taking = b.coordination.takeTask('task:shared');
  await requested();
  const switching = b.coordinator.newConversation();
  await assert.rejects(taking, /no longer current/);
  await switching;
  assert.ok(Date.now() - started < 5000, 'the wait ended with the switch');
  assert.deepEqual(await registry.claims(), before);
});

test('an owner that closes while a request is pending reports the release', async (t) => {
  const { a, b, requested } = await transfer(t);
  const taking = b.coordination.takeTask('task:shared');
  await requested();
  await a.coordinator.close();
  await assert.rejects(taking, /task:shared was released\. Claim it again\./);
});

test('an agent control request cannot take a task', async (t) => {
  const { b, registry } = await transfer(t);
  const before = await registry.claims();
  const result = await callControl(await b.binding(), {
    kind: 'take',
    input: { reference: 'task:shared' },
  });
  assert.deepEqual(
    result.kind === 'error' && result.message,
    'Only the user can move a task between conversations. Ask them to run /task take <reference> here.',
  );
  assert.deepEqual(await registry.claims(), before);
});

test('a conflict reply names /task take with the reference the agent used', async (t) => {
  const { b } = await transfer(t);
  const conflict = await b.claim('task:Shared', 'Other work');
  assert.equal(conflict.kind, 'conflict');
  assert.match(
    conflict.kind === 'conflict' ? conflict.message : '',
    /The user can move it here with \/task take task:Shared once its owner is idle\.$/,
  );
});
