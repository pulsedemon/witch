import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UserRequest } from '../src/agents/types.js';
import { TurnGate } from './fixtures/agent.js';
import { fixture, turns } from './fixtures/coordinator.js';
import { within } from './fixtures/within.js';

const question = (id = 'choice'): UserRequest => ({
  id,
  kind: 'question',
  title: 'Questions',
  detail: '',
  questions: [
    {
      id: 'target',
      title: 'Which target?',
      options: ['Preview', 'Production'],
    },
    { id: 'notes', title: 'Any constraints?', options: [] },
  ],
  replyAsPrompt: true,
});
const response = {
  decision: 'accept' as const,
  answers: { target: ['Preview'], notes: ['Keep logs, please'] },
};
const answer =
  '**Which target?**\n→ Preview\n\n**Any constraints?**\n→ Keep logs, please';

await test('an async question survives turn completion and its answer starts one normal turn', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the question turn');
    const { onEvent } = a.sessions.at(-1)!.options;
    onEvent({ type: 'request', request: question() });
    onEvent({
      type: 'request',
      request: { ...question('blocking'), replyAsPrompt: undefined },
    });
    gate.open();
    await sending;
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.deepEqual(coordinator.snapshot.requests, [question()]);
    await Promise.all([
      coordinator.respond('choice', response),
      coordinator.respond('choice', response),
    ]);
    assert.deepEqual(turns(a), [
      ['Start', undefined],
      [answer, undefined],
    ]);
    assert.deepEqual(a.responses, []);
    assert.deepEqual(coordinator.snapshot.requests, []);
    assert.deepEqual(
      coordinator.snapshot.items
        .filter((item) => item.kind === 'user')
        .map((item) => item.text),
      ['Start', answer],
    );
    onEvent({ type: 'request', request: question('later') });
    await coordinator.interrupt();
    assert.deepEqual(coordinator.snapshot.requests, []);
    assert.deepEqual(turns(a), [
      ['Start', undefined],
      [answer, undefined],
    ]);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

for (const refuseSteer of [false, true])
  await test(`an async answer ${refuseSteer ? 'queues when steering is refused' : 'steers the active turn'}`, async () => {
    const { coordinator, a } = await fixture();
    const gate = new TurnGate();
    try {
      a.gate = gate;
      a.refuseSteer = refuseSteer;
      const sending = coordinator.send('Start');
      await within(gate.entered, 2000, 'the active turn');
      a.sessions
        .at(-1)!
        .options.onEvent({ type: 'request', request: question() });
      await coordinator.respond('choice', response);
      assert.deepEqual(coordinator.snapshot.requests, []);
      assert.deepEqual(a.responses, []);
      assert.deepEqual(a.steers, refuseSteer ? [] : [answer]);
      assert.deepEqual(coordinator.snapshot.queue, refuseSteer ? [answer] : []);
      assert.deepEqual(turns(a), [['Start', undefined]]);
      gate.open();
      await sending;
      assert.deepEqual(
        turns(a),
        refuseSteer
          ? [
              ['Start', undefined],
              [answer, undefined],
            ]
          : [['Start', undefined]],
      );
      assert.deepEqual(coordinator.snapshot.queue, []);
      assert.deepEqual(
        coordinator.snapshot.items
          .filter((item) => item.kind === 'user')
          .map((item) => item.text),
        ['Start', answer],
      );
    } finally {
      gate.open();
      await coordinator.close();
    }
  });

await test('declining an async question leaves other questions open and cancelling interrupts without an answer', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the active turn');
    const { onEvent } = a.sessions.at(-1)!.options;
    for (const id of ['first', 'second', 'third'])
      onEvent({ type: 'request', request: question(id) });
    await coordinator.respond('first', { decision: 'decline' });
    assert.deepEqual(coordinator.snapshot.requests, [
      question('second'),
      question('third'),
    ]);
    assert.equal(coordinator.snapshot.phase, 'running');
    await coordinator.respond('second', { decision: 'cancel' });
    assert.equal(
      (await within(gate.result, 2000, 'the interrupted turn')).status,
      'interrupted',
    );
    await sending;
    assert.deepEqual(coordinator.snapshot.requests, []);
    assert.deepEqual(a.responses, []);
    assert.deepEqual(a.steers, []);
    assert.deepEqual(turns(a), [['Start', undefined]]);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

await test('a new conversation discards the previous session questions and ignores their late answers', async () => {
  const { coordinator, a } = await fixture();
  try {
    a.sessions
      .at(-1)!
      .options.onEvent({ type: 'request', request: question() });
    const previous = coordinator.snapshot.conversation!.id;
    await coordinator.newConversation();
    assert.notEqual(coordinator.snapshot.conversation!.id, previous);
    assert.deepEqual(coordinator.snapshot.requests, []);
    await coordinator.respond('choice', response);
    assert.deepEqual(turns(a), []);
    assert.deepEqual(a.responses, []);
    assert.deepEqual(coordinator.snapshot.items, []);
  } finally {
    await coordinator.close();
  }
});
