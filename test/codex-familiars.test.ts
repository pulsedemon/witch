import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import type { AgentEvent } from '../src/agents/types.js';
import { writeJson } from '../src/persistence/json.js';
import { fixture } from './fixtures/codex-adapter.js';
import { until } from './fixtures/within.js';

async function reportedFixture() {
  const events: AgentEvent[] = [];
  const binding = {
    directory: '/control/familiars',
    conversation: 'conversation',
    activation: randomUUID(),
  };
  const { session, cwd } = await fixture((event) => events.push(event), {
    mode: 'brews',
    familiarBinding: binding,
  });
  let sequence = 0;
  const emit = (...messages: unknown[]) =>
    writeJson(join(cwd, `events-${++sequence}.json`), messages);
  const run = randomUUID();
  const marker = `WITCH_FAMILIAR ${JSON.stringify({ version: 1, conversation: binding.conversation, activation: binding.activation, run })}\r\n`;
  const params = { threadId: 'native-thread', turnId: 'reported-turn' };
  const item = {
    id: 'review-command',
    type: 'commandExecution',
    processId: '42',
    command: 'review',
    cwd,
    source: 'unifiedExecStartup',
    status: 'inProgress',
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
  const output = (delta: string, threadId = params.threadId) => ({
    method: 'item/commandExecution/outputDelta',
    params: { ...params, threadId, itemId: item.id, delta },
  });
  const register = () =>
    session.reportFamiliar!(
      { kind: 'familiar-register', run, name: 'plan review' },
      Date.now() + 5000,
    );
  const familiarEvents = () =>
    events.flatMap((event) =>
      event.type === 'subagent' &&
      event.subagent.id.startsWith('claude-review/')
        ? [event.subagent]
        : [],
    );
  return {
    session,
    cwd,
    events,
    binding,
    run,
    marker,
    params,
    item,
    emit,
    output,
    register,
    familiarEvents,
  };
}

test('a split registration marker and a live native handle are both required before familiar progress can be reported', async () => {
  const f = await reportedFixture();
  try {
    assert.equal((await f.register()).kind, 'familiar-pending');
    await f.emit({
      method: 'item/started',
      params: { ...f.params, item: f.item },
    });
    await until('command start', () =>
      f.events.some((e) => e.type === 'tool' && e.id === f.item.id),
    );
    assert.equal((await f.register()).kind, 'familiar-pending');
    assert.deepEqual(f.familiarEvents(), []);
    await f.emit(
      f.output(f.marker.slice(0, 29)),
      f.output(f.marker.slice(29)),
      f.output(f.marker),
    );
    await until(
      'registration',
      async () => (await f.register()).kind === 'familiar-registered',
    );
    assert.equal(f.familiarEvents().length, 1);
    const start = f.familiarEvents()[0]!;
    assert.equal(start.name, 'plan review');
    assert.equal(start.runtime, 'claude');
    assert.equal(start.model, undefined);
    await f.session.reportFamiliar!(
      {
        kind: 'familiar-update',
        run: f.run,
        sequence: 0,
        progress: {
          status: 'running',
          model: 'claude-opus-5-5',
          tools: 2,
          activity: 'Read plan',
        },
      },
      Date.now() + 5000,
    );
    await f.session.reportFamiliar!(
      {
        kind: 'familiar-update',
        run: f.run,
        sequence: 0,
        progress: { status: 'completed', tools: 99 },
      },
      Date.now() + 5000,
    );
    assert.equal(f.familiarEvents().length, 2);
    assert.equal(f.familiarEvents().at(-1)!.tools, 2);
    assert.equal(start.model, undefined);
    await f.session.reportFamiliar!(
      {
        kind: 'familiar-update',
        run: f.run,
        sequence: 1,
        progress: {
          status: 'completed',
          model: 'claude-opus-5-5',
          tools: 2,
          report: 'Verified review.',
        },
      },
      Date.now() + 5000,
    );
    await assert.rejects(
      f.session.reportFamiliar!(
        {
          kind: 'familiar-update',
          run: f.run,
          sequence: 2,
          progress: { status: 'running' },
        },
        Date.now() + 5000,
      ),
      /already ended/,
    );
    await f.emit({
      method: 'item/completed',
      params: {
        ...f.params,
        item: { ...f.item, status: 'completed', exitCode: 0 },
      },
    });
    await until(
      'targeted cleanup',
      async () =>
        (
          await readFile(join(f.cwd, 'terminated.jsonl'), 'utf8').catch(
            () => '',
          )
        ).length > 0,
    );
    assert.deepEqual(
      JSON.parse(
        (await readFile(join(f.cwd, 'terminated.jsonl'), 'utf8')).trim(),
      ),
      { threadId: 'native-thread', processId: '42' },
    );
    assert.equal(f.familiarEvents().at(-1)!.report, 'Verified review.');
    assert.equal(f.familiarEvents().length, 3);
  } finally {
    await f.session.close();
  }
});

test('a registration accepted during native background listing cannot become a duplicate brew', async () => {
  const f = await reportedFixture();
  try {
    await f.emit(
      { method: 'item/started', params: { ...f.params, item: f.item } },
      {
        method: 'turn/completed',
        params: {
          threadId: f.params.threadId,
          turn: { id: f.params.turnId, status: 'completed', error: null },
        },
      },
    );
    await until(
      'pending listing',
      async () =>
        !!(await readFile(join(f.cwd, 'list-1.json'), 'utf8').catch(() => '')),
    );
    await f.emit(f.output(f.marker));
    await until(
      'registration',
      async () => (await f.register()).kind === 'familiar-registered',
    );
    await writeFile(
      join(f.cwd, 'list-reply-1.json'),
      JSON.stringify({
        result: {
          data: [{ itemId: f.item.id, command: 'review' }],
          nextCursor: null,
        },
      }),
    );
    await until(
      'list returned',
      async () =>
        await readFile(join(f.cwd, 'list-replied-1'), 'utf8').then(
          () => true,
          () => false,
        ),
    );
    await f.session.models();
    await f.session.reportFamiliar!(
      {
        kind: 'familiar-update',
        run: f.run,
        sequence: 0,
        progress: { status: 'running', tools: 4 },
      },
      Date.now() + 5000,
    );
    assert.deepEqual(
      f.events.filter((e) => e.type === 'command'),
      [],
    );
    assert.equal(f.familiarEvents().at(-1)!.tools, 4);
  } finally {
    await f.session.close();
  }
});

test('known child-thread command deltas can register a nested reviewer without projecting its output into the main transcript', async () => {
  const f = await reportedFixture();
  const threadId = 'child-thread';
  try {
    await f.emit(
      {
        method: 'turn/started',
        params: {
          threadId,
          turn: { id: f.params.turnId, status: 'inProgress' },
        },
      },
      {
        method: 'item/started',
        params: { ...f.params, threadId, item: f.item },
      },
      f.output(f.marker, threadId),
    );
    await until(
      'child registration',
      async () => (await f.register()).kind === 'familiar-registered',
    );
    assert.equal(f.familiarEvents()[0]!.parent, 'child-thread');
    assert.equal(
      f.events.some((e) => e.type === 'tool' && e.id === f.item.id),
      false,
    );
    await f.emit({
      method: 'item/completed',
      params: {
        ...f.params,
        threadId,
        item: { ...f.item, status: 'failed', exitCode: 137 },
      },
    });
    await until(
      'lost wrapper failure',
      () => f.familiarEvents().at(-1)?.status === 'failed',
    );
    assert.equal(f.familiarEvents()[0]!.status, 'running');
  } finally {
    await f.session.close();
  }
});
