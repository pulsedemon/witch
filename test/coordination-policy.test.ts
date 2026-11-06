import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import {
  unitCoordinationFixture,
  git,
  legacyLock,
  pauseDiscovery,
} from './fixtures/coordination.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import { record } from './fixtures/coordinator.js';
import { selectionTurn } from './fixtures/task-selection.js';
import { until } from './fixtures/within.js';

test('solo context retains PR claims and selection without requiring other task claims', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start } = await unitCoordinationFixture(cleanup);
  const a = await start();
  const choosing = await selectionTurn(cleanup, a);
  const input = a.a.inputs.at(-1)!;
  assert.equal(input.prompt, 'Choose the next task');
  assert.doesNotMatch(input.context!, /--release|Before starting a new task/);
  assert.match(
    input.context!,
    /New work needs no claim or pre-task peer query/,
  );
  for (const command of [
    '--select-next',
    '--recommend',
    '--cancel-selection',
    // a solo session can still pause sessions in other projects
    '--pause --json',
    '--to <session-id>',
  ])
    assert.ok(input.context!.includes(command));
  assert.match(input.context!, /--claim/);
  assert.match(input.context!, /Open pull requests still need an active claim/);
  assert.match(input.context!, /Control command:/);
  assert.match(input.context!, /Session coordination:/);
  assert.ok(input.context!.includes(`Selection turn: ${choosing.turn}`));
  const selection = await choosing.select();
  assert.equal(selection.position, 1);
});

test('policy overrides survive fixed-instruction caching and ignore other projects', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start } = await unitCoordinationFixture(cleanup);
  const a = await start();
  const send = async (prompt: string, required: boolean, fixed: boolean) => {
    await a.coordinator.send(prompt);
    const input = a.a.inputs.at(-1)!;
    assert.equal(input.prompt, prompt);
    assert.equal(input.context!.includes('Control command:'), fixed);
    assert.equal(
      input.context!.includes('Claim coordination is required'),
      required,
    );
    assert.equal(input.context!.includes('New work needs no claim'), !required);
    assert.equal(input.context!.includes('--claim'), fixed);
    assert.equal(
      input.context!.includes('has no current verified usable credits'),
      required && fixed,
    );
  };
  await send('First solo request', false, true);
  await send('Second solo request', false, false);
  await start('C');
  await send('Another project is open', false, false);
  const b = await start('B');
  await send('A possible owner joined', true, true);
  await send('The same owner remains', true, false);
  await b.coordinator.close();
  await send('The possible owner left', false, true);
  await send('Still solo', false, false);
});

test('a reservation retains claim instructions without a same-project peer', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { root, start } = await unitCoordinationFixture(cleanup);
  const a = await start();
  const b = await start('B');
  const held = await b.claim('task:reserved');
  assert.equal(held.kind, 'claimed');
  await git(
    '-C',
    join(root, 'B'),
    'remote',
    'set-url',
    'origin',
    join(root, 'other'),
  );
  await b.coordination.context();
  await until(
    'the peer published its new project',
    async () => (await a.query()).peers.length === 0,
  );
  const input = await a.coordination.context();
  assert.equal(input.snapshot.error, undefined);
  assert.deepEqual(input.snapshot.peers, []);
  assert.equal(input.snapshot.reservations.length, 1);
  assert.match(input.instructions, /--claim/);
  assert.match(input.context, /Claim any unclaimed task already underway/);
  assert.equal((await a.claim('task:reserved')).kind, 'conflict');
});

test('an unregistered owner retains claim instructions', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { root, start, store } = await unitCoordinationFixture(cleanup);
  const a = await start();
  const legacy = record(randomUUID(), join(root, 'B'));
  await (await store.create(legacy)).close();
  const lock = await legacyLock(store, legacy.id);
  cleanup(() => lock.close());
  const input = await a.coordination.context();
  assert.equal(input.snapshot.error, undefined);
  assert.deepEqual(input.snapshot.peers, []);
  assert.deepEqual(
    input.snapshot.unregistered.map(({ id }) => id),
    [legacy.id],
  );
  assert.match(input.instructions, /--claim/);
  assert.match(input.context, /Claim coordination is required/);
});

test('failed discovery never grants solo policy', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  pauseDiscovery(vi.spyOn);
  const { start, store } = await unitCoordinationFixture(cleanup);
  const a = await start();
  const id = randomUUID();
  const held = await store.create(
    record(id, a.coordinator.snapshot.conversation!.cwd),
  );
  cleanup(() => held.close());
  await writeFile(
    join(store.root, 'conversations', id, 'state.json'),
    '{broken',
  );
  const input = await a.coordination.context();
  assert.deepEqual(input.snapshot.peers, []);
  assert.deepEqual(input.snapshot.reservations, []);
  assert.ok(input.snapshot.error);
  assert.match(input.instructions, /--claim/);
  assert.match(input.context, /Coordination is unavailable/);
  assert.match(input.context, /Claim coordination is required/);
  assert.doesNotMatch(input.context, /New work needs no claim/);
});

for (const owned of ['active claim', 'recorded suggestion']) {
  test(`a solo ${owned} retains release instructions and its reservation`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);
    const { start, registry } = await unitCoordinationFixture(cleanup);
    const a = await start();
    if (owned === 'active claim')
      assert.equal((await a.claim()).kind, 'claimed');
    else {
      const choosing = await selectionTurn(cleanup, a);
      const { ticket } = await choosing.select();
      await choosing.recommend(ticket.id);
      await choosing.finish();
    }
    const before = await registry.claims();
    assert.equal(before.length, 1);
    const input = await a.coordination.context();
    assert.deepEqual(input.snapshot.ownClaim, before[0]);
    assert.match(input.instructions, /--release <claim-id>/);
    assert.match(
      input.instructions,
      /release only after the task and its delegated work have ended/,
    );
    assert.match(
      input.instructions,
      /--cancel-selection removes only its selection ticket/,
    );
    assert.match(input.instructions, /--claim/);
    assert.match(
      input.instructions,
      /Promote its suggestion to an active claim for Copilot watching/,
    );
    assert.match(input.context, /New work needs no claim/);
    assert.deepEqual(await registry.claims(), before);
    await a.coordinator.releaseTask();
    assert.deepEqual(await registry.claims(), []);
    assert.doesNotMatch(
      (await a.coordination.context()).instructions,
      /--release/,
    );
  });
}
