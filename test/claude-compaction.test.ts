import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import type { AgentEvent } from '../src/agents/types.js';
import { fixture, content, jsonLines } from './fixtures/claude-adapter.js';
import { until, within } from './fixtures/within.js';

async function scripted(sessionState = true) {
  const events: AgentEvent[] = [];
  const f = await fixture((e) => events.push(e), 'compaction', {
    sessionState,
  });
  await f.session.send('seed');
  events.length = 0;
  let sequence = 0;
  const emit = async (...frames: object[]) => {
    const index = ++sequence;
    await writeFile(join(f.cwd, 'events.next'), JSON.stringify(frames));
    await rename(
      join(f.cwd, 'events.next'),
      join(f.cwd, `events-${index}.json`),
    );
    await until('frame barrier', () =>
      events.some(
        (e) => e.type === 'skills' && e.skills[0]?.name === `barrier-${index}`,
      ),
    );
  };
  const compact = async () => {
    let settled = false;
    const result = f.session.compact().then((r) => {
      settled = true;
      return r;
    });
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
    return { result, uuid, settled: () => settled };
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
    await writeFile(join(f.cwd, 'hold-context'), '');
    let settled = false;
    const stale = f.session.contextUsage().then((value) => {
      settled = true;
      return value;
    });
    const request = async (previous = '') => {
      let id = '';
      await until('context read', async () =>
        jsonLines(join(f.cwd, 'context-request.json')).then(([message]) => {
          if (!message) return false;
          id = (message as { request_id: string }).request_id;
          return id !== previous;
        }),
      );
      return id;
    };
    const first = await request();
    assert.equal(settled, false);
    await f.session.selectModel('claude-b');
    const reply = (request_id: string, percentage: number, maxTokens: number) =>
      f.emit({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id,
          response: { percentage, maxTokens },
        },
      });
    await reply(first, 71, 300000);
    assert.equal(await stale, undefined);
    assert.equal(f.session.usage.context, undefined);
    const fresh = f.session.contextUsage();
    await reply(await request(first), 82, 900000);
    assert.equal(await within(fresh, 2000, 'fresh context'), 82);
    assert.equal(f.session.usage.context, 82);
    assert.equal(f.session.usage.contextWindow, 900000);
  } finally {
    await f.session.close();
  }
});
