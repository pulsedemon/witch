import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { CodexAdapter } from '../src/agents/codex.js';
import { scratch } from './fixtures/scratch.js';
import { within } from './fixtures/within.js';
import { untimed } from './fixtures/limits.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import type { RegisterCleanup } from './fixtures/cleanup.js';

async function discovery(
  register: RegisterCleanup,
  agent: string,
  first = 'catalog',
) {
  const cwd = await scratch('witch-discovery-');
  const children: { child: ChildProcessWithoutNullStreams; closed: boolean }[] =
    [];
  const args: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const start = (signal?: AbortSignal) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL(`fixtures/${agent}.mjs`, import.meta.url)),
        children.length ? 'catalog' : first,
      ],
      { cwd, stdio: 'pipe', signal },
    );
    const entry = { child, closed: false };
    child.once('close', () => {
      entry.closed = true;
    });
    children.push(entry);
    register(async () => {
      if (entry.closed) return;
      const closing = new Promise<void>((resolve) =>
        child.once('close', () => resolve()),
      );
      child.kill();
      await closing;
    });
    return child;
  };
  const adapter =
    agent === 'claude'
      ? new ClaudeAdapter((options) => {
          args.push(options.args);
          envs.push(options.env);
          return start(options.signal);
        })
      : new CodexAdapter((_, _cwd, signal) => start(signal));
  return {
    children,
    args,
    envs,
    adapter,
    options: { cwd, executable: '/fixture' },
    read: (signal?: AbortSignal) =>
      adapter.models({ cwd, executable: '/fixture', signal }),
    wire: async () =>
      (await readFile(join(cwd, 'wire.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              type?: string;
              request?: { subtype: string };
            },
        ),
  };
}

test('standalone Codex catalogs include every page without opening a thread', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const probe = await discovery(cleanup, 'codex');
  assert.deepEqual(await probe.read(), [
    { id: 'model-a', label: 'A', efforts: ['low'] },
    { id: 'model-b', label: 'B', efforts: ['high'] },
  ]);
  assert.deepEqual(
    (await probe.wire()).map((frame) => frame.method),
    ['initialize', 'initialized', 'model/list', 'model/list'],
  );
  assert.equal(probe.children[0]!.closed, true);
});

test('standalone Claude catalogs preserve settings without prompts or history', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const probe = await discovery(cleanup, 'claude');
  assert.deepEqual(await probe.read(), [
    { id: 'claude-a', label: 'Claude fixture', efforts: ['low', 'high'] },
  ]);
  const args = probe.args[0]!;
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--setting-sources=user,project,local'));
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]!), {
    disableAllHooks: true,
  });
  for (const flag of ['--resume', '--model', '--session-id'])
    assert.ok(!args.some((arg) => arg === flag || arg.startsWith(`${flag}=`)));
  assert.deepEqual(
    (await probe.wire()).map((frame) => [frame.type, frame.request?.subtype]),
    [['control_request', 'initialize']],
  );
  assert.equal(probe.children[0]!.closed, true);
});

test('standalone Codex limits read the account without opening a thread', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const probe = await discovery(cleanup, 'codex');
  assert.deepEqual(
    untimed(
      (await probe.adapter.accountUsage(probe.options, { limits: [] })).limits,
    ),
    [
      { window: '5H', percent: 12, resetsAt: 2000000000 },
      { window: '7D', percent: 40, resetsAt: 2000500000 },
    ],
  );
  assert.deepEqual(
    (await probe.wire()).map((frame) => frame.method),
    ['initialize', 'initialized', 'account/rateLimits/read'],
  );
  assert.equal(probe.children[0]!.closed, true);
});

test('a Codex limits read keeps each previous window its report leaves out, past its reset too', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const probe = await discovery(cleanup, 'codex', 'sparse-limits');
  const weekly = { window: '7D', percent: 99, resetsAt: 1, observedAt: 5 };
  const before = Date.now();
  const { limits } = await probe.adapter.accountUsage(probe.options, {
    limits: [{ window: '5H', percent: 1, observedAt: 4 }, weekly],
  });
  assert.deepEqual(untimed(limits.slice(0, 1)), [
    { window: '5H', percent: 12, resetsAt: 2000000000 },
  ]);
  assert.ok(limits[0]!.observedAt >= before);
  assert.deepEqual(limits[1], weekly);
});

test('standalone Claude limits read the account without a turn', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const probe = await discovery(cleanup, 'claude');
  assert.deepEqual(
    untimed(
      (await probe.adapter.accountUsage(probe.options, { limits: [] })).limits,
    ),
    [
      {
        window: '5H',
        percent: 23.5,
        resetsAt: Date.parse('2033-05-18T03:33:20Z') / 1000,
      },
      { window: '7D', percent: 61 },
    ],
  );
  assert.ok(probe.args[0]!.includes('--setting-sources=user,project,local'));
  assert.deepEqual(
    (await probe.wire()).map((frame) => frame.request?.subtype),
    ['initialize', 'get_usage'],
  );
  assert.equal(probe.children[0]!.closed, true);
});

test('Claude limits a runtime reports unavailable read as none', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const probe = await discovery(cleanup, 'claude', 'no-limits');
  const previous = [{ window: '5H', percent: 1, observedAt: 1 }];
  assert.deepEqual(
    (await probe.adapter.accountUsage(probe.options, { limits: previous }))
      .limits,
    [],
  );
});

test('the latest Claude models ignore native model pins', async (t) => {
  vi.stubEnv('ANTHROPIC_DEFAULT_OPUS_MODEL', 'claude-opus-5');
  vi.stubEnv('ANTHROPIC_MODEL', 'claude-opus-5');
  t.onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const cleanup = orderedCleanup(t.onTestFinished);
  const probe = await discovery(cleanup, 'claude', 'aliases');
  assert.ok(probe.adapter instanceof ClaudeAdapter);
  assert.deepEqual(await probe.adapter.latest(probe.options), {
    opus: 'claude-opus-5-5',
    haiku: 'claude-haiku-5-5',
  });
  const args = probe.args[0]!;
  assert.ok(
    !args.some((arg) => arg.includes('user,project,local')),
    args.join(' '),
  );
  assert.equal(probe.envs[0]!.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  assert.equal(probe.envs[0]!.ANTHROPIC_MODEL, undefined);
  assert.equal(probe.envs[0]!.PATH, process.env.PATH);
  assert.equal(probe.children[0]!.closed, true);
});

for (const agent of ['claude', 'codex']) {
  test(`${agent} discovery joins initialization failure cleanup and can retry`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);
    const probe = await discovery(cleanup, agent, 'exit-on-init');
    await assert.rejects(
      within(probe.read(), 3000, 'discovery failure'),
      /init exit text/,
    );
    assert.equal(probe.children[0]!.closed, true);
    assert.ok((await probe.read()).length > 0);
    assert.equal(probe.children[1]!.closed, true);
  });
  for (const alreadyAborted of [false, true]) {
    test(`${agent} discovery joins ${alreadyAborted ? 'pre-aborted' : 'pending'} cancellation`, async (t) => {
      const cleanup = orderedCleanup(t.onTestFinished);
      const probe = await discovery(cleanup, agent, 'hang-on-init');
      const abort = new AbortController();
      if (alreadyAborted) abort.abort();
      const pending = probe.read(abort.signal);
      const rejected = assert.rejects(
        within(pending, 3000, 'discovery abort'),
        { name: 'AbortError' },
      );
      if (!alreadyAborted) {
        await once(probe.children[0]!.child, 'spawn');
        abort.abort();
      }
      await rejected;
      assert.equal(probe.children[0]!.closed, true);
      assert.ok((await probe.read()).length > 0);
      assert.equal(probe.children[1]!.closed, true);
    });
  }
}
