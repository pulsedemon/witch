import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import type { AgentEvent } from '../../../src/agents/types.js';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  fixture,
  content,
  frameWriter,
  jsonLines,
} from '../../fixtures/claude-adapter.js';
import { settled, until, within } from '../../fixtures/within.js';

async function scripted(sessionState = true) {
  const events: AgentEvent[] = [];

  const f = await fixture((e) => events.push(e), 'compaction', {
    sessionState,
  });

  await f.session.send('seed');
  events.length = 0;

  const emit = frameWriter(
    f.cwd,
    (name) =>
      events.some((e) => e.type === 'skills' && e.skills[0]?.name === name),
    f.child,
  );

  const compact = async () => {
    const result = f.session.compact();
    const isSettled = settled(result);
    let uuid = '';

    await until('compact request', async () =>
      readFile(join(f.cwd, 'compact.json'), 'utf8').then(
        (s) => {
          const message = JSON.parse(s) as {
            uuid: string;
            message: { content: string };
          };

          assert.equal(message.message.content, '/compact');
          uuid = message.uuid;

          return true;
        },
        () => false,
      ),
    );

    return { result, uuid, settled: isSettled };
  };

  return { ...f, events, emit, compact };
}

const idle = {
  type: 'system',
  subtype: 'session_state_changed',
  state: 'idle',
};

const boundary = {
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'manual', pre_tokens: 1000, post_tokens: 100 },
};

const result = (uuid: string) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 0,
  result: '',
  total_cost_usd: 0,
  user_message_uuid: uuid,
  user_message_uuids: [uuid],
  local_command: 'compact',
});

async function busy() {
  const events: AgentEvent[] = [];
  const f = await fixture((event) => events.push(event), 'background');

  const emit = frameWriter(
    f.cwd,
    (name) =>
      events.some((e) => e.type === 'skills' && e.skills[0]?.name === name),
    f.child,
  );

  const parent = f.session.send('initial');
  const parentDone = settled(parent);

  await until('ordinary result', () =>
    events.some((e) => e.type === 'skills' && e.skills[0]?.name === 'result-1'),
  );

  await emit({
    type: 'system',
    subtype: 'task_started',
    task_id: 'held-helper',
    task_type: 'local_agent',
    description: 'Held helper',
    tool_use_id: 'helper-tool',
  });

  const compact = async () => {
    const promise = f.session.compactDuringTurn!();
    assert.ok(promise);
    const isSettled = settled(promise);
    let input: SDKUserMessage | undefined;

    await until('raw compact input', async () => {
      input = (
        (await jsonLines(join(f.cwd, 'inputs.jsonl'))) as SDKUserMessage[]
      ).find((message) => message.message.content === '/compact');

      return !!input;
    });

    assert.equal(Object.hasOwn(input!, 'client_composed'), false);

    return { promise, uuid: input!.uuid!, settled: isSettled };
  };

  const release = () =>
    emit(
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'held-helper',
        status: 'completed',
        output_file: '/fixture/report',
        summary: 'Helper completed',
      },
      idle,
    );

  return {
    ...f,
    events,
    emit,
    compact,
    release,
    parent,
    parentDone,
  };
}

test('busy Claude compaction finishes independently and preserves the ordinary result and familiar', async () => {
  const f = await busy();

  try {
    const pending = await f.compact();
    assert.equal(f.session.compactDuringTurn!(), undefined);
    assert.equal(await f.session.steer('wait for compact'), false);
    await f.emit(idle);
    assert.equal(pending.settled(), false);
    assert.equal(f.parentDone(), false);

    await f.emit(
      {
        type: 'command_lifecycle',
        command_uuid: pending.uuid,
        state: 'started',
      },
      { type: 'system', subtype: 'session_state_changed', state: 'running' },
      boundary,
      result(pending.uuid),
    );

    assert.deepEqual(await pending.promise, { status: 'completed', text: '' });
    assert.equal(f.parentDone(), false);
    assert.equal(f.session.replied, true);
    assert.equal(f.events.filter((e) => e.type === 'compacted').length, 1);
    const familiar = f.events.filter((e) => e.type === 'subagent').at(-1);
    assert.equal(familiar?.subagent.status, 'running');
    await f.release();

    assert.deepEqual(await f.parent, {
      status: 'completed',
      text: 'Finished.',
    });

    const completed = f.events.filter((e) => e.type === 'subagent').at(-1);
    assert.equal(completed?.subagent.id, 'held-helper');
    assert.equal(completed?.subagent.status, 'completed');
  } finally {
    await f.session.close();
  }
});

for (const source of ['automatic', 'child', 'before-start'] as const) {
  test(`busy compact cannot use a ${source} boundary as its replacement`, async () => {
    const f = await busy();

    try {
      const pending = await f.compact();

      const started = {
        type: 'command_lifecycle',
        command_uuid: pending.uuid,
        state: 'started',
      };

      if (source !== 'before-start') await f.emit(started);

      await f.emit({
        ...boundary,
        ...(source === 'child' ? { session_id: randomUUID() } : {}),
        ...(source === 'automatic'
          ? {
              compact_metadata: {
                ...boundary.compact_metadata,
                trigger: 'auto',
              },
            }
          : {}),
      });

      if (source === 'before-start') await f.emit(started);

      await f.emit(result(pending.uuid));
      const compact = await pending.promise;
      assert.equal(compact.status, 'failed');
      assert.match(compact.error!, /without confirming history replacement/);
      assert.equal(f.parentDone(), false);
      await f.release();
      assert.equal((await f.parent).text, 'Finished.');
    } finally {
      await f.session.close();
    }
  });
}

test('canceling accepted native compact input settles only its own result', async () => {
  const f = await busy();

  try {
    const pending = await f.compact();

    await f.emit({
      type: 'command_lifecycle',
      command_uuid: pending.uuid,
      state: 'cancelled',
    });

    assert.equal((await pending.promise).status, 'failed');
    assert.equal(f.parentDone(), false);
    await f.release();
    assert.equal((await f.parent).text, 'Finished.');
  } finally {
    await f.session.close();
  }
});

for (const stop of ['interrupt', 'close'] as const) {
  test(`${stop} settles a busy compact that never produced a native result`, async () => {
    const f = await busy();

    try {
      const pending = await f.compact();
      await f.session[stop]();

      assert.equal(
        (await within(pending.promise, 2000, 'stopped compaction')).status,
        stop === 'interrupt' ? 'interrupted' : 'failed',
      );

      assert.equal(
        (await f.parent).status,
        stop === 'interrupt' ? 'interrupted' : 'failed',
      );
    } finally {
      await f.session.close();
    }
  });
}

for (const replaced of [false, true])
  test(`without session state compaction ${replaced ? 'completes after' : 'fails without'} history replacement`, async () => {
    const f = await scripted(false);

    try {
      const pending = await f.compact();

      if (replaced) await f.emit(boundary);

      await f.emit(result(pending.uuid));
      const outcome = await within(pending.result, 2000, 'compaction result');
      assert.equal(outcome.status, replaced ? 'completed' : 'failed');

      if (!replaced) assert.match(outcome.error!, /without confirming/);

      assert.equal(
        f.events.filter((e) => e.type === 'compacted').length,
        replaced ? 1 : 0,
      );
    } finally {
      await f.session.close();
    }
  });

test('Claude compaction waits for its result and idle while preserving command records', async () => {
  const f = await scripted();

  try {
    await f.session.shell('printf pending-record');
    const pending = await f.compact();
    await f.emit(result(randomUUID()), idle);
    assert.equal(pending.settled(), false);
    assert.equal(await f.session.steer('must wait'), false);
    await f.emit(boundary, result(pending.uuid));
    assert.equal(pending.settled(), false);
    await f.emit(idle);

    assert.deepEqual(await within(pending.result, 2000, 'compact idle'), {
      status: 'completed',
      text: '',
    });

    assert.equal(f.events.filter((e) => e.type === 'compacted').length, 1);
    assert.equal(f.events.filter((e) => e.type === 'text').length, 0);
    await f.session.send('following');
    const blocks = (await content(f.cwd)) as { text: string }[];
    assert.match(blocks[0]!.text, /pending-record/);
    assert.equal(blocks.at(-1)!.text, 'following');
  } finally {
    await f.session.close();
  }
});

for (const status of [false, true]) {
  test(`Claude successful SDK result without replacement fails compaction${status ? ' with native detail' : ''}`, async () => {
    const f = await scripted();

    try {
      const pending = await f.compact();

      if (status)
        await f.emit({
          type: 'system',
          subtype: 'status',
          status: null,
          compact_result: 'failed',
          compact_error: 'provider rejected compaction',
        });

      await f.emit(result(pending.uuid), idle);
      const ended = await pending.result;
      assert.equal(ended.status, 'failed');

      assert.match(
        ended.error!,
        status ? /provider rejected/ : /without confirming/,
      );

      assert.equal(f.events.filter((e) => e.type === 'compacted').length, 0);
    } finally {
      await f.session.close();
    }
  });
}

test('Claude compaction rejected for usage reports exhaustion', async () => {
  const f = await scripted();

  try {
    const pending = await f.compact();
    const resetsAt = Date.now() / 1000 + 3600;

    await f.emit(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rateLimitType: 'seven_day',
          resetsAt,
        },
      },
      {
        type: 'system',
        subtype: 'status',
        status: null,
        compact_result: 'failed',
      },
      result(pending.uuid),
      idle,
    );

    assert.deepEqual(await within(pending.result, 2000, 'compaction'), {
      status: 'failed',
      text: '',
      error: 'Claude compaction failed',
      exhausted: true,
      limit: { window: '7D', resetsAt },
    });
  } finally {
    await f.session.close();
  }
});

test('Claude reports automatic main-session replacement without admitting child boundaries', async () => {
  const f = await scripted();

  try {
    await f.emit({ ...boundary, session_id: randomUUID() });
    assert.equal(f.events.filter((e) => e.type === 'compacted').length, 0);

    await f.emit({
      ...boundary,
      compact_metadata: { ...boundary.compact_metadata, trigger: 'auto' },
    });

    assert.equal(f.events.filter((e) => e.type === 'compacted').length, 1);
    assert.equal(await f.session.contextUsage(), 12.5);
    assert.equal(f.session.usage.contextWindow, 200000);
  } finally {
    await f.session.close();
  }
});

/** the id of the context read the fixture holds, once it differs from `previous`. */
async function contextRequest(cwd: string, previous = ''): Promise<string> {
  let id = '';

  await until('context read', async () =>
    jsonLines(join(cwd, 'context-request.json')).then(([message]) => {
      if (!message) return false;

      id = (message as { request_id: string }).request_id;

      return id !== previous;
    }),
  );

  return id;
}

function contextReply(
  f: Awaited<ReturnType<typeof scripted>>,
  request_id: string,
  percentage: number,
  maxTokens: number,
) {
  return f.emit({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id,
      response: { percentage, maxTokens },
    },
  });
}

test('Claude reports the 1M form of a model that runs below 1M', async () => {
  const f = await scripted();

  try {
    // the fixture reports a 200k window
    await f.session.selectModel('claude-b');
    assert.equal(f.session.usage.contextWindow, 200000);
    assert.equal(f.session.usage.longContext, 'claude-b[1m]');
    // a settings-limited window can keep a 1M form below 1M
    await f.session.selectModel('claude-b[1m]');
    assert.equal(f.session.usage.longContext, undefined);
    await f.session.selectModel('claude-b');
    await writeFile(join(f.cwd, 'hold-context'), '');
    const selecting = f.session.selectModel('claude-c');
    await contextReply(f, await contextRequest(f.cwd), 5, 1_000_000);
    await within(selecting, 2000, 'model change');
    assert.equal(f.session.usage.longContext, undefined);
  } finally {
    await f.session.close();
  }
});

test('Claude process closure settles a compaction without a native result', async () => {
  const f = await scripted();

  try {
    const pending = await f.compact();
    f.child.kill('SIGTERM');

    assert.equal(
      (await within(pending.result, 2000, 'closed compaction')).status,
      'failed',
    );
  } finally {
    await f.session.close();
  }
});

test('Claude awaits a fresh context read without waiting for account usage and rejects an obsolete model sample', async () => {
  const f = await scripted();

  try {
    await writeFile(join(f.cwd, 'hold-usage'), '');
    await f.session.send('start usage refresh');

    await until('account read', () =>
      readFile(join(f.cwd, 'usage-request.json')).then(
        () => true,
        () => false,
      ),
    );

    // drain the post-turn sample before the fixture can hold a different request.
    await within(
      f.session.contextUsage(),
      2000,
      'context with account usage held',
    );

    await writeFile(join(f.cwd, 'hold-context'), '');
    const stale = f.session.contextUsage();
    const isSettled = settled(stale);
    const first = await contextRequest(f.cwd);
    assert.equal(isSettled(), false);
    const selecting = f.session.selectModel('claude-b');
    // the new model's own read proves setModel resolved, so the held sample is obsolete
    const second = await contextRequest(f.cwd, first);
    await contextReply(f, first, 71, 300000);
    assert.equal(await stale, undefined);
    assert.equal(f.session.usage.context, undefined);
    await contextReply(f, second, 82, 1_000_000);
    await within(selecting, 2000, 'model change');
    assert.equal(f.session.usage.context, 82);
    assert.equal(f.session.usage.contextWindow, 1_000_000);
  } finally {
    await f.session.close();
  }
});
