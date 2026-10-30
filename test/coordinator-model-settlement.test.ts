import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import { TurnGate } from './fixtures/agent.js';
import { fixture, holdSettlement, readRecord } from './fixtures/coordinator.js';
import { until, within } from './fixtures/within.js';

test('a same-runtime model choice made while a finished turn settles waits and applies once', async () => {
  const { coordinator, a } = await fixture();
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
    const { coordinator, a, root } = await fixture();
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

test('a model picker opened while a finished turn settles waits and refreshes once', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  const { session } = a.sessions.at(-1)!;
  const settlement = holdSettlement(session);
  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    const release = coordinator.holdPromptDelivery();
    gate.open();
    await within(settlement.entered, 2000, 'the post-turn save');
    assert.equal(coordinator.snapshot.phase, 'running');
    assert.equal(session.replied, false);
    a.catalog.push({ id: 'a-new', label: 'a-new', efforts: [] });
    const refreshing = coordinator.refreshModels();
    await coordinator.send('/after');
    await delay(100);
    assert.equal(
      coordinator.snapshot.models.some(({ id }) => id === 'a-new'),
      false,
    );
    settlement.release();
    assert.equal(await within(refreshing, 2000, 'the refresh'), true);
    assert.equal(
      coordinator.snapshot.models.some(({ id }) => id === 'a-new'),
      true,
    );
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.deepEqual(coordinator.snapshot.queue, ['/after']);
    release();
    await within(sending, 2000, 'the turn');
  } finally {
    settlement.restore();
    gate.open();
    await coordinator.close();
  }
});

for (const outcome of ['interrupt', 'close', 'failure'] as const)
  test(`a model picker waiting on a finished turn lapses after ${outcome}`, async () => {
    const { coordinator, a } = await fixture();
    const gate = new TurnGate();
    const { session } = a.sessions.at(-1)!;
    const settlement = holdSettlement(session);
    try {
      a.gate = gate;
      const sending = coordinator.send('Start');
      await within(gate.entered, 2000, 'the gated turn');
      gate.open();
      await within(settlement.entered, 2000, 'the post-turn save');
      assert.equal(coordinator.snapshot.phase, 'running');
      a.catalog.push({ id: 'a-new', label: 'a-new', efforts: [] });
      const refreshing = coordinator.refreshModels();
      if (outcome === 'interrupt') {
        await coordinator.interrupt();
        settlement.release();
      } else if (outcome === 'close') {
        const closing = coordinator.close();
        settlement.release();
        await closing;
      } else settlement.fail(new Error('disk full'));
      assert.equal(await within(refreshing, 2000, 'the lapsed refresh'), false);
      await within(sending, 2000, 'the turn');
      assert.equal(
        coordinator.snapshot.models.some(({ id }) => id === 'a-new'),
        false,
      );
    } finally {
      settlement.restore();
      gate.open();
      await coordinator.close();
    }
  });
