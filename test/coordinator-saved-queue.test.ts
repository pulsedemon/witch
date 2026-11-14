import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import type { AgentSession } from '../src/agents/types.js';
import type { ConversationRecord } from '../src/core/state.js';
import { ConversationStore } from '../src/persistence/store.js';
import { TurnGate } from './fixtures/agent.js';
import { unitFixture, readRecord, turns } from './fixtures/coordinator.js';
import { until, within } from './fixtures/within.js';

const review = { name: 'review', description: 'Review changes' };

type Context = Awaited<ReturnType<typeof unitFixture>>;

const saved = async (
  f: Context,
  id = f.coordinator.snapshot.conversation!.id,
) => {
  const { queue, draft } = await readRecord(f.root, id);

  return { queue, draft };
};

/** every record saved from now on, as it was when saved. */
function captureSaves() {
  const records: ConversationRecord[] = [];
  const save = ConversationStore.prototype.save;

  const spy = vi
    .spyOn(ConversationStore.prototype, 'save')
    .mockImplementation(function (
      this: ConversationStore,
      record: ConversationRecord,
    ) {
      records.push(structuredClone(record));

      return save.call(this, record);
    });

  return { records, restore: () => spy.mockRestore() };
}

/** holds the session's next steer until it is accepted or refused. */
function holdSteer(session: AgentSession) {
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<boolean>();
  const steer = session.steer.bind(session);

  session.steer = async (...args) => {
    entered.resolve();

    return (await held.promise) && steer(...args);
  };

  return {
    entered: entered.promise,
    accept: () => held.resolve(true),
    refuse: () => held.resolve(false),
  };
}

/** a turn held open, with what is sent meanwhile queued behind it. */
async function queueBehind(f: Context, gate: TurnGate, prompts: string[]) {
  f.a.gate = gate;
  f.a.refuseSteer = true;
  const sending = f.coordinator.send('Start');

  sending.catch(() => {});

  await within(gate.entered, 2000, 'the gated turn');

  for (const prompt of prompts) await f.coordinator.send(prompt);

  // wrapped, since awaiting a returned promise would wait for the held turn
  return { sending };
}

test('prompts queued when Witch stops come back queued, stay held through other operations and run with the next prompt', async () => {
  const f = await unitFixture();
  const gate = new TurnGate();

  try {
    await queueBehind(f, gate, ['p1', 'p2']);

    await until(
      'the saved queue',
      async () => (await saved(f)).queue?.join() === 'p1,p2',
    );
  } finally {
    // closing interrupts the held turn before its queue can run
    await f.coordinator.close();

    gate.open();
  }

  const reopened = await f.reopen();

  try {
    assert.deepEqual(reopened.snapshot.queue, ['p1', 'p2']);

    const inputs = f.a.inputs.length;

    assert.equal(await reopened.refreshModels(), true);

    assert.equal(await reopened.compact(), true);

    assert.equal(f.a.inputs.length, inputs);

    assert.deepEqual(reopened.snapshot.queue, ['p1', 'p2']);

    await reopened.send('p3');

    assert.deepEqual(turns(f.a).slice(inputs), [['p1\np2\np3', undefined]]);
  } finally {
    await reopened.close();
  }
});

test('a prompt waiting on a steer is saved until the steer is accepted', async () => {
  const f = await unitFixture();
  const gate = new TurnGate();

  try {
    f.a.gate = gate;
    const sending = f.coordinator.send('Start');

    await within(gate.entered, 2000, 'the gated turn');

    const steer = holdSteer(f.a.sessions.at(-1)!.session);
    const following = f.coordinator.send('follow');

    await within(steer.entered, 2000, 'the held steer');

    await until(
      'the arriving prompt saved',
      async () => (await saved(f)).queue?.join() === 'follow',
    );

    steer.accept();

    await following;

    assert.deepEqual(f.a.steers, ['follow']);

    await until(
      'the steered prompt gone',
      async () => (await saved(f)).queue === undefined,
    );

    gate.open();

    await sending;
  } finally {
    gate.open();

    await f.coordinator.close();
  }
});

test('a composer submission moves its draft into the queue in one save, and another send keeps the draft', async () => {
  const f = await unitFixture();
  const gate = new TurnGate();
  const saves = captureSaves();

  try {
    const id = f.coordinator.snapshot.conversation!.id;
    const { sending } = await queueBehind(f, gate, []);

    f.coordinator.draft(id, '/x');

    const from = saves.records.length;

    // a spell completion submits the full name from a prefix
    await f.coordinator.send('/x-two', { composer: true });

    const submitted = saves.records.slice(from);

    assert.ok(submitted.length > 0);

    assert.ok(submitted.every(({ draft }) => draft === undefined));

    f.coordinator.draft(id, 'kept');

    await f.coordinator.send('kept');

    await until('the send saved', async () => {
      const { queue, draft } = await saved(f);

      return queue?.join() === '/x-two,kept' && draft === 'kept';
    });

    gate.open();

    await sending;
  } finally {
    saves.restore();

    gate.open();

    await f.coordinator.close();
  }
});

test('a batch is saved until its row is, through pre-turn compaction, and comes back once when its turn fails first', async () => {
  const f = await unitFixture();
  const start = new TurnGate();
  const compaction = new TurnGate();
  const turn = new TurnGate();

  try {
    const { sending } = await queueBehind(f, start, ['A']);
    f.a.sessions.at(-1)!.session.contextUsage = async () => 80;
    f.a.gate = compaction;

    start.open();

    await within(compaction.entered, 2000, 'the pre-turn compaction');

    assert.deepEqual(f.coordinator.snapshot.queue, []);

    await until(
      'the taken batch saved',
      async () => (await saved(f)).queue?.join() === 'A',
    );

    f.a.gate = turn;

    compaction.open();

    await within(turn.entered, 2000, 'the queued turn');

    await until(
      'the shown batch gone',
      async () => (await saved(f)).queue === undefined,
    );

    turn.open();

    await sending;

    const failing = new TurnGate();
    const { sending: next } = await queueBehind(f, failing, ['B']);

    await f.a.sessions.at(-1)!.session.close();

    f.a.failConnect = true;

    failing.open();

    await next;

    // closing the session also ends the held turn before its input was written, so both come back
    await until(
      'the failed batches requeued',
      () => f.coordinator.snapshot.queue.join() === 'Start,B',
    );

    assert.deepEqual((await saved(f)).queue, ['Start', 'B']);
  } finally {
    for (const gate of [start, compaction, turn]) gate.open();

    await f.coordinator.close();
  }
});

for (const unread of [['follow'], undefined])
  test(`a turn whose input was never written saves its batch back ${unread ? 'with the prompts it left unread' : 'alone'}`, async () => {
    const f = await unitFixture();
    const gate = new TurnGate();
    const saves = captureSaves();

    try {
      const { session } = f.a.sessions.at(-1)!;
      const send = session.send.bind(session);

      session.send = async (...args) => {
        await send(...args);

        return {
          status: 'failed',
          text: '',
          error: 'Input delivery failed',
          inputUnsent: true,
          ...(unread && { unread }),
        };
      };

      f.a.gate = gate;
      const sending = f.coordinator.send('Start');

      await within(gate.entered, 2000, 'the gated turn');

      if (unread) await f.coordinator.send('follow');

      f.a.refuseSteer = true;

      await f.coordinator.send('later');

      const from = saves.records.length;

      gate.open();

      await within(sending, 2000, 'the failed turn');

      const expected = ['Start', ...(unread ?? []), 'later'];

      assert.deepEqual(f.coordinator.snapshot.queue, expected);

      const after = saves.records.slice(from).map(({ queue }) => queue);

      assert.ok(after.length > 0);

      assert.ok(
        after.every((queue) => queue?.join() === expected.join()),
        JSON.stringify(after),
      );
    } finally {
      saves.restore();

      gate.open();

      await f.coordinator.close();
    }
  });

test('a ! command whose reply was never written stays off the saved queue', async () => {
  const f = await unitFixture();
  const gate = new TurnGate();

  try {
    const { sending } = await queueBehind(f, gate, ['!echo hi']);
    const { session } = f.a.sessions.at(-1)!;
    const send = session.send.bind(session);

    session.send = async (...args) => {
      await send(...args);

      return { status: 'failed', text: '', error: 'Lost', inputUnsent: true };
    };

    gate.open();

    await sending;

    await until('the command ran', () => f.a.shells.includes('echo hi'));

    await until('settled', () => f.coordinator.snapshot.phase !== 'running');

    assert.deepEqual(f.coordinator.snapshot.queue, []);

    assert.equal((await saved(f)).queue, undefined);
  } finally {
    gate.open();

    await f.coordinator.close();
  }
});

for (const outcome of ['accepted', 'refused'] as const)
  test(`a queued follower is saved while its steer waits, and once ${outcome}`, async () => {
    const f = await unitFixture(undefined, (a) => {
      a.skills = [review];
    });

    const first = new TurnGate();
    const second = new TurnGate();

    try {
      const { sending } = await queueBehind(f, first, ['/review now', 'B']);
      f.a.refuseSteer = false;
      f.a.gate = second;
      const steer = holdSteer(f.a.sessions.at(-1)!.session);

      first.open();

      await within(steer.entered, 2000, 'the follower steer');

      await until(
        'the follower saved',
        async () => (await saved(f)).queue?.join() === 'B',
      );

      if (outcome === 'accepted') steer.accept();
      else steer.refuse();

      await until(
        'the steer settled',
        async () =>
          (await saved(f)).queue?.join() ===
          (outcome === 'accepted' ? undefined : 'B'),
      );

      second.open();

      await sending;
    } finally {
      first.open();

      second.open();

      await f.coordinator.close();
    }
  });

test('handing the queue to the composer saves the merged draft in the same save', async () => {
  const f = await unitFixture();
  const gate = new TurnGate();
  const saves = captureSaves();

  try {
    const id = f.coordinator.snapshot.conversation!.id;
    const { sending } = await queueBehind(f, gate, ['p1']);

    f.coordinator.draft(id, 'x');

    const from = saves.records.length;

    assert.deepEqual(f.coordinator.unqueue('p1\nx'), ['p1']);

    const after = saves.records.slice(from);

    assert.ok(after.length > 0);

    for (const { queue = [], draft = '' } of after) {
      const held = [...queue, ...draft.split('\n')];

      assert.equal(held.filter((text) => text === 'p1').length, 1);

      assert.ok(held.includes('x'));
    }

    assert.deepEqual(
      [after.at(-1)!.queue, after.at(-1)!.draft],
      [undefined, 'p1\nx'],
    );

    gate.open();

    await sending;
  } finally {
    saves.restore();

    gate.open();

    await f.coordinator.close();
  }
});

test("a draft is saved as typed, reopens with an unused conversation, and another conversation's or a closed one's write is dropped", async () => {
  const f = await unitFixture();
  const id = f.coordinator.snapshot.conversation!.id;

  f.coordinator.draft(id, 'x');

  await until('the saved draft', async () => (await saved(f)).draft === 'x');

  await f.coordinator.close();

  const reopened = await f.reopen();

  try {
    assert.equal(reopened.snapshot.conversation!.id, id);

    assert.equal(reopened.snapshot.draft, 'x');

    await reopened.newConversation();

    assert.notEqual(reopened.snapshot.conversation!.id, id);

    assert.equal(reopened.snapshot.draft, undefined);

    reopened.draft(id, 'y');

    const other = reopened.snapshot.conversation!.id;

    reopened.draft(other, 'z');

    await until(
      'the new draft',
      async () => (await saved(f, other)).draft === 'z',
    );

    assert.equal((await saved(f, id)).draft, 'x');
  } finally {
    await reopened.close();
  }

  reopened.draft(reopened.snapshot.conversation!.id, 'late');

  assert.equal(reopened.snapshot.error, undefined);
});

test('restored image markers lose their numbers outside ! commands', async () => {
  const f = await unitFixture();
  const id = f.coordinator.snapshot.conversation!.id;

  await f.coordinator.close();

  const path = join(f.root, 'state', 'conversations', id, 'state.json');
  const record = JSON.parse(await readFile(path, 'utf8')) as ConversationRecord;

  await writeFile(
    path,
    JSON.stringify({
      ...record,
      queue: ['look [Image #2]', '!cat [Image #2]'],
      draft: 'and [Image #3]',
    }),
  );

  const reopened = await f.reopen();

  try {
    assert.deepEqual(reopened.snapshot.queue, [
      'look [Image]',
      '!cat [Image #2]',
    ]);

    assert.equal(reopened.snapshot.draft, 'and [Image]');
  } finally {
    await reopened.close();
  }
});
