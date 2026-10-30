import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { CodexSchema } from './fixtures/codex-schema.js';
import { CodexAdapter } from '../src/agents/codex.js';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { nativeScenario } from './fixtures/native-scenario.js';
import { replayWire, observeWire } from './fixtures/native-wire.js';
import { scratch } from './fixtures/scratch.js';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { fixture, close } from './fixtures/codex-adapter.js';
import type { RpcMessage } from '../src/agents/json-rpc.js';
import type {
  AgentEvent,
  TurnResult,
  UserRequest,
  UserResponse,
} from '../src/agents/types.js';
import { until, within } from './fixtures/within.js';
import { untimed } from './fixtures/limits.js';

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
  for (const scenario of ['basic', 'control', 'background', 'spell'] as const) {
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
          .map((event) => untimed(event.usage.limits))
          .filter((value) => value !== undefined);
        assert.deepEqual(
          limits[0],
          runtime === 'codex'
            ? [{ window: '7D', percent: 37, resetsAt: 1793820572 }]
            : [
                { window: '5H', percent: 8, resetsAt: 1793298599.822 },
                { window: '7D', percent: 71, resetsAt: 1793483999.822 },
              ],
        );
        if (runtime === 'claude')
          assert.deepEqual(
            limits.find((value) => value[0]?.percent === 7),
            [
              { window: '5H', percent: 7, resetsAt: 1793298600 },
              { window: '7D', percent: 71, resetsAt: 1793484000 },
            ],
          );
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
      (await f.session.send('familiars', { name: 'review', args: '' })).text,
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

test('every Codex request method in production is covered by the native schema and an exercised call', () => {
  const methods = new CodexSchema(schema).methods();
  const exercised = new Set(requests.map(({ method }) => method));
  for (const file of ['codex.ts', 'codex-commands.ts']) {
    const source = ts.createSourceFile(
      file,
      readFileSync(new URL(`../src/agents/${file}`, import.meta.url), 'utf8'),
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
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['request', 'notify'].includes(node.expression.name.text)
      ) {
        for (const method of names(node.arguments[0]!)) {
          assert.ok(methods.has(method), `Schema lacks ${method}`);
          assert.ok(
            exercised.has(method),
            `Contract cases do not exercise ${method}`,
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
