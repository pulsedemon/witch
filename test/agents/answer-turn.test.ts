import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { AnswerTurn } from '../../src/agents/answer-turn.js';
import { NativeStop, NativeStopTimeout } from '../../src/agents/shutdown.js';
import type {
  AgentSession,
  SessionOptions,
  TurnResult,
} from '../../src/agents/types.js';

const source = {
  id: 'owner',
  agent: 'codex',
  model: 'owner-model',
  permissionMode: 'default',
  hasHistory: true,
};

const options: SessionOptions = {
  cwd: '/project',
  executable: 'native',
  memoryDirectories: [],
  onEvent: () => {},
  onProcess: async () => {},
};

const input = {
  outputSchema: { type: 'object' },
  requestFile: '/project/request.json',
};

const completed: TurnResult = { status: 'completed', text: 'answer' };

function child(): AgentSession {
  return {
    info: { ...source, id: 'answer' },
    usage: {},
    closed: false,
    replied: false,
    models: async () => [],
    skills: async () => [],
    contextUsage: async () => undefined,
    compact: async () => completed,
    shell: async () => completed,
    steer: async () => false,
    selectModel: async () => {},
    respond: () => {},
    send: async () => completed,
    close: async () => {},
    interrupt: async () => {},
  };
}

const open = { closed: false, running: false, label: 'Fixture' };

test('cancellation during connection aborts startup and waits for its cleanup', async () => {
  const entered = Promise.withResolvers<SessionOptions>();
  const cleanup = Promise.withResolvers<void>();

  const turn = new AnswerTurn(options, async (connected) => {
    entered.resolve(connected);

    await new Promise<void>((resolve) =>
      connected.signal!.addEventListener('abort', () => resolve(), {
        once: true,
      }),
    );

    await cleanup.promise;

    throw connected.signal!.reason;
  });

  const running = turn.run(open, source, 'answer', undefined, input);
  const connected = await entered.promise;
  let stopped = false;

  const stopping = turn.interrupt({ deadline: 123, restart: true }).then(() => {
    stopped = true;
  });

  assert.ok(connected.signal!.reason instanceof NativeStop);

  assert.deepEqual(connected.signal!.reason.options, {
    deadline: 123,
    restart: true,
  });

  assert.equal(turn.busy, true);

  await Promise.resolve();

  assert.equal(stopped, false);

  cleanup.resolve();

  await stopping;

  assert.equal((await running).status, 'interrupted');

  assert.equal(turn.busy, false);
});

test('startup cleanup failures remain visible after cancellation', async () => {
  const entered = Promise.withResolvers<void>();
  const failure = new NativeStopTimeout();

  const turn = new AnswerTurn(options, async (connected) => {
    entered.resolve();

    await new Promise<void>((resolve) =>
      connected.signal!.addEventListener('abort', () => resolve(), {
        once: true,
      }),
    );

    throw failure;
  });

  const rejected = assert.rejects(
    turn.run(open, source, 'answer', undefined, input),
    (error) => error === failure,
  );

  await entered.promise;

  await turn.interrupt();

  await rejected;

  assert.equal(turn.busy, false);
});

test('connected cancellation interrupts before close without aborting the native transport', async () => {
  const sending = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<TurnResult>();
  const session = child();
  let connected!: SessionOptions;

  session.send = async () => {
    sending.resolve();

    return finished.promise;
  };

  session.interrupt = vi.fn(async () => {
    assert.equal(connected.signal!.aborted, false);

    finished.resolve({ status: 'interrupted', text: '' });
  });

  session.close = vi.fn(async () => {});

  const turn = new AnswerTurn(options, async (value) => {
    connected = value;

    return session;
  });

  const running = turn.run(open, source, 'answer', undefined, input);

  await sending.promise;

  const stop = { deadline: 456, restart: true };

  await turn.interrupt(stop);

  assert.equal((await running).status, 'interrupted');

  assert.deepEqual(vi.mocked(session.interrupt).mock.calls, [[stop]]);

  assert.deepEqual(vi.mocked(session.close).mock.calls, [[stop]]);
});

test('cancellation during child close discards an otherwise completed answer', async () => {
  const closing = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const session = child();

  session.close = async () => {
    closing.resolve();

    await closed.promise;
  };

  const turn = new AnswerTurn(options, async () => session);
  const running = turn.run(open, source, 'answer', undefined, input);

  await closing.promise;

  const stopping = turn.interrupt();

  assert.equal(turn.busy, true);

  closed.resolve();

  await stopping;

  assert.deepEqual(await running, { status: 'interrupted', text: '' });
});

test('failed send and failed close both release the answer slot', async () => {
  for (const failure of ['send', 'close'] as const) {
    const session = child();

    session[failure] = async () => {
      throw new Error(failure);
    };

    const turn = new AnswerTurn(options, async () => session);

    await assert.rejects(
      turn.run(open, source, 'answer', undefined, input),
      new RegExp(failure),
    );

    assert.equal(turn.busy, false);
  }
});

test('a refused interrupt closes the child and joins the pending answer before rejecting', async () => {
  const sending = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<TurnResult>();
  const session = child();

  session.send = async () => {
    sending.resolve();

    return finished.promise;
  };

  session.interrupt = async () => {
    throw new Error('Native interrupt refused');
  };

  session.close = vi.fn(async () => {
    finished.resolve({ status: 'interrupted', text: '' });
  });

  const turn = new AnswerTurn(options, async () => session);
  const running = turn.run(open, source, 'answer', undefined, input);

  await sending.promise;

  const stop = { deadline: 789 };

  await assert.rejects(turn.interrupt(stop), /Native interrupt refused/);

  assert.equal((await running).status, 'interrupted');

  assert.equal(turn.busy, false);

  assert.deepEqual(vi.mocked(session.close).mock.calls[0], [stop]);
});
