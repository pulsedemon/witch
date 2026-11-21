import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test, vi } from 'vitest';
import { EvidenceJournal, field } from '../../scripts/background-exhaustion.js';
import type { Expectation } from '../../scripts/background-exhaustion.js';
import {
  main,
  checkCapacity,
  releaseTrigger,
  runCase,
  scenarioHelper,
  waitForEvidenceFile,
} from '../../scripts/check-background-exhaustion.js';
import { ClaudeAdapter } from '../../src/agents/claude/adapter.js';
import { CodexAdapter } from '../../src/agents/codex/adapter.js';
import * as nativeProfile from '../../src/agents/updates/native-verification-profile.js';
import { FixtureAgent } from '../fixtures/agent.js';
import { initialSnapshot } from '../../src/core/snapshot.js';
import { createConversation } from '../../src/core/state.js';
import { identifyProcess, runs } from '../../src/persistence/process.js';
import { quote } from '../../src/shell.js';
import { scratch } from '../fixtures/scratch.js';

const execute = promisify(execFile);

type Observation = Parameters<EvidenceJournal['record']>[0];

const token = 'independent-report-content';
const command = 'node helper.mjs familiar-0';

const claim = {
  id: 'claim-a',
  conversation: 'conversation-a',
  references: ['task:check'],
};

const expected: Expectation = {
  marker: 'SETUP_MARKER',
  queued: 'unique queued request',
  reply: 'QUEUED_DONE',
  refusalModel: 'claude-fable-5-2',
  withBrew: false,
};

function capacityFixture() {
  const source = new FixtureAgent('claude');
  const destination = new FixtureAgent('codex');

  source.catalog.splice(
    0,
    Infinity,
    ...['haiku', 'fable'].map((id) => ({ id, label: id, efforts: [] })),
  );

  source.latest = async () => ({
    haiku: 'claude-haiku-5-5',
    fable: 'claude-fable-5-2',
  });

  source.accountReading = {
    limits: [{ window: '7D', percent: 25, observedAt: Date.now() }],
    modelLimits: [
      { window: '7D', model: 'Fable', percent: 100, observedAt: Date.now() },
    ],
  };

  destination.catalog.splice(0, Infinity, {
    id: 'gpt-6-astra',
    label: 'Astra',
    efforts: [],
  });

  destination.accountReading = {
    limits: [{ window: '7D', percent: 40, observedAt: Date.now() }],
  };

  return {
    source,
    destination,
    agents: [
      { adapter: source, executable: 'fixture-claude' },
      { adapter: destination, executable: 'fixture-codex' },
    ],
  };
}

function timeline(withBrew = false): Observation[] {
  const entries: Observation[] = [];

  const source = (
    message: unknown,
    direction: 'client' | 'server' = 'server',
  ) =>
    entries.push({
      kind: 'wire',
      runtime: 'claude',
      process: 11,
      frame: { direction, message },
    });

  const destination = (
    message: unknown,
    direction: 'client' | 'server' = 'server',
  ) =>
    entries.push({
      kind: 'wire',
      runtime: 'codex',
      process: 22,
      frame: { direction, message },
    });

  const fact = (name: string, value: unknown) =>
    entries.push({ kind: 'fact', name, value });

  fact('claim-before', claim);
  fact('original', { prompt: expected.marker, commands: [command] });

  source(
    {
      type: 'user',
      uuid: 'input-a',
      message: { content: [{ type: 'text', text: expected.marker }] },
    },
    'client',
  );

  source({
    type: 'command_lifecycle',
    command_uuid: 'input-a',
    state: 'started',
    session_id: 'source-a',
  });

  fact('token', { value: token });

  source({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'Bash', id: 'tool-a', input: { command } },
      ],
    },
  });

  source({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-a',
    run_id: 'task-run',
    tool_use_id: 'tool-a',
    is_backgrounded: true,
    session_id: 'source-a',
  });

  if (withBrew) {
    fact('budget-ready', { command: 'node helper budget' });

    source({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            id: 'tool-budget',
            input: { command: 'node helper budget' },
          },
        ],
      },
    });

    source({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-budget',
      run_id: 'budget-run',
      tool_use_id: 'tool-budget',
      is_backgrounded: true,
      session_id: 'source-a',
    });
  }

  source({
    type: 'result',
    subtype: 'success',
    is_error: false,
    user_message_uuids: ['input-a'],
    session_id: 'source-a',
  });

  source({
    type: 'command_lifecycle',
    command_uuid: 'input-a',
    state: 'completed',
    session_id: 'source-a',
  });

  source({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'idle',
    session_id: 'source-a',
  });

  entries.push({
    kind: 'event',
    runtime: 'claude',
    session: 'source-a',
    event: {
      type: 'subagent',
      subagent: {
        id: 'familiar-a',
        name: 'familiar',
        kind: 'check',
        status: 'completed',
        run: 'familiar-run',
        report: token,
      },
    },
  });

  source({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-a',
    run_id: 'task-run',
    status: 'completed',
    session_id: 'source-a',
  });

  source({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'running',
    session_id: 'source-a',
  });

  source({
    type: 'result',
    subtype: 'success',
    is_error: false,
    user_message_uuids: [],
    session_id: 'source-a',
  });

  source({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'idle',
    session_id: 'source-a',
  });

  fact('report', {
    run: 'familiar-run',
    command,
    text: token,
    code: 0,
    signal: null,
  });

  source(
    {
      type: 'control_request',
      request_id: 'model-a',
      request: { subtype: 'set_model', model: expected.refusalModel },
    },
    'client',
  );

  source({
    type: 'control_response',
    response: { request_id: 'model-a', subtype: 'success', response: {} },
  });

  fact('selected', {
    model: expected.refusalModel,
    persisted: expected.refusalModel,
  });

  fact('trigger', true);

  source({
    type: 'result',
    is_error: true,
    user_message_uuids: [],
    session_id: 'source-a',
  });

  entries.push({
    kind: 'event',
    runtime: 'claude',
    session: 'source-a',
    event: { type: 'exhausted' },
  });

  fact('queued', true);

  source({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'idle',
    session_id: 'source-a',
  });

  if (withBrew) {
    fact('brew-held', true);
    fact('budget-done', { code: 0, natural: true });

    source({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-budget',
      run_id: 'budget-run',
      status: 'completed',
      session_id: 'source-a',
    });
  }

  fact('snapshot', {
    conversation: { agent: 'claude' },
    nativeRunning: false,
    backgroundCommands: [],
    subagents: [],
  });

  destination(
    { id: 0, method: 'thread/start', params: { model: 'gpt-6-astra' } },
    'client',
  );

  destination({ id: 0, result: { thread: { id: 'destination-a' } } });
  fact('admission', { ...claim, sourceOutcome: 'completed' });

  destination(
    {
      id: 1,
      method: 'thread/inject_items',
      params: {
        threadId: 'destination-a',
        items: [
          {
            content: [
              { type: 'input_text', text: expected.marker + ' ' + token },
            ],
          },
        ],
      },
    },
    'client',
  );

  destination({ id: 1, result: {} });

  destination(
    {
      id: 2,
      method: 'turn/start',
      params: {
        threadId: 'destination-a',
        input: [
          { type: 'text', text: 'Continue the task described by handoff' },
        ],
      },
    },
    'client',
  );

  destination({ id: 2, result: { turn: { id: 'turn-a' } } });

  destination({
    method: 'turn/completed',
    params: {
      threadId: 'destination-a',
      turn: {
        id: 'turn-a',
        status: 'completed',
        items: [{ type: 'agentMessage', text: 'CONTINUED ' + token }],
      },
    },
  });

  destination(
    {
      id: 3,
      method: 'turn/start',
      params: {
        threadId: 'destination-a',
        input: [{ type: 'text', text: expected.queued }],
      },
    },
    'client',
  );

  destination({ id: 3, result: { turn: { id: 'turn-b' } } });

  destination({
    method: 'turn/completed',
    params: {
      threadId: 'destination-a',
      turn: {
        id: 'turn-b',
        status: 'completed',
        items: [{ type: 'agentMessage', text: expected.reply }],
      },
    },
  });

  fact('claim-after', claim);
  fact('cleanup', true);

  return entries;
}

function record(entries: Observation[]): EvidenceJournal {
  const journal = new EvidenceJournal();

  for (const entry of entries) journal.record(entry);

  return journal;
}

for (const withBrew of [false, true])
  test(`the ${withBrew ? 'with-brew' : 'no-brew'} verdict requires acknowledged context injection, token consumption and a later queue reply`, () => {
    const result = record(timeline(withBrew)).finish({ ...expected, withBrew });
    assert.equal(result.status, 'passed');

    assert.ok(
      result.conditions.every(
        (condition) =>
          condition.status === 'verified' && condition.evidence.length > 0,
      ),
    );
  });

test('an already-recorded input acknowledgement wakes a waiter without another frame', async () => {
  const entries = timeline();

  const started = entries.findIndex(
    (entry) =>
      entry.kind === 'wire' &&
      field(entry.frame.message, 'type') === 'command_lifecycle' &&
      field(entry.frame.message, 'state') === 'started',
  );

  const journal = record(entries.slice(0, started + 1));

  await journal.waitFor(
    'accepted input',
    () => !!journal.accepted(expected.marker),
    AbortSignal.timeout(1000),
  );

  assert.equal(journal.accepted(expected.marker)!.uuid, 'input-a');
});

test('snapshot evidence retains settlement when the live conversation later changes runtimes', () => {
  const journal = new EvidenceJournal();

  const snapshot = {
    conversation: { agent: 'claude' },
    nativeRunning: false,
    backgroundCommands: [],
    subagents: [],
  };

  journal.fact('snapshot', snapshot);
  snapshot.conversation.agent = 'codex';
  assert.equal(journal.settlement(0)?.sequence, 1);
});

test('a cleared snapshot without native background idle remains unverified', () => {
  const entries = timeline();

  const trigger = entries.findIndex(
    (entry) => entry.kind === 'fact' && entry.name === 'trigger',
  );

  const missingIdle = entries.filter(
    (entry, index) =>
      !(
        index > trigger &&
        entry.kind === 'wire' &&
        entry.runtime === 'claude' &&
        field(entry.frame.message, 'state') === 'idle'
      ),
  );

  assert.equal(record(missingIdle).finish(expected).status, 'incomplete');
});

test('starting the destination before native settlement is a failed relationship', () => {
  const entries = timeline();

  const connection = entries.find(
    (entry) =>
      entry.kind === 'wire' &&
      field(entry.frame.message, 'method') === 'thread/start',
  )!;

  const reordered = entries.filter((entry) => entry !== connection);

  const queued = reordered.findIndex(
    (entry) => entry.kind === 'fact' && entry.name === 'queued',
  );

  reordered.splice(queued + 1, 0, connection);
  assert.equal(record(reordered).finish(expected).status, 'failed');
});

test('idle before a report notification cannot settle the later native follow-up', () => {
  const entries = timeline().filter(
    (entry) =>
      entry.kind !== 'wire' ||
      field(entry.frame.message, 'subtype') !== 'task_notification',
  );

  const journal = record(entries);
  assert.equal(journal.followup(journal.task(command)!, 0), undefined);
  assert.equal(journal.finish(expected).status, 'incomplete');
});

for (const change of ['session', 'input'] as const)
  test(`an ordinary result from another ${change} cannot satisfy the completion barrier`, () => {
    const entries = timeline();

    const result = entries.find(
      (entry) =>
        entry.kind === 'wire' &&
        field(entry.frame.message, 'type') === 'result',
    )!;

    assert.equal(result.kind, 'wire');

    if (result.kind === 'wire')
      result.frame.message = {
        ...(result.frame.message as Record<string, unknown>),
        ...(change === 'session'
          ? { session_id: 'different-source' }
          : { user_message_uuids: ['different-input'] }),
      };

    assert.equal(record(entries).ordinary(expected.marker), undefined);
  });

test('refused model selection remains blocked rather than fabricating background acceptance', () => {
  const entries = timeline();

  const refusal = entries.findIndex(
    (entry) =>
      entry.kind === 'wire' &&
      field(entry.frame.message, 'response', 'request_id') === 'model-a',
  );

  const journal = record(entries.slice(0, refusal));

  journal.record({
    kind: 'wire',
    runtime: 'claude',
    process: 11,
    frame: {
      direction: 'server',
      message: {
        type: 'control_response',
        response: {
          request_id: 'model-a',
          subtype: 'error',
          error: 'model not changed',
        },
      },
    },
  });

  journal.fact('stop', {
    status: 'blocked',
    reason: 'native-model-change-refused',
  });

  journal.fact('cleanup', true);
  assert.equal(journal.finish(expected).status, 'blocked');
});

test('a 429 without the production exhaustion event cannot pass acceptance', () => {
  const entries = timeline().filter(
    (entry) => !(entry.kind === 'event' && entry.event.type === 'exhausted'),
  );

  const result = record(entries).finish(expected);
  assert.equal(result.status, 'incomplete');

  assert.equal(
    result.conditions.find(
      (condition) => condition.name === 'confirmed native background refusal',
    )!.status,
    'unverified',
  );
});

for (const change of [
  'unacknowledged',
  'other-thread',
  'missing-token-answer',
] as const)
  test(`${change} destination evidence cannot prove report consumption`, () => {
    const entries = timeline().filter(
      (entry) =>
        !(
          change === 'unacknowledged' &&
          entry.kind === 'wire' &&
          entry.runtime === 'codex' &&
          entry.frame.direction === 'server' &&
          field(entry.frame.message, 'id') === 1
        ),
    );

    if (change !== 'unacknowledged') {
      const target = entries.find(
        (entry) =>
          entry.kind === 'wire' &&
          entry.runtime === 'codex' &&
          field(entry.frame.message, 'method') ===
            (change === 'other-thread'
              ? 'thread/inject_items'
              : 'turn/completed'),
      )!;

      assert.equal(target.kind, 'wire');

      if (target.kind === 'wire')
        target.frame.message =
          change === 'other-thread'
            ? {
                id: 1,
                method: 'thread/inject_items',
                params: {
                  threadId: 'different-thread',
                  items: [
                    {
                      content: [
                        {
                          type: 'input_text',
                          text: expected.marker + ' ' + token,
                        },
                      ],
                    },
                  ],
                },
              }
            : {
                method: 'turn/completed',
                params: {
                  threadId: 'destination-a',
                  turn: {
                    id: 'turn-a',
                    status: 'completed',
                    items: [
                      {
                        type: 'agentMessage',
                        text: 'CONTINUED without a report',
                      },
                    ],
                  },
                },
              };
    }

    assert.equal(
      record(entries).finish(expected).status,
      change === 'other-thread' ? 'failed' : 'incomplete',
    );
  });

test('duplicate queue delivery and source-side delivery are both failed relationships', () => {
  for (const source of [false, true]) {
    const entries = timeline();

    const queued = entries.find(
      (entry) =>
        entry.kind === 'wire' &&
        entry.runtime === 'codex' &&
        entry.frame.direction === 'client' &&
        field(entry.frame.message, 'id') === 3,
    )!;

    entries.push(
      source
        ? {
            kind: 'wire',
            runtime: 'claude',
            process: 11,
            frame: {
              direction: 'client',
              message: {
                type: 'user',
                uuid: 'unwanted-source-input',
                message: { content: [{ type: 'text', text: expected.queued }] },
              },
            },
          }
        : queued,
    );

    assert.equal(record(entries).finish(expected).status, 'failed');
  }
});

for (const delivery of ['continuation', 'steer'] as const)
  test(`queued input in ${delivery} cannot pass beside its later ordinary turn`, () => {
    const entries = timeline();

    const continuation = entries.find(
      (entry) =>
        entry.kind === 'wire' &&
        entry.runtime === 'codex' &&
        entry.frame.direction === 'client' &&
        field(entry.frame.message, 'id') === 2,
    )!;

    if (delivery === 'continuation' && continuation.kind === 'wire')
      continuation.frame.message = {
        id: 2,
        method: 'turn/start',
        params: {
          threadId: 'destination-a',
          input: [
            {
              type: 'text',
              text:
                'Continue the task described by handoff\n' + expected.queued,
            },
          ],
        },
      };
    else {
      const completed = entries.findIndex(
        (entry) =>
          entry.kind === 'wire' &&
          field(entry.frame.message, 'method') === 'turn/completed',
      );

      entries.splice(
        completed,
        0,
        {
          kind: 'wire',
          runtime: 'codex',
          process: 22,
          frame: {
            direction: 'client',
            message: {
              id: 4,
              method: 'turn/steer',
              params: {
                threadId: 'destination-a',
                expectedTurnId: 'turn-a',
                input: [{ type: 'text', text: expected.queued }],
              },
            },
          },
        },
        {
          kind: 'wire',
          runtime: 'codex',
          process: 22,
          frame: {
            direction: 'server',
            message: { id: 4, result: { turnId: 'turn-a' } },
          },
        },
      );
    }

    const result = record(entries).finish(expected);
    assert.equal(result.status, 'failed');

    assert.equal(
      result.conditions.find(
        (condition) =>
          condition.name ===
          'queued prompt completes once after continuation, never on source',
      )!.status,
      'failed',
    );
  });

test('a budget brew stopped during teardown cannot qualify as natural settlement', () => {
  const entries = timeline(true).filter(
    (entry) =>
      !(
        entry.kind === 'wire' &&
        field(entry.frame.message, 'subtype') === 'task_notification' &&
        field(entry.frame.message, 'task_id') === 'task-budget'
      ),
  );

  assert.equal(
    record(entries).finish({ ...expected, withBrew: true }).status,
    'incomplete',
  );
});

test('native budget completion after destination answers cannot qualify earlier settlement', () => {
  const entries = timeline(true);

  const late = entries.filter(
    (entry) =>
      (entry.kind === 'fact' && entry.name === 'budget-done') ||
      (entry.kind === 'wire' &&
        field(entry.frame.message, 'subtype') === 'task_notification' &&
        field(entry.frame.message, 'task_id') === 'task-budget'),
  );

  const reordered = entries.filter((entry) => !late.includes(entry));

  const cleanup = reordered.findIndex(
    (entry) => entry.kind === 'fact' && entry.name === 'cleanup',
  );

  reordered.splice(cleanup, 0, ...late);
  const result = record(reordered).finish({ ...expected, withBrew: true });
  assert.equal(result.status, 'failed');

  assert.equal(
    result.conditions.find(
      (condition) =>
        condition.name ===
        'independent brew delays switching and exits naturally',
    )!.status,
    'failed',
  );
});

test('the claim must remain owned at continuation admission as well as at the end', () => {
  const entries = timeline();

  const admission = entries.find(
    (entry) => entry.kind === 'fact' && entry.name === 'admission',
  )!;

  if (admission.kind === 'fact')
    admission.value = {
      ...claim,
      id: 'different-claim',
      sourceOutcome: 'completed',
    };

  assert.equal(record(entries).finish(expected).status, 'failed');
});

test('file barriers return persisted records and block approvals arriving while they wait', async () => {
  const directory = await scratch('witch-exhaustion-files-');
  const snapshot = initialSnapshot([]);
  const persisted = join(directory, 'completed.json');
  await writeFile(persisted, JSON.stringify({ code: 0, natural: true }));

  assert.deepEqual(
    await waitForEvidenceFile(
      persisted,
      () => snapshot,
      AbortSignal.timeout(1000),
    ),
    { code: 0, natural: true },
  );

  const waiting = waitForEvidenceFile(
    join(directory, 'missing-report.json'),
    () => snapshot,
    AbortSignal.timeout(1000),
  );

  queueMicrotask(() => {
    snapshot.requests = [
      {
        id: 'native-approval',
        kind: 'approval',
        title: 'Run the synthetic gate',
        detail: 'Native permission is required.',
      },
    ];
  });

  await assert.rejects(
    waiting,
    (error: unknown) =>
      field(error, 'status') === 'blocked' &&
      field(error, 'reason') === 'native-permission-required',
  );
});

test('private prompt, native error and environment fields stay out of the result', () => {
  const journal = record(timeline());

  journal.fact('error', {
    credential: 'private-key-value',
    prompt: 'private-user-prose',
  });

  journal.fact('environment', { HOME: '/private-personal-directory' });
  const serialized = JSON.stringify(journal.finish(expected));
  assert.equal(journal.finish(expected).status, 'passed');

  for (const value of [
    'private-key-value',
    'private-user-prose',
    '/private-personal-directory',
  ])
    assert.ok(!serialized.includes(value));
});

test('unverified cleanup prevents a passing verdict even after every acceptance condition', () => {
  const journal = record(timeline());
  journal.fact('cleanup', false);
  assert.equal(journal.finish(expected).status, 'incomplete');
  assert.equal(journal.finish(expected).reason, 'cleanup-unverified');
});

test('missing consent exits before native discovery and preserves an existing output directory', async () => {
  const directory = await scratch('witch-exhaustion-consent-');
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const launched = join(directory, 'native-launched');

  for (const name of ['claude', 'codex'])
    await writeFile(
      join(bin, name),
      '#!/bin/sh\nprintf launched > ' + quote(launched) + '\nexit 99\n',
      { mode: 0o700 },
    );

  const out = join(directory, 'result');

  const script = fileURLToPath(
    new URL('../../scripts/check-background-exhaustion.ts', import.meta.url),
  );

  await assert.rejects(
    execute(process.execPath, ['--import', 'tsx', script, '--out', out], {
      env: { ...process.env, PATH: bin },
    }),
    (error: unknown) => field(error, 'code') === 2,
  );

  const result = JSON.parse(
    await readFile(join(out, 'result.json'), 'utf8'),
  ) as { reason: string };

  assert.equal(result.reason, 'account-usage-consent-required');
  await assert.rejects(readFile(launched), { code: 'ENOENT' });
  await writeFile(join(out, 'keep.txt'), 'retain this');
  assert.equal(await main(['--out', out]), 2);
  assert.equal(await readFile(join(out, 'keep.txt'), 'utf8'), 'retain this');
});

test('capacity discovery passes native settings to its probes and resolves the destination', async () => {
  const directory = await scratch('witch-exhaustion-catalog-');
  const { source, agents } = capacityFixture();
  const signal = AbortSignal.timeout(1000);
  const journal = new EvidenceJournal();

  await checkCapacity(
    agents,
    {
      refusalModel: 'claude-fable-5-2',
      signal,
    },
    directory,
    journal,
  );

  assert.equal(journal.facts('destination-model')[0]!.value, 'gpt-6-astra');
  assert.equal(source.discoveries[0]!.cwd, directory);
  assert.equal(source.accountReads[0]!.executable, 'fixture-claude');
  assert.equal(source.accountReads[0]!.signal, signal);
});

test('capacity discovery finishes cold profile initialization before the next probe starts', async () => {
  const directory = await scratch('witch-exhaustion-cold-profile-');
  const { destination, agents } = capacityFixture();
  const started = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const models = destination.models.bind(destination);
  let initialized = false;

  destination.models = async (options) => {
    started.resolve();
    await ready.promise;
    const result = await models(options);
    initialized = true;

    return result;
  };

  destination.accountRead = async () => {
    assert.ok(initialized, 'the new native home is still initializing');

    return destination.accountReading;
  };

  const journal = new EvidenceJournal();

  const checking = checkCapacity(
    agents,
    {
      refusalModel: 'claude-fable-5-2',
      signal: AbortSignal.timeout(5000),
    },
    directory,
    journal,
  );

  void checking.catch(() => {});
  await started.promise;
  ready.resolve();
  await checking;
  assert.equal(journal.facts('destination-model')[0]!.value, 'gpt-6-astra');
});

for (const condition of [
  'an unresolved Claude alias',
  'a full source meter',
  'a new job report directory',
])
  test(`${condition} reaches native startup with working job marking`, async () => {
    const directory = await scratch('witch-exhaustion-startup-');
    const { source, destination, agents } = capacityFixture();
    const controller = new AbortController();
    let reported: string | undefined;

    if (condition === 'an unresolved Claude alias')
      source.latest = async () => ({ haiku: 'claude-haiku-5-5' });

    if (condition === 'a full source meter') {
      source.accountReading.limits[0]!.percent = 100;

      source.accountReading.creditAccess = {
        state: 'unavailable',
        observedAt: Date.now(),
      };
    }

    source.beforeConnect = async ({ mark }) => {
      assert.ok(mark?.script);

      const { stdout } = await execute('/bin/sh', [
        '-c',
        '. "$1"; printf "%s" "$WITCH_JOBS"',
        'job-check',
        mark.script,
      ]);

      reported = stdout;
      assert.equal(mark.environment.WITCH_JOBS, reported);
      controller.abort(new Error('Native job marking verified'));
      controller.signal.throwIfAborted();
    };

    const profile = vi
      .spyOn(nativeProfile, 'verificationAdapter')
      .mockImplementation(async (runtime) =>
        runtime === 'claude' ? source : destination,
      );

    try {
      const result = await runCase(
        {
          directory,
          sourceModel: 'claude-haiku-5-5',
          refusalModel: 'claude-fable-5-2',
          withBrew: false,
          signal: controller.signal,
        },
        agents,
        () => {
          throw new Error('Unexpected native process');
        },
      );

      assert.equal(reported, join(directory, 'jobs'));
      assert.equal(result.status, 'incomplete');
      assert.equal(result.cleanup, 'verified');

      const entries = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line));

      assert.equal(
        field(
          entries.find((entry) => field(entry, 'name') === 'destination-model'),
          'value',
        ),
        'gpt-6-astra',
      );
    } finally {
      profile.mockRestore();
    }
  });

test('a routed child uses its configured Codex home instead of inheriting the source home', async () => {
  const directory = await scratch('witch-exhaustion-familiar-home-');
  const source = join(directory, 'claude-home');
  const destination = join(directory, 'codex-home');
  await mkdir(source);
  await mkdir(destination);
  await writeFile(join(destination, 'auth.json'), 'synthetic-token-store');
  const helper = join(directory, 'helper.mjs');
  await writeFile(helper, scenarioHelper);

  await writeFile(
    join(directory, 'familiar-0.launch.json'),
    JSON.stringify({
      command: [
        process.execPath,
        '-e',
        "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(require('node:fs').readFileSync(process.env.CODEX_HOME + '/auth.json', 'utf8')))",
      ],
      prompt: 'synthetic prompt',
      env: { CODEX_HOME: destination },
    }),
  );

  const result = await execute(process.execPath, [helper, 'familiar-0'], {
    cwd: directory,
    env: { ...process.env, CODEX_HOME: source },
  });

  assert.equal(result.stdout, 'synthetic-token-store');

  assert.deepEqual(
    JSON.parse(await readFile(join(directory, 'familiar-0.exit.json'), 'utf8')),
    { code: 0, signal: null },
  );
});

test('a refused or unapplied model change never releases the trigger', async () => {
  for (const refused of [true, false]) {
    const directory = await scratch('witch-exhaustion-model-');
    const snapshot = initialSnapshot([]);

    snapshot.native = {
      id: 'source-a',
      agent: 'claude',
      model: 'healthy',
      permissionMode: 'default',
      hasHistory: true,
    };

    snapshot.conversation = createConversation(directory, 'claude');

    snapshot.conversation.sessions.claude = {
      id: 'source-a',
      model: 'healthy',
      hasHistory: true,
    };

    const coordinator = {
      snapshot,
      selectModel: async () => {
        if (refused) throw new Error('Native model not changed');
      },
    };

    const journal = new EvidenceJournal();

    await assert.rejects(
      releaseTrigger(
        coordinator,
        expected.refusalModel,
        directory,
        journal,
        performance.now() + 1000,
      ),
      new RegExp(
        refused
          ? 'native-model-change-refused'
          : 'native-model-selection-disagrees',
      ),
    );

    await assert.rejects(readFile(join(directory, 'trigger.release')), {
      code: 'ENOENT',
    });

    assert.equal(journal.facts('trigger').length, 0);
  }
});

test('aborting partial native startup retains an incomplete result and joins its owned children', async () => {
  const directory = await scratch('witch-exhaustion-abort-');
  const children: ReturnType<typeof spawn>[] = [];
  const identities: ReturnType<typeof identifyProcess>[] = [];
  const controller = new AbortController();

  const result = await runCase(
    {
      directory,
      sourceModel: 'healthy',
      refusalModel: 'refused',
      withBrew: false,
      signal: controller.signal,
    },
    [
      { adapter: new ClaudeAdapter(), executable: process.execPath },
      { adapter: new CodexAdapter(), executable: process.execPath },
    ],
    (_command, _args, cwd, env, signal) => {
      const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
        cwd,
        env,
        signal,
        stdio: 'pipe',
      });

      children.push(child);
      const identity = identifyProcess(child.pid!);
      identities.push(identity);

      void identity.then(
        () => controller.abort(),
        (error: unknown) => controller.abort(error),
      );

      return child;
    },
  );

  assert.ok(children.length > 0);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.evidence, 'offline');
  assert.equal(result.cleanup, 'verified');

  for (const child of children) {
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  }

  const observed = await Promise.all(identities);
  assert.ok(observed.some(Boolean));

  for (const identity of observed)
    if (identity) assert.equal(await runs(identity), false);

  assert.deepEqual(
    JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')),
    result,
  );
});
