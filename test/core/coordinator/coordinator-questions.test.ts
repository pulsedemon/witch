import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../../../src/agents/codex/adapter.js';
import { unreportedContextCatalog } from '../../fixtures/codex-adapter.js';
import type { UserRequest } from '../../../src/agents/types.js';
import { Coordinator } from '../../../src/core/coordinator.js';
import { StateStore } from '../../../src/persistence/store.js';
import { holdConnect, TurnGate } from '../../fixtures/agent.js';
import { unitFixture, turns } from '../../fixtures/coordinator.js';
import { scratch } from '../../fixtures/scratch.js';
import { seededMemory } from '../../fixtures/seeded-memory.js';
import { until, within } from '../../fixtures/within.js';
import { frameWriter } from '../../fixtures/codex-adapter.js';

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

const secondResponse = {
  decision: 'accept' as const,
  answers: { target: ['Production'], notes: ['Remove debug output'] },
};

const secondAnswer =
  '**Which target?**\n→ Production\n\n**Any constraints?**\n→ Remove debug output';

async function codexFixture() {
  const root = await scratch('witch-codex-requests-');
  const project = join(root, 'project');
  await mkdir(project);
  const store = await StateStore.open(join(root, 'state'));

  const adapter = new CodexAdapter(
    (_, cwd, signal) =>
      spawn(
        process.execPath,
        [
          fileURLToPath(new URL('../../fixtures/codex.mjs', import.meta.url)),
          'file-approvals',
        ],
        { cwd, stdio: 'pipe', signal },
      ),
    unreportedContextCatalog,
  );

  const memory = await seededMemory(join(root, 'state', 'memory.git'));

  const coordinator = new Coordinator(store, memory, [
    { adapter, executable: 'fixture' },
  ]);

  const emit = frameWriter(project, (text) =>
    coordinator.snapshot.items.some(
      (item) => item.kind === 'notice' && item.text === text,
    ),
  );

  const receipt = async (id: number): Promise<unknown> => {
    const file = join(project, `response-${id}.json`);

    await until(`response ${id}`, () =>
      readFile(file).then(
        () => true,
        () => false,
      ),
    );

    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  };

  const close = async () => {
    await writeFile(join(project, 'release'), 'yes');
    await coordinator.close();
  };

  return { project, coordinator, emit, receipt, close };
}

for (const completed of [false, true])
  test(`a native connection exit keeps async questions ${completed ? 'after' : 'during'} their turn`, async () => {
    const { project, coordinator, emit, close } = await codexFixture();

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

      await emit(...frames);

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

      assert.deepEqual(coordinator.snapshot.requests, [
        {
          id: 'question/choice',
          kind: 'question',
          title: 'Questions',
          detail: '',
          questions: [
            { id: '0', title: 'Which target?', options: ['Preview'] },
          ],
          replyAsPrompt: true,
        },
      ]);
    } finally {
      await close();
    }
  });

for (const ending of ['answer', 'resolve', 'exit'])
  test(`Codex requests remain answerable after coordinator settlement (${ending})`, async () => {
    const { project, coordinator, emit, receipt, close } = await codexFixture();

    try {
      await coordinator.initialize(project);
      const sending = coordinator.send('Start');

      await until('the main request', () =>
        coordinator.snapshot.requests.some((request) => request.id === '77'),
      );

      await emit(
        {
          id: 902,
          method: 'item/fileChange/requestApproval',
          params: {
            threadId: 'child-thread',
            turnId: 'turn-1',
            itemId: 'child-patch',
            startedAtMs: 1,
            reason: 'Child approval',
            grantRoot: null,
          },
        },
        {
          id: 903,
          method: 'mcpServer/elicitation/request',
          params: {
            threadId: 'native-thread',
            turnId: null,
            serverName: 'fixture-mcp',
            mode: 'form',
            _meta: null,
            message: 'Provide a label',
            requestedSchema: {
              type: 'object',
              properties: { label: { type: 'string' } },
              required: ['label'],
            },
          },
        },
        {
          method: 'turn/completed',
          params: {
            threadId: 'native-thread',
            turn: { id: 'turn-1', status: 'completed', error: null },
          },
        },
      );

      await within(sending, 3000, 'the settled turn');
      assert.equal(coordinator.snapshot.phase, 'idle');

      assert.deepEqual(
        coordinator.snapshot.requests.map((request) => request.id),
        ['902', '903'],
      );

      if (ending === 'exit') {
        await writeFile(join(project, 'exit'), '');

        await until('the native exit', () =>
          coordinator.snapshot.items.some(
            (item) =>
              item.kind === 'notice' &&
              item.text.includes('Agent process exited'),
          ),
        );

        assert.deepEqual(coordinator.snapshot.requests, []);
        await coordinator.respond('902', { decision: 'accept' });

        await coordinator.respond('903', {
          decision: 'accept',
          content: { label: 'late' },
        });

        for (const id of [902, 903])
          await assert.rejects(readFile(join(project, `response-${id}.json`)), {
            code: 'ENOENT',
          });
      } else {
        if (ending === 'resolve') {
          await emit({
            method: 'serverRequest/resolved',
            params: { threadId: 'child-thread', requestId: 902 },
          });

          assert.deepEqual(
            coordinator.snapshot.requests.map((request) => request.id),
            ['903'],
          );
        }

        await coordinator.respond('902', { decision: 'accept' });

        await coordinator.respond('903', {
          decision: 'accept',
          content: { label: 'accepted' },
        });

        assert.deepEqual(await receipt(903), {
          id: 903,
          result: {
            action: 'accept',
            content: { label: 'accepted' },
            _meta: null,
          },
        });

        if (ending === 'answer')
          assert.deepEqual(await receipt(902), {
            id: 902,
            result: { decision: 'accept' },
          });
        else
          await assert.rejects(readFile(join(project, 'response-902.json')), {
            code: 'ENOENT',
          });

        assert.deepEqual(coordinator.snapshot.requests, []);
      }
    } finally {
      await close();
    }
  });

test('answering retained questions resumes once and preserves the remaining questions', async () => {
  const { coordinator, a } = await unitFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let answering: Promise<void[]> | undefined;

  try {
    await coordinator.send('Start');
    const original = a.sessions[0]!;

    for (const id of ['first', 'second'])
      original.options.onEvent({ type: 'request', request: question(id) });

    await original.session.close();
    original.options.onEvent({ type: 'closed' });

    assert.deepEqual(coordinator.snapshot.requests, [
      question('first'),
      question('second'),
    ]);

    a.beforeConnect = holdConnect(entered, release);

    answering = Promise.all([
      coordinator.respond('first', response),
      coordinator.respond('first', response),
    ]);

    await within(entered.promise, 3000, 'the answer reconnect');
    assert.deepEqual(coordinator.snapshot.requests, [question('second')]);
    assert.deepEqual(turns(a), [['Start', undefined]]);
    release.resolve();
    await within(answering, 3000, 'the first answer');
    assert.deepEqual(coordinator.snapshot.requests, [question('second')]);
    const completed = coordinator.snapshot.completedTurn;
    assert.ok(completed);
    await coordinator.respond('second', secondResponse);
    assert.equal(a.sessions.length, 2);
    assert.equal(a.sessions[1]!.options.resume, original.session.info.id);

    assert.deepEqual(turns(a), [
      ['Start', undefined],
      [answer, undefined],
      [secondAnswer, undefined],
    ]);

    assert.ok(
      a.inputs.every(({ session }) => session === original.session.info.id),
    );

    assert.deepEqual(a.responses, []);
    assert.deepEqual(coordinator.snapshot.requests, []);
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.equal(coordinator.snapshot.error, undefined);
    assert.ok(coordinator.snapshot.completedTurn);
    assert.notEqual(coordinator.snapshot.completedTurn, completed);

    assert.deepEqual(
      coordinator.snapshot.items
        .filter((item) => item.kind === 'user')
        .map((item) => item.text),
      ['Start', answer, secondAnswer],
    );
  } finally {
    release.resolve();
    await coordinator.close();
    await answering;
  }
});

test('a failed reconnect keeps queued answers and unanswered questions', async () => {
  const { coordinator, a } = await unitFixture();

  try {
    await coordinator.send('Start');
    const original = a.sessions[0]!;

    for (const id of ['first', 'second'])
      original.options.onEvent({ type: 'request', request: question(id) });

    await original.session.close();
    original.options.onEvent({ type: 'closed' });
    a.failConnect = true;
    await coordinator.respond('first', response);
    assert.deepEqual(coordinator.snapshot.queue, [answer]);
    assert.deepEqual(coordinator.snapshot.requests, [question('second')]);
    assert.deepEqual(turns(a), [['Start', undefined]]);
    assert.equal(coordinator.snapshot.error, 'Destination unavailable');
    a.failConnect = false;
    await coordinator.respond('second', secondResponse);
    assert.equal(a.sessions.length, 2);
    assert.equal(a.sessions[1]!.options.resume, original.session.info.id);

    assert.deepEqual(turns(a), [
      ['Start', undefined],
      [`${answer}\n${secondAnswer}`, undefined],
    ]);

    assert.equal(a.inputs[1]!.session, original.session.info.id);
    assert.deepEqual(a.responses, []);
    assert.deepEqual(coordinator.snapshot.queue, []);
    assert.deepEqual(coordinator.snapshot.requests, []);
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.equal(coordinator.snapshot.error, undefined);
    assert.ok(coordinator.snapshot.completedTurn);

    assert.deepEqual(
      coordinator.snapshot.items
        .filter((item) => item.kind === 'user')
        .map((item) => item.text),
      ['Start', `${answer}\n${secondAnswer}`],
    );
  } finally {
    await coordinator.close();
  }
});

test('a model refused while disconnected keeps unanswered questions', async () => {
  const { coordinator, a } = await unitFixture();

  try {
    await coordinator.send('Start');
    const original = a.sessions[0]!;
    original.options.onEvent({ type: 'request', request: question('kept') });
    await original.session.close();
    original.options.onEvent({ type: 'closed' });
    a.invalidModel = 'a-typo';

    await assert.rejects(
      coordinator.selectModel({ agent: 'a', id: 'a-typo' }),
      /Unknown model/,
    );

    assert.deepEqual(coordinator.snapshot.requests, [question('kept')]);
  } finally {
    await coordinator.close();
  }
});

test('handoff discards retained questions from the previous agent', async () => {
  const { coordinator, a, b } = await unitFixture();

  try {
    await coordinator.send('Start');
    const original = a.sessions[0]!;
    original.options.onEvent({ type: 'request', request: question() });
    await original.session.close();
    original.options.onEvent({ type: 'closed' });
    assert.deepEqual(coordinator.snapshot.requests, [question()]);
    await coordinator.selectModel({ agent: 'b', id: 'b-model' });
    assert.equal(coordinator.snapshot.conversation!.agent, 'b');
    assert.deepEqual(coordinator.snapshot.requests, []);
    assert.equal(coordinator.snapshot.error, undefined);
    const delivered = [turns(a), turns(b)];
    await coordinator.respond('choice', response);
    assert.deepEqual([turns(a), turns(b)], delivered);
    assert.deepEqual(a.responses, []);
    assert.deepEqual(b.responses, []);
  } finally {
    await coordinator.close();
  }
});

for (const { failure, failConnect, id, error } of [
  {
    failure: 'fails to connect',
    failConnect: true,
    id: 'b-model',
    error: /Destination unavailable/,
  },
  {
    failure: 'refuses the model',
    failConnect: false,
    id: 'b-typo',
    error: /Unknown model/,
  },
])
  test(`a handoff whose destination ${failure} keeps the source's questions`, async () => {
    const { coordinator, a, b } = await unitFixture();

    try {
      await coordinator.send('Start');
      const original = a.sessions[0]!;
      original.options.onEvent({ type: 'request', request: question() });
      await original.session.close();
      original.options.onEvent({ type: 'closed' });
      b.failConnect = failConnect;
      b.invalidModel = 'b-typo';
      await assert.rejects(coordinator.selectModel({ agent: 'b', id }), error);
      assert.equal(coordinator.snapshot.conversation!.agent, 'a');
      assert.deepEqual(coordinator.snapshot.requests, [question()]);
      await coordinator.respond('choice', response);
      assert.deepEqual(turns(a).at(-1), [answer, undefined]);
      assert.deepEqual(turns(b), []);
    } finally {
      await coordinator.close();
    }
  });

for (const departure of ['conversation', 'handoff'])
  test(`a question arriving during close does not survive ${departure}`, async () => {
    const { coordinator, a, b } = await unitFixture();

    try {
      await coordinator.send('Start');
      const original = a.sessions[0]!;
      const close = original.session.close.bind(original.session);

      original.session.close = async () => {
        original.options.onEvent({
          type: 'request',
          request: question('late'),
        });

        await close();
        original.options.onEvent({ type: 'closed' });
      };

      if (departure === 'conversation') await coordinator.newConversation();
      else await coordinator.selectModel({ agent: 'b', id: 'b-model' });

      assert.deepEqual(coordinator.snapshot.requests, []);
      assert.equal(coordinator.snapshot.error, undefined);
      const delivered = [turns(a), turns(b)];
      await coordinator.respond('late', response);
      assert.deepEqual([turns(a), turns(b)], delivered);
      assert.deepEqual(a.responses, []);
      assert.deepEqual(b.responses, []);
    } finally {
      await coordinator.close();
    }
  });

test('an async question survives turn completion and its answer starts one normal turn', async () => {
  const { coordinator, a } = await unitFixture();
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
  test(`an async answer ${refuseSteer ? 'queues when steering is refused' : 'steers the active turn'}`, async () => {
    const { coordinator, a } = await unitFixture();
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

test('declining an async question leaves other questions open and cancelling interrupts without an answer', async () => {
  const { coordinator, a } = await unitFixture();
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

test('a new conversation discards the previous session questions and ignores their late answers', async () => {
  const { coordinator, a } = await unitFixture();

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

test('async questions arriving during cancellation are ignored until the next turn', async () => {
  const { coordinator, a } = await unitFixture();
  let gate = new TurnGate();

  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the active turn');
    const { onEvent } = a.sessions.at(-1)!.options;
    const interrupting = coordinator.interrupt();
    onEvent({ type: 'request', request: question('late') });
    assert.deepEqual(coordinator.snapshot.requests, []);
    const blocking = { ...question('blocking'), replyAsPrompt: undefined };
    onEvent({ type: 'request', request: blocking });
    assert.deepEqual(coordinator.snapshot.requests, [blocking]);
    await interrupting;
    await sending;
    assert.deepEqual(coordinator.snapshot.requests, []);
    a.gate = gate = new TurnGate();
    const next = coordinator.send('Next');
    await within(gate.entered, 2000, 'the next turn');
    onEvent({ type: 'request', request: question('next') });
    assert.deepEqual(coordinator.snapshot.requests, [question('next')]);
    gate.open();
    await next;
  } finally {
    gate.open();
    await coordinator.close();
  }
});
