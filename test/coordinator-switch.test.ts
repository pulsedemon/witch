import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { main } from '../src/memory/memory.js';
import type { SessionInfo } from '../src/agents/types.js';
import type { ConversationRecord } from '../src/core/state.js';
import { ConversationStore } from '../src/persistence/store.js';
import { holdConnect, TurnGate } from './fixtures/agent.js';
import { record, readRecord, fixture } from './fixtures/coordinator.js';
import { until, within } from './fixtures/within.js';

test('handoff returns to the original native session with updated context, and a switch to the current or an uninstalled agent sends nothing', async () => {
  const { coordinator, a, b } = await fixture();
  try {
    await coordinator.send(' Start the migration\n');
    const original = a.inputs[0]!.session;
    await coordinator.selectModel({ agent: 'b', id: 'b-model' });
    assert.equal(b.inputs.length, 0);
    await coordinator.send('Work on the destination');
    assert.match(b.inputs[0]!.context!, /a: finish the migration/);
    const sourceInputs = a.inputs.length;
    await coordinator.selectModel({ agent: 'a', id: 'a-model' });
    assert.equal(a.inputs.length, sourceInputs);
    await coordinator.send('Return to the original task');
    assert.equal(a.inputs.at(-1)!.session, original);
    assert.match(a.inputs.at(-1)!.context!, /b: finish the migration/);
    assert.equal(coordinator.snapshot.conversation?.agent, 'a');
    assert.equal(
      coordinator.snapshot.conversation?.title,
      'Start the migration',
    );
    const sent = a.inputs.length;
    await coordinator.selectModel({ agent: 'a', id: 'a-model' });
    await assert.rejects(
      coordinator.selectModel({ agent: 'c', id: 'c-model' }),
      /c is not installed/,
    );
    assert.equal(a.inputs.length, sent);
  } finally {
    await coordinator.close();
  }
});

for (const status of ['completed', 'interrupted', 'failed'] as const)
  for (const restart of [false, true])
    test(`handoff after a ${status} ordinary turn${restart ? ' survives restart' : ''}`, async () => {
      const f = await fixture();
      let coordinator = f.coordinator;
      const gate = new TurnGate();
      let switching: Promise<void> | undefined;
      try {
        f.a.interruptNext = status === 'interrupted';
        f.a.failNext = status === 'failed';
        await coordinator.send('Source task');
        const id = coordinator.snapshot.conversation!.id;
        const source = (await readRecord(f.root, id)).lastTurn;
        assert.equal(source?.status, status);
        if (restart) {
          await coordinator.close();
          coordinator = await f.reopen();
          assert.deepEqual((await readRecord(f.root, id)).lastTurn, source);
        }
        if (status !== 'completed') f.b.gate = gate;
        switching = coordinator.selectModel({ agent: 'b', id: 'b-model' });
        if (status !== 'completed') {
          await within(gate.entered, 5000, 'the destination continuation');
          assert.deepEqual((await readRecord(f.root, id)).lastTurn, source);
          gate.open();
        }
        await switching;
        if (status === 'completed') {
          assert.equal(f.b.inputs.length, 0);
          const stored = await readRecord(f.root, id);
          assert.deepEqual(stored.lastTurn, source);
          assert.equal(stored.handoff?.activated, true);
          assert.equal(stored.handoff.summary, 'a: finish the migration');
          await coordinator.send('Next requested action');
          assert.equal(f.b.inputs[0]!.prompt, 'Next requested action');
        } else
          assert.equal(
            f.b.inputs[0]!.prompt,
            'Continue the task described by the handoff context. Check the working files before relying on statements about their state.',
          );
        assert.equal(f.b.inputs.length, 1);
        assert.match(f.b.inputs[0]!.context!, /a: finish the migration/);
        assert.equal(coordinator.snapshot.conversation!.handoff, undefined);
        assert.equal((await readRecord(f.root, id)).handoff, undefined);
      } finally {
        gate.open();
        await switching?.catch(() => {});
        await coordinator.close();
        await f.coordinator.close();
      }
    });

test('a legacy conversation with history defers its handoff until the next prompt', async () => {
  const f = await fixture();
  let coordinator = f.coordinator;
  try {
    await coordinator.send('Existing conversation');
    const id = coordinator.snapshot.conversation!.id;
    await coordinator.close();
    const stored = await readRecord(f.root, id);
    delete stored.lastTurn;
    await writeFile(
      join(f.root, 'state', 'conversations', id, 'state.json'),
      JSON.stringify(stored),
    );
    coordinator = await f.reopen();
    await coordinator.selectModel({ agent: 'b', id: 'b-model' });
    assert.equal(f.b.inputs.length, 0);
    const pending = await readRecord(f.root, id);
    assert.equal(pending.lastTurn, undefined);
    assert.equal(pending.handoff?.summary, 'a: finish the migration');
    await coordinator.send('Next legacy request');
    assert.equal(f.b.inputs.length, 1);
    assert.equal(f.b.inputs[0]!.prompt, 'Next legacy request');
    assert.match(f.b.inputs[0]!.context!, /a: finish the migration/);
    assert.equal(coordinator.snapshot.conversation!.handoff, undefined);
  } finally {
    await coordinator.close();
    await f.coordinator.close();
  }
});

test('destination startup failure retains the source conversation and session', async () => {
  const { coordinator, a, b, root } = await fixture();
  try {
    await coordinator.send('Start');
    b.failConnect = true;
    await assert.rejects(
      coordinator.selectModel({ agent: 'b', id: 'b-model' }),
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

for (const resumed of [false, true])
  for (const effort of ['high', undefined])
    test(`${resumed ? 'resumed' : 'first'} handoff dispatch uses the selected model and ${effort ?? 'destination'} effort`, async () => {
      const { coordinator, a, b, root } = await fixture();
      const dispatched: SessionInfo[] = [];
      try {
        if (resumed) {
          await coordinator.selectModel({
            agent: 'b',
            id: 'b-old',
            effort: 'low',
          });
          await coordinator.selectModel({
            agent: 'a',
            id: 'a-big',
            effort: 'high',
          });
        } else
          await coordinator.selectModel({
            agent: 'a',
            id: 'a-big',
            effort: 'high',
          });
        const previous = coordinator.snapshot.conversation!.sessions.b?.id;
        await coordinator.send('Start');
        const source = coordinator.snapshot.native!.id;
        const id = coordinator.snapshot.conversation!.id;
        const connect = b.connect.bind(b);
        b.connect = async (options) => {
          const session = await connect(options);
          const send = session.send;
          session.send = async (...args) => {
            dispatched.push({ ...session.info });
            return send(...args);
          };
          return session;
        };
        await coordinator.selectModel({ agent: 'b', id: 'b-big', effort });
        assert.equal(dispatched.length, 0);
        await coordinator.send('Use the selected destination model');
        const expectedEffort = effort ?? (resumed ? 'low' : undefined);
        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0]!.model, 'b-big');
        assert.equal(dispatched[0]!.effort, expectedEffort);
        assert.equal(b.sessions.at(-1)!.options.model, 'b-big');
        assert.equal(b.sessions.at(-1)!.options.effort, expectedEffort);
        if (resumed) assert.equal(dispatched[0]!.id, previous);
        const saved = await readRecord(root, id);
        assert.equal(saved.id, id);
        assert.equal(saved.sessions.b!.requestedModel, 'b-big');
        assert.equal(saved.sessions.b!.effort, expectedEffort);
        assert.match(b.inputs.at(-1)!.context!, /a: finish the migration/);
        await coordinator.selectModel({ agent: 'a', id: 'a-big' });
        await coordinator.send('Use the original session');
        assert.equal(a.inputs.at(-1)!.session, source);
      } finally {
        await coordinator.close();
      }
    });

for (const prior of [false, true])
  for (const cancel of [false, true])
    test(`${cancel ? 'interrupted' : 'rejected'} destination selection restores ${prior ? 'the prior preference' : 'an absent destination'} before activation`, async () => {
      const { coordinator, a, b, root } = await fixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let switching: Promise<void> | undefined;
      try {
        if (prior) {
          await coordinator.selectModel({
            agent: 'b',
            id: 'b-old',
            effort: 'low',
          });
          await coordinator.selectModel({ agent: 'a', id: 'a-big' });
        }
        await coordinator.send('Start');
        const source = coordinator.snapshot.native!.id;
        const previous = coordinator.snapshot.conversation!.sessions.b;
        const persisted = (
          await readRecord(root, coordinator.snapshot.conversation!.id)
        ).sessions.b;
        const connect = b.connect.bind(b);
        b.connect = async (options) => {
          const session = await connect(options);
          const select = session.selectModel,
            close = session.close;
          session.selectModel = async (...args) => {
            await select(...args);
            entered.resolve();
            await release.promise;
            throw new Error('Selection refused');
          };
          session.close = async () => {
            await close();
            release.resolve();
          };
          return session;
        };
        switching = coordinator.selectModel({
          agent: 'b',
          id: 'b-big',
          effort: 'high',
        });
        const rejected = assert.rejects(switching, /Selection refused/);
        await within(entered.promise, 2000, 'destination setter');
        await coordinator.send('Queued during selection');
        if (cancel) await coordinator.interrupt();
        else release.resolve();
        await within(rejected, 2000, 'selection rejection');
        assert.equal(b.sessions.at(-1)!.session.closed, true);
        const current = coordinator.snapshot.conversation!;
        assert.equal(current.agent, 'a');
        assert.equal(current.handoff, undefined);
        assert.deepEqual(current.sessions.b, previous);
        assert.deepEqual(
          (await readRecord(root, current.id)).sessions.b,
          persisted,
        );
        assert.equal(b.inputs.length, 0);
        assert.deepEqual(coordinator.snapshot.queue, [
          'Queued during selection',
        ]);
        assert.equal(coordinator.snapshot.recovery, undefined);
        coordinator.unqueue('');
        await coordinator.send('Resume manually');
        assert.equal(a.inputs.at(-1)!.session, source);
      } finally {
        release.resolve();
        await switching?.catch(() => {});
        await coordinator.close();
      }
    });

test('handoff preference and activation are durable together before continuation', async () => {
  const { coordinator, a, b, root, reopen } = await fixture();
  const beforeReady = Promise.withResolvers<void>(),
    afterReady = Promise.withResolvers<void>();
  const activate = Promise.withResolvers<void>(),
    continueTurn = Promise.withResolvers<void>();
  let before = '',
    after = '',
    switching: Promise<void> | undefined;
  let intercepted = false;
  try {
    await coordinator.selectModel({ agent: 'b', id: 'b-old', effort: 'low' });
    await coordinator.selectModel({ agent: 'a', id: 'a-big', effort: 'high' });
    a.interruptNext = true;
    await coordinator.send('Start');
    const id = coordinator.snapshot.conversation!.id;
    const source = coordinator.snapshot.native!.id;
    const file = join(root, 'state', 'conversations', id, 'state.json');
    const save = ConversationStore.prototype.save;
    vi.spyOn(ConversationStore.prototype, 'save').mockImplementation(
      async function (this: ConversationStore, record: ConversationRecord) {
        if (record.id !== id || !record.handoff?.activated || intercepted)
          return save.call(this, record);
        intercepted = true;
        await this.flush();
        before = await readFile(file, 'utf8');
        beforeReady.resolve();
        await activate.promise;
        await save.call(this, record);
        after = await readFile(file, 'utf8');
        afterReady.resolve();
        await continueTurn.promise;
      },
    );
    switching = coordinator.selectModel({
      agent: 'b',
      id: 'b-big',
      effort: 'high',
    });
    await within(beforeReady.promise, 2000, 'activation writer');
    assert.equal(b.sessions.at(-1)!.session.info.model, 'b-big');
    assert.equal(b.sessions.at(-1)!.session.info.effort, 'high');
    assert.equal(b.inputs.length, 0);
    const unactivated = JSON.parse(before);
    assert.equal(unactivated.agent, 'a');
    assert.equal(unactivated.handoff.activated, false);
    assert.equal(unactivated.sessions.b.requestedModel, 'b-old');
    assert.equal(unactivated.sessions.b.effort, 'low');
    activate.resolve();
    await within(afterReady.promise, 2000, 'activation saved');
    assert.equal(b.inputs.length, 0);
    const activated = JSON.parse(after);
    assert.equal(activated.agent, 'b');
    assert.equal(activated.handoff.activated, true);
    assert.equal(activated.sessions.b.requestedModel, 'b-big');
    assert.equal(activated.sessions.b.effort, 'high');
    continueTurn.resolve();
    await switching;
    await coordinator.close();
    for (const [snapshot, agent, model, effort] of [
      [before, 'a', 'b-old', 'low'],
      [after, 'b', 'b-big', 'high'],
    ] as const) {
      await writeFile(file, snapshot);
      const sent: number = a.inputs.length + b.inputs.length;
      const restarted = await reopen();
      try {
        assert.equal(restarted.snapshot.conversation!.agent, agent);
        assert.equal(
          restarted.snapshot.conversation!.sessions.b!.requestedModel,
          model,
        );
        assert.equal(
          restarted.snapshot.conversation!.sessions.b!.effort,
          effort,
        );
        assert.equal(restarted.snapshot.conversation!.sessions.a!.id, source);
        assert.equal(a.inputs.length + b.inputs.length, sent);
      } finally {
        await restarted.close();
      }
    }
  } finally {
    activate.resolve();
    continueTurn.resolve();
    await switching?.catch(() => {});
    await coordinator.close();
  }
});

test('failed destination shutdown preserves the handoff error and persists pre-activation rollback', async () => {
  const { coordinator, a, b, root } = await fixture();
  try {
    await coordinator.send('Start');
    const source = coordinator.snapshot.native!.id;
    const connect = b.connect.bind(b);
    b.connect = async (options) => {
      const session = await connect(options);
      session.selectModel = async () => {
        throw new Error('Selection refused');
      };
      return session;
    };
    b.failClose = true;
    await assert.rejects(
      coordinator.selectModel({ agent: 'b', id: 'b-big', effort: 'high' }),
      /Selection refused/,
    );
    assert.equal(coordinator.snapshot.error, 'Selection refused');
    const saved = await readRecord(root, coordinator.snapshot.conversation!.id);
    assert.equal(saved.agent, 'a');
    assert.equal(saved.sessions.b, undefined);
    assert.equal(coordinator.snapshot.conversation!.sessions.b, undefined);
    assert.equal(b.sessions.at(-1)!.session.closed, true);
    assert.deepEqual(b.inputs, []);
    b.failClose = false;
    await coordinator.send('Resume manually');
    assert.equal(a.inputs.at(-1)!.session, source);
  } finally {
    b.failClose = false;
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
  test(`restart at handoff stage ${stage} preserves the active agent without replaying input`, async () => {
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
        model: activated ? 'b-big' : 'b-model',
        requestedModel: activated ? 'b-big' : undefined,
        effort: activated ? 'high' : undefined,
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
      if (activated) {
        assert.equal(restarted.snapshot.native!.model, 'b-big');
        assert.equal(restarted.snapshot.native!.effort, 'high');
      }
      assert.equal(a.inputs.length + b.inputs.length, 0);
      await restarted.send('Resume manually');
      const active = activated ? b : a;
      const prior = conversation.sessions[active.id]!;
      if (prior.hasHistory) assert.equal(active.inputs[0]!.session, prior.id);
      else assert.notEqual(active.inputs[0]!.session, prior.id);
      assert.ok(active.inputs[0]!.prompt.includes('Resume manually'));
      assert.equal(
        active.inputs[0]!.context!.includes('Continue the migration'),
        activated,
      );
      assert.equal(restarted.snapshot.conversation!.handoff, undefined);
    } finally {
      await restarted.close();
    }
  });
}

test('undelivered handoff context survives visiting another conversation and clears only after success', async () => {
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
    assert.doesNotMatch(a.inputs.at(-1)!.context!, /amber-195/);
    await coordinator.selectConversation(conversation.id);
    b.interruptNext = true;
    await coordinator.send('Continue');
    assert.match(b.inputs.at(-1)!.context!, /amber-195/);
    assert.ok(coordinator.snapshot.conversation!.handoff);
    b.interruptNext = true;
    await assert.rejects(
      coordinator.selectModel({ agent: 'a', id: 'a-model' }),
      /interrupted/,
    );
    await coordinator.send('Continue manually');
    assert.match(b.inputs.at(-1)!.context!, /amber-195/);
    assert.equal(coordinator.snapshot.conversation!.handoff, undefined);
  } finally {
    await coordinator.close();
  }
});

for (const reason of ['held', 'bad history'] as const) {
  test(`a switch to a conversation with ${reason} keeps the current conversation, session and lock`, async () => {
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

test('selecting the current conversation keeps its session and claim', async () => {
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

test('a disconnect that throws during a switch still adopts the new conversation', async () => {
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

test('a late event from a released session reaches neither conversation', async () => {
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

test('switching between conversations on one agent connects a fresh native session', async () => {
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

test('a handoff cancelled during the summary keeps the source', async () => {
  const context = await handoffFixture();
  const { coordinator, a } = context;
  const gate = new TurnGate();
  a.gate = gate;
  try {
    const switching = coordinator.selectModel({ agent: 'b', id: 'b-model' });
    await within(gate.entered, 2000, 'the summary turn');
    await coordinator.interrupt();
    await assert.rejects(switching, /interrupted/);
    await context.assertSourceActive();
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a handoff cancelled while the summary is saved never connects the destination', async () => {
  const context = await handoffFixture();
  const { coordinator, a, b } = context;
  const gate = new TurnGate();
  a.gate = gate;
  const save = ConversationStore.prototype.save;
  const held = Promise.withResolvers<void>();
  const holding = Promise.withResolvers<void>();
  try {
    const switching = coordinator.selectModel({ agent: 'b', id: 'b-model' });
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

test('a handoff cancelled during the destination connect keeps the source', async () => {
  const context = await handoffFixture();
  const { coordinator, b } = context;
  const connecting = Promise.withResolvers<void>();
  b.beforeConnect = holdConnect(connecting, undefined, {
    onAbort: 'resolve',
  });
  try {
    const switching = coordinator.selectModel({ agent: 'b', id: 'b-model' });
    await within(connecting.promise, 2000, 'the destination connect');
    await coordinator.interrupt();
    await assert.rejects(switching, /interrupted/);
    await context.assertSourceActive();
  } finally {
    await coordinator.close();
  }
});

test('a handoff cancelled while saving its connection starts no catalog discovery', async () => {
  const { coordinator, a, b } = await fixture();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const save = ConversationStore.prototype.save;
  let held = false;
  let switching: Promise<void> | undefined;
  try {
    vi.spyOn(ConversationStore.prototype, 'save').mockImplementation(
      async function (this: ConversationStore, record: ConversationRecord) {
        const pending = save.call(this, record);
        if (
          !held &&
          record.handoff?.to === 'b' &&
          b.sessions.length &&
          record.process
        ) {
          held = true;
          await pending;
          entered.resolve();
          await release.promise;
        } else await pending;
      },
    );
    const discoveries = a.discoveries.length;
    switching = coordinator.selectModel({
      agent: 'b',
      id: 'b-big',
      effort: 'high',
    });
    const rejected = assert.rejects(switching, /interrupted/);
    await within(entered.promise, 2000, 'connection save');
    await coordinator.interrupt();
    release.resolve();
    await rejected;
    assert.equal(a.discoveries.length, discoveries);
    assert.equal(b.sessions.at(-1)!.session.closed, true);
    assert.equal(coordinator.snapshot.conversation!.agent, 'a');
    assert.equal(coordinator.snapshot.conversation!.sessions.b, undefined);
  } finally {
    release.resolve();
    await switching?.catch(() => {});
    await coordinator.close();
  }
});

test('a handoff cancelled during the continuation stays with the destination', async () => {
  const context = await handoffFixture();
  const { coordinator, a, b } = context;
  const gate = new TurnGate();
  b.gate = gate;
  try {
    a.interruptNext = true;
    await coordinator.send('Unfinished migration');
    const switching = coordinator.selectModel({
      agent: 'b',
      id: 'b-big',
      effort: 'high',
    });
    await within(gate.entered, 2000, 'the continuation');
    await coordinator.interrupt();
    await within(switching, 2000, 'the handoff');
    const conversation = coordinator.snapshot.conversation!;
    assert.equal(conversation.agent, 'b');
    assert.equal(conversation.handoff?.activated, true);
    assert.equal(conversation.sessions.b!.requestedModel, 'b-big');
    assert.equal(conversation.sessions.b!.effort, 'high');
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a prompt sent during a handoff waits and goes to the destination', async () => {
  const { coordinator, a, b } = await handoffFixture();
  const gate = new TurnGate();
  a.gate = gate;
  try {
    const switching = coordinator.selectModel({ agent: 'b', id: 'b-model' });
    await within(gate.entered, 2000, 'the summary turn');
    await coordinator.send('During');
    assert.deepEqual(a.steers, []);
    assert.deepEqual(coordinator.snapshot.queue, ['During']);
    gate.open();
    await within(switching, 2000, 'the handoff');
    await until('the queued prompt', () =>
      b.inputs.some(({ prompt }) => prompt === 'During'),
    );
    assert.deepEqual(
      b.inputs.map(({ prompt }) => prompt),
      ['During'],
    );
    assert.match(b.inputs[0]!.context!, /a: finish the migration/);
    await until(
      'the handoff to clear',
      () => coordinator.snapshot.conversation!.handoff === undefined,
    );
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a /model switch whose summary fails activates with transcript context and delivers a prompt sent during it', async () => {
  const { coordinator, a, b } = await handoffFixture();
  const gate = new TurnGate();
  a.gate = gate;
  try {
    a.failNext = true;
    const switching = coordinator.selectModel({ agent: 'b', id: 'b-model' });
    await within(gate.entered, 2000, 'the summary turn');
    await coordinator.send('During');
    gate.open();
    await within(switching, 2000, 'the handoff');
    await until('the queued prompt', () => b.inputs.length === 1);
    assert.equal(b.inputs[0]!.prompt, 'During');
    assert.match(b.inputs[0]!.context!, /could not summarize/);
    assert.match(b.inputs[0]!.context!, /User: Start the migration/);
    assert.equal(coordinator.snapshot.conversation!.agent, 'b');
    assert.ok(
      !coordinator.snapshot.items.some(({ text }) =>
        text.includes('out of usage'),
      ),
    );
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a /model switch whose failed summary leaves memory pending keeps the source', async () => {
  const { coordinator, a, b } = await handoffFixture();
  try {
    const { session, options } = a.sessions.at(-1)!;
    const send = session.send.bind(session);
    vi.spyOn(session, 'send').mockImplementation(async (prompt, ...rest) => {
      if (!prompt.includes('handoff summary')) return send(prompt, ...rest);
      await writeFile(
        join(options.memoryDirectories[1]!, 'notes.md'),
        'half written',
      );
      return { status: 'failed', text: '', error: 'Overloaded' };
    });
    await assert.rejects(
      coordinator.selectModel({ agent: 'b', id: 'b-model' }),
      /Overloaded/,
    );
    assert.equal(coordinator.snapshot.conversation!.agent, 'a');
    assert.equal(coordinator.snapshot.conversation!.handoff, undefined);
    assert.equal(coordinator.snapshot.phase, 'recovery');
    assert.equal(b.sessions.length, 0);
  } finally {
    vi.restoreAllMocks();
    await coordinator.close();
  }
});
