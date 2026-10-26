import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, vi } from 'vitest';
import type { FamiliarAction } from '../src/agents/familiar-report.js';
import { familiarMarker } from '../src/agents/familiar-report.js';
import { ClaudeCommands } from '../src/agents/claude-commands.js';
import type {
  AgentEvent,
  UserRequest,
  UserResponse,
} from '../src/agents/types.js';
import { callControl, ControlHost } from '../src/persistence/control.js';
import { checkDeadline } from '../src/persistence/coordination.js';
import {
  coordinationFixture,
  pauseDiscovery,
} from './fixtures/coordination.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import { scratch } from './fixtures/scratch.js';
import { within } from './fixtures/within.js';

test('familiar reports bypass a blocked task mailbox and preserve active-session admission', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  pauseDiscovery(vi.spyOn);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await coordinationFixture(cleanup, async () => {
    entered.resolve();
    await release.promise;
  });
  const client = await f.start();
  client.a.sessions[0]!.session.familiar = {
    runtime: 'claude',
    report: async (action) => {
      if (action.kind === 'familiar-update') {
        client.a.sessions[0]!.options.onEvent({
          type: 'subagent',
          subagent: {
            id: 'review',
            name: 'Claude review',
            kind: '',
            ...action.progress,
          },
        });
        return { kind: 'familiar-updated' };
      }
      return { kind: 'familiar-registered' };
    },
  };
  const binding = client.coordination.familiarBinding();
  const claiming = client.claim('https://github.com/acme/widget/issues/42');
  try {
    await within(entered.promise, 5000, 'claim assignment');
    const action: FamiliarAction = {
      kind: 'familiar-update',
      run: randomUUID(),
      sequence: 0,
      progress: { status: 'running', model: 'observed-model', tools: 7 },
    };
    assert.equal(
      (await within(callControl(binding, action), 3000, 'independent report'))
        .kind,
      'familiar-updated',
    );
    assert.equal(client.coordinator.snapshot.subagents[0]!.tools, 7);
    const stale = await callControl(
      { ...binding, activation: randomUUID() },
      { ...action, sequence: 1, progress: { status: 'failed', tools: 99 } },
    );
    assert.equal(stale.kind, 'error');
    assert.equal(client.coordinator.snapshot.subagents[0]!.tools, 7);
    const wrongMailbox = await callControl(binding, { kind: 'peers' });
    assert.equal(wrongMailbox.kind, 'error');
  } finally {
    release.resolve();
    assert.equal((await claiming).kind, 'claimed');
  }
});

test('an explicit control deadline reaches the host and prevents late report acceptance', async () => {
  const binding = {
    directory: await scratch('familiar-deadline-'),
    conversation: 'conversation',
    activation: randomUUID(),
  };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const deadline = Date.now() + 10_000;
  let accepted = false;
  let received = 0;
  const host = await ControlHost.open(
    binding.directory,
    async (request) => {
      received = request.deadline;
      entered.resolve();
      await release.promise;
      checkDeadline(request.deadline);
      accepted = true;
      return { kind: 'familiar-registered' };
    },
    (error) => {
      throw error;
    },
  );
  const calling = callControl(
    binding,
    { kind: 'familiar-register', run: randomUUID(), name: 'review' },
    deadline,
  );
  const rejected = assert.rejects(calling, /result unknown/);
  let now: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await within(entered.promise, 3000, 'report arrival');
    assert.equal(received, deadline);
    now = vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
    release.resolve();
    await rejected;
    await host.drain();
    assert.equal(accepted, false);
  } finally {
    release.resolve();
    await host.close();
    now?.mockRestore();
  }
});

test('only a supporting session receives familiar instructions and the exact user prompt stays separate', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  pauseDiscovery(vi.spyOn);
  const f = await coordinationFixture(cleanup);
  const client = await f.start();
  const prompt = 'Review this\n  exact user input.';
  await client.coordinator.send(prompt);
  assert.doesNotMatch(client.a.inputs.at(-1)!.context!, /--familiar-claude/);
  client.a.sessions[0]!.session.familiar = {
    runtime: 'claude',
    report: async () => ({
      kind: 'familiar-registered',
    }),
  };
  await client.coordinator.send(prompt);
  const input = client.a.inputs.at(-1)!;
  assert.equal(input.prompt, prompt);
  assert.ok(!input.context!.includes(prompt));
  assert.ok(input.context!.includes(client.coordination.familiarCommand()));
  assert.match(input.context!, /--familiar-claude <task-name> --report-file/);
  assert.match(input.context!, /--permission-prompts none/);
  assert.match(input.context!, /keep its stdout connected/);
  assert.match(
    input.context!,
    /Delegate work to Claude when it suits the task/,
  );
  client.a.sessions[0]!.session.familiar.runtime = 'codex';
  await client.coordinator.send(prompt);
  const codex = client.a.inputs.at(-1)!;
  assert.equal(codex.prompt, prompt);
  assert.match(codex.context!, /Delegate work to Codex when it suits the task/);
  assert.match(codex.context!, /--familiar-codex <task-name> --report-file/);
  assert.match(codex.context!, /run_in_background: true/);
  assert.doesNotMatch(codex.context!, /--familiar-claude/);
});

test('pending native requests leave the mailbox available and retain complete request and response payloads', async () => {
  const binding = {
    directory: await scratch('familiar-requests-'),
    conversation: 'owner',
    activation: randomUUID(),
  };
  const run = randomUUID();
  const events: AgentEvent[] = [];
  const owner = new ClaudeCommands(
    {
      getTaskOutput: async () => ({
        output: familiarMarker({
          version: 1,
          conversation: binding.conversation,
          activation: binding.activation,
          run,
        }),
      }),
      stopTask: async () => {},
    },
    binding,
    () => 'session',
    () => false,
    (event) => events.push(event),
  );
  owner.receive({
    type: 'system',
    subtype: 'task_started',
    task_id: 'review',
    task_type: 'local_bash',
    description: 'review',
    is_backgrounded: true,
    uuid: randomUUID(),
    session_id: 'session',
  });
  const host = await ControlHost.open(
    binding.directory,
    async (request) =>
      owner.report(request.action as FamiliarAction, request.deadline),
    (error) => {
      throw error;
    },
  );
  const cases: { request: UserRequest; response: UserResponse }[] = [
    {
      request: {
        id: 'write',
        kind: 'approval',
        title: 'Write',
        detail: 'patch',
        diff: [
          {
            path: '/packet/a',
            kind: 'update',
            movePath: '/packet/b',
            hunks: [{ oldStart: 2, newStart: 4, lines: ['-old', '+new'] }],
          },
        ],
      },
      response: { decision: 'decline' },
    },
    {
      request: {
        id: 'choice',
        kind: 'question',
        title: 'Choice',
        detail: 'pick',
        questions: [
          {
            id: 'q',
            title: 'Pick',
            options: ['first', 'second'],
            secret: true,
            multiple: true,
          },
        ],
      },
      response: { decision: 'cancel' },
    },
    {
      request: {
        id: 'mcp',
        kind: 'elicitation',
        title: 'Details',
        detail: 'server',
        schema: { type: 'object', properties: { count: { type: 'number' } } },
        url: 'https://example.test/request',
      },
      response: { decision: 'accept', content: { count: 5, enabled: true } },
    },
  ];
  try {
    await callControl(binding, {
      kind: 'familiar-register',
      run,
      name: 'review',
    });
    let sequence = 0;
    for (const { request, response } of cases) {
      assert.equal(
        (await callControl(binding, { kind: 'familiar-request', run, request }))
          .kind,
        'familiar-request-pending',
      );
      assert.equal(
        (
          await callControl(binding, {
            kind: 'familiar-update',
            run,
            sequence: sequence++,
            progress: { status: 'running', tools: 7 },
          })
        ).kind,
        'familiar-updated',
      );
      const emitted = events.filter((e) => e.type === 'request').at(-1)!;
      assert.equal(emitted.type, 'request');
      assert.deepEqual(emitted.request, {
        ...request,
        id: `familiar/${run}/${request.id}`,
        replyAsPrompt: false,
        survivesTurn: true,
      });
      owner.respond(emitted.request.id, response);
      const answer = await callControl(binding, {
        kind: 'familiar-request-poll',
        run,
        id: request.id,
      });
      assert.equal(answer.kind, 'familiar-response');
      assert.deepEqual(answer.response, response);
      await callControl(binding, {
        kind: 'familiar-request-resolved',
        run,
        id: request.id,
      });
    }
  } finally {
    await owner.close();
    await host.close();
  }
  assert.equal(events.filter((e) => e.type === 'request-resolved').length, 3);
});
