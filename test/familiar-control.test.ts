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
import {
  callControl,
  ControlHost,
  controlRequestSchema,
} from '../src/persistence/control.js';
import { checkDeadline } from '../src/persistence/coordination.js';
import {
  coordinationFixture,
  pauseDiscovery,
} from './fixtures/coordination.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import { scratch } from './fixtures/scratch.js';
import { within } from './fixtures/within.js';

test('familiar request parsing enforces the absolute diff path contract', () => {
  const input = {
    version: 1,
    id: randomUUID(),
    conversation: 'owner',
    activation: randomUUID(),
    deadline: Date.now() + 5000,
    action: {
      kind: 'familiar-request',
      run: randomUUID(),
      request: {
        id: 'approval',
        kind: 'approval',
        title: 'Change a file',
        detail: '',
        diff: [{ path: 'relative.txt', kind: 'update', hunks: [] }],
      },
    },
  };
  assert.throws(
    () => controlRequestSchema.parse(input),
    /paths must be absolute/,
  );
  input.action.request.diff[0]!.path = '/work/absolute.txt';
  assert.deepEqual(controlRequestSchema.parse(input), input);
});

test('familiar reports bypass a blocked task mailbox and preserve active-session admission', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  pauseDiscovery(vi.spyOn);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await coordinationFixture(cleanup, async (references) => {
    entered.resolve();
    await release.promise;
    return {
      assigned: references.filter((reference) =>
        reference.startsWith('github:'),
      ),
    };
  });
  const client = await f.start();
  client.a.sessions[0]!.session.familiar = {
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
    {
      kind: 'familiar-register',
      run: randomUUID(),
      name: 'review',
      runtime: 'codex',
    },
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
  assert.doesNotMatch(
    client.a.inputs.at(-1)!.context!,
    /When you write a plan, in a file or in your reply/,
  );
  client.a.sessions[0]!.session.familiar = {
    report: async () => ({
      kind: 'familiar-registered',
    }),
  };
  await client.coordinator.send(prompt);
  const input = client.a.inputs.at(-1)!;
  assert.equal(input.prompt, prompt);
  assert.ok(!input.context!.includes(prompt));
  assert.ok(
    input.context!.includes(client.coordination.commandPrefixes().familiar),
  );
  // both wrappers, the route first, and the launch tool of a session that isn't Claude
  assert.match(
    input.context!,
    /Delegate work only through Witch, never your own subagent tool/,
  );
  assert.match(
    input.context!,
    /--route <review\|planning\|implementation\|investigation> --json/,
  );
  assert.match(
    input.context!,
    /--familiar-claude <task-name> --report-file <new-file-under-task-scratch> -- --model <model>/,
  );
  assert.match(
    input.context!,
    /--familiar-codex <task-name> --report-file <new-file-under-task-scratch> -- -c model="<model>"/,
  );
  assert.match(input.context!, /--permission-prompts none/);
  assert.match(
    input.context!,
    /native exec_command with sandbox_permissions "require_escalated"/,
  );
  assert.match(input.context!, /keep its stdout connected/);
  assert.doesNotMatch(input.context!, /run_in_background/);
  const rule = input
    .context!.split('\n\n')
    .find((paragraph) =>
      paragraph.startsWith('When you write a plan, in a file or in your reply'),
    );
  assert.ok(rule, input.context);
  assert.match(
    rule,
    /or a familiar writes one for you, have familiars review it before you present it or carry it out, without waiting for the user to ask; this rule is the user's request for that review/,
  );
  assert.match(
    rule,
    /Your native progress list, carrying out an already approved plan and a plan Witch's \/review has reviewed don't need this review/,
  );
  assert.match(rule, /A spell's self-review doesn't replace it/);
  assert.match(
    rule,
    /--route review --of <runtime>:<model> --json, naming the runtime and model that wrote the plan/,
  );
  assert.match(
    rule,
    /launch only on a newly returned route that has no reviewer in this round, and in this round don't relaunch one that failed, stopped or was interrupted/,
  );
  assert.match(
    rule,
    /every route of your latest routing has a reviewer that finished with its report and no other reviewer failed, stopped or was interrupted/,
  );
  assert.match(
    rule,
    /if routing is refused or the review isn't complete, say the plan's review is incomplete and never call it reviewed/,
  );
  await client.coordinator.send(prompt);
  assert.doesNotMatch(client.a.inputs.at(-1)!.context!, /--familiar-claude/);
  const before = client.coordination.commandPrefixes().familiar;
  const native = client.a.sessions[0]!.session;
  const { familiar } = native;
  await native.close();
  const connect = client.a.connect.bind(client.a);
  // a Claude session launches its familiar with Bash
  client.a.connect = async (options) => {
    const session = await connect(options);
    session.familiar = familiar;
    const info = Object.getOwnPropertyDescriptor(session, 'info')!.get!;
    Object.defineProperty(session, 'info', {
      get: () => ({ ...info.call(session), agent: 'claude' }),
    });
    return session;
  };
  await client.coordinator.send(prompt);
  assert.equal(client.a.inputs.at(-1)!.session, input.session);
  assert.match(
    client.a.inputs.at(-1)!.context!,
    /Use native Bash with run_in_background: true and keep its stdout connected/,
  );
  assert.match(
    client.a.inputs.at(-1)!.context!,
    /When you write a plan, in a file or in your reply/,
  );
  assert.doesNotMatch(client.a.inputs.at(-1)!.context!, /require_escalated/);
  assert.notEqual(client.coordination.commandPrefixes().familiar, before);
  assert.ok(
    client.a.inputs
      .at(-1)!
      .context!.includes(client.coordination.commandPrefixes().familiar),
  );
  assert.ok(!client.a.inputs.at(-1)!.context!.includes(before));
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
      runtime: 'codex',
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
