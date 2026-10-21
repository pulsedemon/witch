import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../src/agents/codex.js';
import type { UserRequest } from '../src/agents/types.js';
import { Coordinator } from '../src/core/coordinator.js';
import { Memory } from '../src/memory/memory.js';
import { StateStore } from '../src/persistence/store.js';
import { TurnGate } from './fixtures/agent.js';
import { fixture, turns } from './fixtures/coordinator.js';
import { scratch } from './fixtures/scratch.js';
import { until, within } from './fixtures/within.js';

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

for (const completed of [false, true])
  await test(`a native connection exit clears async questions ${completed ? 'after' : 'during'} their turn`, async () => {
    const root = await scratch('witch-question-exit-');
    const project = join(root, 'project');
    await mkdir(project);
    const store = await StateStore.open(join(root, 'state'));
    const adapter = new CodexAdapter((_, cwd, signal) =>
      spawn(
        process.execPath,
        [
          fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url)),
          'file-approvals',
        ],
        { cwd, stdio: 'pipe', signal },
      ),
    );
    const coordinator = new Coordinator(
      store,
      new Memory(join(root, 'state', 'memory.git')),
      [{ adapter, executable: 'fixture' }],
    );
    try {
      await coordinator.initialize(project);
      const sending = coordinator.send('Start');
      await until('the native turn', () =>
        existsSync(join(project, 'prompt.json')),
      );
      const frames = [
        {
          method: 'item/completed',
          params: {
            threadId: 'native-thread',
            turnId: 'turn-1',
            item: {
              type: 'agentMessage',
              id: 'choice',
              text: 'Which target?',
              phase: 'final_answer',
              delivery: 'async',
              memoryCitation: null,
              questions: [{ title: 'Which target?', options: ['Preview'] }],
            },
          },
        },
        ...(completed
          ? [
              {
                method: 'turn/completed',
                params: {
                  threadId: 'native-thread',
                  turn: { id: 'turn-1', status: 'completed', error: null },
                },
              },
            ]
          : []),
      ];
      await writeFile(join(project, 'events.next'), JSON.stringify(frames));
      await rename(
        join(project, 'events.next'),
        join(project, 'events-1.json'),
      );
      await until('the async question', () =>
        coordinator.snapshot.requests.some(
          (request) => request.id === 'question/choice',
        ),
      );
      if (completed) await within(sending, 3000, 'the completed turn');
      assert.equal(coordinator.snapshot.phase, completed ? 'idle' : 'running');
      await writeFile(join(project, 'exit'), '');
      await within(sending, 3000, 'the exited turn');
      await until('the native exit notice', () =>
        coordinator.snapshot.items.some(
          (item) =>
            item.kind === 'notice' &&
            item.text.includes('Agent process exited'),
        ),
      );
      assert.deepEqual(coordinator.snapshot.requests, []);
    } finally {
      await coordinator.close();
    }
  });

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
