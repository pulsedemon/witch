import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { AnswerTurn } from '../src/agents/answer-turn.js';
import type { AgentEvent, AgentSession } from '../src/agents/types.js';
import { writeJson } from '../src/persistence/json.js';
import {
  peerAnswerOutputSchema,
  preparePeerAnswers,
  parsePeerAnswers,
} from '../src/core/peer-answers.js';
import {
  answerInstruction,
  requestContext,
} from '../src/core/peer-requests.js';
import {
  fixture as codex,
  controlledFixture,
} from './fixtures/codex-adapter.js';
import { launcher as claude } from './fixtures/claude-adapter.js';
import { until } from './fixtures/within.js';
import { scratch } from './fixtures/scratch.js';

async function input(cwd: string) {
  const requests = ['First private question', 'Second private question'].map(
    (message) => ({
      id: randomUUID(),
      claim: randomUUID(),
      project: 'project',
      from: 'asker',
      to: 'owner',
      reference: 'task:answer',
      message,
      askedAt: '2026-10-30T00:00:00Z',
    }),
  );
  const batch = await preparePeerAnswers(requests, cwd);
  return { requests, file: batch.file, context: requestContext(batch) };
}

async function answer(session: AgentSession, cwd: string) {
  const batch = await input(cwd);
  const result = await session.send(
    answerInstruction,
    undefined,
    batch.context,
    'peer-answer',
    { outputSchema: peerAnswerOutputSchema, requestFile: batch.file },
  );
  assert.equal(result.status, 'completed');
  assert.deepEqual(
    parsePeerAnswers(result.text, batch.requests),
    batch.requests.map(({ id, message }) => ({
      id,
      message: `Read: ${message}`,
    })),
  );
  return batch;
}

for (const runtime of ['codex', 'claude']) {
  test(`${runtime} reviews use the ordinary session without peer-answer restrictions`, async (t) => {
    const processes: (number | undefined)[] = [];
    const requests: string[] = [];
    const onAnswerProcess = async (pid: number | undefined) => {
      processes.push(pid);
    };
    const onEvent = (event: AgentEvent) => {
      if (event.type === 'request') {
        requests.push(event.request.kind);
        session.respond(event.request.id, { decision: 'accept' });
      }
    };
    const f =
      runtime === 'codex'
        ? await codex(onEvent, { onAnswerProcess })
        : await claude();
    const session: AgentSession =
      'session' in f
        ? f.session
        : await f.connect({ onAnswerProcess, onEvent });
    t.onTestFinished(() => session.close());
    assert.equal((await session.send('normal')).status, 'completed');
    const id = session.info.id;
    requests.length = 0;
    assert.equal(
      (
        await session.send(
          'normal review',
          undefined,
          'task context',
          'pr-review',
        )
      ).status,
      'completed',
    );
    assert.equal(session.info.id, id);
    assert.deepEqual(processes, []);
    if ('session' in f) {
      const frame = JSON.parse(
        await readFile(join(f.cwd, 'prompt.json'), 'utf8'),
      ) as { params: Record<string, unknown> };
      assert.equal(frame.params.threadId, id);
      assert.equal(frame.params.outputSchema, undefined);
      assert.ok(requests.includes('approval'));
    } else {
      const content = await readFile(join(f.cwd, 'content.json'), 'utf8');
      assert.match(content, /Witch request/);
      assert.equal(f.children.length, 1);
    }
    assert.equal((await session.send('normal afterward')).status, 'completed');
  });
}

for (const history of [false, true]) {
  test(`Codex answers in a separate restricted ${history ? 'fork' : 'fresh thread'} and preserves its owner`, async (t) => {
    const events: AgentEvent[] = [];
    const processes: (number | undefined)[] = [];
    const { session, cwd, child } = await codex(
      (event) => {
        events.push(event);
        if (event.type === 'request')
          session.respond(event.request.id, { decision: 'accept' });
      },
      {
        onAnswerProcess: async (pid) => {
          if (pid === undefined)
            assert.throws(() => process.kill(processes[0]!, 0), {
              code: 'ESRCH',
            });
          processes.push(pid);
        },
      },
    );
    t.onTestFinished(() => session.close());
    if (history) await session.send('normal');
    const before = { ...session.info };
    events.length = 0;
    await writeFile(
      join(cwd, 'config.json'),
      JSON.stringify({
        mcp_servers: {
          connected: { command: 'fake', tool_timeout_sec: null },
          remote: { url: 'https://probe.invalid/mcp', tool_timeout_sec: null },
        },
      }),
    );
    await answer(session, cwd);
    assert.deepEqual(session.info, before);
    assert.equal(child.exitCode, null);
    assert.notEqual(processes[0], child.pid);
    assert.equal(processes.length, 2);
    assert.equal(processes[1], undefined);
    assert.ok(
      !events.some((event) =>
        ['text', 'info', 'request', 'closed'].includes(event.type),
      ),
    );
    const request = JSON.parse(
      await readFile(join(cwd, 'answer-connect.json'), 'utf8'),
    ) as { method: string; params: Record<string, unknown> };
    assert.equal(request.method, history ? 'thread/fork' : 'thread/start');
    assert.equal(request.params.threadId, history ? before.id : undefined);
    assert.equal(request.params.excludeTurns, history ? true : undefined);
    assert.equal(request.params.approvalPolicy, 'never');
    assert.equal(request.params.sandbox, 'read-only');
    assert.equal(request.params.ephemeral, true);
    const config = request.params.config as Record<string, unknown>;
    for (const feature of [
      'apps',
      'plugins',
      'hooks',
      'multi_agent',
      'multi_agent_v2',
      'skill_mcp_dependency_install',
    ])
      assert.equal(config[`features.${feature}`], false);
    assert.deepEqual(config.mcp_servers, {
      connected: { command: 'fake', enabled: false },
      remote: { url: 'https://probe.invalid/mcp', enabled: false },
    });
    assert.deepEqual(config.notify, []);
    const turn = JSON.parse(
      await readFile(join(cwd, 'prompt.json'), 'utf8'),
    ) as { params: Record<string, unknown> };
    assert.deepEqual(turn.params.outputSchema, peerAnswerOutputSchema);
    assert.equal((await session.send('normal afterward')).status, 'completed');
  });

  test(`Claude answers in a separate restricted ${history ? 'fork' : 'fresh session'} and preserves its owner`, async (t) => {
    const f = await claude();
    const events: AgentEvent[] = [];
    const processes: (number | undefined)[] = [];
    const session = await f.connect({
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'request')
          session.respond(event.request.id, { decision: 'accept' });
      },
      onAnswerProcess: async (pid) => {
        if (pid === undefined)
          assert.throws(() => process.kill(processes[0]!, 0), {
            code: 'ESRCH',
          });
        processes.push(pid);
      },
    });
    t.onTestFinished(() => session.close());
    if (history) await session.send('normal');
    const before = { ...session.info };
    events.length = 0;
    await answer(session, f.cwd);
    assert.deepEqual(session.info, before);
    assert.equal(f.children[0]!.exitCode, null);
    assert.equal(processes[0], f.children[1]!.pid);
    assert.deepEqual(processes.slice(1), [undefined]);
    assert.ok(
      !events.some((event) =>
        ['text', 'info', 'request', 'closed', 'tool'].includes(event.type),
      ),
      JSON.stringify(events),
    );
    const args = f.args[1]!;
    assert.equal(args.includes('--fork-session'), history);
    assert.equal(args.includes(`--resume=${before.id}`), history);
    for (const argument of [
      '--tools=Read,Grep,Glob',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--setting-sources=user,project,local',
    ])
      assert.ok(args.includes(argument), argument);
    assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]!), {
      disableAllHooks: true,
    });
    assert.deepEqual(
      JSON.parse(
        args
          .find((arg) => arg.startsWith('--json-schema='))!
          .slice('--json-schema='.length),
      ),
      peerAnswerOutputSchema,
    );
    assert.equal((await session.send('normal afterward')).status, 'completed');
  });
}

for (const builtin of [undefined, ':workspace']) {
  test(`Codex permits the request file and preserves named boundaries${builtin ? ' with a builtin parent' : ''}`, async (t) => {
    const { session, cwd } = await codex(
      (event) => {
        if (event.type === 'request')
          session.respond(event.request.id, { decision: 'accept' });
      },
      { mode: 'named-profile' },
    );
    t.onTestFinished(() => session.close());
    await writeFile(
      join(cwd, 'config.json'),
      JSON.stringify({
        permissions: {
          owner: {
            description: null,
            extends: 'base',
            workspace_roots: null,
            filesystem: {
              glob_scan_max_depth: null,
              '/project': 'write',
              '/secret': 'deny',
              ':workspace_roots': { cache: 'write', denied: 'deny' },
            },
            network: {
              enabled: true,
              proxy_url: null,
              domains: { 'example.com': 'allow' },
            },
          },
          base: {
            extends: builtin ?? null,
            filesystem: {
              glob_scan_max_depth: 3,
              '/readable': 'read',
              '/inherited-secret': 'deny',
            },
            network: null,
          },
        },
      }),
    );
    const batch = await answer(session, await scratch('private-requests-'));
    const { params } = JSON.parse(
      await readFile(join(cwd, 'answer-connect.json'), 'utf8'),
    ) as { params: Record<string, unknown> };
    assert.equal(params.permissions, 'owner');
    assert.equal(params.sandbox, undefined);
    assert.deepEqual((params.config as Record<string, unknown>).permissions, {
      owner: {
        extends: 'base',
        filesystem: {
          [batch.file]: 'read',
          '/project': 'read',
          '/secret': 'deny',
          ':workspace_roots': { cache: 'read', denied: 'deny' },
        },
        network: { enabled: false, domains: { 'example.com': 'allow' } },
      },
      base: {
        ...(builtin ? { extends: ':read-only' } : {}),
        filesystem: {
          glob_scan_max_depth: 3,
          '/readable': 'read',
          '/inherited-secret': 'deny',
        },
        network: { enabled: false },
      },
    });
  });
}

test('Codex answers follow changed and cleared native permission profiles', async (t) => {
  const f = await controlledFixture('identity');
  t.onTestFinished(() => f.session.close());
  await writeJson(join(f.cwd, 'config.json'), {
    permissions: {
      updated: {
        filesystem: { ':root': 'read', '/updated-secret': 'deny' },
        network: { enabled: false },
      },
    },
  });
  for (const expected of [
    { profile: { id: 'updated' }, permissions: 'updated', sandbox: undefined },
    { profile: null, permissions: undefined, sandbox: 'read-only' },
  ]) {
    await f.emit({
      method: 'thread/settings/updated',
      params: {
        threadId: 'native-thread',
        threadSettings: {
          activePermissionProfile: expected.profile,
          model: 'model-a',
          effort: 'low',
          cwd: f.cwd,
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          modelProvider: 'openai',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          collaborationMode: {
            mode: 'default',
            settings: {
              model: 'model-a',
              reasoning_effort: 'low',
              developer_instructions: null,
            },
          },
        },
      },
    });
    await answer(f.session, f.cwd);
    const { params } = JSON.parse(
      await readFile(join(f.cwd, 'answer-connect.json'), 'utf8'),
    ) as { params: Record<string, unknown> };
    assert.equal(params.permissions, expected.permissions);
    assert.equal(params.sandbox, expected.sandbox);
  }
});

for (const reason of ['missing profile', 'exposed tool', 'registration']) {
  test(`Codex refuses an answer before sending input on ${reason} failure`, async (t) => {
    const { session, cwd, child } = await codex(
      (event) => {
        if (event.type === 'request')
          session.respond(event.request.id, { decision: 'accept' });
      },
      {
        mode: reason === 'missing profile' ? 'named-profile' : undefined,
        onAnswerProcess: async (pid) => {
          if (pid && reason === 'registration')
            throw new Error('Registration failed');
        },
      },
    );
    t.onTestFinished(() => session.close());
    if (reason === 'exposed tool')
      await writeFile(
        join(cwd, 'answer-tools.json'),
        JSON.stringify([
          {
            name: 'unreal',
            authStatus: 'unsupported',
            runtimeStatus: 'connected',
            resources: [],
            resourceTemplates: [],
            tools: {
              write: { name: 'write', inputSchema: { type: 'object' } },
            },
          },
        ]),
      );
    await assert.rejects(
      answer(session, cwd),
      /permission profile|exposed MCP|Registration failed/,
    );
    await assert.rejects(readFile(join(cwd, 'prompt.json')), {
      code: 'ENOENT',
    });
    assert.equal(child.exitCode, null);
    assert.equal((await session.send('normal afterward')).status, 'completed');
  });
}

for (const runtime of ['codex', 'claude'] as const) {
  test(`${runtime} declines interactive answer requests without prompting the owner`, async (t) => {
    const events: AgentEvent[] = [];
    const onEvent = (event: AgentEvent) => events.push(event);
    const f = runtime === 'codex' ? await codex(onEvent) : await claude();
    const session = 'session' in f ? f.session : await f.connect({ onEvent });
    t.onTestFinished(() => session.close());
    await writeFile(join(f.cwd, 'answer-approval'), '');
    await answer(session, f.cwd);
    const response: unknown = JSON.parse(
      await readFile(join(f.cwd, 'answer-response.json'), 'utf8'),
    );
    assert.match(
      JSON.stringify(response),
      runtime === 'codex'
        ? /cannot request user input or approval/
        : /"behavior":"deny"/,
    );
    assert.ok(!events.some((event) => event.type === 'request'));
  });
}

test('Claude allows its exact request file when the native read needs approval', async (t) => {
  const f = await claude();
  const events: AgentEvent[] = [];
  const session = await f.connect({ onEvent: (event) => events.push(event) });
  t.onTestFinished(() => session.close());
  const batch = await input(f.cwd);
  await writeFile(join(f.cwd, 'answer-approval'), batch.file);
  const result = await session.send(
    answerInstruction,
    undefined,
    batch.context,
    'peer-answer',
    { outputSchema: peerAnswerOutputSchema, requestFile: batch.file },
  );
  assert.equal(result.status, 'completed');
  const response = JSON.parse(
    await readFile(join(f.cwd, 'answer-response.json'), 'utf8'),
  ) as { response: { behavior: string; updatedInput: unknown } };
  assert.equal(response.response.behavior, 'allow');
  assert.deepEqual(response.response.updatedInput, { file_path: batch.file });
  assert.ok(!events.some((event) => event.type === 'request'));
  assert.deepEqual(
    parsePeerAnswers(result.text, batch.requests),
    batch.requests.map(({ id, message }) => ({
      id,
      message: `Read: ${message}`,
    })),
  );
});

test('Claude closes a child whose process registration fails and keeps its owner usable', async (t) => {
  const f = await claude();
  const session = await f.connect({
    onAnswerProcess: async (pid) => {
      if (pid) throw new Error('Registration failed');
    },
    onEvent: (event) => {
      if (event.type === 'request')
        session.respond(event.request.id, { decision: 'accept' });
    },
  });
  t.onTestFinished(() => session.close());
  await assert.rejects(answer(session, f.cwd), /Registration failed/);
  assert.notEqual(f.children[1]!.exitCode ?? f.children[1]!.signalCode, null);
  assert.equal(f.children[0]!.exitCode, null);
  assert.equal((await session.send('normal afterward')).status, 'completed');
});

test('Codex owner shutdown collects its familiar after answer cleanup rejects', async () => {
  const events: AgentEvent[] = [];
  const binding = {
    directory: '/control/familiars',
    conversation: 'conversation',
    activation: randomUUID(),
  };
  const run = randomUUID();
  const f = await codex((event) => events.push(event), {
    mode: 'brews',
    familiarBinding: binding,
  });
  const interrupted = vi
    .spyOn(AnswerTurn.prototype, 'interrupt')
    .mockRejectedValueOnce(new Error('Answer cleanup refused'));
  try {
    const params = { threadId: 'native-thread', turnId: 'reported-turn' };
    await writeJson(join(f.cwd, 'events-1.json'), [
      {
        method: 'item/started',
        params: {
          ...params,
          item: {
            id: 'review-command',
            type: 'commandExecution',
            processId: '42',
            command: 'review',
            cwd: f.cwd,
            source: 'unifiedExecStartup',
            status: 'inProgress',
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          },
        },
      },
      {
        method: 'item/commandExecution/outputDelta',
        params: {
          ...params,
          itemId: 'review-command',
          delta: `WITCH_FAMILIAR ${JSON.stringify({ version: 1, conversation: binding.conversation, activation: binding.activation, run })}\r\n`,
        },
      },
    ]);
    await until(
      'registered familiar',
      async () =>
        (
          await f.session.familiar!.report(
            {
              kind: 'familiar-register',
              run,
              name: 'cleanup check',
              runtime: 'claude',
            },
            Date.now() + 5000,
          )
        ).kind === 'familiar-registered',
    );
    await assert.rejects(f.session.close(), /Answer cleanup refused/);
    assert.deepEqual(
      JSON.parse(await readFile(join(f.cwd, 'terminated.jsonl'), 'utf8')),
      {
        threadId: 'native-thread',
        processId: '42',
      },
    );
    assert.notEqual(f.child.exitCode ?? f.child.signalCode, null);
    assert.ok(
      !events.some(
        (event) =>
          event.type === 'notice' &&
          /could not confirm cleanup/.test(event.text),
      ),
    );
    assert.equal(
      events.filter((event) => event.type === 'subagent').at(-1)?.subagent
        .status,
      'stopped',
    );
  } finally {
    interrupted.mockRestore();
    await f.session.close().catch(() => {});
  }
});

test('Claude owner shutdown still closes its native process after answer cleanup rejects', async () => {
  const f = await claude();
  const session = await f.connect();
  const interrupt = vi
    .spyOn(AnswerTurn.prototype, 'interrupt')
    .mockRejectedValueOnce(new Error('Answer cleanup refused'));
  try {
    await assert.rejects(session.close(), /Answer cleanup refused/);
    assert.notEqual(f.children[0]!.exitCode ?? f.children[0]!.signalCode, null);
  } finally {
    interrupt.mockRestore();
    f.children[0]!.kill();
  }
});

for (const runtime of ['codex', 'claude'] as const) {
  for (const phase of ['closing', 'closed']) {
    test(`${runtime} rejects automatic answers through a ${phase} owner without spawning`, async () => {
      const processes: (number | undefined)[] = [];
      const onAnswerProcess = async (pid: number | undefined) => {
        processes.push(pid);
      };
      const f =
        runtime === 'codex'
          ? await codex(undefined, { onAnswerProcess })
          : await claude();
      const session =
        'session' in f ? f.session : await f.connect({ onAnswerProcess });
      const batch = await input(f.cwd);
      const closing = session.close();
      if (phase === 'closed') await closing;
      const rejected = assert.rejects(
        session.send(answerInstruction, undefined, '', 'peer-answer', {
          outputSchema: peerAnswerOutputSchema,
          requestFile: batch.file,
        }),
        /session is closed/,
      );
      await closing;
      await rejected;
      assert.deepEqual(processes, []);
    });
  }

  test(`${runtime} normalizes cancelled startup only after its answer process exits`, async (t) => {
    const entered = Promise.withResolvers<void>();
    const registered = Promise.withResolvers<void>();
    let answerPid: number | undefined;
    const onAnswerProcess = async (pid: number | undefined) => {
      if (pid !== undefined) {
        answerPid = pid;
        entered.resolve();
        await registered.promise;
      }
    };
    const f =
      runtime === 'codex'
        ? await codex(undefined, { onAnswerProcess })
        : await claude();
    const session =
      'session' in f ? f.session : await f.connect({ onAnswerProcess });
    t.onTestFinished(async () => {
      registered.resolve();
      await session.close();
    });
    const batch = await input(f.cwd);
    const sending = session.send(
      answerInstruction,
      undefined,
      '',
      'peer-answer',
      {
        outputSchema: peerAnswerOutputSchema,
        requestFile: batch.file,
      },
    );
    await entered.promise;
    const stopping = session.interrupt();
    registered.resolve();
    await stopping;
    assert.equal((await sending).status, 'interrupted');
    assert.throws(() => process.kill(answerPid!, 0), { code: 'ESRCH' });
    assert.equal(session.closed, false);
    assert.ok((await session.skills()).length > 0);
  });
}
