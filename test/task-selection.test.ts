import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { CoordinationStore } from '../src/persistence/coordination.js';
import { callControl } from '../src/persistence/control.js';
import { identifyProcess } from '../src/persistence/process.js';
import {
  ConversationStore,
  LockedElsewhere,
} from '../src/persistence/store.js';
import { coordinationFixture, git } from './fixtures/coordination.js';
import { record } from './fixtures/coordinator.js';
import { selectionTurn } from './fixtures/task-selection.js';
import { until, within } from './fixtures/within.js';

for (const failed of [false, true]) {
  await test(`${failed ? 'failed' : 'completed'} selection turns release the next waiter`, async (t) => {
    const f = await coordinationFixture(t);
    const a = await f.start(),
      b = await f.start('B');
    const first = await selectionTurn(t, a),
      second = await selectionTurn(t, b);
    await first.select();
    const queued = await second.select();
    assert.equal(queued.position, 2);
    a.a.failNext = failed;
    await first.finish();
    const next = await callControl(second.binding, {
      kind: 'selection-status',
      selection: queued.ticket.id,
    });
    assert.equal(next.kind, 'selection');
    if (next.kind === 'selection') assert.equal(next.selection.position, 1);
    assert.deepEqual(
      (await f.registry.state()).selections.map((ticket) => ticket.id),
      [queued.ticket.id],
    );
  });
}

await test('failed head cleanup retries while idle and old cleanup cannot cancel a later turn', async (t) => {
  const f = await coordinationFixture(t);
  const a = await f.start(),
    b = await f.start('B');
  const first = await selectionTurn(t, a),
    second = await selectionTurn(t, b);
  const initial = await first.select(),
    queued = await second.select();
  const cancel = CoordinationStore.prototype.cancelSelection;
  let rejected = false;
  t.mock.method(
    CoordinationStore.prototype,
    'cancelSelection',
    async function (
      this: CoordinationStore,
      ...args: Parameters<typeof cancel>
    ) {
      if (!rejected && args[0].turn === first.turn) {
        rejected = true;
        throw new Error('Temporary selection cleanup failure');
      }
      return cancel.apply(this, args);
    },
  );
  await first.finish();
  assert.equal(a.coordinator.snapshot.phase, 'idle');
  assert.match(
    a.coordinator.snapshot.error ?? '',
    /Temporary selection cleanup failure/,
  );
  await until(
    'automatic cleanup while the owner stays idle',
    async () => (await f.registry.state()).selections.length === 1,
  );
  assert.equal(rejected, true);
  const next = await callControl(second.binding, {
    kind: 'selection-status',
    selection: queued.ticket.id,
  });
  if (next.kind !== 'selection') assert.fail(JSON.stringify(next));
  assert.equal(next.selection.position, 1);
  const later = await selectionTurn(t, a);
  const newer = await later.select();
  await f.registry.cancelSelection(
    initial.ticket,
    undefined,
    Date.now() + 1000,
    async () => {},
  );
  assert.ok(
    (await f.registry.state()).selections.some(
      (ticket) => ticket.id === newer.ticket.id,
    ),
  );
});

await test('interruption revokes selection before native cancellation resolves', async (t) => {
  const f = await coordinationFixture(t);
  const a = await f.start();
  const first = await selectionTurn(t, a);
  const ticket = await first.select();
  const native = a.a.sessions.at(-1)!.session;
  const interrupt = native.interrupt.bind(native);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  native.interrupt = async () => {
    entered.resolve();
    await release.promise;
    await interrupt();
  };
  const stopping = a.coordinator.interrupt();
  try {
    await within(entered.promise, 2000, 'native interrupt entered');
    const stale = await callControl(first.binding, {
      kind: 'select-next',
      turn: first.turn,
    });
    assert.equal(stale.kind, 'error');
    await until(
      'cancelled selection removed',
      async () => !(await f.registry.state()).selections.length,
    );
    const before = await f.ledger();
    assert.equal(
      (
        await callControl(first.binding, {
          kind: 'recommend',
          selection: ticket.ticket.id,
          input: { reference: 'task:late', summary: 'Late work' },
        })
      ).kind,
      'error',
    );
    assert.equal(await f.ledger(), before);
  } finally {
    release.resolve();
    await stopping;
    await first.sending;
    native.interrupt = interrupt;
  }
});

await test('a client-delayed request from an interrupted turn cannot enter a later turn', async (t) => {
  const f = await coordinationFixture(t);
  const a = await f.start();
  const first = await selectionTurn(t, a);
  const old = await first.select();
  const delayed = { kind: 'select-next' as const, turn: first.turn };
  await a.coordinator.interrupt();
  await first.sending;
  const later = await selectionTurn(t, a);
  const current = await later.select();
  assert.equal(first.binding.activation, later.binding.activation);
  const before = await f.ledger();
  assert.equal((await callControl(first.binding, delayed)).kind, 'error');
  assert.equal(
    (
      await callControl(first.binding, {
        kind: 'cancel-selection',
        selection: old.ticket.id,
      })
    ).kind,
    'selection-cancelled',
  );
  assert.equal(await f.ledger(), before);
  assert.deepEqual((await f.registry.state()).selections, [current.ticket]);
});

await test('cancelled status and recommendation never recreate a selection', async (t) => {
  const f = await coordinationFixture(t);
  const a = await f.start();
  const turn = await selectionTurn(t, a),
    choice = await turn.select();
  assert.equal(
    (
      await callControl(turn.binding, {
        kind: 'cancel-selection',
        selection: choice.ticket.id,
      })
    ).kind,
    'selection-cancelled',
  );
  const before = await f.ledger();
  assert.equal(
    (
      await callControl(turn.binding, {
        kind: 'selection-status',
        selection: choice.ticket.id,
      })
    ).kind,
    'error',
  );
  assert.equal(
    (
      await callControl(turn.binding, {
        kind: 'recommend',
        selection: choice.ticket.id,
        input: { reference: 'task:late', summary: 'Late' },
      })
    ).kind,
    'error',
  );
  assert.equal(await f.ledger(), before);
});

await test('recommendation keeps the next chooser waiting until a brew ends', async (t) => {
  const f = await coordinationFixture(t);
  const a = await f.start(),
    b = await f.start('B');
  const first = await selectionTurn(t, a),
    second = await selectionTurn(t, b);
  const head = await first.select(),
    waiting = await second.select();
  const emit = a.a.sessions.at(-1)!.options.onEvent;
  const command = { id: 'triage', description: 'Inspect candidate tasks' };
  emit({ type: 'command', command: { ...command, status: 'running' } });
  const before = await f.ledger();
  const action = {
    kind: 'recommend' as const,
    selection: head.ticket.id,
    input: { reference: 'task:chosen', summary: 'Chosen task' },
  };
  const blocked = await callControl(first.binding, action);
  if (blocked.kind !== 'error') assert.fail(JSON.stringify(blocked));
  assert.match(blocked.message, /familiars and brews/);
  assert.equal(await f.ledger(), before);
  const queued = await callControl(second.binding, {
    kind: 'selection-status',
    selection: waiting.ticket.id,
  });
  if (queued.kind !== 'selection') assert.fail(JSON.stringify(queued));
  assert.equal(queued.selection.position, 2);
  emit({ type: 'command', command: { ...command, status: 'completed' } });
  const recommended = await callControl(first.binding, action);
  if (recommended.kind !== 'claimed') assert.fail(JSON.stringify(recommended));
  assert.equal(recommended.claim.suggestion?.selection, head.ticket.id);
  const ready = await callControl(second.binding, {
    kind: 'selection-status',
    selection: waiting.ticket.id,
  });
  if (ready.kind !== 'selection') assert.fail(JSON.stringify(ready));
  assert.equal(ready.selection.position, 1);
});

await test('normal exit releases a suggestion while restart and native handoff preserve it', async (t) => {
  const f = await coordinationFixture(t);
  const a = await f.start();
  const turn = await selectionTurn(t, a),
    choice = await turn.select();
  const suggestion = await turn.recommend(choice.ticket.id);
  await turn.finish();
  a.a.gate = undefined;
  await a.coordinator.selectModel({ agent: 'b', id: 'b-model' });
  assert.notEqual((await a.binding()).activation, turn.binding.activation);
  assert.deepEqual(await f.registry.claims(), [suggestion]);
  await a.coordinator.close({ restart: true });
  assert.deepEqual(await f.registry.claims(), [suggestion]);
  const reopened = await f.start('A', {
    conversation: turn.binding.conversation,
  });
  assert.deepEqual((await reopened.query()).ownClaim, suggestion);
  await reopened.coordinator.close();
  assert.deepEqual(await f.registry.claims(), []);
});

await test('replacing a conversation releases every active alias and preserves another open owner', async (t) => {
  const f = await coordinationFixture(t);
  const a = await f.start(),
    b = await f.start('B');
  const binding = await a.binding();
  const held = await callControl(binding, {
    kind: 'claim',
    input: {
      reference: 'https://github.com/acme/queue/issues/17',
      aliases: ['https://github.com/acme/queue/pull/19'],
      summary: 'Active work',
    },
  });
  assert.equal(held.kind, 'claimed');
  assert.equal(
    (await b.claim('https://github.com/acme/queue/issues/19')).kind,
    'conflict',
  );
  const other = await b.claim('task:other');
  if (other.kind !== 'claimed') assert.fail(JSON.stringify(other));
  await assert.rejects(
    a.coordinator.selectConversation(b.coordinator.snapshot.conversation!.id),
    LockedElsewhere,
  );
  assert.equal((await f.registry.claims()).length, 2);
  await a.coordinator.newConversation();
  assert.notEqual(
    a.coordinator.snapshot.conversation!.id,
    binding.conversation,
  );
  assert.deepEqual(await f.registry.claims(), [other.claim]);
  await b.coordination.releaseTask();
  assert.equal(
    (await b.claim('https://github.com/acme/queue/issues/19')).kind,
    'claimed',
  );
});

await test('active claims survive reconnect and restart but normal close makes them available', async (t) => {
  const f = await coordinationFixture(t);
  const a = await f.start(),
    b = await f.start('B');
  const binding = await a.binding();
  const first = await a.claim();
  if (first.kind !== 'claimed') assert.fail(JSON.stringify(first));
  assert.equal((await b.claim()).kind, 'conflict');
  await a.coordinator.selectModel({ agent: 'b', id: 'b-model' });
  assert.notEqual((await a.binding()).activation, binding.activation);
  assert.deepEqual(await f.registry.claims(), [first.claim]);
  await a.coordinator.close({ restart: true });
  assert.deepEqual(await f.registry.claims(), [first.claim]);
  assert.equal((await b.claim()).kind, 'conflict');
  const reopened = await f.start('A', { conversation: binding.conversation });
  assert.equal((await reopened.query()).ownClaim?.id, first.claim.id);
  await reopened.coordinator.close();
  assert.deepEqual(await f.registry.claims(), []);
  assert.equal((await b.claim()).kind, 'claimed');
});

await test('adopting a legacy claim preserves its aliases through restart without binding another legacy owner', async (t) => {
  const f = await coordinationFixture(t);
  const id = randomUUID();
  const files = await f.store.create(record(id, join(f.root, 'A')));
  const other = await f.store.create(record('older-peer', join(f.root, 'B')));
  t.after(() => other.close());
  const { project } = await f.memory.scopePaths(join(f.root, 'A'));
  const original = {
    id: randomUUID(),
    owner: { conversation: id, project },
    references: ['github:acme/queue#17', 'github:acme/queue#19'],
    summary: 'Legacy work',
    createdAt: 1,
  };
  const otherClaim = {
    ...original,
    id: randomUUID(),
    owner: { conversation: other.record.id, project },
    references: ['github:acme/queue#90'],
  };
  await writeFile(
    join(f.store.root, 'coordination', 'claims.json'),
    JSON.stringify({ version: 1, claims: [original, otherClaim] }),
  );
  await files.close();
  const a = await f.start('A', { conversation: id });
  const adopted = { ...original, process: await identifyProcess(process.pid) };
  const migrated = JSON.parse(await f.ledger());
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.claims, [adopted, otherClaim]);
  await a.coordinator.selectModel({ agent: 'b', id: 'b-model' });
  await other.close();
  const b = await f.start('B');
  await a.coordinator.close({ restart: true });
  assert.equal(await f.store.isOpen(id), false);
  const refused = await b.claim('https://github.com/acme/queue/issues/19');
  assert.equal(refused.kind, 'conflict');
  assert.deepEqual(await f.registry.claims(), [adopted]);
  const resumed = await f.start('A', { conversation: id });
  assert.deepEqual((await resumed.query()).ownClaim, adopted);
  await resumed.coordinator.close();
  assert.deepEqual(await f.registry.claims(), []);
  assert.equal(
    (await b.claim('https://github.com/acme/queue/issues/19')).kind,
    'claimed',
  );
});

await test('restart recovers a departed claim release while preserving other open conversations', async (t) => {
  const f = await coordinationFixture(t);
  const a = await f.start(),
    b = await f.start('B');
  const binding = await a.binding();
  await a.claim();
  const other = await b.claim('task:other');
  if (other.kind !== 'claimed') assert.fail(JSON.stringify(other));
  const release = CoordinationStore.prototype.releaseConversation;
  let failing = true;
  t.mock.method(
    CoordinationStore.prototype,
    'releaseConversation',
    function (this: CoordinationStore, ...args: Parameters<typeof release>) {
      if (failing && args[0].conversation === binding.conversation)
        return Promise.reject(new Error('Claim cleanup unavailable'));
      return release.apply(this, args);
    },
  );
  await a.coordinator.newConversation().catch(() => {});
  const next = a.coordinator.snapshot.conversation!.id;
  assert.notEqual(next, binding.conversation);
  await a.coordinator.close({ restart: true }).catch(() => {});
  assert.equal((await f.registry.claims()).length, 2);
  failing = false;
  const reopened = await f.start('A', { conversation: next });
  assert.deepEqual(await f.registry.claims(), [other.claim]);
  assert.equal((await reopened.claim()).kind, 'claimed');
  assert.equal((await b.query()).ownClaim?.id, other.claim.id);
});

await test('failed target preparation keeps a suggestion and a successful switch releases it', async (t) => {
  const f = await coordinationFixture(t);
  const a = await f.start(),
    b = await f.start('B');
  const turn = await selectionTurn(t, a),
    choice = await turn.select();
  const suggestion = await turn.recommend(choice.ticket.id);
  await turn.finish();
  await assert.rejects(
    a.coordinator.selectConversation(b.coordinator.snapshot.conversation!.id),
    LockedElsewhere,
  );
  assert.deepEqual(await f.registry.claims(), [suggestion]);
  const items = t.mock.method(
    ConversationStore.prototype,
    'items',
    async () => {
      throw new Error('Target preparation failed');
    },
  );
  await assert.rejects(
    a.coordinator.newConversation(),
    /Target preparation failed/,
  );
  assert.deepEqual(await f.registry.claims(), [suggestion]);
  assert.equal(
    a.coordinator.snapshot.conversation!.id,
    turn.binding.conversation,
  );
  items.mock.restore();
  await a.coordinator.newConversation();
  assert.notEqual(
    a.coordinator.snapshot.conversation!.id,
    turn.binding.conversation,
  );
  assert.deepEqual(await f.registry.claims(), []);
});

await test('switching away releases a suggestion even when native close rejects', async (t) => {
  const f = await coordinationFixture(t);
  const a = await f.start();
  const turn = await selectionTurn(t, a),
    choice = await turn.select();
  await turn.recommend(choice.ticket.id);
  await turn.finish();
  a.a.failClose = true;
  await a.coordinator.newConversation();
  a.a.failClose = false;
  assert.notEqual(
    a.coordinator.snapshot.conversation!.id,
    turn.binding.conversation,
  );
  assert.deepEqual(await f.registry.claims(), []);
});

await test('an idle origin change retires a suggestion through ordinary reconnect', async (t) => {
  const f = await coordinationFixture(t);
  const a = await f.start();
  const turn = await selectionTurn(t, a),
    choice = await turn.select();
  await turn.recommend(choice.ticket.id);
  await turn.finish();
  await git(
    '-C',
    join(f.root, 'A'),
    'remote',
    'set-url',
    'origin',
    join(f.root, 'other'),
  );
  a.a.gate = undefined;
  await a.coordinator.send('Continue');
  assert.notEqual((await a.binding()).activation, turn.binding.activation);
  assert.deepEqual(await f.registry.claims(), []);
});

await test('an origin change inside ledger verification rejects and cancels without nested locking', async (t) => {
  const f = await coordinationFixture(t);
  const a = await f.start();
  const turn = await selectionTurn(t, a),
    choice = await turn.select();
  const scopePaths = f.memory.scopePaths.bind(f.memory);
  let reads = 0;
  t.mock.method(f.memory, 'scopePaths', async (cwd: string) => {
    if (cwd === join(f.root, 'A') && ++reads === 2)
      await git(
        '-C',
        cwd,
        'remote',
        'set-url',
        'origin',
        join(f.root, 'other'),
      );
    return scopePaths(cwd);
  });
  const result = await within(
    callControl(turn.binding, {
      kind: 'recommend',
      selection: choice.ticket.id,
      input: { reference: 'task:old', summary: 'Old project' },
    }),
    5000,
    'origin change rejection',
  );
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') assert.match(result.message, /project changed/);
  assert.deepEqual(await f.registry.state(), { claims: [], selections: [] });
});

await test('cleanup failure is surfaced while shutdown still closes native work and activation', async (t) => {
  const f = await coordinationFixture(t);
  const a = await f.start();
  const turn = await selectionTurn(t, a);
  await turn.select();
  const cancel = t.mock.method(
    CoordinationStore.prototype,
    'cancelSelection',
    async () => {
      throw new Error('Cleanup unavailable');
    },
  );
  try {
    await assert.rejects(a.coordinator.close(), /Cleanup unavailable/);
    assert.equal(a.a.sessions.at(-1)!.session.closed, true);
    assert.equal(await f.registry.isActive(turn.binding.activation), false);
    assert.deepEqual((await f.registry.state()).selections, []);
  } finally {
    cancel.mock.restore();
  }
});

await test('legacy peers block selection until closed while other projects select independently', async (t) => {
  const f = await coordinationFixture(t);
  const a = await f.start(),
    b = await f.start('B'),
    other = await f.start('C');
  const turn = await selectionTurn(t, a);
  const legacy = (await f.registry.presences()).find(
    (presence) => presence.id === b.coordinator.snapshot.conversation!.id,
  )!;
  delete legacy.selectionQueue;
  await f.registry.publish(legacy);
  const rejected = await callControl(turn.binding, {
    kind: 'select-next',
    turn: turn.turn,
  });
  assert.equal(rejected.kind, 'error');
  if (rejected.kind === 'error')
    assert.match(rejected.message, /Restart or close/);
  const independent = await selectionTurn(t, other);
  assert.equal((await independent.select()).position, 1);
  await b.coordinator.close();
  assert.equal((await turn.select()).position, 1);
});

await test('a lost recommendation reply reconciles to one claim and one advancement', async (t) => {
  const f = await coordinationFixture(t);
  const a = await f.start(),
    b = await f.start('B');
  const first = await selectionTurn(t, a),
    second = await selectionTurn(t, b);
  const choice = await first.select(),
    queued = await second.select();
  const recommend = CoordinationStore.prototype.recommend;
  let committed = false;
  t.mock.method(
    CoordinationStore.prototype,
    'recommend',
    async function (
      this: CoordinationStore,
      ...args: Parameters<typeof recommend>
    ) {
      const claim = await recommend.apply(this, args);
      if (!committed) {
        committed = true;
        throw new Error('Reply unavailable after commit');
      }
      return claim;
    },
  );
  const action = {
    kind: 'recommend' as const,
    selection: choice.ticket.id,
    input: {
      reference: 'https://github.com/acme/queue/issues/17',
      summary: 'Issue 17',
    },
  };
  assert.equal((await callControl(first.binding, action)).kind, 'error');
  const recorded = (await a.query()).ownClaim;
  assert.ok(recorded);
  const before = await f.ledger();
  const retried = await callControl(first.binding, action);
  assert.equal(retried.kind, 'claimed');
  if (retried.kind === 'claimed') assert.deepEqual(retried.claim, recorded);
  assert.equal(await f.ledger(), before);
  const next = await callControl(second.binding, {
    kind: 'selection-status',
    selection: queued.ticket.id,
  });
  if (next.kind !== 'selection') assert.fail(JSON.stringify(next));
  assert.equal(next.selection.position, 1);
  assert.equal((await f.registry.claims()).length, 1);
});

for (const active of [false, true])
  await test(`failed ${active ? 'active claim' : 'suggestion'} cleanup retries without removing a later recommendation`, async (t) => {
    const f = await coordinationFixture(t);
    const a = await f.start();
    const first = await selectionTurn(t, a),
      choice = await first.select();
    let previous = await first.recommend(choice.ticket.id);
    await first.finish();
    if (active) {
      const promoted = await a.claim('https://github.com/acme/queue/issues/17');
      if (promoted.kind !== 'claimed') assert.fail(JSON.stringify(promoted));
      previous = promoted.claim;
    }
    const release = CoordinationStore.prototype.releaseConversation;
    let failing = true;
    t.mock.method(
      CoordinationStore.prototype,
      'releaseConversation',
      function (this: CoordinationStore, ...args: Parameters<typeof release>) {
        return failing
          ? Promise.reject(new Error('Suggestion cleanup unavailable'))
          : release.apply(this, args);
      },
    );
    await a.coordinator.newConversation().catch(() => {});
    assert.match(
      a.coordinator.snapshot.error ?? '',
      /Suggestion cleanup unavailable/,
    );
    assert.notEqual(
      a.coordinator.snapshot.conversation!.id,
      first.binding.conversation,
    );
    assert.deepEqual(await f.registry.claims(), [previous]);
    failing = false;
    await until(
      'departed suggestion cleanup retried',
      async () => !(await f.registry.claims()).length,
    );
    await a.coordinator.selectConversation(first.binding.conversation);
    const later = await selectionTurn(t, a),
      next = await later.select();
    const current = await later.recommend(next.ticket.id, 18);
    await later.finish();
    await a.coordination.endTurn(first.turn);
    assert.deepEqual((await a.query()).ownClaim, current);
    assert.deepEqual(await f.registry.claims(), [current]);
  });
