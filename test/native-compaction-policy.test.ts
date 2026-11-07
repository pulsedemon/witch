import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { test, vi } from 'vitest';
import { ClaudeContext } from '../src/agents/claude-context.js';
import type { ClaudeCompactionControl } from '../src/agents/claude-context.js';
import type { AgentEvent } from '../src/agents/types.js';
import { JsonRpc } from '../src/agents/json-rpc.js';
import type { RpcMessage } from '../src/agents/json-rpc.js';
import {
  close,
  fixture,
  frameWriter,
  commandFrame,
} from './fixtures/codex-adapter.js';
import { settled, until, within } from './fixtures/within.js';
import {
  launcher,
  jsonLines,
  frameWriter as claudeFrames,
} from './fixtures/claude-adapter.js';

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
    await assert.rejects(
      f.session.selectModel('unknown-model'),
      /background work/,
    );
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

for (const rejected of [false, true]) {
  test(`Claude preserves prompt order while configuration is pending${rejected ? ' and retains input on rejection' : ''}`, async () => {
    const ready = Promise.withResolvers<void>();
    const configure = vi
      .spyOn(ClaudeContext.prototype, 'configure')
      .mockImplementation(() => ready.promise);
    const f = await launcher();
    const session = await f.connect({ automaticCompaction: true });
    try {
      const sending = session.send('steerable');
      const steering = session.steer('follower');
      assert.deepEqual(await jsonLines(join(f.cwd, 'inputs.jsonl')), []);
      if (rejected) {
        ready.reject(new Error('configuration refused'));
        assert.equal(await steering, false);
        const result = await sending;
        assert.equal(result.status, 'failed');
        assert.equal(result.inputUnsent, true);
        assert.deepEqual(await jsonLines(join(f.cwd, 'inputs.jsonl')), []);
      } else {
        ready.resolve();
        assert.equal(await steering, true);
        let inputs: { message: { content: string } }[] = [];
        await until('initial input followed by steered input', async () => {
          inputs = (await jsonLines(
            join(f.cwd, 'inputs.jsonl'),
          )) as typeof inputs;
          return inputs.length === 2;
        });
        assert.deepEqual(
          inputs.map((input) => input.message.content),
          ['steerable', 'follower'],
        );
        await session.interrupt();
        await sending;
      }
    } finally {
      configure.mockRestore();
      await session.close();
    }
  });
}

test('Codex reloads without the previous override when the selected capacity is unknown', async () => {
  const calls: RpcMessage[] = [];
  const f = await fixture(undefined, {
    model: 'model-a',
    resume: 'native-thread',
    automaticCompaction: true,
    configuration: { model_context_window: 1_000_000 },
    contextCatalog: async () => ({
      models: (await catalog()).models.slice(0, 1),
    }),
    onClient: (message) => calls.push(message),
  });
  try {
    calls.length = 0;
    await f.session.selectModel('model-b');
    assert.deepEqual(
      calls.map((call) => call.method),
      ['thread/settings/update', 'thread/unsubscribe', 'thread/resume'],
    );
    const resumed = calls.at(-1)!.params as { config: Record<string, unknown> };
    assert.equal(resumed.config.model_auto_compact_token_limit, undefined);
    assert.equal(
      resumed.config.model_auto_compact_token_limit_scope,
      undefined,
    );
    calls.length = 0;
    await f.session.selectModel('model-b', 'high');
    assert.deepEqual(
      calls.map((call) => call.method),
      ['thread/settings/update'],
    );
  } finally {
    await close(f.session, f.cwd);
  }
});

test('Claude model selection waits for the new compaction policy before completing', async () => {
  const ready = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const configure = vi
    .spyOn(ClaudeContext.prototype, 'configure')
    .mockImplementation(() => {
      entered.resolve();
      return ready.promise;
    });
  const f = await launcher();
  const session = await f.connect({ automaticCompaction: true });
  try {
    const selecting = session.selectModel('claude-b');
    const done = settled(selecting);
    await entered.promise;
    assert.equal(session.info.model, 'claude-b');
    assert.equal(done(), false);
    ready.resolve();
    await selecting;
  } finally {
    configure.mockRestore();
    await session.close();
  }
});

for (const action of ['compact', 'shell'] as const) {
  test(`Codex ${action} recovers a failed model reload before dispatch`, async () => {
    const f = await codex('compaction');
    try {
      await writeFile(join(f.cwd, 'resume-fail'), '');
      await assert.rejects(f.session.selectModel('model-b'), /resume refused/);
      await rm(join(f.cwd, 'resume-fail'));
      f.calls.length = 0;
      const result =
        action === 'compact'
          ? f.session.compact()
          : f.session.shell('recovered');
      const method =
        action === 'compact' ? 'thread/compact/start' : 'thread/shellCommand';
      await until('native operation after reload', () =>
        f.calls.some((call) => call.method === method),
      );
      assert.deepEqual(f.calls.map((call) => call.method).slice(0, 3), [
        'thread/unsubscribe',
        'thread/resume',
        method,
      ]);
      if (action === 'compact') {
        const emit = frameWriter(f.cwd, (text) =>
          f.events.some((e) => e.type === 'notice' && e.text === text),
        );
        await emit(
          {
            method: 'turn/started',
            params: {
              threadId: 'native-thread',
              turn: { id: 'compact-recovered', status: 'inProgress' },
            },
          },
          {
            method: 'item/started',
            params: {
              threadId: 'native-thread',
              turnId: 'compact-recovered',
              item: { id: 'summary', type: 'contextCompaction' },
            },
          },
          {
            method: 'item/completed',
            params: {
              threadId: 'native-thread',
              turnId: 'compact-recovered',
              item: { id: 'summary', type: 'contextCompaction' },
            },
          },
          {
            method: 'turn/completed',
            params: {
              threadId: 'native-thread',
              turn: {
                id: 'compact-recovered',
                status: 'completed',
                error: null,
              },
            },
          },
        );
      }
      assert.equal(
        (await within(result, 2000, 'recovered operation')).status,
        'completed',
      );
    } finally {
      await writeFile(join(f.cwd, 'exit'), '');
      await close(f.session, f.cwd);
    }
  });
}

test('a fresh Codex model change starts a replacement thread and sends the first prompt to it', async () => {
  const calls: RpcMessage[] = [],
    events: AgentEvent[] = [];
  const f = await fixture((event) => events.push(event), {
    model: 'model-a',
    automaticCompaction: true,
    contextCatalog: catalog,
    onClient: (message) => calls.push(message),
  });
  try {
    const originalId = f.session.info.id;
    calls.length = 0;
    await f.session.selectModel('model-b', 'high');
    assert.deepEqual(
      calls.map((call) => call.method),
      ['thread/settings/update', 'thread/unsubscribe', 'thread/start'],
    );
    const started = calls.at(-1)!.params as {
      model: string;
      config: Record<string, unknown>;
    };
    assert.equal(started.model, 'model-b');
    assert.equal(started.config.model_reasoning_effort, 'high');
    assert.equal(started.config.model_auto_compact_token_limit, 204800);
    const replacementId = f.session.info.id;
    assert.notEqual(replacementId, originalId);
    assert.equal(f.session.info.model, 'model-b');
    assert.equal(f.session.info.nativeEffort, 'high');
    const sending = f.session.send('first prompt on replacement');
    await until('replacement prompt approval', () =>
      events.some((event) => event.type === 'request'),
    );
    const request = events.find((event) => event.type === 'request');
    assert.ok(request?.type === 'request');
    await f.session.respond(request.request.id, { decision: 'accept' });
    const result = await within(sending, 2000, 'replacement prompt');
    assert.equal(result.status, 'completed');
    const turns = calls.filter((call) => call.method === 'turn/start');
    assert.equal(turns.length, 1);
    assert.equal(
      (turns[0]!.params as { threadId: string }).threadId,
      replacementId,
    );
  } finally {
    await close(f.session, f.cwd);
  }
});

test('Codex reduces the resolved window before deriving a limit below the token cap', async () => {
  const calls: RpcMessage[] = [];
  const f = await fixture(undefined, {
    model: 'model-a',
    automaticCompaction: true,
    configuration: { model_context_window: 1000000 },
    contextCatalog: async () => ({
      models: [
        {
          slug: 'model-a',
          context_window: 100000,
          max_context_window: 200000,
          effective_context_window_percent: 95,
        },
      ],
    }),
    onClient: (message) => calls.push(message),
  });
  try {
    const start = calls.find((call) => call.method === 'thread/start')!
      .params as { config: Record<string, unknown> };
    assert.equal(start.config.model_auto_compact_token_limit, 152000);
  } finally {
    await close(f.session, f.cwd);
  }
});

test('Claude ignores a foreign completion while preparing the initial input', async () => {
  const ready = Promise.withResolvers<void>();
  const configure = vi
    .spyOn(ClaudeContext.prototype, 'configure')
    .mockImplementation(() => ready.promise);
  const f = await launcher('background');
  const events: AgentEvent[] = [];
  const session = await f.connect({
    automaticCompaction: true,
    onEvent: (event) => events.push(event),
  });
  const emit = claudeFrames(
    f.cwd,
    (name) =>
      events.some(
        (event) =>
          event.type === 'skills' &&
          event.skills.some((skill) => skill.name === name),
      ),
    f.children[0]!,
  );
  try {
    const sending = session.send(
      'owned request',
      undefined,
      'accepted context marker',
    );
    await emit(
      {
        type: 'result',
        subtype: 'success',
        result: 'foreign result',
        user_message_uuids: ['foreign-input'],
      },
      { type: 'system', subtype: 'session_state_changed', state: 'idle' },
    );
    ready.resolve();
    let inputs: { uuid: string; message: { content: string } }[] = [];
    await until('initial input after foreign completion', async () => {
      inputs = (await jsonLines(join(f.cwd, 'inputs.jsonl'))) as typeof inputs;
      return inputs.length === 1;
    });
    assert.match(inputs[0]!.message.content, /owned request/);
    assert.match(inputs[0]!.message.content, /accepted context marker/);
    await emit(
      {
        type: 'result',
        subtype: 'success',
        result: 'owned result',
        user_message_uuids: [inputs[0]!.uuid],
      },
      { type: 'system', subtype: 'session_state_changed', state: 'idle' },
    );
    const result = await within(sending, 2000, 'owned input completion');
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'owned result');
    assert.notEqual(result.inputUnsent, true);
  } finally {
    ready.resolve();
    configure.mockRestore();
    await session.close();
  }
});

test('failed live Claude preparation returns unread shell context without closing the session', async () => {
  const configure = vi
    .spyOn(ClaudeContext.prototype, 'configure')
    .mockRejectedValue(new Error('policy application refused'));
  const f = await launcher();
  const session = await f.connect({ automaticCompaction: true });
  try {
    assert.equal(
      (await session.shell('printf preparation-context-marker')).status,
      'completed',
    );
    const result = await session.send('retain original input');
    assert.equal(result.status, 'failed');
    assert.equal(result.inputUnsent, true);
    assert.equal(result.unreadContext?.length, 1);
    assert.match(result.unreadContext![0]!, /preparation-context-marker/);
    assert.ok(session.takeUnreadContext);
    assert.deepEqual(session.takeUnreadContext(), []);
    assert.equal(session.closed, false);
  } finally {
    configure.mockRestore();
    await session.close();
  }
});

for (const configured of [false, true]) {
  test(`Codex resolves a fresh implicit model from ${configured ? 'native configuration' : 'the default model listing'}`, async () => {
    const calls: RpcMessage[] = [];
    const f = await fixture(undefined, {
      automaticCompaction: true,
      configuration: configured ? { model: 'model-b' } : undefined,
      contextCatalog: catalog,
      onClient: (message) => calls.push(message),
    });
    try {
      const start = calls.find((call) => call.method === 'thread/start')!
        .params as { model?: string; config: Record<string, unknown> };
      assert.equal(start.model, undefined);
      assert.equal(
        start.config.model_auto_compact_token_limit,
        configured ? 204800 : 400000,
      );
      assert.equal(f.session.info.model, configured ? 'model-b' : 'model-a');
      assert.equal(
        calls.some((call) => call.method === 'model/list'),
        !configured,
      );
    } finally {
      await close(f.session, f.cwd);
    }
  });
}

for (const stop of ['interrupt', 'close'] as const) {
  test(`Claude ${stop} during pending policy configuration leaves initial and following input unsent`, async () => {
    const ready = Promise.withResolvers<void>();
    const configure = vi
      .spyOn(ClaudeContext.prototype, 'configure')
      .mockImplementation(() => ready.promise);
    const f = await launcher('background');
    const session = await f.connect({ automaticCompaction: true });
    try {
      const sending = session.send('initial input');
      const steering = session.steer('following input');
      const stopping = session[stop]();
      ready.resolve();
      const result = await within(sending, 2000, 'unsent interrupted input');
      await within(stopping, 2000, 'stop during configuration');
      assert.equal(result.status, 'interrupted');
      assert.equal(result.inputUnsent, true);
      assert.equal(await steering, false);
      assert.deepEqual(await jsonLines(join(f.cwd, 'inputs.jsonl')), []);
    } finally {
      ready.resolve();
      configure.mockRestore();
      await session.close();
    }
  });
}

for (const action of ['send', 'compact', 'shell'] as const) {
  test(`Codex interrupt during reload prevents ${action} dispatch`, async () => {
    const f = await codex('compaction');
    const ready = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    const request = JsonRpc.prototype.request;
    let interception: { mockRestore(): void } | undefined;
    try {
      await writeFile(join(f.cwd, 'resume-fail'), '');
      await assert.rejects(f.session.selectModel('model-b'), /resume refused/);
      await rm(join(f.cwd, 'resume-fail'));
      interception = vi
        .spyOn(JsonRpc.prototype, 'request')
        .mockImplementation(async function (this: JsonRpc, method, params) {
          if (method === 'thread/resume') {
            entered.resolve();
            await ready.promise;
          }
          return request.call(this, method, params);
        });
      f.calls.length = 0;
      const operation =
        action === 'send'
          ? f.session.send('unsent input')
          : action === 'compact'
            ? f.session.compact()
            : f.session.shell('must not execute');
      await entered.promise;
      const stopping = f.session.interrupt();
      ready.resolve();
      const result = await within(operation, 2000, 'interrupted operation');
      await within(stopping, 2000, 'reload interruption');
      assert.equal(result.status, 'interrupted');
      if (action === 'send') assert.equal(result.inputUnsent, true);
      assert.equal(
        f.calls.some((call) =>
          [
            'turn/start',
            'thread/compact/start',
            'thread/shellCommand',
          ].includes(call.method ?? ''),
        ),
        false,
      );
    } finally {
      ready.resolve();
      interception?.mockRestore();
      await writeFile(join(f.cwd, 'exit'), '');
      await close(f.session, f.cwd);
    }
  });
}

test('Codex repairs a failed reload before selecting a model with the previous limit', async () => {
  const f = await codex();
  try {
    await writeFile(join(f.cwd, 'resume-fail'), '');
    await assert.rejects(
      f.session.selectModel('model-b', 'high'),
      /resume refused/,
    );
    await rm(join(f.cwd, 'resume-fail'));
    f.calls.length = 0;
    await f.session.selectModel('model-a');
    assert.deepEqual(
      f.calls.map((call) => call.method),
      [
        'thread/unsubscribe',
        'thread/resume',
        'thread/settings/update',
        'thread/unsubscribe',
        'thread/resume',
      ],
    );
    assert.equal(f.session.info.model, 'model-a');
    assert.equal(f.session.info.nativeEffort, 'high');
    const last = f.calls.at(-1)!.params as { config: Record<string, unknown> };
    assert.equal(last.config.model_auto_compact_token_limit, 600000);
    const sending = f.session.send('continue on the original model');
    await until('recovered model prompt approval', () =>
      f.events.some((event) => event.type === 'request'),
    );
    const event = f.events.find((event) => event.type === 'request');
    assert.ok(event?.type === 'request');
    await f.session.respond(event.request.id, { decision: 'accept' });
    assert.equal(
      (await within(sending, 2000, 'recovered model turn')).status,
      'completed',
    );
  } finally {
    await close(f.session, f.cwd);
  }
});

test('Claude respects disabled native auto-compaction without applying an override', async () => {
  const policy = new ClaudeContext(() => ({
    getContextUsage: async () => ({
      ...context(1000000, 967000),
      isAutoCompactEnabled: false,
    }),
    getSettings: async () =>
      assert.fail('disabled compaction must not read flag settings'),
    applyFlagSettings: async () =>
      assert.fail('disabled compaction must not apply an override'),
  }));
  await policy.configure();
});

test('Codex refuses a window-changing selection until a running familiar completes', async () => {
  const f = await codex('compaction');
  const emit = frameWriter(f.cwd, (text) =>
    f.events.some((event) => event.type === 'notice' && event.text === text),
  );
  try {
    await emit({
      method: 'turn/started',
      params: {
        threadId: 'child-thread',
        turn: { id: 'child-run', status: 'inProgress' },
      },
    });
    f.calls.length = 0;
    await assert.rejects(f.session.selectModel('model-b'), /background work/);
    assert.equal(f.session.info.model, 'model-a');
    assert.equal(
      f.calls.some((call) =>
        [
          'thread/settings/update',
          'thread/unsubscribe',
          'thread/resume',
        ].includes(call.method ?? ''),
      ),
      false,
    );
    await emit({
      method: 'turn/completed',
      params: {
        threadId: 'child-thread',
        turn: { id: 'child-run', status: 'completed', error: null },
      },
    });
    await f.session.selectModel('model-b');
    assert.equal(f.session.info.model, 'model-b');
  } finally {
    await writeFile(join(f.cwd, 'exit'), '');
    await close(f.session, f.cwd);
  }
});
