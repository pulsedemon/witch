import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import { Coordinator } from '../../../src/core/coordinator.js';
import { ConversationStore } from '../../../src/persistence/store.js';
import { TurnGate, holdConnect } from '../../fixtures/agent.js';
import {
  unitFixture,
  holdSettlement,
  readRecord,
} from '../../fixtures/coordinator.js';
import { until, within } from '../../fixtures/within.js';

test('a same-runtime model choice made while a finished turn settles waits and applies once', async () => {
  const { coordinator, a } = await unitFixture();
  const gate = new TurnGate();
  const { session } = a.sessions.at(-1)!;
  const settlement = holdSettlement(session);
  const sent: [string, string][] = [];
  const send = session.send.bind(session);

  session.send = (prompt, ...rest) => {
    sent.push([prompt, session.info.model]);

    return send(prompt, ...rest);
  };

  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    a.replied = true;
    // the picker opens while the familiar holds the reply open
    assert.equal(await coordinator.refreshModels(), true);
    const release = coordinator.holdPromptDelivery();
    const before = a.selections.length;
    gate.open();
    await within(settlement.entered, 2000, 'the post-turn save');
    assert.equal(coordinator.snapshot.phase, 'running');
    assert.equal(session.replied, false);

    const outcome = coordinator
      .selectModel({ agent: 'a', id: 'a-big', effort: 'high' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    await coordinator.send('/after');
    await delay(100);
    assert.deepEqual(a.selections.slice(before), []);
    assert.deepEqual(coordinator.snapshot.queue, ['/after']);
    settlement.release();
    assert.equal(await within(outcome, 2000, 'the model choice'), undefined);
    assert.deepEqual(a.selections.slice(before), [['a-big', 'high']]);
    assert.equal(coordinator.snapshot.conversation!.sessions.a!.model, 'a-big');
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.deepEqual(coordinator.snapshot.queue, ['/after']);
    release();

    await until('the queued turn', () =>
      sent.some(([prompt]) => prompt === '/after'),
    );

    assert.deepEqual(
      sent.find(([prompt]) => prompt === '/after'),
      ['/after', 'a-big'],
    );

    await within(sending, 2000, 'the turn');
  } finally {
    settlement.restore();
    gate.open();
    await coordinator.close();
  }
});

for (const outcome of [
  'interrupt',
  'queued interrupt',
  'close',
  'failure',
] as const)
  test(`a model choice waiting on a finished turn lapses after ${outcome}`, async () => {
    const { coordinator, a, root } = await unitFixture();
    const gate = new TurnGate();
    const { session } = a.sessions.at(-1)!;
    const settlement = holdSettlement(session);
    const sent: [string, string][] = [];
    const send = session.send.bind(session);

    session.send = (prompt, ...rest) => {
      sent.push([prompt, session.info.model]);

      return send(prompt, ...rest);
    };

    try {
      const id = coordinator.snapshot.conversation!.id;
      a.gate = gate;
      const sending = coordinator.send('Start');
      await within(gate.entered, 2000, 'the gated turn');

      const release =
        outcome === 'queued interrupt'
          ? coordinator.holdPromptDelivery()
          : undefined;

      const before = a.selections.length;
      gate.open();
      await within(settlement.entered, 2000, 'the post-turn save');
      assert.equal(coordinator.snapshot.phase, 'running');
      assert.equal(session.replied, false);

      const lapsed = assert.rejects(
        coordinator.selectModel({ agent: 'a', id: 'a-big' }),
        { message: 'Model change canceled' },
      );

      if (outcome === 'interrupt' || outcome === 'queued interrupt') {
        if (release) await coordinator.send('/queued');

        await coordinator.interrupt();
        // Escape releases the batch's hold after interrupting
        release?.();
        settlement.release();
      } else if (outcome === 'close') {
        const closing = coordinator.close();
        settlement.release();
        await closing;
      } else settlement.fail(new Error('disk full'));

      await within(lapsed, 2000, 'the lapsed choice');
      await within(sending, 2000, 'the turn');

      if (release)
        await until('the queued turn', () =>
          sent.some(([prompt]) => prompt === '/queued'),
        );

      assert.equal(a.selections.length, before);

      if (outcome === 'failure')
        assert.equal(coordinator.snapshot.error, 'disk full');

      if (release)
        assert.deepEqual(
          sent.find(([prompt]) => prompt === '/queued'),
          ['/queued', 'a-model'],
        );

      await coordinator.close();
      assert.equal((await readRecord(root, id)).sessions.a!.model, 'a-model');
    } finally {
      settlement.restore();
      gate.open();
      await coordinator.close();
    }
  });

for (const interrupted of [false, true])
  test(`a picker with no listed models ${interrupted ? 'lapses after a startup interrupt' : 'waits for startup and refreshes'}`, async () => {
    const f = await unitFixture();
    await f.coordinator.close();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.a.beforeConnect = holdConnect(entered, release);

    const coordinator = new Coordinator(f.store, f.memory, [
      { adapter: f.a, executable: 'a' },
      { adapter: f.b, executable: 'b' },
    ]);

    const starting = coordinator.initialize(f.project);

    try {
      await within(entered.promise, 2000, 'the held startup');
      assert.deepEqual(coordinator.snapshot.models, []);
      const refreshing = coordinator.refreshModels();

      if (interrupted) await coordinator.interrupt();

      release.resolve();
      await within(starting, 3000, 'startup settlement');

      assert.equal(
        await within(refreshing, 2000, 'the picker refresh'),
        !interrupted,
      );

      if (!interrupted)
        assert.ok(coordinator.snapshot.models.some(({ id }) => id === 'a-big'));
    } finally {
      release.resolve();
      await starting.catch(() => {});
      await coordinator.close();
    }
  });

test('a model choice made after a stop waits for its settlement and applies once', async () => {
  const { coordinator, a } = await unitFixture();
  const gate = new TurnGate();
  const session = a.sessions.at(-1)!.session;
  const settlement = holdSettlement(session);

  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    await coordinator.interrupt();
    await within(settlement.entered, 2000, 'the stopped turn settlement');
    const before = a.selections.length;
    const choice = coordinator.selectModel({ agent: 'a', id: 'a-big' });

    assert.deepEqual(coordinator.snapshot.pendingModel, {
      agent: 'a',
      id: 'a-big',
    });

    assert.equal(a.selections.length, before);
    settlement.release();
    await within(choice, 2000, 'the model choice');
    assert.deepEqual(a.selections.slice(before), [['a-big', undefined]]);
    assert.equal(session.info.model, 'a-big');
    await within(sending, 2000, 'the stopped turn');
  } finally {
    settlement.restore();
    gate.open();
    await coordinator.close();
  }
});

test('a model choice after Escape waits for the interrupt response even after the turn settled', async () => {
  const { coordinator, a } = await unitFixture();
  const session = a.sessions[0]!.session;
  const gate = new TurnGate();
  const stopGate = Promise.withResolvers<void>();
  const modelGate = Promise.withResolvers<void>();
  const modelEntered = Promise.withResolvers<void>();
  const interrupt = session.interrupt.bind(session);
  const select = session.selectModel.bind(session);
  let entered = false;
  let sending: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let selecting: Promise<void> | undefined;

  session.interrupt = async (...args) => {
    await interrupt(...args);
    await stopGate.promise;
  };

  session.selectModel = async (...args) => {
    entered = true;
    modelEntered.resolve();
    await modelGate.promise;
    await select(...args);
  };

  try {
    a.gate = gate;
    sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    stopping = coordinator.interrupt();

    await within(
      sending,
      2000,
      'turn settlement before the interrupt response',
    );

    assert.equal(coordinator.snapshot.phase, 'idle');
    selecting = coordinator.selectModel({ agent: 'a', id: 'a-big' });

    assert.deepEqual(coordinator.snapshot.pendingModel, {
      agent: 'a',
      id: 'a-big',
    });

    assert.equal(entered, false);
    stopGate.resolve();
    await within(stopping, 2000, 'the interrupt response');
    await within(modelEntered.promise, 2000, 'model application');
    assert.equal(session.closed, false);
    modelGate.resolve();
    await within(selecting, 2000, 'the model selection');
    assert.equal(session.closed, false);
    assert.equal(coordinator.snapshot.native!.model, 'a-big');
  } finally {
    stopGate.resolve();
    modelGate.resolve();
    gate.open();
    await Promise.allSettled([sending, stopping, selecting]);
    await coordinator.close();
  }
});

test('a close that starts while a finished turn settles keeps the closing phase', async () => {
  const { coordinator, a } = await unitFixture();
  const gate = new TurnGate();
  const settlement = holdSettlement(a.sessions.at(-1)!.session);
  const save = ConversationStore.prototype.save;
  const settling = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();

  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    gate.open();
    await within(settlement.entered, 2000, 'the post-turn save');
    // the save after the turn runner's is settlement's own, past its closed check
    const holding = ConversationStore.prototype.save;

    ConversationStore.prototype.save = function (record) {
      ConversationStore.prototype.save = holding;
      settling.resolve();

      return held.promise.then(() => holding.call(this, record));
    };

    settlement.release();
    await within(settling.promise, 2000, 'the settlement save');
    const closing = coordinator.close();
    held.resolve();
    await closing;
    await within(sending, 2000, 'the turn');
    assert.equal(coordinator.snapshot.phase, 'closing');
  } finally {
    held.resolve();
    settlement.restore();
    ConversationStore.prototype.save = save;
    gate.open();
    await coordinator.close();
  }
});
