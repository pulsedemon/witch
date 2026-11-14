import assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';

import { readFile, writeFile } from 'node:fs/promises';

import { join } from 'node:path';

import { test } from 'vitest';

import type { AgentEvent } from '../src/agents/types.js';

import { writeJson } from '../src/persistence/json.js';

import { fixture } from './fixtures/codex-adapter.js';

import { until, within } from './fixtures/within.js';

async function reportedFixture() {
  const events: AgentEvent[] = [];

  const binding = {
    directory: '/control/familiars',
    conversation: 'conversation',
    activation: randomUUID(),
  };

  const { session, cwd, child } = await fixture((event) => events.push(event), {
    mode: 'brews',
    familiarBinding: binding,
  });

  let sequence = 0;

  const emit = async (...messages: unknown[]) => {
    const index = ++sequence;

    const text = `reported fixture barrier ${index}`;

    await writeJson(join(cwd, `events-${index}.json`), [
      ...messages,
      {
        method: 'error',
        params: { error: { message: text }, willRetry: true },
      },
    ]);

    await until(text, () =>
      events.some((event) => event.type === 'notice' && event.text === text),
    );
  };

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

  const register = (runtime: 'claude' | 'codex' = 'claude') =>
    session.familiar!.report(
      {
        kind: 'familiar-register',
        run,
        name: 'plan review',
        runtime,
      },
      Date.now() + 5000,
    );

  const familiarEvents = () =>
    events.flatMap((event) =>
      event.type === 'subagent' && event.subagent.id.includes('-familiar/')
        ? [event.subagent]
        : [],
    );

  return {
    session,
    cwd,
    child,
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

const cleanupNotices = (events: AgentEvent[]) =>
  events.flatMap((event) =>
    event.type === 'notice' && /could not confirm cleanup/.test(event.text)
      ? [event.text]
      : [],
  );

async function terminateRequests(cwd: string): Promise<unknown[]> {
  const text = await readFile(join(cwd, 'terminated.jsonl'), 'utf8').catch(
    () => '',
  );

  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

test('a missing familiar cleanup acknowledgment cannot hold Codex close open', async () => {
  const f = await reportedFixture();

  try {
    await f.emit(
      { method: 'item/started', params: { ...f.params, item: f.item } },
      f.output(f.marker),
    );

    assert.equal((await f.register()).kind, 'familiar-registered');

    await writeFile(join(f.cwd, 'hold-termination'), '');

    const closing = f.session.close({ deadline: performance.now() + 3200 });

    await within(closing, 2500, 'bounded familiar cleanup');

    assert.equal(f.session.closed, true);

    assert.ok(f.child.exitCode !== null || f.child.signalCode !== null);

    assert.equal(f.familiarEvents().at(-1)!.status, 'stopped');

    assert.equal(
      f.events.filter(
        (event) =>
          event.type === 'notice' && /did not stop in time/.test(event.text),
      ).length,
      1,
    );
  } finally {
    await f.session.close();
  }
});

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

    await f.session.familiar!.report(
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

    await f.session.familiar!.report(
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

    await f.session.familiar!.report(
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
      f.session.familiar!.report(
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

    await writeJson(join(f.cwd, 'list-reply-1.json'), {
      result: {
        data: [{ itemId: f.item.id, command: 'review' }],
        nextCursor: null,
      },
    });

    await until(
      'list returned',
      async () =>
        await readFile(join(f.cwd, 'list-replied-1'), 'utf8').then(
          () => true,
          () => false,
        ),
    );

    await f.session.models();

    await f.session.familiar!.report(
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

test('stale markers and expired admission cannot register, and another command cannot reuse an admitted run', async () => {
  const f = await reportedFixture();

  try {
    await f.emit(
      { method: 'item/started', params: { ...f.params, item: f.item } },
      f.output(f.marker.replace(f.binding.activation, randomUUID())),
    );

    assert.equal((await f.register()).kind, 'familiar-pending');

    await f.emit(f.output(`${'x'.repeat(5000)}\n${f.marker}`));

    await assert.rejects(
      f.session.familiar!.report(
        {
          kind: 'familiar-register',
          run: f.run,
          name: 'plan review',
          runtime: 'claude',
        },
        Date.now() - 1,
      ),
      /expired/i,
    );

    assert.deepEqual(f.familiarEvents(), []);

    assert.equal((await f.register()).kind, 'familiar-registered');

    await f.emit(
      {
        method: 'item/started',
        params: {
          ...f.params,
          item: { ...f.item, id: 'another-command', processId: '43' },
        },
      },
      {
        method: 'item/commandExecution/outputDelta',
        params: { ...f.params, itemId: 'another-command', delta: f.marker },
      },
    );

    await assert.rejects(f.register(), /more than one command/);

    assert.equal(f.familiarEvents().length, 1);
  } finally {
    await f.session.close();
  }

  await assert.rejects(f.register(), /session is closing/);
});

test('registration requires a live native process handle and cannot adopt an ended command', async () => {
  const f = await reportedFixture();

  try {
    await f.emit(
      {
        method: 'item/started',
        params: { ...f.params, item: { ...f.item, processId: null } },
      },
      f.output(f.marker),
    );

    assert.equal((await f.register()).kind, 'familiar-pending');

    await writeJson(join(f.cwd, 'list-reply-1.json'), {
      result: { data: [], nextCursor: null },
    });

    await f.emit({
      method: 'item/completed',
      params: { ...f.params, item: { ...f.item, status: 'completed' } },
    });

    await assert.rejects(f.register(), /already ended/);

    assert.deepEqual(f.familiarEvents(), []);
  } finally {
    await f.session.close();
  }
});

test('a registration renamed after its command ended reports the ended command, as Claude does', async () => {
  const f = await reportedFixture();

  try {
    await f.emit(
      { method: 'item/started', params: { ...f.params, item: f.item } },
      f.output(f.marker),
    );

    assert.equal((await f.register()).kind, 'familiar-registered');

    await f.emit({
      method: 'item/completed',
      params: { ...f.params, item: { ...f.item, status: 'completed' } },
    });

    await assert.rejects(
      f.session.familiar!.report(
        {
          kind: 'familiar-register',
          run: f.run,
          name: 'another review',
          runtime: 'claude',
        },
        Date.now() + 5000,
      ),
      { message: 'The familiar command has already ended.' },
    );
  } finally {
    await f.session.close();
  }
});

test('an approval-first start resolves only its own native handle before admitting the familiar', async () => {
  const f = await reportedFixture();

  try {
    await f.emit(
      {
        method: 'item/started',
        params: {
          ...f.params,
          item: { ...f.item, source: 'agent', processId: null },
        },
      },
      f.output(f.marker),
    );

    assert.equal((await f.register()).kind, 'familiar-pending');

    assert.deepEqual(f.familiarEvents(), []);

    await writeJson(join(f.cwd, 'list-reply-1.json'), {
      result: {
        data: [{ itemId: 'unrelated', processId: '99', command: 'other' }],
        nextCursor: 'second-page',
      },
    });

    await until('second handle page', () =>
      readFile(join(f.cwd, 'list-2.json')).then(
        () => true,
        () => false,
      ),
    );

    assert.deepEqual(
      JSON.parse(await readFile(join(f.cwd, 'list-2.json'), 'utf8')).params,
      { threadId: 'native-thread', cursor: 'second-page' },
    );

    await writeJson(join(f.cwd, 'list-reply-2.json'), {
      result: {
        data: [{ itemId: f.item.id, processId: '73', command: 'review' }],
        nextCursor: null,
      },
    });

    await until(
      'resolved handle admission',
      async () => (await f.register()).kind === 'familiar-registered',
    );

    await f.session.close();

    assert.deepEqual(
      JSON.parse(
        (await readFile(join(f.cwd, 'terminated.jsonl'), 'utf8')).trim(),
      ),
      { threadId: 'native-thread', processId: '73' },
    );
  } finally {
    await f.session.close();
  }
});

test('native handle discovery cannot register after the command ended while its list request was pending', async () => {
  const f = await reportedFixture();

  try {
    await f.emit(
      {
        method: 'item/started',
        params: { ...f.params, item: { ...f.item, processId: null } },
      },
      f.output(f.marker),
    );

    assert.equal((await f.register()).kind, 'familiar-pending');

    await f.emit({
      method: 'item/completed',
      params: { ...f.params, item: { ...f.item, status: 'failed' } },
    });

    await writeJson(join(f.cwd, 'list-reply-1.json'), {
      result: {
        data: [{ itemId: f.item.id, processId: '73', command: 'review' }],
        nextCursor: null,
      },
    });

    await f.session.models();

    await assert.rejects(f.register(), /already ended/);

    assert.deepEqual(f.familiarEvents(), []);
  } finally {
    await f.session.close();
  }
});

test('a late wrapper exit retains the originating turn interruption', async () => {
  const f = await reportedFixture();

  try {
    await f.emit(
      { method: 'item/started', params: { ...f.params, item: f.item } },
      f.output(f.marker),
    );

    await f.register();

    await f.emit({
      method: 'turn/completed',
      params: {
        threadId: f.params.threadId,
        turn: { id: f.params.turnId, status: 'interrupted', error: null },
      },
    });

    await f.emit({
      method: 'item/completed',
      params: {
        ...f.params,
        item: { ...f.item, status: 'failed', exitCode: 130 },
      },
    });

    assert.equal(f.familiarEvents().at(-1)!.status, 'stopped');
  } finally {
    await f.session.close();
  }
});

test('closing a native connection reports stopped even when command completion arrives before cleanup acknowledgment', async () => {
  const f = await reportedFixture();

  let closing: Promise<void> | undefined;

  try {
    await f.emit(
      { method: 'item/started', params: { ...f.params, item: f.item } },
      f.output(f.marker),
    );

    await f.register();

    await writeFile(join(f.cwd, 'hold-termination'), 'yes');

    closing = f.session.close();

    await until('cleanup request', () =>
      readFile(join(f.cwd, 'terminated.jsonl')).then(
        () => true,
        () => false,
      ),
    );

    await f.emit({
      method: 'item/completed',
      params: { ...f.params, item: { ...f.item, status: 'failed' } },
    });

    assert.equal(f.familiarEvents().at(-1)!.status, 'stopped');
  } finally {
    await writeFile(join(f.cwd, 'release-termination'), 'yes');

    await (closing ?? f.session.close());
  }
});

test('a familiar command that exited 0 leaves no cleanup notice when Codex already reaped its terminal', async () => {
  const f = await reportedFixture();

  try {
    await f.emit(
      { method: 'item/started', params: { ...f.params, item: f.item } },
      f.output(f.marker),
    );

    assert.equal((await f.register()).kind, 'familiar-registered');

    await f.session.familiar!.report(
      {
        kind: 'familiar-update',
        run: f.run,
        sequence: 0,
        progress: { status: 'completed' },
      },
      Date.now() + 5000,
    );

    await writeFile(join(f.cwd, 'terminal-gone'), '');

    await f.emit({
      method: 'item/completed',
      params: {
        ...f.params,
        item: { ...f.item, status: 'completed', exitCode: 0 },
      },
    });

    await until(
      'cleanup request',
      async () => (await terminateRequests(f.cwd)).length > 0,
    );

    await f.emit();

    assert.deepEqual(cleanupNotices(f.events), []);

    assert.deepEqual(await terminateRequests(f.cwd), [
      { threadId: 'native-thread', processId: '42' },
    ]);
  } finally {
    await f.session.close();
  }
});

test('a familiar command that ended without a clean exit keeps the cleanup notice', async () => {
  const f = await reportedFixture();

  try {
    await f.emit(
      { method: 'item/started', params: { ...f.params, item: f.item } },
      f.output(f.marker),
    );

    assert.equal((await f.register()).kind, 'familiar-registered');

    await writeFile(join(f.cwd, 'terminal-gone'), '');

    // an evicted terminal whose exit Codex never saw ends this way
    await f.emit({
      method: 'item/completed',
      params: {
        ...f.params,
        item: { ...f.item, status: 'failed', exitCode: -1 },
      },
    });

    await until(
      'cleanup request',
      async () => (await terminateRequests(f.cwd)).length > 0,
    );

    await f.emit();

    assert.equal(f.familiarEvents().at(-1)!.status, 'failed');

    assert.deepEqual(cleanupNotices(f.events), [
      'Witch could not confirm cleanup of plan review: The native terminal was not found; check remaining jobs.',
    ]);
  } finally {
    await f.session.close();
  }
});

test('a familiar command that exits 0 while close is cleaning it up keeps the cleanup notice', async () => {
  const f = await reportedFixture();

  let closing: Promise<void> | undefined;

  try {
    await f.emit(
      { method: 'item/started', params: { ...f.params, item: f.item } },
      f.output(f.marker),
    );

    assert.equal((await f.register()).kind, 'familiar-registered');

    await writeFile(join(f.cwd, 'terminal-gone'), '');

    await writeFile(join(f.cwd, 'hold-termination'), '');

    closing = f.session.close();

    await until(
      'cleanup request',
      async () => (await terminateRequests(f.cwd)).length > 0,
    );

    await f.emit({
      method: 'item/completed',
      params: {
        ...f.params,
        item: { ...f.item, status: 'completed', exitCode: 0 },
      },
    });

    await writeFile(join(f.cwd, 'release-termination'), '');

    await closing;

    assert.equal((await terminateRequests(f.cwd)).length, 1);

    assert.deepEqual(cleanupNotices(f.events), [
      'Witch could not confirm cleanup of plan review: The native terminal was not found; check remaining jobs.',
    ]);
  } finally {
    await writeFile(join(f.cwd, 'release-termination'), '');

    await (closing ?? f.session.close());
  }
});

test('registration transfers an existing brew and leaves an unrelated background command visible', async () => {
  const f = await reportedFixture();

  try {
    await f.emit(
      { method: 'item/started', params: { ...f.params, item: f.item } },
      {
        method: 'item/started',
        params: {
          ...f.params,
          item: { ...f.item, id: 'unrelated', processId: '99' },
        },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: f.params.threadId,
          turn: { id: f.params.turnId, status: 'completed', error: null },
        },
      },
    );

    await until('background list', () =>
      readFile(join(f.cwd, 'list-1.json')).then(
        () => true,
        () => false,
      ),
    );

    await writeJson(join(f.cwd, 'list-reply-1.json'), {
      result: {
        data: [
          { itemId: f.item.id, command: 'review' },
          { itemId: 'unrelated', command: 'server' },
        ],
        nextCursor: null,
      },
    });

    await until(
      'two brews',
      () => f.events.filter((e) => e.type === 'command').length === 2,
    );

    await f.emit(f.output(f.marker));

    await f.register();

    assert.deepEqual(
      f.events.flatMap((e) => (e.type === 'command' ? [e.command] : [])),
      [
        {
          id: 'native-thread/review-command',
          description: 'review',
          status: 'running',
        },
        {
          id: 'native-thread/unrelated',
          description: 'server',
          status: 'running',
        },
        {
          id: 'native-thread/review-command',
          description: 'review',
          status: 'running',
          familiar: `claude-familiar/${f.run}`,
        },
      ],
    );
  } finally {
    await f.session.close();
  }
});

test('one native command registers each familiar whose marker appears in its output', async () => {
  const f = await reportedFixture();

  const second = randomUUID();

  try {
    await f.emit(
      { method: 'item/started', params: { ...f.params, item: f.item } },
      f.output(f.marker),
    );

    assert.equal((await f.register()).kind, 'familiar-registered');

    await f.emit(
      f.output(
        `WITCH_FAMILIAR ${JSON.stringify({ version: 1, conversation: f.binding.conversation, activation: f.binding.activation, run: second })}\n${f.marker}`,
      ),
    );

    assert.equal(
      (
        await f.session.familiar!.report(
          {
            kind: 'familiar-register',
            run: second,
            name: 'second review',
            runtime: 'codex',
          },
          Date.now() + 5000,
        )
      ).kind,
      'familiar-registered',
    );

    await f.emit({
      method: 'item/completed',
      params: { ...f.params, item: { ...f.item, status: 'failed' } },
    });

    await until('targeted cleanup', async () =>
      (
        await readFile(join(f.cwd, 'terminated.jsonl'), 'utf8').catch(() => '')
      ).endsWith('\n'),
    );

    assert.deepEqual(
      (await readFile(join(f.cwd, 'terminated.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown),
      [{ threadId: 'native-thread', processId: '42' }],
    );

    assert.deepEqual(
      f.familiarEvents().map(({ name, status }) => [name, status]),
      [
        ['plan review', 'running'],
        ['second review', 'running'],
        ['plan review', 'failed'],
        ['second review', 'failed'],
      ],
    );
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

test("a Codex session's Codex familiar forwards its requests, which an answer or the familiar's end resolves", async () => {
  const f = await reportedFixture();

  const request = (id: string) => ({
    id,
    kind: 'approval' as const,
    title: 'Create a file',
    detail: 'touch ok.txt',
  });

  const report = (
    action:
      | { kind: 'familiar-request'; request: ReturnType<typeof request> }
      | { kind: 'familiar-request-poll'; id: string },
  ) => f.session.familiar!.report({ ...action, run: f.run }, Date.now() + 5000);

  try {
    await f.emit(
      { method: 'item/started', params: { ...f.params, item: f.item } },
      f.output(f.marker),
    );

    await until(
      'registration',
      async () => (await f.register('codex')).kind === 'familiar-registered',
    );

    assert.equal(f.familiarEvents()[0]!.id, `codex-familiar/${f.run}`);

    assert.equal(f.familiarEvents()[0]!.runtime, 'codex');

    assert.deepEqual(
      await report({ kind: 'familiar-request', request: request('first') }),
      { kind: 'familiar-request-pending' },
    );

    const shown = `familiar/${f.run}/first`;

    assert.ok(
      f.events.some(
        (event) => event.type === 'request' && event.request.id === shown,
      ),
    );

    f.session.respond(shown, { decision: 'accept' });

    assert.deepEqual(
      await report({ kind: 'familiar-request-poll', id: 'first' }),
      {
        kind: 'familiar-response',
        response: { decision: 'accept' },
      },
    );

    await report({ kind: 'familiar-request', request: request('second') });

    await f.emit({
      method: 'item/completed',
      params: {
        ...f.params,
        item: { ...f.item, status: 'completed', exitCode: 0 },
      },
    });

    await until('the pending request resolves with the familiar', () =>
      f.events.some(
        (event) =>
          event.type === 'request-resolved' &&
          event.id === `familiar/${f.run}/second`,
      ),
    );
  } finally {
    await f.session.close();
  }
});
