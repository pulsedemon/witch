import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { test, vi } from 'vitest';
import { ClaudeCommands } from '../src/agents/claude-commands.js';
import { familiarMarker } from '../src/agents/familiar-report.js';
import type { AgentEvent, TaskStatus } from '../src/agents/types.js';
import { frameWriter, jsonLines, launcher } from './fixtures/claude-adapter.js';
import { until } from './fixtures/within.js';

function commands() {
  const binding = {
    directory: '/control',
    conversation: 'owner',
    activation: randomUUID(),
  };
  const run = randomUUID();
  const events: AgentEvent[] = [];
  const outputs = new Map<string, string>();
  const stopped: string[] = [];
  const control = {
    getTaskOutput: async (id: string): Promise<unknown> => ({
      output: outputs.get(id) ?? '',
    }),
    stopTask: async (id: string) => {
      stopped.push(id);
    },
  };
  const owner = new ClaudeCommands(
    control,
    binding,
    () => 'session',
    (id) => id === 'parent',
    (e) => events.push(e),
  );
  const emit = (fields: object) =>
    owner.receive({
      type: 'system',
      session_id: 'session',
      uuid: randomUUID(),
      ...fields,
    } as SDKMessage);
  const start = (id = 'review', runId = '2', background = true) =>
    emit({
      subtype: 'task_started',
      task_id: id,
      run_id: runId,
      task_type: 'local_bash',
      parent_task_id: 'parent',
      description: 'review',
      is_backgrounded: background,
    });
  const marker = familiarMarker({
    version: 1,
    conversation: binding.conversation,
    activation: binding.activation,
    run,
  });
  const register = () =>
    owner.report(
      { kind: 'familiar-register', run, name: 'review' },
      Date.now() + 5000,
    );
  const update = (sequence: number, status: TaskStatus = 'running') =>
    owner.report(
      {
        kind: 'familiar-update',
        run,
        sequence,
        progress: {
          status,
          tools: 3,
          model: 'observed',
          report: status === 'completed' ? 'Full report' : undefined,
        },
      },
      Date.now() + 5000,
    );
  const familiars = () =>
    events.flatMap((e) => (e.type === 'subagent' ? [e.subagent] : []));
  outputs.set('review', marker);
  return {
    binding,
    run,
    events,
    outputs,
    stopped,
    control,
    owner,
    emit,
    start,
    marker,
    register,
    update,
    familiars,
  };
}

test('a Claude background command registers after the parent turn and closes only its native task', async () => {
  const events: AgentEvent[] = [];
  const f = await launcher('background');
  const binding = {
    directory: '/control',
    conversation: 'owner',
    activation: randomUUID(),
  };
  const session = await f.connect({
    familiarBinding: binding,
    onEvent: (e) => events.push(e),
  });
  const emit = frameWriter(
    f.cwd,
    (name) =>
      events.some((e) => e.type === 'skills' && e.skills[0]?.name === name),
    f.children[0]!,
  );
  const run = randomUUID();
  try {
    const turn = session.send('initial');
    await until('parent reply', () =>
      events.some(
        (e) => e.type === 'skills' && e.skills[0]?.name === 'result-1',
      ),
    );
    await emit({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
    });
    assert.equal((await turn).status, 'completed');
    await writeFile(
      join(f.cwd, 'task-outputs.json'),
      JSON.stringify({
        reviewer: familiarMarker({
          version: 1,
          conversation: binding.conversation,
          activation: binding.activation,
          run,
        }),
      }),
    );
    const tasks = [
      {
        task_id: 'reviewer',
        run_id: '1',
        task_type: 'local_bash',
        description: 'review',
      },
      {
        task_id: 'server',
        run_id: '1',
        task_type: 'local_bash',
        description: 'serve',
      },
    ];
    await emit({ type: 'system', subtype: 'background_tasks_changed', tasks });
    assert.equal(
      (
        await session.familiar!.report(
          { kind: 'familiar-register', run, name: 'check' },
          Date.now() + 5000,
        )
      ).kind,
      'familiar-registered',
    );
    await session.familiar!.report(
      {
        kind: 'familiar-update',
        run,
        sequence: 0,
        progress: { status: 'running', model: 'gpt-6-astra', tools: 4 },
      },
      Date.now() + 5000,
    );
    await emit({ type: 'system', subtype: 'background_tasks_changed', tasks });
    assert.equal(session.replied, false);
    const request = {
      id: 'native-approval',
      kind: 'approval' as const,
      title: 'Write file',
      detail: 'native approval',
    };
    assert.equal(
      (
        await session.familiar!.report(
          { kind: 'familiar-request', run, request },
          Date.now() + 5000,
        )
      ).kind,
      'familiar-request-pending',
    );
    const pending = events.find((event) => event.type === 'request');
    assert.ok(pending?.type === 'request');
    assert.equal(pending.request.survivesTurn, true);
    session.respond(pending.request.id, { decision: 'decline' });
    assert.deepEqual(
      await session.familiar!.report(
        { kind: 'familiar-request-poll', run, id: request.id },
        Date.now() + 5000,
      ),
      { kind: 'familiar-response', response: { decision: 'decline' } },
    );
    assert.deepEqual(
      events.flatMap((e) =>
        e.type === 'subagent'
          ? [[e.subagent.runtime, e.subagent.model, e.subagent.tools]]
          : [],
      ),
      [
        ['codex', undefined, 0],
        ['codex', 'gpt-6-astra', 4],
      ],
    );
    assert.equal(
      events.filter((e) => e.type === 'command' && e.command.familiar).length,
      1,
    );
    await session.close();
    const requests = (await jsonLines(join(f.cwd, 'wire.jsonl'))) as {
      request?: { subtype: string; task_id?: string };
    }[];
    assert.deepEqual(
      requests.flatMap((r) =>
        r.request?.subtype === 'stop_task' ? [r.request.task_id] : [],
      ),
      ['reviewer'],
    );
    await assert.rejects(
      session.familiar!.report(
        { kind: 'familiar-register', run, name: 'check' },
        Date.now() + 5000,
      ),
      /unavailable/,
    );
  } finally {
    await session.close();
  }
});

test('native request IDs stay distinct between familiar runs and answers survive retries', async () => {
  const f = commands();
  f.start();
  await f.register();
  const other = randomUUID();
  f.start('other');
  f.outputs.set(
    'other',
    familiarMarker({
      version: 1,
      conversation: f.binding.conversation,
      activation: f.binding.activation,
      run: other,
    }),
  );
  await f.owner.report(
    { kind: 'familiar-register', run: other, name: 'other' },
    Date.now() + 5000,
  );
  const request = {
    id: '7',
    kind: 'question' as const,
    title: 'Choose',
    detail: 'question',
    questions: [
      {
        id: 'answer',
        title: 'Choose',
        options: ['left', 'right'],
        multiple: false,
        secret: true,
      },
    ],
  };
  for (const run of [f.run, other]) {
    assert.equal(
      (
        await f.owner.report(
          { kind: 'familiar-request', run, request },
          Date.now() + 5000,
        )
      ).kind,
      'familiar-request-pending',
    );
    await f.owner.report(
      { kind: 'familiar-request', run, request },
      Date.now() + 5000,
    );
  }
  const requests = f.events.flatMap((e) =>
    e.type === 'request' ? [e.request] : [],
  );
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0]!.id, requests[1]!.id);
  assert.deepEqual(requests[0]!.questions, request.questions);
  assert.equal(f.owner.respond('7', { decision: 'cancel' }), false);
  f.owner.respond(requests[1]!.id, {
    decision: 'accept',
    answers: { answer: ['right'] },
  });
  f.owner.respond(requests[0]!.id, { decision: 'decline' });
  f.owner.respond(requests[0]!.id, { decision: 'accept' });
  for (let count = 0; count < 2; count++) {
    assert.deepEqual(
      await f.owner.report(
        { kind: 'familiar-request-poll', run: f.run, id: '7' },
        Date.now() + 5000,
      ),
      { kind: 'familiar-response', response: { decision: 'decline' } },
    );
    assert.deepEqual(
      await f.owner.report(
        { kind: 'familiar-request-poll', run: other, id: '7' },
        Date.now() + 5000,
      ),
      {
        kind: 'familiar-response',
        response: { decision: 'accept', answers: { answer: ['right'] } },
      },
    );
  }
  await f.owner.report(
    { kind: 'familiar-request-resolved', run: f.run, id: '7' },
    Date.now() + 5000,
  );
  await f.owner.report(
    { kind: 'familiar-request-resolved', run: f.run, id: '7' },
    Date.now() + 5000,
  );
  assert.deepEqual(
    f.events.flatMap((e) => (e.type === 'request-resolved' ? [e.id] : [])),
    [requests[0]!.id],
  );
  await f.owner.close();
  assert.deepEqual(
    f.events.flatMap((e) => (e.type === 'request-resolved' ? [e.id] : [])),
    [requests[0]!.id, requests[1]!.id],
  );
  assert.equal(f.owner.respond(requests[1]!.id, { decision: 'cancel' }), false);
});

test('registration waits for backgrounding and a complete matching marker', async () => {
  const f = commands();
  assert.equal((await f.register()).kind, 'familiar-pending');
  f.start('review', '2', false);
  assert.equal((await f.register()).kind, 'familiar-pending');
  f.emit({
    subtype: 'task_updated',
    task_id: 'review',
    run_id: '2',
    patch: { is_backgrounded: true },
  });
  f.outputs.set('review', f.marker.trimEnd());
  assert.equal((await f.register()).kind, 'familiar-pending');
  f.outputs.set('review', f.marker);
  assert.equal((await f.register()).kind, 'familiar-registered');
  assert.equal((await f.register()).kind, 'familiar-registered');
  assert.equal(f.familiars().length, 1);
  assert.equal(f.familiars()[0]!.parent, 'parent');
  await f.owner.close();
});

test('completed foreground tasks release their state while active tasks can still become familiars', async () => {
  const f = commands();
  f.start('active', '2', false);
  for (let index = 0; index < 1000; index++) {
    const id = `finished-${index}`;
    f.start(id, '2', false);
    f.emit({
      subtype: 'task_updated',
      task_id: id,
      run_id: '2',
      patch: { status: 'completed' },
    });
  }
  assert.equal(f.owner['entries'].size, 1);
  f.emit({
    subtype: 'task_updated',
    task_id: 'active',
    run_id: '2',
    patch: { is_backgrounded: true },
  });
  f.outputs.set('active', f.marker);
  assert.equal((await f.register()).kind, 'familiar-registered');
  assert.equal(f.familiars().at(-1)!.status, 'running');
  await f.owner.close();
  assert.equal(f.familiars().at(-1)!.status, 'stopped');
  assert.equal(f.owner['entries'].size, 0);
});

test('two native commands cannot claim the same reported run', async () => {
  const f = commands();
  f.start();
  f.start('other');
  f.outputs.set('other', f.marker);
  await assert.rejects(f.register(), /more than one command/);
  assert.deepEqual(f.familiars(), []);
  await f.owner.close();
});

test('a task end or expired deadline during an output read prevents admission', async () => {
  for (const change of ['end', 'expire', 'connection'] as const) {
    const f = commands();
    f.start();
    const output = Promise.withResolvers<unknown>();
    f.control.getTaskOutput = () => output.promise;
    const deadline = Date.now() + 10_000;
    const registering = f.owner.report(
      { kind: 'familiar-register', run: f.run, name: 'review' },
      deadline,
    );
    const now =
      change === 'expire'
        ? vi.spyOn(Date, 'now').mockReturnValue(deadline + 1)
        : undefined;
    if (change === 'end')
      f.emit({
        subtype: 'task_notification',
        task_id: 'review',
        run_id: '2',
        status: 'completed',
      });
    if (change === 'connection') f.owner.stop();
    output.resolve({ output: f.marker });
    try {
      if (change === 'end')
        assert.equal((await registering).kind, 'familiar-pending');
      else
        await assert.rejects(
          registering,
          change === 'expire' ? /deadline|expired/ : /unavailable/,
        );
      assert.deepEqual(f.familiars(), []);
    } finally {
      now?.mockRestore();
      await f.owner.close();
    }
  }
});

test('stale native runs and repeated progress cannot revive a completed familiar', async () => {
  const f = commands();
  f.start();
  await f.register();
  f.emit({
    subtype: 'task_notification',
    task_id: 'review',
    run_id: '1',
    status: 'stopped',
  });
  await f.update(0);
  await f.update(0, 'failed');
  await f.update(1, 'completed');
  f.emit({
    subtype: 'task_notification',
    task_id: 'review',
    run_id: '2',
    status: 'completed',
  });
  f.start();
  assert.deepEqual(
    f.familiars().map((s) => s.status),
    ['running', 'running', 'completed'],
  );
  assert.equal(f.familiars().at(-1)!.report, 'Full report');
  await assert.rejects(f.update(2), /already ended/);
  f.start('review', '3');
  f.outputs.set('review', '');
  await assert.rejects(f.update(3), /not registered/);
  await f.owner.close();
});

test('native completion without a final report fails the familiar while live-set removal stops it', async () => {
  for (const status of ['completed', 'failed', 'removed'] as const) {
    const f = commands();
    f.emit({
      subtype: 'background_tasks_changed',
      tasks: [
        {
          task_id: 'review',
          run_id: '2',
          task_type: 'local_bash',
          description: 'review',
        },
      ],
    });
    await f.register();
    if (status === 'removed')
      f.emit({ subtype: 'background_tasks_changed', tasks: [] });
    else
      f.emit({
        subtype: 'task_notification',
        task_id: 'review',
        run_id: '2',
        status,
      });
    assert.equal(
      f.familiars().at(-1)!.status,
      status === 'removed' ? 'stopped' : 'failed',
    );
    await f.owner.close();
  }
});
