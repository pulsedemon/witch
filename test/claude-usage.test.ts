import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type {
  Query,
  SDKControlGetUsageResponse,
} from '@anthropic-ai/claude-agent-sdk';
import { createElement } from 'react';
import type {
  AgentEvent,
  AgentSession,
  SessionOptions,
} from '../src/agents/types.js';
import { Coordinator } from '../src/core/coordinator.js';
import { Memory } from '../src/memory/memory.js';
import { StateStore } from '../src/persistence/store.js';
import { App } from '../src/ui/app.js';
import { frameWriter, jsonLines, launcher } from './fixtures/claude-adapter.js';
import { show } from './fixtures/ui.js';
import { until } from './fixtures/within.js';

const timeout = 10_000;
const idle = {
  type: 'system',
  subtype: 'session_state_changed',
  state: 'idle',
};
const firstLimits = [
  { window: '5H', percent: 23.5, resetsAt: 2_000_000_000 },
  { window: '7D', percent: 61, resetsAt: 2_000_086_400 },
];
const nextLimits = [
  { window: '5H', percent: 0, resetsAt: 2_000_003_600 },
  { window: '7D', percent: 72, resetsAt: 2_000_172_800 },
];

function report(next = false): SDKControlGetUsageResponse {
  return {
    session: {
      total_cost_usd: 777,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 999,
      total_lines_removed: 888,
      model_usage: {},
    },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: {
        utilization: next ? 0 : 23.5,
        resets_at: next ? '2033-05-18T04:33:20Z' : '2033-05-18T03:33:20Z',
      },
      seven_day: {
        utilization: next ? 72 : 61,
        resets_at: next ? '2033-05-20T03:33:20Z' : '2033-05-19T03:33:20Z',
      },
    },
    behaviors: null,
  };
}

interface Control {
  type: string;
  request_id: string;
  request: { subtype: string; skip_behaviors?: boolean };
}

function endpoint(child: ChildProcessWithoutNullStreams, cwd: string) {
  const barriers = new Set<string>();
  const replies = new Set<string>();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const message = JSON.parse(line) as {
      type: string;
      subtype?: string;
      commands?: { name: string }[];
      response?: { request_id: string };
    };
    if (message.type === 'system' && message.subtype === 'commands_changed')
      for (const command of message.commands ?? []) barriers.add(command.name);
    if (message.type === 'control_response')
      replies.add(message.response!.request_id);
  });
  const emit = frameWriter(cwd, (name) => barriers.has(name), child);
  return {
    child,
    cwd,
    emit,
    async requests(subtype = 'get_usage') {
      return ((await jsonLines(join(cwd, 'wire.jsonl'))) as Control[]).filter(
        (m) => m.type === 'control_request' && m.request.subtype === subtype,
      );
    },
    async pending(previous = '') {
      let request: Control | undefined;
      await until('usage request', async () => {
        [request] = (await jsonLines(
          join(cwd, 'usage-request.json'),
        )) as Control[];
        return !!request && request.request_id !== previous;
      });
      return request!;
    },
    async reply(value: unknown = report(), previous = '', error = false) {
      const request = await this.pending(previous);
      assert.equal(request.request.skip_behaviors, true);
      await emit({
        type: 'control_response',
        response: error
          ? {
              subtype: 'error',
              request_id: request.request_id,
              error: 'Account unavailable',
            }
          : {
              subtype: 'success',
              request_id: request.request_id,
              response: value,
            },
      });
      return request.request_id;
    },
    async barrier() {
      const request_id = randomUUID();
      child.stdin.write(
        `${JSON.stringify({ type: 'control_request', request_id, request: { subtype: 'get_context_usage' } })}\n`,
      );
      await until('control round trip', () => replies.has(request_id));
    },
  };
}

type Endpoint = ReturnType<typeof endpoint>;

async function controlled(
  t: TestContext,
  options: Partial<SessionOptions> = {},
  mode = 'background',
  usageMode = 'background',
  holdMain = false,
) {
  const f = await launcher(mode, usageMode);
  const helpers: Endpoint[] = [];
  const events: AgentEvent[] = [];
  const identities: (number | undefined)[] = [];
  if (holdMain) await writeFile(join(f.cwd, 'hold-usage'), '');
  const prepare = async (pid: number | undefined) => {
    identities.push(pid);
    if (pid !== undefined) {
      const launched = f.usageChildren.find(
        (entry) => entry.child.pid === pid,
      )!;
      writeFileSync(join(launched.cwd, 'hold-usage'), '');
      helpers.push(endpoint(launched.child, launched.cwd));
    }
    await options.onUsageProcess?.(pid);
  };
  const session = await f.connect({
    ...options,
    onUsageProcess: prepare,
    onEvent: (event) => {
      events.push(event);
      options.onEvent?.(event);
    },
  });
  const main = endpoint(f.children[0]!, f.cwd);
  t.after(async () => {
    t.mock.timers.reset();
    try {
      await session.close();
    } finally {
      for (const child of [
        ...f.children,
        ...f.usageChildren.map((h) => h.child),
      ]) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const closed = once(child, 'close');
        child.kill('SIGKILL');
        await closed;
      }
    }
  });
  return { ...f, session, main, helpers, events, identities, prepare };
}

type Fixture = Awaited<ReturnType<typeof controlled>>;

async function initial(f: Fixture) {
  await until('initial usage', () => !!f.session.usage.limits);
}

async function poll(t: TestContext, f: Fixture, index = 0) {
  t.mock.timers.tick(60_000);
  await until('usage helper', () => !!f.helpers[index]);
  const helper = f.helpers[index]!;
  await helper.pending();
  return helper;
}

async function complete(f: Fixture) {
  const turn = f.session.send('complete');
  await until('turn result', () => f.session.usage.cost === 0.25);
  await f.main.emit(idle);
  await turn;
}

for (const state of ['foreground', 'familiar', 'idle'] as const) {
  await test(
    `periodic Claude limits refresh during ${state} without a new result or idle event`,
    { timeout },
    async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const f = await controlled(t, {}, 'compaction');
      await initial(f);
      let finished = false;
      if (state !== 'idle') {
        void f.session
          .send(state === 'foreground' ? 'wait' : 'background familiar')
          .then(() => {
            finished = true;
          });
        await until('active turn', () =>
          state === 'foreground'
            ? f.events.some((e) => e.type === 'text')
            : f.session.replied,
        );
      }
      const writes = t.mock.method(f.children[0]!.stdin, 'write');
      t.mock.timers.tick(59_999);
      await f.main.barrier();
      assert.equal(f.helpers.length, 0);
      t.mock.timers.tick(1);
      await until('first periodic helper', () => !!f.helpers[0]);
      const helper = f.helpers[0]!;
      const first = await helper.reply();
      assert.deepEqual(f.session.usage.limits, firstLimits);
      assert.ok(
        f.events.some(
          (e) =>
            e.type === 'usage' && e.usage.limits === f.session.usage.limits,
        ),
      );
      t.mock.timers.tick(59_999);
      await helper.barrier();
      assert.equal((await helper.requests()).length, 1);
      t.mock.timers.tick(1);
      await helper.reply(report(true), first);
      assert.deepEqual(f.session.usage.limits, nextLimits);
      assert.equal(finished, false);
      assert.equal(
        writes.mock.calls.filter(({ arguments: args }) =>
          String(args[0]).includes('"get_usage"'),
        ).length,
        0,
      );
      assert.equal((await helper.requests()).length, 2);
    },
  );
}

await test(
  'connect and completion usage serialize before periodic polling starts',
  { timeout },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await controlled(t, {}, 'background', 'background', true);
    await f.main.pending();
    await complete(f);
    await f.main.barrier();
    assert.equal((await f.main.requests()).length, 1);
    t.mock.timers.tick(60_000);
    await f.main.barrier();
    assert.equal(f.helpers.length, 0);
    const id = await f.main.reply();
    await f.main.reply(report(true), id);
    assert.equal((await f.main.requests()).length, 2);
    assert.deepEqual(f.session.usage.limits, nextLimits);
    const helper = await poll(t, f);
    await helper.reply();
    assert.equal((await f.main.requests()).length, 2);
  },
);

await test(
  'completion requests fresh context before a held helper read and queues one main statistics read',
  { timeout },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await controlled(t);
    await initial(f);
    const helper = await poll(t, f);
    await writeFile(join(f.cwd, 'hold-context'), '');
    await complete(f);
    let context: Control | undefined;
    await until('completion context request', async () => {
      [context] = (await jsonLines(
        join(f.cwd, 'context-request.json'),
      )) as Control[];
      return !!context;
    });
    await f.main.emit({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: context!.request_id,
        response: { percentage: 82, maxTokens: 900000 },
      },
    });
    assert.equal(f.session.usage.context, 82);
    assert.equal(f.session.usage.contextWindow, 900000);
    assert.equal((await f.main.requests()).length, 1);
    await writeFile(join(f.cwd, 'hold-usage'), '');
    await helper.reply();
    const next = report(true);
    next.session.total_lines_added = 17;
    next.session.total_lines_removed = 3;
    await f.main.reply(next);
    assert.equal((await f.main.requests()).length, 2);
    assert.deepEqual(f.session.usage.lines, { added: 17, removed: 3 });
    assert.deepEqual(f.session.usage.limits, nextLimits);
  },
);

for (const source of ['main', 'helper'] as const) {
  for (const variant of ['rejected', 'malformed', 'null', 'partial'] as const) {
    await test(
      `${source} ${variant} account report retains the missing valid windows and later recovers`,
      { timeout },
      async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const f = await controlled(t, {}, 'background', 'background', true);
        const mainId = await f.main.reply();
        assert.deepEqual(f.session.usage.limits, firstLimits);
        const target = source === 'main' ? f.main : await poll(t, f);
        if (source === 'main') await complete(f);
        const bad = report();
        if (variant === 'null') bad.rate_limits = null;
        if (variant === 'partial')
          bad.rate_limits = { five_hour: { utilization: 0, resets_at: null } };
        const previous = source === 'main' ? mainId : '';
        await target.reply(
          variant === 'malformed'
            ? {
                session: bad.session,
                rate_limits_available: true,
                rate_limits: 'invalid',
              }
            : bad,
          previous,
          variant === 'rejected',
        );
        assert.deepEqual(
          f.session.usage.limits,
          variant === 'partial'
            ? [{ window: '5H', percent: 0 }, firstLimits[1]]
            : firstLimits,
        );
        const helper = f.helpers[0] ?? (await poll(t, f));
        const last =
          source === 'helper' ? (await helper.pending()).request_id : '';
        if (source === 'helper') t.mock.timers.tick(60_000);
        await helper.reply(report(true), last);
        assert.deepEqual(f.session.usage.limits, nextLimits);
        assert.equal(f.helpers.length, 1);
      },
    );
  }
}

await test(
  'helper totals and stream messages cannot replace main statistics or identity',
  { timeout },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await controlled(t, {}, 'compaction');
    await initial(f);
    await f.session.send('hello');
    await until('main line totals', () => f.session.usage.lines?.added === 4);
    const info = { ...f.session.info };
    const helper = await poll(t, f);
    const before = f.events.length;
    await helper.emit(
      {
        type: 'system',
        subtype: 'init',
        session_id: 'helper-session',
        model: 'wrong-model',
        permissionMode: 'plan',
        tools: [],
        mcp_servers: [],
        slash_commands: [],
        skills: [],
      },
      { type: 'result', result: 'helper result', total_cost_usd: 333 },
    );
    assert.equal(f.events.length, before);
    await helper.reply(report(true));
    assert.deepEqual(f.session.info, info);
    assert.equal(f.session.usage.cost, 0.25);
    assert.deepEqual(f.session.usage.lines, { added: 4, removed: 1 });
    assert.equal(f.session.usage.context, 12.5);
    assert.deepEqual(f.session.usage.limits, nextLimits);
    const args = f.usageChildren[0]!.args;
    assert.ok(!args.includes('--resume') && !args.includes(info.id));
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(args.some((arg) => arg.includes('disableAllHooks')));
    const wire = (await jsonLines(join(helper.cwd, 'wire.jsonl'))) as {
      type: string;
    }[];
    assert.ok(wire.every((frame) => frame.type !== 'user'));
  },
);

await test(
  'foreground context, steering and interruption finish before a helper reply',
  { timeout },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await controlled(t, {}, 'compaction');
    await initial(f);
    const turn = f.session.send('steerable');
    await until('foreground text', () =>
      f.events.some((event) => event.type === 'text'),
    );
    const helper = await poll(t, f);
    assert.equal(await f.session.contextUsage(), 12.5);
    assert.equal(await f.session.steer('extra context'), true);
    await f.main.barrier();
    await f.session.interrupt();
    assert.equal((await turn).status, 'interrupted');
    assert.equal((await helper.requests()).length, 1);
    assert.deepEqual(f.session.usage.lines, { added: 0, removed: 0 });
  },
);

for (const phase of ['initialization', 'registration'] as const) {
  await test(
    `main controls remain usable and close joins delayed helper ${phase}`,
    { timeout },
    async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const registered = Promise.withResolvers<void>();
      const f = await controlled(
        t,
        {
          onUsageProcess: (pid) =>
            pid === undefined || phase !== 'registration'
              ? Promise.resolve()
              : registered.promise,
        },
        'background',
        phase === 'initialization' ? 'hang-on-init' : 'background',
      );
      try {
        await initial(f);
        assert.equal(f.helpers.length, 0);
        t.mock.timers.tick(60_000);
        await until('helper spawned', () => !!f.helpers[0]);
        const helper = f.helpers[0]!;
        await until(
          'helper initialization',
          async () =>
            (await jsonLines(join(helper.cwd, 'initialize.json'))).length === 1,
        );
        assert.equal(await f.session.contextUsage(), 12.5);
        assert.equal((await helper.requests()).length, 0);
        let closed = false;
        const closing = f.session.close().then(() => {
          closed = true;
        });
        await until(
          'helper stopped',
          () =>
            helper.child.exitCode !== null || helper.child.signalCode !== null,
        );
        if (phase === 'registration') assert.equal(closed, false);
        registered.resolve();
        await closing;
        assert.deepEqual(f.identities, [helper.child.pid, undefined]);
        t.mock.timers.tick(60_000);
        assert.equal(f.helpers.length, 1);
      } finally {
        registered.resolve();
      }
    },
  );
}

await test(
  'registration failure stops pending initialization and releases queued statistics',
  { timeout },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const registered = Promise.withResolvers<void>();
    let starts = 0;
    const f = await controlled(
      t,
      {
        onUsageProcess: async (pid) => {
          if (pid !== undefined && ++starts === 1) await registered.promise;
        },
      },
      'background',
      'hang-on-init',
    );
    try {
      await initial(f);
      t.mock.timers.tick(60_000);
      await until('helper spawned', () => !!f.helpers[0]);
      const helper = f.helpers[0]!;
      await until(
        'pending initialization',
        async () =>
          (await jsonLines(join(helper.cwd, 'initialize.json'))).length === 1,
      );
      await complete(f);
      assert.equal((await f.main.requests()).length, 1);
      const closed = once(helper.child, 'close');
      registered.reject(new Error('Cannot register helper'));
      await closed;
      await until(
        'queued statistics',
        () => f.session.usage.lines?.added === 4,
      );
      assert.equal(f.session.closed, false);
      t.mock.timers.tick(59_999);
      await f.main.barrier();
      assert.equal(f.helpers.length, 1);
      t.mock.timers.tick(1);
      await until('replacement helper', () => f.helpers.length === 2);
      assert.equal(await f.session.contextUsage(), 12.5);
      assert.equal(f.children.length, 1);
    } finally {
      registered.resolve();
    }
  },
);

for (const failure of ['startup', 'registration'] as const) {
  await test(
    `helper ${failure} failure retains usage and retries at the next interval`,
    { timeout },
    async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let starts = 0;
      const f = await controlled(t, {
        onUsageProcess: async (pid) => {
          if (pid === undefined || ++starts !== 1) return;
          if (failure === 'registration')
            throw new Error('Cannot register helper');
          process.kill(pid, 'SIGTERM');
        },
      });
      await initial(f);
      const before = structuredClone(f.session.usage);
      const mainPid = f.children[0]!.pid;
      const sessionId = f.session.info.id;
      t.mock.timers.tick(60_000);
      await until(
        'failed helper stopped',
        () =>
          !!f.helpers[0] &&
          (f.helpers[0].child.exitCode !== null ||
            f.helpers[0].child.signalCode !== null),
      );
      await f.main.barrier();
      assert.deepEqual(f.session.usage, before);
      assert.equal(f.session.closed, false);
      t.mock.timers.tick(59_999);
      await f.main.barrier();
      assert.equal(f.helpers.length, 1);
      t.mock.timers.tick(1);
      await until('replacement helper', () => f.helpers.length === 2);
      await f.helpers[1]!.reply(report(true));
      assert.deepEqual(f.session.usage.limits, nextLimits);
      assert.equal(f.children[0]!.pid, mainPid);
      assert.equal(f.session.info.id, sessionId);
    },
  );
}

await test(
  'an exited helper is replaced after cleanup without reconnecting the conversation',
  { timeout },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await controlled(t);
    await initial(f);
    const turn = f.session.send('held before helper exit');
    await until('native session identity', () => f.session.usage.cost === 0.25);
    const helper = await poll(t, f);
    await helper.reply();
    const firstPid = helper.child.pid;
    const sessionId = f.session.info.id;
    helper.child.kill('SIGTERM');
    await until(
      'helper identity cleared',
      () => f.identities.at(-1) === undefined,
    );
    await f.main.emit(idle);
    await turn;
    await f.main.barrier();
    assert.equal(f.helpers.length, 1);
    assert.equal(f.session.closed, false);
    assert.equal(f.session.info.id, sessionId);
    t.mock.timers.tick(59_999);
    await f.main.barrier();
    assert.equal(f.helpers.length, 1);
    t.mock.timers.tick(1);
    await until('second helper', () => !!f.helpers[1]);
    await f.helpers[1]!.reply(report(true));
    assert.deepEqual(f.identities, [
      firstPid,
      undefined,
      f.helpers[1]!.child.pid,
    ]);
    assert.deepEqual(f.session.usage.limits, nextLimits);
    assert.equal(f.children.length, 1);
  },
);

for (const reason of [
  'close',
  'idle exit',
  'active exit',
  'unread interruption',
] as const) {
  await test(
    `helper shutdown joins both children and cancels the scheduled callback on ${reason}`,
    { timeout },
    async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const timers: ReturnType<typeof t.mock.fn<() => void>>[] = [];
      const schedule = setTimeout;
      const scheduling = t.mock.method(
        globalThis,
        'setTimeout',
        (
          callback: (...args: unknown[]) => void,
          ms?: number,
          ...args: unknown[]
        ) => {
          if (ms !== 60_000) return schedule(callback, ms, ...args);
          const run = t.mock.fn(() => callback(...args));
          timers.push(run);
          return schedule(run, ms);
        },
      );
      try {
        const f = await controlled(t);
        await initial(f);
        const helper = await poll(t, f);
        await helper.reply();
        let turn: ReturnType<AgentSession['send']> | undefined;
        if (reason === 'active exit' || reason === 'unread interruption') {
          turn = f.session.send('held');
          await until('held turn result', () => f.session.usage.cost === 0.25);
        }
        const callbacks = timers.map((timer) => timer.mock.callCount());
        if (reason === 'close') await f.session.close();
        else if (reason === 'unread interruption') {
          assert.equal(await f.session.steer('queued input'), true);
          let uuid: string | undefined;
          await until('queued native input', async () => {
            const frames = (await jsonLines(join(f.cwd, 'inputs.jsonl'))) as {
              uuid: string;
              message: { content: string };
            }[];
            uuid = frames.find(
              (frame) => frame.message.content === 'queued input',
            )?.uuid;
            return !!uuid;
          });
          await writeFile(join(f.cwd, 'receipt.json'), JSON.stringify([uuid]));
          await f.session.interrupt();
          assert.deepEqual((await turn!).unread, ['queued input']);
        } else f.children[0]!.kill('SIGTERM');
        await until(
          'both processes closed',
          () =>
            f.session.closed &&
            [f.children[0]!, helper.child].every(
              (child) => child.exitCode !== null || child.signalCode !== null,
            ),
        );
        await until(
          'usage registration cleared',
          () => f.identities.at(-1) === undefined,
        );
        if (reason === 'active exit')
          assert.equal((await turn!).status, 'failed');
        t.mock.timers.tick(60_000);
        assert.deepEqual(
          timers.map((timer) => timer.mock.callCount()),
          callbacks,
        );
        assert.equal(f.helpers.length, 1);
      } finally {
        scheduling.mock.restore();
      }
    },
  );
}

await test(
  'a successful helper response after close cannot publish or rearm polling',
  { timeout },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await controlled(t);
    await initial(f);
    const helper = await poll(t, f);
    await helper.reply();
    const reader = Reflect.get(f.session, 'usageReader') as {
      helper: { query: Query };
    };
    const delayed = Promise.withResolvers<SDKControlGetUsageResponse>();
    const method = t.mock.method(
      reader.helper.query,
      'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET',
      () => delayed.promise,
    );
    t.mock.timers.tick(60_000);
    await until('deferred SDK request', () => method.mock.callCount() === 1);
    await f.session.close();
    const events = f.events.length;
    const usage = structuredClone(f.session.usage);
    delayed.resolve(report(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.events.length, events);
    assert.deepEqual(f.session.usage, usage);
    t.mock.timers.tick(60_000);
    assert.equal(method.mock.callCount(), 1);
    assert.equal(f.helpers.length, 1);
  },
);

await test(
  'periodic limits render during familiar work and idle and explicit unavailability clears them',
  { timeout },
  async (t) => {
    t.mock.method(Date, 'now', () => 1_999_996_400_000);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await launcher('background');
    const helpers: Endpoint[] = [];
    let session: AgentSession | undefined;
    const connect = f.adapter.connect.bind(f.adapter);
    f.adapter.connect = async (options) =>
      (session = await connect({
        ...options,
        onUsageProcess: async (pid) => {
          if (pid !== undefined) {
            const helper = f.usageChildren.find(
              (entry) => entry.child.pid === pid,
            )!;
            writeFileSync(join(helper.cwd, 'hold-usage'), '');
            helpers.push(endpoint(helper.child, helper.cwd));
          }
          await options.onUsageProcess?.(pid);
        },
      }));
    const store = await StateStore.open(join(f.cwd, 'state'));
    const memory = new Memory(join(f.cwd, 'state', 'memory.git'));
    const coordinator = new Coordinator(store, memory, [
      { adapter: f.adapter, executable: '/fake/claude' },
    ]);
    let ui: ReturnType<typeof show> | undefined;
    try {
      await coordinator.initialize(f.cwd);
      await until('initial snapshot', () => !!session?.usage.limits);
      ui = show(createElement(App, { coordinator, onExit: () => {} }));
      const main = endpoint(f.children[0]!, f.cwd);
      let finished = false;
      const turn = coordinator.send('hold for refresh').then(() => {
        finished = true;
      });
      await until('main result', () => session?.usage.cost === 0.25);
      await main.emit({
        type: 'system',
        subtype: 'task_started',
        task_id: 'helper',
        task_type: 'local_agent',
        description: 'Held familiar',
        tool_use_id: 'helper-tool',
      });
      t.mock.timers.tick(60_000);
      await until('usage helper', () => !!helpers[0]);
      const helper = helpers[0]!;
      let id = await helper.reply();
      await until('first rendered limits', () => {
        t.mock.timers.tick(40);
        return /5H 24% 1h0m\s+7D 61% 1d1h/.test(ui!.text());
      });
      t.mock.timers.tick(60_000);
      id = await helper.reply(report(true), id);
      await until('changed held limits', () => {
        t.mock.timers.tick(40);
        return /5H 0% 2h0m\s+7D 72% 2d1h/.test(ui!.text());
      });
      assert.equal(coordinator.snapshot.phase, 'running');
      assert.equal(finished, false);
      const conversation = coordinator.snapshot.conversation!.id;
      const recordPath = join(
        f.cwd,
        'state',
        'conversations',
        conversation,
        'state.json',
      );
      const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
        process: { pid: number };
        usageProcess: { pid: number };
      };
      assert.equal(record.process.pid, f.children[0]!.pid);
      assert.equal(record.usageProcess.pid, helper.child.pid);
      await main.emit(
        {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'helper',
          status: 'completed',
          output_file: '',
          summary: 'done',
        },
        idle,
      );
      await turn;
      await until(
        'main completion statistics',
        () =>
          coordinator.snapshot.phase === 'idle' &&
          session?.usage.lines?.added === 4,
      );
      t.mock.timers.tick(60_000);
      id = await helper.reply(report(true), id);
      await until('changed idle limits', () => {
        t.mock.timers.tick(40);
        return /5H 0% 2h0m\s+7D 72% 2d1h/.test(ui!.text());
      });
      assert.equal(coordinator.snapshot.phase, 'idle');
      const unavailable = report();
      unavailable.rate_limits_available = false;
      unavailable.rate_limits = null;
      t.mock.timers.tick(60_000);
      await helper.reply(unavailable, id);
      await until('unavailable windows cleared', () => {
        t.mock.timers.tick(40);
        return !ui!.text().includes('5H ') && !ui!.text().includes('7D ');
      });
      assert.deepEqual(session!.usage.limits, []);
      assert.equal(session!.usage.cost, 0.25);
      assert.deepEqual(session!.usage.lines, { added: 4, removed: 1 });
    } finally {
      t.mock.timers.reset();
      ui?.unmount();
      await coordinator.close();
      for (const child of [
        ...f.children,
        ...f.usageChildren.map((entry) => entry.child),
      ])
        assert.ok(child.exitCode !== null || child.signalCode !== null);
    }
  },
);

await test(
  'close stops a helper whose native usage response is still pending',
  { timeout },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await controlled(t);
    await initial(f);
    const helper = await poll(t, f);
    const usageEvents = f.events.filter(
      (event) => event.type === 'usage',
    ).length;
    await f.session.close();
    assert.ok(
      helper.child.exitCode !== null || helper.child.signalCode !== null,
    );
    assert.ok(
      f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null,
    );
    assert.equal(
      f.events.filter((event) => event.type === 'usage').length,
      usageEvents,
    );
    assert.deepEqual(f.identities, [helper.child.pid, undefined]);
    t.mock.timers.tick(60_000);
    assert.equal(f.helpers.length, 1);
  },
);

await test(
  'helper exit during registration preserves a queued completion refresh',
  { timeout },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const registered = Promise.withResolvers<void>();
    const f = await controlled(t, {
      onUsageProcess: (pid) =>
        pid === undefined ? Promise.resolve() : registered.promise,
    });
    try {
      await initial(f);
      t.mock.timers.tick(60_000);
      await until('helper registration started', () => !!f.helpers[0]);
      const helper = f.helpers[0]!;
      await helper.barrier();
      await complete(f);
      await f.main.barrier();
      assert.equal((await f.main.requests()).length, 1);
      helper.child.kill('SIGTERM');
      await until(
        'helper exit',
        () =>
          helper.child.exitCode !== null || helper.child.signalCode !== null,
      );
      registered.resolve();
      await until(
        'queued main statistics',
        () => f.session.usage.lines?.added === 4,
      );
      assert.equal((await f.main.requests()).length, 2);
      assert.equal(f.session.closed, false);
    } finally {
      registered.resolve();
    }
  },
);

await test(
  'a failed helper spawn reports no identity and retries without closing the conversation',
  { timeout },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await controlled(t, {}, 'background', 'spawn-error');
    await initial(f);
    const before = structuredClone(f.session.usage);
    t.mock.timers.tick(60_000);
    await until(
      'failed spawn closed',
      () => !!f.usageChildren[0] && f.usageChildren[0].child.exitCode !== null,
    );
    await f.main.barrier();
    assert.deepEqual(f.identities, []);
    assert.deepEqual(f.session.usage, before);
    assert.equal(f.session.closed, false);
    t.mock.timers.tick(59_999);
    await f.main.barrier();
    assert.equal(f.usageChildren.length, 1);
    t.mock.timers.tick(1);
    await until('spawn retried', () => f.usageChildren.length === 2);
    await f.session.close();
    assert.deepEqual(f.identities, []);
  },
);
