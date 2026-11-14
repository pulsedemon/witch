import assert from 'node:assert/strict';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import type { TestContext } from 'vitest';
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '../../../src/agents/types.js';
import {
  frameWriter,
  jsonLines,
  launcher,
} from '../../fixtures/claude-adapter.js';
import { until } from '../../fixtures/within.js';

async function fixture(
  t: TestContext,
  servers: McpServerStatus[],
  gate?: 'hold-mcp' | 'reject-mcp',
) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const timers: ReturnType<typeof vi.fn<() => void>>[] = [];
  const schedule = setTimeout;

  vi.spyOn(globalThis, 'setTimeout').mockImplementation(
    <Args extends unknown[]>(
      callback: (...args: Args) => void,
      ms?: number,
      ...args: Args
    ) => {
      if (ms !== 1000) return schedule(callback, ms, ...args);

      const run = vi.fn(() => callback(...args));

      timers.push(run);

      return schedule(run, ms);
    },
  );

  const f = await launcher('mcp');

  const setServers = (rows: McpServerStatus[]) =>
    writeFile(join(f.cwd, 'mcp-status.json'), JSON.stringify(rows));

  await setServers(servers);

  if (gate) await writeFile(join(f.cwd, gate), '');

  const notices: Extract<AgentEvent, { type: 'notice' }>[] = [];
  const barriers = new Set<string>();

  const session = await f.connect({
    onEvent: (event) => {
      if (event.type === 'notice') notices.push(event);

      if (event.type === 'skills')
        for (const skill of event.skills) barriers.add(skill.name);
    },
  });

  t.onTestFinished(async () => {
    try {
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  const emit = frameWriter(f.cwd, (name) => barriers.has(name), f.children[0]!);

  const requests = async () =>
    (
      (await jsonLines(join(f.cwd, 'wire.jsonl'))) as {
        type: string;
        request_id: string;
        request?: { subtype: string };
      }[]
    ).filter(
      ({ type, request }) =>
        type === 'control_request' && request?.subtype === 'mcp_status',
    );

  await until(
    'initial MCP status request',
    async () => (await requests()).length > 0,
  );

  await emit();

  return {
    ...f,
    session,
    notices,
    timers,
    requests,
    setServers,
    emit,
    async turn() {
      assert.equal((await session.send('hello')).status, 'completed');

      await emit();
    },
  };
}

test('Claude reports failed MCP connections and sign-in requirements once per connection', async (t) => {
  const rows: McpServerStatus[] = [
    { name: 'unreachable', status: 'failed', error: 'handshake refused' },
    { name: 'silent', status: 'failed' },
    { name: 'signin', status: 'needs-auth' },
    { name: 'working', status: 'connected' },
    { name: 'off', status: 'disabled' },
  ];

  const expected = [
    {
      type: 'notice',
      text: 'Claude could not connect to MCP server unreachable: handshake refused',
      transient: true,
    },
    {
      type: 'notice',
      text: 'Claude could not connect to MCP server silent.',
      transient: true,
    },
    {
      type: 'notice',
      text: 'Claude MCP server signin needs sign-in.',
      transient: true,
    },
  ];

  const f = await fixture(t, rows);

  assert.deepEqual(f.notices, expected);

  await f.turn();

  await f.turn();

  assert.deepEqual(f.notices, expected);

  await f.session.close();

  const reconnected = await f.connect({
    onEvent: (event) => {
      if (event.type === 'notice') f.notices.push(event);
    },
  });

  try {
    await until('reconnected MCP notices', () => f.notices.length === 6);

    assert.deepEqual(f.notices, [...expected, ...expected]);
  } finally {
    await reconnected.close();
  }
});

test('a pending Claude MCP connection reports its later failure without another prompt', async (t) => {
  const f = await fixture(t, [{ name: 'delayed', status: 'pending' }]);

  assert.deepEqual(f.notices, []);

  await f.turn();

  await f.setServers([
    { name: 'delayed', status: 'failed', error: 'Connection closed' },
  ]);

  vi.advanceTimersByTime(1000);

  await until('delayed failure notice', () => f.notices.length === 1);

  assert.deepEqual(f.notices, [
    {
      type: 'notice',
      text: 'Claude could not connect to MCP server delayed: Connection closed',
      transient: true,
    },
  ]);

  const count = (await f.requests()).length;

  vi.advanceTimersByTime(2000);

  await f.emit();

  assert.equal((await f.requests()).length, count);

  assert.equal(f.notices.length, 1);
});

test('Claude reports each diagnostic state once for the same MCP server', async (t) => {
  const f = await fixture(t, [
    { name: 'service', status: 'failed', error: 'connection refused' },
  ]);

  await f.setServers([{ name: 'service', status: 'needs-auth' }]);

  await f.turn();

  await f.setServers([
    { name: 'service', status: 'failed', error: 'retry failed' },
  ]);

  await f.turn();

  await f.setServers([{ name: 'service', status: 'needs-auth' }]);

  await f.turn();

  assert.deepEqual(f.notices, [
    {
      type: 'notice',
      text: 'Claude could not connect to MCP server service: connection refused',
      transient: true,
    },
    {
      type: 'notice',
      text: 'Claude MCP server service needs sign-in.',
      transient: true,
    },
  ]);
});

test('cached pending Claude MCP discovery does not sustain polling', async (t) => {
  const f = await fixture(t, [
    { name: 'cached', status: 'pending', tools: [] },
  ]);

  const count = (await f.requests()).length;

  vi.advanceTimersByTime(3000);

  await f.emit();

  assert.equal((await f.requests()).length, count);

  assert.deepEqual(f.notices, []);

  await f.setServers([{ name: 'cached', status: 'needs-auth' }]);

  await f.turn();

  await until('sign-in notice', () => f.notices.length === 1);

  assert.deepEqual(f.notices, [
    {
      type: 'notice',
      text: 'Claude MCP server cached needs sign-in.',
      transient: true,
    },
  ]);
});

test('a failed MCP status read does not fail the Claude turn', async (t) => {
  const f = await fixture(
    t,
    [{ name: 'unreachable', status: 'failed', error: 'handshake refused' }],
    'reject-mcp',
  );

  await f.turn();

  assert.deepEqual(f.notices, []);

  await unlink(join(f.cwd, 'reject-mcp'));

  await f.turn();

  assert.deepEqual(f.notices, [
    {
      type: 'notice',
      text: 'Claude could not connect to MCP server unreachable: handshake refused',
      transient: true,
    },
  ]);
});

test('pending MCP polling recovers from a rejected status read while idle', async (t) => {
  const f = await fixture(t, [{ name: 'delayed', status: 'pending' }]);

  await f.turn();

  await writeFile(join(f.cwd, 'reject-mcp'), '');

  const count = (await f.requests()).length;

  vi.advanceTimersByTime(1000);

  await until(
    'rejected MCP poll',
    async () => (await f.requests()).length > count,
  );

  await f.emit();

  assert.deepEqual(f.notices, []);

  await unlink(join(f.cwd, 'reject-mcp'));

  await f.setServers([
    { name: 'delayed', status: 'failed', error: 'Connection closed' },
  ]);

  vi.advanceTimersByTime(1000);

  await until('recovered MCP poll', () => f.notices.length === 1);

  assert.deepEqual(f.notices, [
    {
      type: 'notice',
      text: 'Claude could not connect to MCP server delayed: Connection closed',
      transient: true,
    },
  ]);
});

test('init refreshes during an MCP status read coalesce into one fresh read', async (t) => {
  const f = await fixture(
    t,
    [{ name: 'late', status: 'needs-auth' }],
    'hold-mcp',
  );

  await f.turn();

  await f.turn();

  const requests = await f.requests();

  assert.equal(requests.length, 1);

  await unlink(join(f.cwd, 'hold-mcp'));

  await f.emit({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requests[0]!.request_id,
      response: { mcpServers: [] },
    },
  });

  await until('fresh MCP status', () => f.notices.length === 1);

  assert.equal((await f.requests()).length, 2);

  assert.deepEqual(f.notices, [
    {
      type: 'notice',
      text: 'Claude MCP server late needs sign-in.',
      transient: true,
    },
  ]);
});

for (const pending of ['timer', 'request'] as const) {
  test(`closing Claude stops pending MCP diagnostics with a pending ${pending}`, async (t) => {
    const f = await fixture(
      t,
      [{ name: 'pending', status: 'pending' }],
      pending === 'request' ? 'hold-mcp' : undefined,
    );

    const scheduled = f.timers.length;

    await f.turn();

    // the turn's init starts another status read, so close only once it has scheduled its poll
    if (pending === 'timer')
      await until('MCP poll timer', () => f.timers.length > scheduled);

    const count = (await f.requests()).length;

    if (pending === 'request') assert.equal(count, 1);

    const callbacks = f.timers.map((timer) => timer.mock.calls.length);

    await f.session.close();

    vi.advanceTimersByTime(3000);

    assert.deepEqual(
      f.timers.map((timer) => timer.mock.calls.length),
      callbacks,
    );

    assert.equal((await f.requests()).length, count);

    assert.deepEqual(f.notices, []);
  });
}
