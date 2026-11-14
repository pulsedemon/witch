import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Ajv } from 'ajv';
import { z } from 'zod';
import { CodexAdapter } from '../src/agents/codex/codex.js';
import { readContextCatalog } from '../src/agents/codex/codex-compaction-policy.js';
import type { RpcMessage } from '../src/agents/codex/json-rpc.js';
import { installedAgents } from '../src/agents/registry.js';
import type { AgentEvent, SessionOptions } from '../src/agents/types.js';
import { Coordinator } from '../src/core/coordinator.js';
import type { Snapshot } from '../src/core/snapshot.js';
import type { ProcessIdentity } from '../src/core/state.js';
import { Memory } from '../src/memory/memory.js';
import { identifyProcess } from '../src/persistence/process.js';
import { StateStore } from '../src/persistence/store.js';

const execute = promisify(execFile);
const names = ['alpha', 'beta', 'gamma'] as const;

type Worker = (typeof names)[number];

type Observation<T> = { at: number; order: number; value: T };

const object = z.record(z.string(), z.unknown());

const modelRequest = z.object({
  model: z.string(),
  input: z.array(object),
  tools: z.array(object),
});

const commandFrame = z.object({
  threadId: z.string(),
  turnId: z.string(),
  item: z.object({
    id: z.string(),
    type: z.literal('commandExecution'),
    command: z.string(),
    status: z.string(),
    exitCode: z.number().nullable().optional(),
    aggregatedOutput: z.string().nullable().optional(),
  }),
});

const turnFrame = z.object({
  threadId: z.string(),
  turn: z.object({ id: z.string(), status: z.string() }),
});

const ajv = new Ajv({ strict: false });

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function within<T>(
  label: string,
  work: Promise<T>,
  milliseconds = 30_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timeout: ${label}`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function running(recorded: ProcessIdentity): Promise<boolean> {
  return (await identifyProcess(recorded.pid))?.started === recorded.started;
}

async function killRecorded(recorded: ProcessIdentity): Promise<void> {
  if (!(await running(recorded))) return;

  try {
    process.kill(recorded.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }

  for (let attempt = 0; attempt < 50; attempt++) {
    if (!(await running(recorded))) return;

    await delay(100);
  }

  throw new Error(`Probe process ${recorded.pid} survived cleanup`);
}

async function runScenario(version: 'v1' | 'v2'): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), `witch-codex-brews-${version}-`),
  );

  console.log(`${version} evidence: ${directory}`);

  const home = join(directory, 'home');
  const cwd = join(directory, 'project');
  const temporary = join(directory, 'tmp');
  const state = join(directory, 'state');

  const trace: Observation<{
    direction: 'sent' | 'received';
    message: RpcMessage;
  }>[] = [];

  const events: Observation<AgentEvent>[] = [];

  const snapshots: Observation<
    Pick<Snapshot, 'phase' | 'backgroundCommands' | 'items'>
  >[] = [];

  const model: Observation<unknown>[] = [];
  const workers = new Map<Worker, ProcessIdentity>();
  const descriptions = new Map<Worker, string>();
  const held = new Map<string, ServerResponse>();
  const steps = new Map<string, number>();

  const pending = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<unknown>>
  >();

  const failure = Promise.withResolvers<never>();

  void failure.promise.catch(() => {});

  let error: Error | undefined;
  let order = 0;
  let responseId = 0;
  let requestId = 0;
  let closing = false;
  let coordinator: Coordinator | undefined;
  let native: ProcessIdentity | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let childClosed: Promise<void> | undefined;
  let watching: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;
  let stderr = '';
  let nativeVersion = '';
  let revision = '';
  let port: number | undefined;
  const checks: string[] = [];
  const cleanupErrors: string[] = [];

  const observe = <T>(value: T): Observation<T> => ({
    at: Date.now(),
    order: ++order,
    value,
  });

  const fail = (cause: unknown): void => {
    error ??= cause instanceof Error ? cause : new Error(String(cause));

    failure.reject(error);
  };

  const check = <T>(label: string, work: Promise<T>): Promise<T> =>
    within(label, Promise.race([work, failure.promise]));

  const until = async (
    label: string,
    predicate: () => boolean | Promise<boolean>,
  ): Promise<void> => {
    const deadline = Date.now() + 30_000;

    while (!(await predicate())) {
      if (error) throw error;

      assert.ok(Date.now() < deadline, `Timeout: ${label}`);

      await delay(20);
    }

    if (error) throw error;
  };

  const brewRows = () =>
    coordinator?.snapshot.items.filter((item) =>
      item.title?.startsWith('Brew '),
    ) ?? [];

  const commands = () =>
    events.flatMap((entry) =>
      entry.value.type === 'command'
        ? [{ ...entry, value: entry.value.command }]
        : [],
    );

  const frames = (method: string) =>
    trace.filter(
      (entry) =>
        entry.value.direction === 'received' &&
        entry.value.message.method === method,
    );

  const commandItems = (method: string) =>
    frames(method).flatMap((entry) => {
      const parsed = commandFrame.safeParse(entry.value.message.params);

      return parsed.success && parsed.data.item.id === 'shared-command'
        ? [{ ...entry, value: parsed.data }]
        : [];
    });

  const origin = (name: Worker) => {
    const starts = commandItems('item/started').filter((entry) =>
      entry.value.item.command.includes(`/${name}.pid`),
    );

    assert.equal(starts.length, 1, `${name}: one native command start`);

    return starts[0]!.value;
  };

  const brewId = (name: Worker) => `${origin(name).threadId}/shared-command`;

  const turnEnded = (threadId: string, turnId: string) =>
    frames('turn/completed').find((entry) => {
      const frame = turnFrame.parse(entry.value.message.params);

      return frame.threadId === threadId && frame.turn.id === turnId;
    });

  const laterTurn = (name: Worker) => {
    const first = origin(name);

    const later = frames('turn/started')
      .map((entry) => turnFrame.parse(entry.value.message.params))
      .filter(
        (frame) =>
          frame.threadId === first.threadId && frame.turn.id !== first.turnId,
      );

    assert.equal(later.length, 1, `${name}: one later turn`);

    return later[0]!;
  };

  const workerIdentity = (name: Worker) => {
    const identity = workers.get(name);

    assert.ok(identity, `${name}: recorded worker identity`);

    return identity;
  };

  const listed = (...expected: Worker[]) => {
    assert.deepEqual(
      coordinator!.snapshot.backgroundCommands
        .map((command) => command.id)
        .sort(),
      expected.map(brewId).sort(),
      'Visible brews retain their thread/item identities',
    );
  };

  const sendResponse = (response: ServerResponse, item: unknown): void => {
    const id = `response-${++responseId}`;

    const messages = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.completed',
        response: {
          id,
          status: 'completed',
          usage: {
            input_tokens: 10,
            output_tokens: 10,
            total_tokens: 20,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ];

    model.push(observe({ response: messages }));

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      Connection: 'close',
    });

    response.end(
      messages
        .map(
          (message) =>
            `event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`,
        )
        .join(''),
    );
  };

  const final = (response: ServerResponse, text: string) =>
    sendResponse(response, {
      type: 'message',
      role: 'assistant',
      id: `message-${++responseId}`,
      content: [{ type: 'output_text', text, annotations: [] }],
    });

  const releaseModel = (key: string): void => {
    const response = held.get(key);

    assert.ok(response, `Held model response: ${key}`);

    held.delete(key);

    final(response, `${key} done`);
  };

  const workerCommand = (name: Worker) =>
    `${quote(process.execPath)} -e ${quote(`
const fs = require('node:fs');
const directory = ${JSON.stringify(cwd)};
fs.writeFileSync(directory + '/${name}.pid', String(process.pid));
console.log('${name}-started');
const deadline = setTimeout(() => process.exit(91), 60000);
const poll = setInterval(() => {
  if (fs.existsSync(directory + '/${name}.release')) {
    clearInterval(poll);
    clearTimeout(deadline);
    console.log('${name}-finished');
    process.exit(${name === 'beta' ? 7 : 0});
  }
}, 25);
`)}`;

  const namespace = version === 'v1' ? 'multi_agent_v1' : 'collaboration';

  const call = (
    response: ServerResponse,
    body: z.infer<typeof modelRequest>,
    id: string,
    name: string,
    args: Record<string, unknown>,
    scope?: string,
  ): void => {
    const tools = scope
      ? z
          .array(object)
          .parse(
            body.tools.find(
              (tool) => tool.type === 'namespace' && tool.name === scope,
            )?.tools,
          )
      : body.tools;

    const tool = tools.find(
      (tool) => tool.type === 'function' && tool.name === name,
    );

    assert.ok(tool, `Native tool advertised: ${scope ?? ''}/${name}`);

    assert.ok(
      ajv.validate(object.parse(tool.parameters), args),
      ajv.errorsText(),
    );

    sendResponse(response, {
      type: 'function_call',
      id: `function-${id}`,
      call_id: id,
      name,
      arguments: JSON.stringify(args),
      ...(scope ? { namespace: scope } : {}),
    });
  };

  const verifyOutputs = (body: z.infer<typeof modelRequest>): void => {
    for (const item of body.input.filter(
      (input) => input.type === 'function_call_output',
    )) {
      const id = z.string().parse(item.call_id);
      const output = z.string().parse(item.output);

      if (id === 'shared-command')
        assert.match(output, /Process running with session ID \d+/);
      else if (id.startsWith('spawn-')) {
        const result = object.parse(JSON.parse(output));

        assert.ok(
          version === 'v1'
            ? typeof result.agent_id === 'string'
            : result.task_name === `/root/${id.slice(6)}`,
          `Native spawn succeeded: ${output}`,
        );
      } else if (id.startsWith('follow-')) {
        if (version === 'v1')
          z.object({ submission_id: z.string() }).parse(JSON.parse(output));
        else assert.equal(output, '', 'Native followup succeeded');
      } else if (id === 'close-gamma')
        z.object({ previous_status: object }).parse(JSON.parse(output));
      else assert.fail(`Unexpected native tool result: ${id}`);
    }
  };

  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];

      for await (const chunk of request) chunks.push(Buffer.from(chunk));

      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString());

      model.push(observe({ request: raw, url: request.url }));

      assert.equal(request.url, '/v1/responses');

      const body = modelRequest.parse(raw);

      assert.equal(body.model, 'gpt-5.4');

      if (closing) {
        final(response, 'cleanup');

        return;
      }

      if (error) throw error;

      verifyOutputs(body);

      const input = body.input.findLast(
        (item) =>
          (item.role === 'user' || item.type === 'agent_message') &&
          /WITCH_CHILD_|PARENT_/.test(JSON.stringify(item)),
      );

      const marker = JSON.stringify(input);

      assert.ok(marker, 'Scenario marker reached the local provider');

      const name = ([...names, 'delta'] as const).find((name) =>
        marker.includes(`WITCH_CHILD_${name}`),
      );

      const key = name
        ? `${name}${marker.includes('FOLLOWUP') ? '-follow' : ''}`
        : marker.includes('PARENT_START')
          ? 'parent-start'
          : marker.includes('PARENT_FOLLOW')
            ? 'parent-follow'
            : marker.includes('PARENT_SHUTDOWN')
              ? 'parent-shutdown'
              : undefined;

      assert.ok(key, `Unexpected model request: ${marker}`);

      const step = steps.get(key) ?? 0;

      steps.set(key, step + 1);

      model.push(observe({ key, step }));

      if (name === 'delta') {
        assert.equal(step, 0, 'Delta sends one final response');

        final(response, 'delta done');
      } else if (name) {
        if (!key.endsWith('-follow') && step === 0) {
          call(response, body, 'shared-command', 'exec_command', {
            cmd: workerCommand(name),
            yield_time_ms: 1000,
            max_output_tokens: 1000,
          });
        } else {
          assert.equal(
            step,
            key.endsWith('-follow') ? 0 : 1,
            `No model retry advances ${key}`,
          );

          assert.ok(!held.has(key));

          held.set(key, response);
        }
      } else if (key === 'parent-start') {
        assert.ok(step <= 3, 'Parent spawn sequence');

        if (step === 3) final(response, 'parent done');
        else {
          const target = names[step]!;

          call(
            response,
            body,
            `spawn-${target}`,
            'spawn_agent',
            version === 'v1'
              ? { message: `WITCH_CHILD_${target}`, fork_context: false }
              : {
                  task_name: target,
                  message: `WITCH_CHILD_${target}`,
                  fork_turns: 'none',
                },
            namespace,
          );
        }
      } else if (key === 'parent-follow' || step === 0) {
        assert.ok(step <= 1, 'Parent alpha followup sequence');

        if (step === 1) final(response, 'followup sent');
        else {
          const target: Worker = key === 'parent-follow' ? 'alpha' : 'beta';

          call(
            response,
            body,
            `follow-${target}`,
            version === 'v1' ? 'send_input' : 'followup_task',
            {
              target: version === 'v1' ? origin(target).threadId : target,
              message: `WITCH_CHILD_${target} FOLLOWUP`,
            },
            namespace,
          );
        }
      } else {
        assert.ok(step <= 2, 'Parent shutdown sequence');

        if (step === 2) final(response, 'shutdown triggered');
        else {
          await until('Beta later turn held before shutdown', () =>
            held.has('beta-follow'),
          );

          if (version === 'v1')
            call(
              response,
              body,
              'close-gamma',
              'close_agent',
              { target: origin('gamma').threadId },
              namespace,
            );
          else
            call(
              response,
              body,
              'spawn-delta',
              'spawn_agent',
              {
                task_name: 'delta',
                message: 'WITCH_CHILD_delta',
                fork_turns: 'none',
              },
              namespace,
            );
        }
      }
    })().catch((cause) => {
      fail(cause);

      if (!response.headersSent) response.writeHead(500);

      response.end(String(cause));
    });
  });

  server.on('error', fail);

  const rpc = async (method: string, threadId: string): Promise<unknown> => {
    assert.ok(child);

    const id = `brew-check-${++requestId}`;
    const result = Promise.withResolvers<unknown>();

    pending.set(id, result);

    try {
      child.stdin.write(
        `${JSON.stringify({ id, method, params: { threadId } })}\n`,
      );

      return await check(method, result.promise);
    } finally {
      pending.delete(id);
    }
  };

  const send = (prompt: string): Promise<void> => {
    const work = check(prompt, coordinator!.send(prompt)).then(() => {
      assert.equal(
        coordinator!.snapshot.phase,
        'idle',
        coordinator!.snapshot.error,
      );

      assert.equal(coordinator!.snapshot.error, undefined);

      assert.deepEqual(coordinator!.snapshot.queue, []);
    });

    void work.catch(fail);

    return work;
  };

  const discoverWorkers = async (): Promise<void> => {
    for (const name of names) {
      if (workers.has(name)) continue;

      let content: string;

      try {
        content = await readFile(join(cwd, `${name}.pid`), 'utf8');
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue;

        throw cause;
      }

      const pid = Number(content);

      assert.ok(Number.isInteger(pid) && pid > 0, `${name}: worker PID`);

      const identity = await identifyProcess(pid);

      if (identity) workers.set(name, identity);
    }
  };

  try {
    await Promise.all([home, cwd, temporary].map((path) => mkdir(path)));

    const registration = (await installedAgents()).find(
      (agent) => agent.adapter.id === 'codex',
    );

    assert.ok(
      registration?.executable,
      'Install Codex before running this check',
    );

    nativeVersion = (
      await execute(registration.executable, ['--version'])
    ).stdout.trim();

    revision = (
      await execute('git', ['rev-parse', 'HEAD'], {
        cwd: new URL('..', import.meta.url),
      })
    ).stdout.trim();

    await check(
      'Fixture listener',
      new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)),
    );

    const address = server.address();

    assert.ok(address && typeof address !== 'string');

    port = address.port;

    await writeFile(
      join(home, 'config.toml'),
      `model = "gpt-5.4"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "workspace-write"
[features]
multi_agent = true
multi_agent_v2 = ${version === 'v2'}
[agents]
max_concurrent_threads_per_session = 3
[projects.${JSON.stringify(cwd)}]
trust_level = "trusted"
[model_providers.fixture]
name = "Local fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
`,
    );

    const environment = {
      ...process.env,
      CODEX_HOME: home,
      TMPDIR: temporary,
      OPENAI_API_KEY: undefined,
      CODEX_API_KEY: undefined,
    };

    const adapter = new CodexAdapter(
      (executable, project, signal) => {
        child = spawn(executable, ['app-server'], {
          cwd: project,
          signal,
          stdio: 'pipe',
          env: environment,
        });

        childClosed = new Promise((resolve) => child!.once('close', resolve));

        child.on('error', fail);

        child.once('close', () => {
          if (!closing)
            fail(new Error('Native app-server closed during the check'));
        });

        child.stderr.setEncoding('utf8').on('data', (text: string) => {
          stderr += text;
        });

        const write = child.stdin.write.bind(child.stdin);

        child.stdin.write = (
          chunk: unknown,
          encoding?: BufferEncoding | ((error?: Error | null) => void),
          callback?: (error?: Error | null) => void,
        ) => {
          try {
            trace.push(
              observe({
                direction: 'sent',
                message: JSON.parse(String(chunk)) as RpcMessage,
              }),
            );
          } catch (cause) {
            fail(cause);
          }

          return typeof encoding === 'string'
            ? write(chunk, encoding, callback)
            : write(chunk, encoding ?? callback);
        };

        createInterface({ input: child.stdout }).on('line', (line) => {
          try {
            const message = JSON.parse(line) as RpcMessage;

            trace.push(observe({ direction: 'received', message }));

            if (!closing && message.method === 'error')
              fail(new Error(JSON.stringify(message.params)));

            if (typeof message.id === 'string') {
              const waiting = pending.get(message.id);

              if (message.error)
                waiting?.reject(new Error(message.error.message));
              else waiting?.resolve(message.result);
            }
          } catch (cause) {
            fail(cause);
          }
        });

        return child;
      },
      (options) => readContextCatalog(options, environment),
    );

    const connect = adapter.connect.bind(adapter);

    adapter.connect = (options: SessionOptions) =>
      connect({
        ...options,
        onProcess: async (pid) => {
          if (pid !== undefined) native = await identifyProcess(pid);

          await options.onProcess(pid);
        },
        onEvent: (event) => {
          events.push(observe(event));

          options.onEvent(event);
        },
      });

    coordinator = new Coordinator(
      await StateStore.open(state),
      new Memory(join(state, 'memory.git')),
      [{ adapter, executable: registration.executable }],
    );

    unsubscribe = coordinator.subscribe(() =>
      snapshots.push(
        observe({
          phase: coordinator!.snapshot.phase,
          backgroundCommands: coordinator!.snapshot.backgroundCommands,
          items: brewRows(),
        }),
      ),
    );

    watching = (async () => {
      while (!closing) {
        await discoverWorkers();

        await delay(20);
      }
    })();

    void watching.catch(fail);

    await check('Coordinator initialization', coordinator.initialize(cwd));

    assert.ok(child?.pid);

    assert.ok(native, 'Native process identity');

    const parent = coordinator.snapshot.native?.id;

    assert.ok(parent);

    const starting = send('PARENT_START');

    await until('Three held child replies and worker identities', () =>
      names.every((name) => held.has(name) && workers.has(name)),
    );

    assert.deepEqual(
      commands(),
      [],
      'No brew before originating turn completion',
    );

    assert.deepEqual(brewRows(), [], 'No premature brew transcript row');

    assert.deepEqual(coordinator.snapshot.backgroundCommands, []);

    assert.equal(new Set(names.map((name) => origin(name).threadId)).size, 3);

    for (const name of names) {
      const first = origin(name);

      assert.ok(
        await running(workerIdentity(name)),
        `${name}: worker is alive before admission`,
      );

      assert.notEqual(first.threadId, parent);

      const info = z
        .object({ thread: z.object({ parentThreadId: z.string() }) })
        .parse(await rpc('thread/read', first.threadId));

      assert.equal(info.thread.parentThreadId, parent);

      const terminals = z
        .object({
          data: z.array(z.object({ itemId: z.string(), command: z.string() })),
        })
        .parse(await rpc('thread/backgroundTerminals/list', first.threadId));

      assert.deepEqual(
        terminals.data.map((item) => item.itemId),
        ['shared-command'],
      );

      descriptions.set(name, terminals.data[0]!.command);

      assert.equal(turnEnded(first.threadId, first.turnId), undefined);
    }

    const admitted: Worker[] = [];

    for (const name of names) {
      releaseModel(name);

      await until(
        `${name}: native originating turn ends`,
        () => !!turnEnded(origin(name).threadId, origin(name).turnId),
      );

      await until(`${name}: brew admission`, () =>
        commands().some((entry) => entry.value.id === brewId(name)),
      );

      admitted.push(name);

      listed(...admitted);

      const [start] = commands().filter(
        (entry) => entry.value.id === brewId(name),
      );

      assert.equal(start!.value.status, 'running');

      assert.equal(start!.value.description, descriptions.get(name));

      assert.ok(
        start!.order >
          turnEnded(origin(name).threadId, origin(name).turnId)!.order,
        `${name}: admission follows its originating turn`,
      );
    }

    await starting;

    assert.equal(brewRows().length, 3);

    checks.push('admission');

    const following = send('PARENT_FOLLOW');

    await until('Alpha later turn held', () => held.has('alpha-follow'));

    const alphaLater = laterTurn('alpha');

    assert.ok(await running(workerIdentity('alpha')));

    listed(...names);

    await writeFile(join(cwd, 'alpha.release'), 'go');

    await until('Alpha completion during later turn', () =>
      commands().some(
        (entry) =>
          entry.value.id === brewId('alpha') &&
          entry.value.status === 'completed',
      ),
    );

    assert.equal(turnEnded(alphaLater.threadId, alphaLater.turn.id), undefined);

    listed('beta', 'gamma');

    await following;

    checks.push('late completion');

    await send('PARENT_SHUTDOWN');

    const betaLater = laterTurn('beta');

    await until(
      'Gamma worker exits through native shutdown',
      async () => !(await running(workerIdentity('gamma'))),
    );

    await until('Gamma terminal brew event', () =>
      commands().some(
        (entry) =>
          entry.value.id === brewId('gamma') &&
          entry.value.status !== 'running',
      ),
    );

    assert.equal(turnEnded(alphaLater.threadId, alphaLater.turn.id), undefined);

    assert.equal(turnEnded(betaLater.threadId, betaLater.turn.id), undefined);

    assert.ok(await running(workerIdentity('beta')));

    assert.deepEqual(
      commands()
        .filter((entry) => entry.value.id === brewId('beta'))
        .map((entry) => entry.value.status),
      ['running'],
    );

    listed('beta');

    await assert.rejects(readFile(join(cwd, 'gamma.release')), {
      code: 'ENOENT',
    });

    if (version === 'v2')
      await until(
        'Delta reaches the model fixture after eviction',
        () => steps.get('delta') === 1,
      );

    checks.push('shutdown isolation');

    await writeFile(join(cwd, 'beta.release'), 'go');

    await until('Beta failed brew during later turn', () =>
      commands().some(
        (entry) =>
          entry.value.id === brewId('beta') && entry.value.status === 'failed',
      ),
    );

    assert.equal(turnEnded(betaLater.threadId, betaLater.turn.id), undefined);

    listed();

    for (const name of names) {
      const first = origin(name);

      const ends = commandItems('item/completed').filter(
        (entry) => entry.value.threadId === first.threadId,
      );

      assert.equal(ends.length, 1, `${name}: one native command end`);

      const end = ends[0]!.value;

      assert.equal(
        end.turnId,
        first.turnId,
        `${name}: original turn owns completion`,
      );

      assert.ok(['completed', 'failed'].includes(end.item.status));

      if (name !== 'gamma') {
        assert.equal(end.item.exitCode, name === 'alpha' ? 0 : 7);

        assert.match(
          end.item.aggregatedOutput ?? '',
          new RegExp(`${name}-finished`),
        );
      }

      const expected =
        name === 'gamma'
          ? end.item.status
          : name === 'alpha'
            ? 'completed'
            : 'failed';

      assert.deepEqual(
        commands()
          .filter((entry) => entry.value.id === brewId(name))
          .map((entry) => entry.value.status),
        ['running', expected],
      );

      const rows = brewRows().filter((item) =>
        item.title?.includes(`/${name}.pid`),
      );

      assert.deepEqual(
        rows.map((item) => item.title),
        [
          `Brew started  ${descriptions.get(name)}`,
          `Brew ${expected}  ${descriptions.get(name)}`,
        ],
      );

      await until(
        `${name}: worker gone`,
        async () => !(await running(workerIdentity(name))),
      );
    }

    releaseModel('alpha-follow');

    releaseModel('beta-follow');

    await until(
      'Both later child turns completed',
      () =>
        !!turnEnded(alphaLater.threadId, alphaLater.turn.id) &&
        !!turnEnded(betaLater.threadId, betaLater.turn.id),
    );

    assert.equal(commands().length, 6);

    assert.equal(brewRows().length, 6);

    checks.push('failure and exact transitions');
  } catch (cause) {
    fail(cause);
  } finally {
    closing = true;

    const cleanup = async (
      label: string,
      action: () => Promise<void>,
    ): Promise<void> => {
      try {
        await action();
      } catch (cause) {
        cleanupErrors.push(`${label}: ${String(cause)}`);
      }
    };

    await cleanup('Worker discovery', async () => {
      await watching;

      await discoverWorkers();
    });

    await cleanup('Release gates', async () => {
      for (const [key, response] of held) final(response, `${key} cleanup`);

      held.clear();

      await Promise.all(
        names.map((name) => writeFile(join(cwd, `${name}.release`), 'cleanup')),
      );
    });

    const close = coordinator?.close();

    await cleanup('Coordinator close', async () => {
      try {
        await within('Coordinator close', close ?? Promise.resolve(), 5000);
      } finally {
        if (native) await killRecorded(native);
        else if (child?.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      }
    });

    await cleanup('Native exit', async () => {
      await within('Native exit', childClosed ?? Promise.resolve(), 5000);
    });

    for (const [name, identity] of workers)
      await cleanup(`${name} worker`, () => killRecorded(identity));

    await cleanup('Listener close', async () => {
      server.closeAllConnections();

      if (server.listening)
        await within(
          'Listener close',
          new Promise<void>((resolve, reject) =>
            server.close((cause) => (cause ? reject(cause) : resolve())),
          ),
          5000,
        );

      assert.equal(server.listening, false);
    });

    unsubscribe?.();

    const result = {
      version,
      nativeVersion,
      nodeVersion: process.version,
      revision,
      directory,
      pass: !error && cleanupErrors.length === 0,
      checks,
      error: error?.stack,
      cleanupErrors,
      native,
      workers: Object.fromEntries(workers),
      port,
      nativeClosed:
        !child || child.exitCode !== null || child.signalCode !== null,
      listenerClosed: !server.listening,
    };

    await Promise.all(
      Object.entries({
        result,
        trace,
        events,
        snapshots,
        model,
        transcript: brewRows(),
      }).map(([name, data]) =>
        writeFile(
          join(directory, `${name}.json`),
          `${JSON.stringify(data, null, 2)}\n`,
        ),
      ),
    );

    await writeFile(join(directory, 'stderr.log'), stderr);

    assert.ok(
      result.pass,
      `${error?.message ?? cleanupErrors.join('; ')}. Evidence: ${directory}`,
    );
  }

  console.log(
    `${version}: three brews started and ended once; workers and listener closed`,
  );
}

try {
  await runScenario('v1');

  await runScenario('v2');
} catch (error) {
  console.error(error);

  process.exitCode = 1;
}
