import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { main } from '../src/memory/memory.js';
import { ConversationStore } from '../src/persistence/store.js';
import { TurnGate } from './fixtures/agent.js';
import { record, readRecord, fixture } from './fixtures/coordinator.js';
import { until, within } from './fixtures/within.js';

await test('handoff returns to the original native session with updated context, and a switch to the current or an uninstalled agent sends nothing', async () => {
  const { coordinator, a, b } = await fixture();
  try {
    await coordinator.send(' Start the migration\n');
    const original = a.inputs[0]!.session;
    await coordinator.switchAgent('b');
    assert.match(b.inputs[0]!.prompt, /a: finish the migration/);
    await coordinator.switchAgent('a');
    assert.equal(a.inputs.at(-1)!.session, original);
    assert.match(a.inputs.at(-1)!.prompt, /b: finish the migration/);
    assert.equal(coordinator.snapshot.conversation?.agent, 'a');
    assert.equal(
      coordinator.snapshot.conversation?.title,
      'Start the migration',
    );
    const sent = a.inputs.length;
    await coordinator.switchAgent('a');
    await assert.rejects(coordinator.switchAgent('c'), /c is not installed/);
    assert.equal(a.inputs.length, sent);
  } finally {
    await coordinator.close();
  }
});

await test('destination startup failure retains the source conversation and session', async () => {
  const { coordinator, a, b, root } = await fixture();
  try {
    await coordinator.send('Start');
    b.failConnect = true;
    await assert.rejects(
      coordinator.switchAgent('b'),
      /Destination unavailable/,
    );
    assert.equal(coordinator.snapshot.conversation?.agent, 'a');
    const saved = await readRecord(root, coordinator.snapshot.conversation!.id);
    assert.equal(saved.sessions.a?.id, a.inputs[0]?.session);
    await coordinator.send('Continue the original task');
    assert.equal(a.inputs.at(-1)?.session, a.inputs[0]?.session);
  } finally {
    await coordinator.close();
  }
});

for (const stage of [
  'summarizing',
  'summary-saved',
  'destination-connected',
  'activated',
  'continuing',
  'completed',
] as const) {
  await test(`restart at handoff stage ${stage} preserves the active agent without replaying input`, async () => {
    const {
      coordinator: original,
      store,
      memory,
      a,
      b,
      project,
      reopen,
    } = await fixture();
    const id = original.snapshot.conversation!.id;
    await original.close();
    const activated = ['activated', 'continuing', 'completed'].includes(stage);
    const files = await store.claim(id);
    const conversation = files.record;
    conversation.agent = activated ? 'b' : 'a';
    conversation.sessions.a = {
      id: 'original-a',
      model: 'a-model',
      hasHistory: true,
    };
    if (stage !== 'summarizing' && stage !== 'summary-saved')
      conversation.sessions.b = {
        id: 'destination-b',
        model: 'b-model',
        hasHistory: stage === 'continuing' || stage === 'completed',
      };
    conversation.handoff = {
      from: 'a',
      to: 'b',
      activated,
      summary: stage === 'summarizing' ? undefined : 'Continue the migration',
    };
    if (stage === 'continuing')
      conversation.activity = {
        id: 'interrupted-destination-turn',
        agent: 'b',
        kind: 'turn',
        baseRevision: await memory.resolve(main),
        startedAt: new Date().toISOString(),
      };
    await files.append({
      id: 'earlier',
      kind: 'user',
      text: 'Start the migration',
      cwd: project,
    });
    await files.save(conversation);
    await files.close();
    const restarted = await reopen();
    try {
      assert.equal(
        restarted.snapshot.conversation!.agent,
        activated ? 'b' : 'a',
      );
      assert.equal(restarted.snapshot.conversation!.cwd, project);
      assert.equal(a.inputs.length + b.inputs.length, 0);
      await restarted.send('Resume manually');
      const active = activated ? b : a;
      const prior = conversation.sessions[active.id]!;
      if (prior.hasHistory) assert.equal(active.inputs[0]!.session, prior.id);
      else assert.notEqual(active.inputs[0]!.session, prior.id);
      assert.ok(active.inputs[0]!.prompt.includes('Resume manually'));
      assert.equal(
        active.inputs[0]!.prompt.includes('Continue the migration'),
        activated,
      );
      assert.equal(restarted.snapshot.conversation!.handoff, undefined);
    } finally {
      await restarted.close();
    }
  });
}

await test('undelivered handoff context survives visiting another conversation and clears only after success', async () => {
  const {
    coordinator: original,
    store,
    a,
    b,
    project,
    reopen,
  } = await fixture();
  const id = original.snapshot.conversation!.id;
  await original.close();
  const files = await store.claim(id);
  const conversation = files.record;
  conversation.agent = 'b';
  conversation.handoff = {
    from: 'a',
    to: 'b',
    activated: true,
    summary: 'Unique pending objective: amber-195.',
  };
  conversation.sessions.b = {
    id: 'destination',
    model: 'b-model',
    hasHistory: false,
  };
  await files.append({
    id: 'earlier',
    kind: 'user',
    text: 'Start',
    cwd: project,
  });
  await files.save(conversation);
  await files.close();
  const coordinator = await reopen();
  try {
    await coordinator.newConversation('a');
    await coordinator.send('Independent task');
    assert.doesNotMatch(a.inputs.at(-1)!.prompt, /amber-195/);
    await coordinator.selectConversation(conversation.id);
    b.interruptNext = true;
    await coordinator.send('Continue');
    assert.match(b.inputs.at(-1)!.prompt, /amber-195/);
    assert.ok(coordinator.snapshot.conversation!.handoff);
    b.interruptNext = true;
    await assert.rejects(coordinator.switchAgent('a'), /interrupted/);
    await coordinator.send('Continue manually');
    assert.match(b.inputs.at(-1)!.prompt, /amber-195/);
    assert.equal(coordinator.snapshot.conversation!.handoff, undefined);
  } finally {
    await coordinator.close();
  }
});

for (const reason of ['held', 'bad history'] as const) {
  await test(`a switch to a conversation with ${reason} keeps the current conversation, session and lock`, async () => {
    const { coordinator, store, a, root, project } = await fixture();
    const target = await store.create(record(randomUUID(), project));
    try {
      await coordinator.send('Start');
      const current = coordinator.snapshot.conversation!.id;
      if (reason === 'bad history') {
        await target.close();
        await writeFile(
          join(
            root,
            'state',
            'conversations',
            target.record.id,
            'history.jsonl',
          ),
          '{"id":\n',
        );
      }
      const connects = a.sessions.length;
      await assert.rejects(
        coordinator.selectConversation(target.record.id),
        reason === 'held' ? /open in another Witch instance/ : /JSON/,
      );
      assert.equal(coordinator.snapshot.conversation!.id, current);
      await assert.rejects(
        store.claim(current),
        /open in another Witch instance/,
      );
      assert.equal(a.sessions.at(-1)!.session.closed, false);
      assert.equal(a.sessions.length, connects);
      if (reason === 'bad history')
        await (await store.claim(target.record.id)).close();
    } finally {
      await target.close();
      await coordinator.close();
    }
  });
}

await test('selecting the current conversation keeps its session and claim', async () => {
  const { coordinator, store, a } = await fixture();
  try {
    await coordinator.send('Start');
    const current = coordinator.snapshot.conversation!.id;
    await coordinator.selectConversation(current);
    assert.equal(a.sessions.at(-1)!.session.closed, false);
    await assert.rejects(
      store.claim(current),
      /open in another Witch instance/,
    );
    assert.equal(coordinator.snapshot.error, undefined);
  } finally {
    await coordinator.close();
  }
});

async function failedCloseSwitch() {
  const context = await fixture();
  const { coordinator, store, a, project } = context;
  await coordinator.send('Start');
  const previous = coordinator.snapshot.conversation!.id;
  const released = a.sessions.at(-1)!.options;
  const target = await store.create({
    ...record(randomUUID(), project),
    handoff: { from: 'b', to: 'a', activated: false },
  });
  await target.close();
  a.failClose = true;
  await coordinator.selectConversation(target.record.id);
  a.failClose = false;
  return { ...context, previous, released, target: target.record.id };
}

await test('a disconnect that throws during a switch still adopts the new conversation', async () => {
  const { coordinator, store, previous, target } = await failedCloseSwitch();
  try {
    assert.equal(coordinator.snapshot.conversation!.id, target);
    assert.equal(coordinator.snapshot.conversation!.handoff, undefined);
    assert.match(coordinator.snapshot.error ?? '', /Close failed/);
    await (await store.claim(previous)).close();
  } finally {
    await coordinator.close();
  }
});

await test('a late event from a released session reaches neither conversation', async () => {
  const { coordinator, root, previous, released, target } =
    await failedCloseSwitch();
  const sleeper = spawn('/bin/sleep', ['5'], { stdio: 'ignore' });
  try {
    const reported = coordinator.snapshot.error;
    const errors: (string | undefined)[] = [];
    coordinator.subscribe(() => errors.push(coordinator.snapshot.error));
    const files = (id: string) =>
      Promise.all(
        ['state.json', 'history.jsonl'].map((name) =>
          readFile(
            join(root, 'state', 'conversations', id, name),
            'utf8',
          ).catch(() => ''),
        ),
      );
    const before = await files(previous);
    const adopted = await files(target);
    const items = coordinator.snapshot.items;
    released.onEvent({ type: 'text', id: 'late', text: 'Late text' });
    let rejection: unknown;
    await within(
      released.onProcess(sleeper.pid).catch((error: unknown) => {
        rejection = error;
      }),
      2000,
      'the late process report',
    );
    assert.equal(rejection, undefined);
    for (let elapsed = 0; elapsed < 200; elapsed += 20) {
      assert.deepEqual(await files(previous), before);
      assert.deepEqual(await files(target), adopted);
      await delay(20);
    }
    assert.equal(coordinator.snapshot.items, items);
    assert.notEqual((await readRecord(root, target)).process?.pid, sleeper.pid);
    assert.deepEqual(
      errors.filter((error) => error !== reported),
      [],
    );
  } finally {
    sleeper.kill('SIGKILL');
    await coordinator.close();
  }
});

await test('switching between conversations on one agent connects a fresh native session', async () => {
  const { coordinator, a, root } = await fixture();
  try {
    await coordinator.send('First');
    const first = coordinator.snapshot.conversation!.id;
    assert.ok((await readRecord(root, first)).process);
    await coordinator.newConversation('a');
    assert.equal((await readRecord(root, first)).process, undefined);
    await coordinator.send('Second');
    assert.notEqual(a.inputs.at(-1)!.session, a.inputs[0]!.session);
  } finally {
    await coordinator.close();
  }
});

/** a conversation on agent a with one turn, ready to hand off to b. */
async function handoffFixture() {
  const context = await fixture();
  await context.coordinator.send('Start the migration');
  const source = context.a.inputs[0]!.session;
  const assertSourceActive = async () => {
    const { coordinator, a, root } = context;
    const conversation = coordinator.snapshot.conversation!;
    assert.equal(conversation.agent, 'a');
    assert.equal(conversation.handoff, undefined);
    assert.equal(
      (await readRecord(root, conversation.id)).sessions.a?.id,
      source,
    );
    assert.equal(a.sessions.at(-1)!.session.closed, true);
    a.gate = undefined;
    await coordinator.send('Continue here');
    assert.equal(a.inputs.at(-1)!.session, source);
  };
  return { ...context, assertSourceActive };
}

await test('a handoff cancelled during the summary keeps the source', async () => {
  const context = await handoffFixture();
  const { coordinator, a } = context;
  const gate = new TurnGate();
  a.gate = gate;
  try {
    const switching = coordinator.switchAgent('b');
    await within(gate.entered, 2000, 'the summary turn');
    await coordinator.interrupt();
    await assert.rejects(switching, /interrupted/);
    await context.assertSourceActive();
  } finally {
    gate.open();
    await coordinator.close();
  }
});

await test('a handoff cancelled while the summary is saved never connects the destination', async () => {
  const context = await handoffFixture();
  const { coordinator, a, b } = context;
  const gate = new TurnGate();
  a.gate = gate;
  const save = ConversationStore.prototype.save;
  const held = Promise.withResolvers<void>();
  const holding = Promise.withResolvers<void>();
  try {
    const switching = coordinator.switchAgent('b');
    await within(gate.entered, 2000, 'the summary turn');
    // the summary turn saves first, without a handoff
    ConversationStore.prototype.save = function (record) {
      if (!record.handoff) return save.call(this, record);
      ConversationStore.prototype.save = save;
      holding.resolve();
      return held.promise.then(() => save.call(this, record));
    };
    gate.open();
    await within(holding.promise, 2000, 'the save of the summary');
    const connects = b.sessions.length;
    await coordinator.interrupt();
    held.resolve();
    await assert.rejects(switching, /interrupted/);
    assert.equal(b.sessions.length, connects);
    await context.assertSourceActive();
  } finally {
    ConversationStore.prototype.save = save;
    held.resolve();
    gate.open();
    await coordinator.close();
  }
});

await test('a handoff cancelled during the destination connect keeps the source', async () => {
  const context = await handoffFixture();
  const { coordinator, b } = context;
  const connecting = Promise.withResolvers<void>();
  b.beforeConnect = async (options) => {
    connecting.resolve();
    await new Promise((resolve) =>
      options.signal?.addEventListener('abort', resolve, { once: true }),
    );
  };
  try {
    const switching = coordinator.switchAgent('b');
    await within(connecting.promise, 2000, 'the destination connect');
    await coordinator.interrupt();
    await assert.rejects(switching, /interrupted/);
    await context.assertSourceActive();
  } finally {
    await coordinator.close();
  }
});

await test('a handoff cancelled during the continuation stays with the destination', async () => {
  const context = await handoffFixture();
  const { coordinator, b } = context;
  const gate = new TurnGate();
  b.gate = gate;
  try {
    const switching = coordinator.switchAgent('b');
    await within(gate.entered, 2000, 'the continuation');
    await coordinator.interrupt();
    await within(switching, 2000, 'the handoff');
    const conversation = coordinator.snapshot.conversation!;
    assert.equal(conversation.agent, 'b');
    assert.equal(conversation.handoff?.activated, true);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

await test('a prompt sent during a handoff waits and goes to the destination', async () => {
  const { coordinator, a, b } = await handoffFixture();
  const gate = new TurnGate();
  a.gate = gate;
  try {
    const switching = coordinator.switchAgent('b');
    await within(gate.entered, 2000, 'the summary turn');
    await coordinator.send('During');
    assert.deepEqual(a.steers, []);
    assert.deepEqual(coordinator.snapshot.queue, ['During']);
    gate.open();
    await within(switching, 2000, 'the handoff');
    await until('the queued prompt', () =>
      b.inputs.some(({ prompt }) => prompt.endsWith('User request:\nDuring')),
    );
  } finally {
    gate.open();
    await coordinator.close();
  }
});
