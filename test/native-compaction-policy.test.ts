import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { test } from 'vitest';
import { ClaudeContext } from '../src/agents/claude-context.js';
import type { ClaudeCompactionControl } from '../src/agents/claude-context.js';
import type { AgentEvent } from '../src/agents/types.js';
import type { RpcMessage } from '../src/agents/json-rpc.js';
import {
  close,
  fixture,
  frameWriter,
  commandFrame,
} from './fixtures/codex-adapter.js';
import { until, within } from './fixtures/within.js';

function context(
  maxTokens: number,
  autoCompactThreshold: number,
): SDKControlGetContextUsageResponse {
  return {
    model: 'claude-opus-5-5',
    maxTokens,
    rawMaxTokens: maxTokens,
    totalTokens: 0,
    percentage: 0,
    categories: [],
    gridRows: [],
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    apiUsage: null,
    isAutoCompactEnabled: true,
    autoCompactThreshold,
  };
}

test('Claude converts the native buffer into the target and preserves unrelated flag environment', async () => {
  let sample = context(1_000_000, 967_000);
  const sent: Parameters<ClaudeCompactionControl['applyFlagSettings']>[0][] =
    [];
  const policy = new ClaudeContext(() => ({
    getContextUsage: async () => sample,
    getSettings: async () => ({
      sources: [
        {
          source: 'flagSettings',
          settings: { env: { KEEP_SETTING: 'distinct-value' } },
        },
      ],
    }),
    applyFlagSettings: async (value) => {
      sent.push(value);
    },
  }));
  await policy.configure();
  await policy.configure();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.env?.KEEP_SETTING, 'distinct-value');
  assert.equal(
    Math.floor(
      (Number(sent[0]!.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) / 100) * 980_000,
    ),
    600_000,
  );
  sample = context(200_000, 167_000);
  policy.invalidate();
  await policy.configure();
  assert.equal(sent.length, 2);
  assert.equal(
    Math.floor(
      (Number(sent[1]!.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) / 100) * 180_000,
    ),
    160_000,
  );
});

test('Claude retries a rejected policy application instead of caching it as applied', async () => {
  let refused = true;
  const targets: string[] = [];
  const policy = new ClaudeContext(() => ({
    getContextUsage: async () => context(1_000_000, 967_000),
    getSettings: async () => ({ sources: [] }),
    applyFlagSettings: async (value) => {
      targets.push(value.env!.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE!);
      if (refused) throw new Error('settings refused');
    },
  }));
  await assert.rejects(policy.configure(), /settings refused/);
  refused = false;
  await policy.configure();
  assert.equal(targets.length, 2);
  assert.equal(targets[0], targets[1]);
});

test('Claude keeps the percentage valid when its native safety reserve compacts earlier', async () => {
  let percentage: string | undefined;
  const policy = new ClaudeContext(() => ({
    getContextUsage: async () => context(100_000, 67_000),
    getSettings: async () => ({ sources: [] }),
    applyFlagSettings: async (value) => {
      percentage = value.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    },
  }));
  await policy.configure();
  assert.equal(percentage, '100');
});

test('Claude compact hooks retain the current context reader when an older turn releases its reader', async () => {
  const policy = new ClaudeContext(() => ({
    getContextUsage: async () => context(1_000_000, 967_000),
    getSettings: async () => ({ sources: [] }),
    applyFlagSettings: async () => {},
  }));
  const old = policy.bind(async () => 'old context');
  const current = policy.bind(async () => 'current accepted context');
  old();
  const hook = policy.hooks!.SessionStart![0]!.hooks[0]!;
  const input = {
    hook_event_name: 'SessionStart' as const,
    source: 'compact' as const,
    session_id: 'session',
    transcript_path: '/transcript',
    cwd: '/project',
  };
  const options = { signal: new AbortController().signal };
  assert.deepEqual(await hook(input, undefined, options), {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'current accepted context',
    },
  });
  current();
  assert.deepEqual(await hook(input, undefined, options), {});
});

const catalog = async () => ({
  models: [
    {
      slug: 'model-a',
      context_window: 500_000,
      max_context_window: 1_000_000,
      effective_context_window_percent: 100,
    },
    {
      slug: 'model-b',
      context_window: 256_000,
      max_context_window: 256_000,
      effective_context_window_percent: 100,
    },
  ],
});

async function codex(mode?: string) {
  const calls: RpcMessage[] = [],
    events: AgentEvent[] = [];
  const f = await fixture((event) => events.push(event), {
    model: 'model-a',
    resume: 'native-thread',
    automaticCompaction: true,
    configuration: { model_context_window: 1_000_000 },
    contextCatalog: catalog,
    onClient: (message) => calls.push(message),
    mode,
  });
  return { ...f, calls, events };
}

test('Codex applies the resolved window limit on resume and reloads a smaller model without losing effort', async () => {
  const f = await codex();
  try {
    const initial = f.calls.find((call) => call.method === 'thread/resume')!
      .params as { config: Record<string, unknown> };
    assert.equal(initial.config.model_auto_compact_token_limit, 600_000);
    assert.equal(initial.config.model_auto_compact_token_limit_scope, 'total');
    f.calls.length = 0;
    await f.session.selectModel('model-b', 'high');
    const sequence = f.calls.map((call) => call.method);
    assert.deepEqual(sequence, [
      'thread/settings/update',
      'thread/unsubscribe',
      'thread/resume',
    ]);
    const resumed = f.calls.at(-1)!.params as {
      config: Record<string, unknown>;
      threadId: string;
      model: string;
      runtimeWorkspaceRoots: string[];
    };
    assert.equal(resumed.config.model_auto_compact_token_limit, 204_800);
    assert.equal(resumed.config.model_reasoning_effort, undefined);
    assert.equal(resumed.threadId, 'native-thread');
    assert.equal(resumed.model, undefined);
    assert.deepEqual(resumed.runtimeWorkspaceRoots, [
      f.cwd,
      '/shared/global',
      '/shared/project',
    ]);
    assert.equal(f.session.info.effort, 'high');
    f.calls.length = 0;
    await f.session.selectModel('model-b', 'low');
    assert.deepEqual(
      f.calls.map((call) => call.method),
      ['thread/settings/update'],
    );
  } finally {
    await close(f.session, f.cwd);
  }
});

test('Codex uses the saved model for implicit resume without overriding native model or effort restoration', async () => {
  const calls: RpcMessage[] = [];
  const f = await fixture(undefined, {
    resume: 'native-thread',
    automaticCompaction: true,
    configuration: { model: 'model-b', model_context_window: 1_000_000 },
    contextCatalog: catalog,
    onClient: (message) => calls.push(message),
  });
  try {
    const resume = calls.find((call) => call.method === 'thread/resume')!
      .params as { model?: string; config: Record<string, unknown> };
    assert.equal(resume.model, undefined);
    assert.equal(resume.config.model_auto_compact_token_limit, 600_000);
    assert.equal(resume.config.model_reasoning_effort, undefined);
    assert.equal(f.session.info.model, 'model-a');
  } finally {
    await close(f.session, f.cwd);
  }
});

test('Codex uses the default catalog window when no window is configured and retains the command mark', async () => {
  const calls: RpcMessage[] = [];
  const f = await fixture(undefined, {
    model: 'model-a',
    automaticCompaction: true,
    contextCatalog: catalog,
    mark: { environment: { WITCH_JOBS: '/owned/jobs' } },
    onClient: (message) => calls.push(message),
  });
  try {
    const start = calls.find((call) => call.method === 'thread/start')!
      .params as { config: Record<string, unknown> };
    assert.equal(start.config.model_auto_compact_token_limit, 400_000);
    assert.equal(
      start.config['shell_environment_policy.set.WITCH_JOBS'],
      '/owned/jobs',
    );
  } finally {
    await close(f.session, f.cwd);
  }
});

test('Codex refuses a window change while a command is active without changing the model or interrupting it', async () => {
  const f = await codex('compaction');
  try {
    const emit = frameWriter(f.cwd, (text) =>
      f.events.some((e) => e.type === 'notice' && e.text === text),
    );
    await emit(commandFrame('still-running'));
    f.calls.length = 0;
    await assert.rejects(f.session.selectModel('model-b'), /background work/);
    assert.equal(f.session.info.model, 'model-a');
    assert.deepEqual(f.calls, []);
  } finally {
    await writeFile(join(f.cwd, 'exit'), '');
    await close(f.session, f.cwd);
  }
});

test('a failed Codex reload leaves the prompt unsent and retries the policy before later delivery', async () => {
  const f = await codex();
  try {
    await writeFile(join(f.cwd, 'resume-fail'), '');
    await assert.rejects(f.session.selectModel('model-b'), /resume refused/);
    f.calls.length = 0;
    const failed = await f.session.send('keep this prompt');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.inputUnsent, true);
    assert.equal(
      f.calls.some((call) => call.method === 'turn/start'),
      false,
    );
    await rm(join(f.cwd, 'resume-fail'));
    f.calls.length = 0;
    const pending = f.session.send('keep this prompt');
    await until('retried prompt approval', () =>
      f.events.some((event) => event.type === 'request'),
    );
    const request = f.events.find((event) => event.type === 'request');
    assert.ok(request?.type === 'request');
    await f.session.respond(request.request.id, { decision: 'accept' });
    const result = await within(pending, 2000, 'retried prompt');
    assert.equal(result.status, 'completed');
    const methods = f.calls.map((call) => call.method);
    assert.ok(methods.indexOf('thread/resume') < methods.indexOf('turn/start'));
    const turn = f.calls.find((call) => call.method === 'turn/start')!
      .params as { input: { text: string }[] };
    assert.equal(turn.input[0]!.text, 'keep this prompt');
  } finally {
    await close(f.session, f.cwd);
  }
});
