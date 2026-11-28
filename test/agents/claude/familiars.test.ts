import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { test, vi } from 'vitest';
import { ClaudeCommands } from '../../../src/agents/claude/commands.js';
import { familiarMarker } from '../../../src/agents/familiar-report.js';
import type { AgentEvent, TaskStatus } from '../../../src/agents/types.js';
import { receiptFile } from '../../../src/core/review/review-files.js';
import type { ReviewReceiptFile } from '../../../src/core/review/review-files.js';
import {
  frameWriter,
  jsonLines,
  launcher,
} from '../../fixtures/claude-adapter.js';
import { until } from '../../fixtures/within.js';
import { scratch } from '../../fixtures/scratch.js';

function commands(root?: string) {
  const binding = {
    directory: root ? join(root, 'control', 'familiars') : '/control',
    conversation: 'owner',
    activation: randomUUID(),
  };

  const run = randomUUID();
  const events: AgentEvent[] = [];
  const outputs = new Map<string, string>();
  const stopped: string[] = [];
  const backgrounded: string[] = [];

  const control = {
    getTaskOutput: async (id: string): Promise<unknown> => ({
      output: outputs.get(id) ?? '',
    }),
    backgroundTasks: async (toolUse: string) => {
      backgrounded.push(toolUse);

      return true;
    },
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
      tool_use_id: `toolu_${id}`,
      description: 'review',
      is_backgrounded: background,
    });

  const marker = familiarMarker({
    version: 1,
    conversation: binding.conversation,
    activation: binding.activation,
    run,
  });

  const register = (
    runtime: 'claude' | 'codex' = 'codex',
    planReview = false,
  ) =>
    owner.report(
      {
        kind: 'familiar-register',
        run,
        name: 'review',
        runtime,
        ...(planReview && { planReview: true }),
      },
      Date.now() + 5000,
    );

  const update = (
    sequence: number,
    status: TaskStatus = 'running',
    report = status === 'completed' ? 'Full report' : undefined,
    receipt?: ReviewReceiptFile,
  ) =>
    owner.report(
      {
        kind: 'familiar-update',
        run,
        sequence,
        progress: {
          status,
          tools: 3,
          model: 'observed',
          report,
          receiptFile: receipt,
          notices: ['MCP down'],
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
    backgrounded,
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

const completedReceipt = {
  status: 'completed',
  runtime: 'claude',
  model: 'observed',
  planSha256: 'a'.repeat(64),
  findings: [],
};

for (const code of [0, 1, undefined]) {
  test(`Claude confirms a staged plan review only with an observed zero exit (exit ${code})`, async () => {
    const root = await scratch('witch-review-exit-');
    const f = commands(root);
    f.start();

    await until(
      'plan review registration',
      async () =>
        (await f.register('claude', true)).kind === 'familiar-registered',
    );

    await assert.rejects(
      f.update(0, 'completed'),
      /did not supply a completed receipt/,
    );

    const report = JSON.stringify(completedReceipt);
    const path = join(root, 'receipt.json');
    const file = await open(path, 'wx');

    const receipt = await (async () => {
      try {
        await file.writeFile(report);

        return await receiptFile(path, file);
      } finally {
        await file.close();
      }
    })();

    for (const change of [{ runtime: 'codex' }, { model: 'different' }])
      await assert.rejects(
        f.update(
          0,
          'completed',
          JSON.stringify({ ...completedReceipt, ...change }),
          receipt,
        ),
        /did not supply a completed receipt/,
      );

    await f.update(0, 'completed', report, receipt);
    assert.equal(f.familiars().at(-1)!.status, 'running');
    f.start('other');

    f.emit({
      subtype: 'task_notification',
      task_id: 'other',
      run_id: '2',
      status: 'completed',
      summary: 'Background command "other" completed (exit code 0)',
    });

    f.emit({
      subtype: 'task_updated',
      task_id: 'review',
      run_id: '2',
      patch: { status: 'completed' },
    });

    assert.equal(f.familiars().at(-1)!.status, 'running');

    f.emit({
      subtype: 'task_notification',
      task_id: 'review',
      run_id: '2',
      status: 'completed',
      summary:
        code === undefined
          ? 'review'
          : `Background command "review" completed (exit code ${code})`,
    });

    await until(
      'the carrying shell exit',
      () => f.familiars().at(-1)!.status !== 'running',
    );

    assert.equal(
      f.familiars().at(-1)!.status,
      code === 0 ? 'completed' : 'failed',
    );

    assert.equal(f.familiars().at(-1)!.report, code === 0 ? report : undefined);
  });
}

test('an ordinary familiar cannot acquire plan-review scope on retry', async () => {
  const f = commands();
  f.start();

  await until(
    'ordinary registration',
    async () => (await f.register('claude')).kind === 'familiar-registered',
  );

  await assert.rejects(f.register('claude', true), /review mode changed/);
  await assert.rejects(f.register('codex'), /runtime changed/);
});

test('a plan review cannot stage its first completion after native exit', async () => {
  const f = commands();
  f.start();

  await until(
    'plan review registration',
    async () =>
      (await f.register('claude', true)).kind === 'familiar-registered',
  );

  f.emit({
    subtype: 'task_notification',
    task_id: 'review',
    run_id: '2',
    status: 'completed',
  });

  await assert.rejects(
    f.update(0, 'completed', JSON.stringify(completedReceipt)),
    /familiar run has already ended/,
  );

  assert.equal(f.familiars().at(-1)!.status, 'failed');
});

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
          { kind: 'familiar-register', run, name: 'check', runtime: 'codex' },
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
        { kind: 'familiar-register', run, name: 'check', runtime: 'codex' },
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
    { kind: 'familiar-register', run: other, name: 'other', runtime: 'codex' },
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

test('a familiar in a foreground command is moved to the background and then registers', async () => {
  const f = commands();
  f.start('review', '2', false);
  f.start('other', '2', false);

  f.emit({
    subtype: 'task_started',
    task_id: 'bare',
    run_id: '2',
    task_type: 'local_bash',
    description: 'review',
    is_backgrounded: false,
  });

  f.outputs.set('bare', f.marker);

  f.outputs.set(
    'other',
    familiarMarker({
      version: 1,
      conversation: f.binding.conversation,
      activation: f.binding.activation,
      run: randomUUID(),
    }),
  );

  assert.equal((await f.register()).kind, 'familiar-pending');
  assert.deepEqual(f.backgrounded, ['toolu_review']);
  assert.equal(f.familiars().length, 0);

  f.emit({
    subtype: 'task_updated',
    task_id: 'review',
    run_id: '2',
    patch: { is_backgrounded: true },
  });

  assert.equal((await f.register()).kind, 'familiar-registered');
  assert.equal(f.familiars().length, 1);
  assert.equal(f.familiars()[0]!.status, 'running');
  assert.equal(f.familiars()[0]!.parent, 'parent');
  await f.owner.close();
});

test('a native task request that never answers rejects the registration at its deadline', async () => {
  for (const request of ['getTaskOutput', 'backgroundTasks'] as const) {
    const f = commands();
    f.start('review', '2', request === 'getTaskOutput');
    f.control[request] = () => new Promise<never>(() => {});

    await assert.rejects(
      f.owner.report(
        {
          kind: 'familiar-register',
          run: f.run,
          name: 'review',
          runtime: 'claude',
        },
        Date.now() + 200,
      ),
      /expired/,
    );

    assert.deepEqual(f.familiars(), []);
    await f.owner.close();
  }
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

test('one background command registers each familiar whose marker appears in its output', async () => {
  const f = commands();
  const second = randomUUID();
  f.start();
  assert.equal((await f.register()).kind, 'familiar-registered');

  f.outputs.set(
    'review',
    f.marker +
      familiarMarker({
        version: 1,
        conversation: f.binding.conversation,
        activation: f.binding.activation,
        run: second,
      }) +
      f.marker,
  );

  assert.equal(
    (
      await f.owner.report(
        {
          kind: 'familiar-register',
          run: second,
          name: 'second review',
          runtime: 'claude',
        },
        Date.now() + 5000,
      )
    ).kind,
    'familiar-registered',
  );

  await f.owner.close();
  assert.deepEqual(f.stopped, ['review']);

  assert.deepEqual(
    f.familiars().map(({ name, status }) => [name, status]),
    [
      ['review', 'running'],
      ['second review', 'running'],
      ['review', 'stopped'],
      ['second review', 'stopped'],
    ],
  );
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
      {
        kind: 'familiar-register',
        run: f.run,
        name: 'review',
        runtime: 'codex',
      },
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

    if (change === 'connection') void f.owner.stop();

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
  assert.deepEqual(f.familiars().at(-1)!.notices, ['MCP down']);
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

test("a familiar's own report after its stopped command replaces the stop mark once, and progress past the grace is refused", async () => {
  const f = commands();
  const clock = performance.now();
  const now = vi.spyOn(performance, 'now').mockReturnValue(clock);

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

  f.emit({
    subtype: 'task_notification',
    task_id: 'review',
    run_id: '2',
    status: 'stopped',
  });

  const stops = f.familiars().length;
  assert.equal(f.familiars().at(-1)!.status, 'stopped');
  now.mockReturnValue(clock + 9_999);
  assert.deepEqual(await f.update(0), { kind: 'familiar-updated' });
  assert.equal(f.familiars().length, stops);
  now.mockReturnValue(clock + 10_001);
  await assert.rejects(f.update(1), /already ended/);

  assert.deepEqual(
    await f.owner.report(
      { kind: 'familiar-request-resolved', run: f.run, id: 'question' },
      Date.now() + 5000,
    ),
    { kind: 'familiar-updated' },
  );

  assert.deepEqual(
    await f.owner.report(
      {
        kind: 'familiar-update',
        run: f.run,
        sequence: 1,
        progress: {
          status: 'stopped',
          report: 'Claude task stopped (SIGTERM).',
        },
      },
      Date.now() + 5000,
    ),
    { kind: 'familiar-updated' },
  );

  assert.equal(f.familiars().at(-1)!.status, 'stopped');
  assert.equal(f.familiars().at(-1)!.report, 'Claude task stopped (SIGTERM).');
  await assert.rejects(f.update(2, 'completed'), /already ended/);
  assert.equal(f.familiars().at(-1)!.report, 'Claude task stopped (SIGTERM).');
  now.mockRestore();
  await f.owner.close();
});

test("a Claude session's Claude familiar registers under its own runtime", async () => {
  const f = commands();
  f.start();
  assert.equal((await f.register('claude')).kind, 'familiar-registered');
  assert.equal(f.familiars()[0]!.id, `claude-familiar/${f.run}`);
  assert.equal(f.familiars()[0]!.runtime, 'claude');
  await f.owner.close();
});
