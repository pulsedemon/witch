import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import { CodexSchema } from './fixtures/codex-schema.js';
import { CodexAdapter } from '../src/agents/codex.js';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { nativeScenario } from '../src/agents/native-scenario.js';
import type { NativeScenario } from '../src/agents/native-scenario.js';
import { replayWire, observeWire } from './fixtures/native-wire.js';
import { scratch } from './fixtures/scratch.js';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { fixture, close } from './fixtures/codex-adapter.js';
import type { RpcMessage } from '../src/agents/json-rpc.js';
import type {
  AgentEvent,
  Limit,
  TurnResult,
  UserRequest,
  UserResponse,
} from '../src/agents/types.js';
import { until, within } from './fixtures/within.js';
import { untimed } from './fixtures/limits.js';
import {
  peerAnswerOutputSchema,
  preparePeerAnswers,
  parsePeerAnswers,
} from '../src/core/peer-answers.js';
import {
  answerInstruction,
  requestContext,
} from '../src/core/peer-requests.js';

const schema = JSON.parse(
  readFileSync(
    new URL('./fixtures/native/codex/protocol.schema.json', import.meta.url),
    'utf8',
  ),
);

const manifest = JSON.parse(
  readFileSync(
    new URL('./fixtures/native/manifest.json', import.meta.url),
    'utf8',
  ),
);

const requests: RpcMessage[] = [];

for (const runtime of ['codex', 'claude'] as const) {
  for (const scenario of Object.keys(
    manifest[runtime].scenarios,
  ) as NativeScenario[]) {
    test(`${runtime} replays native ${scenario} through its production adapter`, async () => {
      const cwd = await scratch('witch-native-protocol-');
      const files: string[] = manifest[runtime].scenarios[scenario].files;

      const replay = replayWire(
        files.map((file) =>
          fileURLToPath(
            new URL(`./fixtures/native/${runtime}/${file}`, import.meta.url),
          ),
        ),
        cwd,
      );

      const captures: ReturnType<typeof observeWire>[] = [];

      const launch = () => {
        const child = replay.launch();

        captures.push(observeWire(child));

        return child;
      };

      const adapter =
        runtime === 'codex'
          ? new CodexAdapter(launch)
          : new ClaudeAdapter(launch);

      const events = await nativeScenario(
        adapter,
        {
          cwd,
          executable: '/native/absent',
          model: manifest[runtime].model,
          effort: 'low',
          memoryDirectories: [],
        },
        scenario,
      );

      await replay.finished();

      if (scenario === 'basic') {
        const limits = events
          .filter((event) => event.type === 'usage')
          .map((event) => untimed(event.usage.account?.limits))
          .filter((value) => value !== undefined);

        const expected =
          runtime === 'codex'
            ? [{ window: '7D', percent: 37, resetsAt: 1793820572 }]
            : [{ window: '7D', percent: 47, resetsAt: 1794693600.275 }];

        assert.deepEqual(limits[0], expected);

        if (runtime === 'claude') {
          // later cached replies omit native rows and cannot replace the complete account reading; a fresh reply's reset time moves by a fraction of a second.
          const seconds = (
            reading: readonly Omit<Limit, 'observedAt'>[] | undefined,
          ) =>
            reading?.map((limit) => ({
              ...limit,
              resetsAt: Math.floor(limit.resetsAt!),
            }));

          assert.ok(limits.length > 1);

          for (const reading of limits.slice(1))
            assert.deepEqual(seconds(reading), seconds(expected));
        }
      }

      if (runtime === 'codex') {
        const contract = new CodexSchema(schema);

        for (const capture of captures) {
          await capture.finished();

          const approvals = new Map<string | number, string>();

          for (const frame of capture.frames) {
            const message = frame.message as RpcMessage;

            if (
              frame.direction === 'server' &&
              message.method &&
              message.id !== undefined
            )
              approvals.set(message.id, message.method);

            if (frame.direction === 'client' && message.method) {
              contract.client(frame.message);

              requests.push(message);
            } else if (
              frame.direction === 'client' &&
              message.id !== undefined &&
              approvals.has(message.id) &&
              message.result !== undefined
            ) {
              contract.response(approvals.get(message.id)!, message.result);
            }
          }
        }
      }
    });
  }
}

test('Codex wire validation rejects an optional field the generated schema does not name', () => {
  const contract = new CodexSchema(schema);

  assert.throws(
    () =>
      contract.client({
        id: 1,
        method: 'thread/start',
        params: { runtimeWorkspaceRotts: ['/project'] },
      }),
    /params\/runtimeWorkspaceRotts/,
  );
});

test('Codex wire validation follows input variants while retaining native maps and raw context', () => {
  const contract = new CodexSchema(schema);

  contract.client({
    id: 2,
    method: 'thread/start',
    params: {
      config: { 'shell_environment_policy.set.FIXTURE': 'yes' },
      runtimeWorkspaceRoots: ['/project'],
    },
  });

  contract.client({
    id: 3,
    method: 'thread/inject_items',
    params: {
      threadId: 'thread',
      items: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'context' }],
        },
      ],
    },
  });

  contract.client({
    id: 4,
    method: 'turn/start',
    params: {
      threadId: 'thread',
      input: [
        { type: 'skill', name: 'probe', path: '/project/SKILL.md' },
        { type: 'text', text: 'hello', text_elements: [] },
      ],
    },
  });

  assert.throws(
    () =>
      contract.client({
        id: 5,
        method: 'turn/start',
        params: {
          threadId: 'thread',
          input: [{ type: 'text', text: 'hello', text_elementz: [] }],
        },
      }),
    /input\/0\/text_elementz/,
  );

  assert.throws(
    () =>
      contract.client({
        id: 6,
        method: 'turn/start',
        params: { threadId: 'thread', input: [{ type: 'text', text: 4 }] },
      }),
    /turn\/start/,
  );
});

test('Codex wire validation rejects unknown methods and validates approval answers against their request', () => {
  const contract = new CodexSchema(schema);

  assert.throws(
    () => contract.client({ id: 7, method: 'thread/missing', params: {} }),
    /thread\/missing/,
  );

  contract.response('item/tool/requestUserInput', {
    answers: { question: { answers: ['one'] } },
  });

  assert.throws(
    () =>
      contract.response('item/tool/requestUserInput', {
        answers: { question: { answers: 'one' } },
      }),
    /answers/,
  );
});

test('selected skills and child reads send native-shaped requests and consume their replies', async () => {
  const events: AgentEvent[] = [];
  const contract = new CodexSchema(schema);

  const f = await fixture((event) => events.push(event), {
    onClient(message) {
      if (message.method) {
        contract.client(message);

        requests.push(message);
      }
    },
  });

  try {
    await f.session.skills();

    assert.equal(
      (
        await f.session.send('familiars', {
          skill: { name: 'review', args: '' },
        })
      ).text,
      'Parent text.',
    );

    await until('child metadata', () =>
      events.some(
        (event) =>
          event.type === 'subagent' && event.subagent.name === 'inspect config',
      ),
    );

    const selected = requests
      .filter(({ method }) => method === 'turn/start')
      .at(-1)!;

    assert.deepEqual((selected.params as { input: unknown[] }).input[1], {
      type: 'skill',
      name: 'review',
      path: '/skills/review/SKILL.md',
    });
  } finally {
    await close(f.session, f.cwd);
  }
});

test('images go to Codex as native localImage items after the text and selected skill of turn/start, and after the text of turn/steer', async () => {
  const contract = new CodexSchema(schema);
  const sent: RpcMessage[] = [];

  const f = await fixture(undefined, {
    onClient(message) {
      if (message.method) {
        contract.client(message);

        sent.push(message);
      }
    },
  });

  const input = (method: string) =>
    (
      sent.find((message) => message.method === method)?.params as {
        input: unknown[];
      }
    )?.input;

  try {
    await f.session.skills();

    const turn = f.session.send('hold', {
      skill: { name: 'review', args: '' },
      images: ['/images/a.png', '/images/b.jpg'],
    });

    await until('the turn', () => input('turn/start') !== undefined);

    assert.equal(
      await f.session.steer('also this', { images: ['/images/c.jpg'] }),
      true,
    );

    assert.deepEqual(input('turn/start'), [
      { type: 'text', text: 'hold', text_elements: [] },
      { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
      { type: 'localImage', path: '/images/a.png' },
      { type: 'localImage', path: '/images/b.jpg' },
    ]);

    assert.deepEqual(input('turn/steer'), [
      { type: 'text', text: 'also this', text_elements: [] },
      { type: 'localImage', path: '/images/c.jpg' },
    ]);

    await writeFile(join(f.cwd, 'release'), 'yes');

    await within(f.session.interrupt(), 2000, 'interrupt');

    assert.equal((await turn).status, 'interrupted');
  } finally {
    await close(f.session, f.cwd);
  }
});

for (const [prompt, method, response] of [
  [
    'question',
    'item/tool/requestUserInput',
    { decision: 'accept', answers: { value: ['fixture answer'] } },
  ],
  ['permissions', 'item/permissions/requestApproval', { decision: 'accept' }],
  ['file change', 'item/fileChange/requestApproval', { decision: 'decline' }],
  [
    'elicitation',
    'mcpServer/elicitation/request',
    { decision: 'accept', content: { label: 'fixture label' } },
  ],
] satisfies [string, string, UserResponse][]) {
  test(`the adapter's ${method} response satisfies the generated native contract`, async () => {
    let pending: UserRequest | undefined;
    const contract = new CodexSchema(schema);
    const replies: unknown[] = [];

    const f = await fixture(
      (event) => {
        if (event.type === 'request') pending = event.request;
      },
      {
        onClient(message) {
          if (message.method) contract.client(message);
          else if (message.result !== undefined) {
            contract.response(method, message.result);

            replies.push(message.result);
          }
        },
      },
    );

    try {
      const sending = f.session.send(prompt);

      await until('native request', () => pending !== undefined);

      f.session.respond(pending!.id, response);

      assert.equal((await sending).status, 'completed');

      assert.equal(replies.length, 1);
    } finally {
      await close(f.session, f.cwd);
    }
  });
}

test('a restricted Codex fork and its structured reply use the generated native contract', async () => {
  const contract = new CodexSchema(schema);

  const f = await fixture(undefined, {
    resume: 'native-thread',
    onClient(message) {
      if (message.method) {
        contract.client(message);

        requests.push(message);
      }
    },
  });

  try {
    const request = {
      id: randomUUID(),
      claim: randomUUID(),
      project: 'project',
      from: 'asker',
      to: 'owner',
      reference: 'task:contract',
      message: 'Private contract question',
      askedAt: '2026-10-30T00:00:00Z',
    };

    const batch = await preparePeerAnswers([request], f.cwd);

    const result = await f.session.send(answerInstruction, {
      context: requestContext(batch),
      purpose: 'peer-answer',
      answer: { outputSchema: peerAnswerOutputSchema, requestFile: batch.file },
    });

    assert.equal(result.status, 'completed');

    assert.deepEqual(parsePeerAnswers(result.text, [request]), [
      { id: request.id, message: 'Read: Private contract question' },
    ]);
  } finally {
    await close(f.session, f.cwd);
  }
});

test('a compaction window change unsubscribes and resumes through the generated native contract', async () => {
  const contract = new CodexSchema(schema);
  const sent: string[] = [];

  const f = await fixture(undefined, {
    model: 'model-a',
    resume: 'native-thread',
    automaticCompaction: true,
    configuration: { model_context_window: 1_000_000 },
    contextCatalog: async () => ({
      models: [
        {
          slug: 'model-a',
          context_window: 500_000,
          max_context_window: 1_000_000,
          effective_context_window_percent: 100,
        },
      ],
    }),
    onClient(message) {
      if (!message.method) return;

      contract.client(message);

      requests.push(message);

      sent.push(message.method);
    },
  });

  try {
    sent.length = 0;

    await f.session.selectModel('model-b');

    assert.deepEqual(sent, [
      'thread/settings/update',
      'thread/unsubscribe',
      'thread/resume',
    ]);
  } finally {
    await close(f.session, f.cwd);
  }
});

test('every Codex request method in production is covered by the native schema and an exercised call', () => {
  const methods = new CodexSchema(schema).methods();
  const exercised = new Set(requests.map(({ method }) => method));
  const agents = new URL('../src/agents/', import.meta.url);

  for (const file of readdirSync(agents).filter((name) =>
    /^codex.*\.ts$/.test(name),
  )) {
    const source = ts.createSourceFile(
      file,
      readFileSync(new URL(file, agents), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );

    const names = (expression: ts.Expression): string[] => {
      if (ts.isStringLiteral(expression)) return [expression.text];

      if (ts.isConditionalExpression(expression))
        return [...names(expression.whenTrue), ...names(expression.whenFalse)];

      assert.fail(
        `Uncovered dynamic RPC method in ${file}:${source.getLineAndCharacterOfPosition(expression.pos).line + 1}`,
      );
    };

    const visit = (node: ts.Node) => {
      // `pages(rpc, method, …)` sends `method` once per page
      const method = !ts.isCallExpression(node)
        ? undefined
        : ts.isPropertyAccessExpression(node.expression) &&
            ['request', 'notify'].includes(node.expression.name.text)
          ? node.arguments[0]
          : ts.isIdentifier(node.expression) && node.expression.text === 'pages'
            ? node.arguments[1]
            : undefined;

      if (method) {
        for (const name of names(method)) {
          assert.ok(methods.has(name), `Schema lacks ${name}`);

          assert.ok(
            exercised.has(name),
            `Contract cases do not exercise ${name}`,
          );
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(source);
  }
});

test('removing an optional native field rejects the production request that sends it', () => {
  const changed = structuredClone(schema);

  delete changed.definitions.v2.ThreadStartParams.properties
    .runtimeWorkspaceRoots;

  const request = requests.find(({ method }) => method === 'thread/start');

  assert.ok(request);

  assert.throws(
    () => new CodexSchema(changed).client(request),
    /params\/runtimeWorkspaceRoots/,
  );

  const turn = requests.find(({ method }) => method === 'turn/start');

  assert.ok(turn);

  const input = changed.definitions.v2.UserInput.oneOf.find(
    (branch: { title: string }) => branch.title === 'TextUserInput',
  );

  delete input.properties.text_elements;

  assert.throws(
    () => new CodexSchema(changed).client(turn),
    /input\/0\/text_elements/,
  );
});

test('a recorded Claude result stays pending until its recorded native idle arrives', async () => {
  const cwd = await scratch('witch-native-idle-');

  const files: string[] = manifest.claude.scenarios.basic.files.map(
    (file: string) =>
      fileURLToPath(
        new URL(`./fixtures/native/claude/${file}`, import.meta.url),
      ),
  );

  const frames = readFileSync(files[0]!, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));

  const idle = frames.findIndex(
    ({ message }) =>
      message.type === 'system' &&
      message.subtype === 'session_state_changed' &&
      message.state === 'idle',
  );

  assert.ok(idle > 0);

  const replay = replayWire(files, cwd, { gates: [[idle]], fragmentBytes: 7 });
  let capture: ReturnType<typeof observeWire>;

  const adapter = new ClaudeAdapter(() => {
    const child = replay.launch();

    capture = observeWire(child);

    return child;
  });

  const connect = adapter.connect.bind(adapter);
  let first: Promise<TurnResult> | undefined;
  let completed = false;

  adapter.connect = async (options) => {
    const session = await connect(options);
    const send = session.send.bind(session);

    session.send = (...args) => {
      const result = send(...args);

      if (!first) {
        first = result;

        void result.then(() => {
          completed = true;
        });
      }

      return result;
    };

    return session;
  };

  const events: AgentEvent[] = [];

  const running = nativeScenario(
    adapter,
    {
      cwd,
      executable: '/native/absent',
      model: manifest.claude.model,
      effort: 'low',
      memoryDirectories: [],
    },
    'basic',
    (event) => events.push(event),
  );

  void running.catch(() => {});

  try {
    await within(replay.paused(0, idle), 5000, 'recorded idle gate');

    await until('recorded result at the SDK transport', () =>
      capture.frames.some(
        ({ direction, message }) =>
          direction === 'server' &&
          (message as { type?: string }).type === 'result',
      ),
    );

    await until('recorded reply text', () =>
      events.some(
        (event) =>
          event.type === 'text' && event.text.includes('WITCH_CONTEXT_309'),
      ),
    );

    assert.ok(first);

    assert.equal(
      completed,
      false,
      'result alone must not complete the native turn',
    );
  } finally {
    replay.release(0);

    await running.catch(() => {});
  }

  await running;

  assert.equal(completed, true);

  await replay.finished();
});
