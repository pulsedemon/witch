import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { CodexAdapter } from '../src/agents/codex.js';
import { boundCommandTitle } from '../src/agents/tool-title.js';
import { Coordinator } from '../src/core/coordinator.js';
import { CoordinationStore } from '../src/persistence/coordination.js';
import { callControl } from '../src/persistence/control.js';
import {
  ConversationStore,
  LockedElsewhere,
} from '../src/persistence/store.js';
import { TurnGate } from './fixtures/agent.js';
import { frameWriter } from './fixtures/claude-adapter.js';
import { coordinationFixture, git } from './fixtures/coordination.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import { record } from './fixtures/coordinator.js';
import { selectionTurn } from './fixtures/task-selection.js';
import { until, within } from './fixtures/within.js';

test('bound tool titles use the delivered prefixes, refresh on reconnect and survive results and reopening', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const f = await coordinationFixture(cleanup);
  const client = await f.start();
  const native = client.a.sessions[0]!;
  native.session.familiar = {
    runtime: 'claude',
    report: async () => ({ kind: 'familiar-registered' }),
  };
  await client.coordinator.send('Read the current bindings');
  const context = client.a.inputs.at(-1)!.context!;
  const control = /^Control command: (.+)$/m.exec(context)?.[1];
  const familiar = /using this familiar prefix: ([^\n]+)/.exec(context)?.[1];
  assert.ok(control);
  assert.ok(familiar);
  const { commandPrefixes } = native.options;
  assert.deepEqual(commandPrefixes, { control, familiar });
  const command = `${control} --claim task:render-title --summary inspect`;
  const title = boundCommandTitle(command, commandPrefixes);
  assert.equal(title?.title, 'claim task:render-title');
  assert.ok(title);
  native.options.onEvent({
    type: 'tool',
    id: 'bound',
    ...title,
    text: 'input',
    done: false,
  });
  native.options.onEvent({
    type: 'tool',
    id: 'bound',
    title: '',
    text: 'claimed',
    done: true,
  });
  await native.session.close();
  await client.coordinator.send('Use the refreshed binding');
  const current = client.a.sessions.at(-1)!.options.commandPrefixes;
  assert.ok(current);
  assert.notEqual(current.control, control);
  assert.equal(boundCommandTitle(command, current), undefined);
  const nextContext = client.a.inputs.at(-1)!.context!;
  assert.equal(
    /^Control command: (.+)$/m.exec(nextContext)?.[1],
    current.control,
  );
  assert.equal(
    boundCommandTitle(`${current.control} --peers --json`, current)?.title,
    'peers',
  );
  await client.coordinator.close();
  const reopened = await f.start('A', { continue: true });
  const row = reopened.coordinator.snapshot.items.find(
    (item) => item.title === 'claim task:render-title',
  );
  assert.equal(row?.expandedTitle, command);
  assert.equal(row?.singleLine, true);
  assert.equal(row?.text, 'claimed');
  assert.equal(row?.done, true);
});

for (const name of ['claude', 'codex'] as const) {
  test(
    name === 'claude'
      ? 'Claude exit stops native activity and permits task release'
      : 'Codex exit after its reply stops its familiar and permits task release',
    async (t) => {
      const cleanup = orderedCleanup(t.onTestFinished);
      const { root, start, registry } = await coordinationFixture(cleanup);
      const cwd = join(root, 'A');
      const executable = fileURLToPath(
        new URL(`fixtures/${name}.mjs`, import.meta.url),
      );
      let child: ChildProcessWithoutNullStreams | undefined;
      const launch = (signal?: AbortSignal) => {
        child = spawn(
          process.execPath,
          [executable, name === 'claude' ? 'background' : 'brews'],
          { cwd, stdio: 'pipe', signal },
        );
        return child;
      };
      const adapter =
        name === 'claude'
          ? new ClaudeAdapter((options) => launch(options.signal))
          : new CodexAdapter((_, __, signal) => launch(signal));
      const { coordinator, claim } = await start('A', {}, [
        { adapter, executable },
      ]);
      let turn: Promise<void> | undefined;
      try {
        assert.equal((await claim('task:native-exit')).kind, 'claimed');
        turn = coordinator.send('initial');
        if (name === 'claude') {
          await until(
            'initial Claude reply',
            () => coordinator.snapshot.skills[0]?.name === 'result-1',
          );
          const emit = frameWriter(
            cwd,
            (name) => coordinator.snapshot.skills[0]?.name === name,
            child!,
          );
          await emit(
            {
              type: 'system',
              subtype: 'task_started',
              task_id: 'helper',
              task_type: 'local_agent',
              description: 'Exit helper',
            },
            {
              type: 'system',
              subtype: 'background_tasks_changed',
              tasks: [
                {
                  task_id: 'helper',
                  task_type: 'local_agent',
                  description: 'Exit helper',
                },
                {
                  task_id: 'brew',
                  task_type: 'local_bash',
                  description: 'Exit brew',
                },
              ],
            },
          );
          assert.equal(coordinator.snapshot.backgroundCommands.length, 1);
        } else {
          await until('Codex turn', () =>
            access(join(cwd, 'turn-1.json')).then(
              () => true,
              () => false,
            ),
          );
          await writeFile(
            join(cwd, 'events.next'),
            JSON.stringify([
              {
                method: 'turn/started',
                params: {
                  threadId: 'child-thread',
                  turn: { id: 'child-turn', status: 'inProgress' },
                },
              },
              {
                method: 'turn/completed',
                params: {
                  threadId: 'native-thread',
                  turn: { id: 'turn-1', status: 'completed', error: null },
                },
              },
            ]),
          );
          await rename(join(cwd, 'events.next'), join(cwd, 'events-1.json'));
          await within(turn, 5000, 'Codex main reply');
        }
        await until('running familiar', () =>
          coordinator.snapshot.subagents.some(
            ({ status }) => status === 'running',
          ),
        );
        assert.equal(coordinator.pentacle.active, true);
        const closed = once(child!, 'close');
        assert.equal(child!.kill('SIGKILL'), true);
        await within(closed, 3000, 'fixture exit');
        await within(turn, 5000, 'settled Witch turn');
        assert.equal(coordinator.snapshot.phase, 'idle');
        assert.equal(coordinator.snapshot.recovery, undefined);
        assert.deepEqual(
          coordinator.snapshot.subagents.map(({ status }) => status),
          ['stopped'],
        );
        assert.deepEqual(coordinator.snapshot.backgroundCommands, []);
        assert.equal(coordinator.pentacle.active, false);
        assert.equal(
          coordinator.snapshot.items.filter(({ title }) =>
            title?.startsWith('Familiar stopped'),
          ).length,
          1,
        );
        assert.equal(
          coordinator.snapshot.items.filter(({ title }) =>
            title?.startsWith('Brew stopped'),
          ).length,
          name === 'claude' ? 1 : 0,
        );
        assert.equal((await registry.claims()).length, 1);
        await coordinator.releaseTask();
        assert.deepEqual(await registry.claims(), []);
      } finally {
        if (child?.exitCode === null && child.signalCode === null) {
          const closed = once(child, 'close');
          child.kill('SIGKILL');
          await within(closed, 3000, 'fixture exit');
        }
        await coordinator.close();
        await Promise.allSettled([turn]);
        assert.ok(child);
        assert.ok(child.exitCode !== null || child.signalCode !== null);
      }
    },
  );
}

test('native closure preserves finished work and ends running activity once', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start } = await coordinationFixture(cleanup);
  const { coordinator, a } = await start();
  const native = a.sessions[0]!;
  for (const [id, status, tools, report] of [
    ['running', 'running', 2, 'Halfway.'],
    ['finished', 'running', 0, ''],
    ['finished', 'completed', 3, 'Done.'],
  ] as const)
    native.options.onEvent({
      type: 'subagent',
      subagent: { id, name: id, kind: 'Explore', status, tools, report },
    });
  native.options.onEvent({
    type: 'command',
    command: { id: 'brew', description: 'Fixture brew', status: 'running' },
  });
  await native.session.close();
  native.options.onEvent({ type: 'closed' });
  assert.deepEqual(
    coordinator.snapshot.subagents.map(({ id, status, tools, report }) => [
      id,
      status,
      tools,
      report,
    ]),
    [
      ['running', 'stopped', 2, 'Halfway.'],
      ['finished', 'completed', 3, 'Done.'],
    ],
  );
  assert.deepEqual(coordinator.snapshot.backgroundCommands, []);
  const endings = () =>
    coordinator.snapshot.items
      .filter(
        ({ title }) =>
          title?.startsWith('Familiar stopped') ||
          title?.startsWith('Brew stopped'),
      )
      .map(({ title, text }) => [title, text]);
  const expected = [
    ['Familiar stopped  running  2 tools', 'Halfway.'],
    ['Brew stopped  Fixture brew', ''],
  ];
  assert.deepEqual(endings(), expected);
  native.options.onEvent({ type: 'closed' });
  assert.deepEqual(endings(), expected);
  await coordinator.send('reconnect');
  assert.equal(a.sessions.length, 2);
  assert.deepEqual(endings(), expected);
});

test('coordination context stays before the exact user request and raw steered spells', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { root, start } = await coordinationFixture(cleanup);
  const a = await start(),
    b = await start('B');
  await b.claim('task:peer', 'Distinct peer task');
  const input = '  /review alpha\n  beta with spaces';
  await a.coordinator.send(input);
  const captured = a.a.inputs[0]!;
  assert.ok(captured.context!.includes('Distinct peer task'));
  assert.ok(captured.context!.includes(join(root, 'B')));
  assert.ok(captured.context!.includes((await a.binding()).activation));
  assert.equal(captured.prompt, input);
  assert.ok(!captured.context!.includes(input));
  assert.deepEqual(captured.skill, {
    name: 'review',
    args: 'alpha\n  beta with spaces',
  });
  const gate = new TurnGate();
  a.a.gate = gate;
  const sending = a.coordinator.send('Start');
  try {
    await within(gate.entered, 5000, 'held turn');
    a.a.replied = true;
    await a.coordinator.send(input);
    assert.deepEqual(a.a.steers, ['/review alpha\n  beta with spaces']);
    assert.deepEqual(a.coordinator.snapshot.queue, []);
  } finally {
    gate.open();
    await sending;
  }
});

for (const name of ['claude', 'codex'] as const) {
  for (const coordinated of [true, false])
    test(`${name} preserves spells across instruction delivery with coordination ${coordinated}`, async (t) => {
      const cleanup = orderedCleanup(t.onTestFinished);
      const { root, start, store, memory } = await coordinationFixture(cleanup);
      const script = fileURLToPath(
        new URL(`fixtures/${name}.mjs`, import.meta.url),
      );
      const adapter =
        name === 'claude'
          ? new ClaudeAdapter((options) =>
              spawn(process.execPath, [script], {
                cwd: join(root, 'A'),
                stdio: 'pipe',
                signal: options.signal,
              }),
            )
          : new CodexAdapter((_, cwd, signal) =>
              spawn(process.execPath, [script], {
                cwd,
                stdio: 'pipe',
                signal,
              }),
            );
      const agents = [{ adapter, executable: name }];
      const a = coordinated ? await start('A', {}, agents) : undefined;
      const coordinator =
        a?.coordinator ?? new Coordinator(store, memory, agents);
      if (!a) {
        cleanup(() => coordinator.close());
        await coordinator.initialize(join(root, 'A'));
      }
      const b = coordinated ? await start('B') : undefined;
      await writeFile(join(root, 'A', 'release'), 'yes');
      let previousTurn: string | undefined;
      for (const [index, summary] of [
        'Peer task 17',
        'Peer task 29',
      ].entries()) {
        await b?.claim('task:peer', summary);
        const prompt = `/review request ${index}\n  exact input`;
        const sending = coordinator.send(prompt);
        if (name === 'codex') {
          await until(
            'fixture approval',
            () => coordinator.snapshot.requests.length > 0,
          );
          await coordinator.respond(coordinator.snapshot.requests[0]!.id, {
            decision: 'accept',
          });
        }
        await sending;
        const json = JSON.parse(
          await readFile(
            join(root, 'A', name === 'claude' ? 'content.json' : 'prompt.json'),
            'utf8',
          ),
        );
        const input = name === 'claude' ? json : json.params.input;
        assert.equal(input[0].type, 'text');
        if (index === 0 || a) {
          const context: string =
            name === 'claude'
              ? input[0].text
              : JSON.parse(
                  await readFile(join(root, 'A', 'context.json'), 'utf8'),
                ).items[0].content[0].text;
          for (const fixed of [
            'You are running inside Witch',
            'Witch rule conflict:',
            'Shared memory directories:',
            'Save only new lasting preferences',
            'Record a temporary execution hold',
            'Put scratch files under',
            ...(a
              ? [
                  'Control command:',
                  'Use --peers',
                  'When asked to choose',
                  'After position 1',
                  'Keep the suggestion reserved',
                  'Before starting a new task',
                  'Delegate work to',
                ]
              : []),
          ])
            assert.equal(context.includes(fixed), index === 0, fixed);
          if (a) {
            assert.ok(context.includes(summary));
            const turn = /^Selection turn: (.+)$/m.exec(context)?.[1];
            assert.ok(turn);
            assert.notEqual(turn, previousTurn);
            previousTurn = turn;
            if (index === 0)
              assert.ok(context.includes((await a.binding()).activation));
          }
          if (name === 'claude')
            assert.ok(input[0].text.endsWith(`User request:\n${prompt}`));
        } else {
          assert.equal(input[0].text, prompt);
          if (name === 'codex')
            await assert.rejects(access(join(root, 'A', 'context.json')), {
              code: 'ENOENT',
            });
        }
        if (name === 'codex') assert.equal(input[0].text, prompt);
        assert.deepEqual(
          input.slice(1),
          name === 'claude'
            ? [{ type: 'text', text: prompt }]
            : [
                {
                  type: 'skill',
                  name: 'review',
                  path: '/skills/review/SKILL.md',
                },
              ],
        );
        if (name === 'codex' && !a && index === 0)
          await rename(
            join(root, 'A', 'context.json'),
            join(root, 'A', 'context-first.json'),
          );
      }
    });
}

test('switch revokes old authority before native close and releases the departed claim', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, ledger, registry } = await coordinationFixture(cleanup);
  const a = await start(),
    b = await start('B');
  await a.claim();
  const claim = (await registry.claims())[0]!,
    bound = await a.binding();
  const before = await ledger();
  const native = a.a.sessions.at(-1)!;
  native.options.onEvent({
    type: 'command',
    command: { id: 'brew', description: 'Work', status: 'running' },
  });
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const close = native.session.close.bind(native.session);
  native.session.close = async () => {
    entered.resolve();
    await finish.promise;
    await close();
  };
  const switching = a.coordinator.newConversation();
  try {
    await within(entered.promise, 5000, 'native close');
    assert.equal(a.coordinator.snapshot.backgroundCommands.length, 0);
    assert.equal(
      (await callControl(bound, { kind: 'release', claim: claim.id })).kind,
      'error',
    );
    assert.equal(await ledger(), before);
    assert.notEqual((await b.claim()).kind, 'claimed');
  } finally {
    finish.resolve();
    await switching;
  }
  assert.notEqual((await a.binding()).activation, bound.activation);
  assert.equal((await b.claim()).kind, 'claimed');
  await a.coordinator.selectConversation(bound.conversation);
  assert.equal((await a.query()).ownClaim, undefined);
  assert.equal(
    (await callControl(bound, { kind: 'release', claim: claim.id })).kind,
    'error',
  );
});

for (const replacement of ['handoff', 'origin', 'rollback'] as const) {
  test(`${replacement} replaces native authority without releasing the conversation's task`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);
    const { root, start, registry, ledger, store } =
      await coordinationFixture(cleanup);
    const a = await start();
    const peer = replacement === 'rollback' ? await start('B') : undefined;
    await a.claim();
    const claim = (await registry.claims())[0]!,
      bound = await a.binding();
    const before = await ledger();
    const native = a.a.sessions.at(-1)!.session;
    const close = native.close.bind(native);
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    native.close = async () => {
      entered.resolve();
      await finish.promise;
      await close();
    };
    if (replacement === 'origin')
      await git(
        '-C',
        join(root, 'A'),
        'remote',
        'set-url',
        'origin',
        join(root, 'other'),
      );
    if (replacement === 'rollback') a.b.failConnect = true;
    const replacing =
      replacement === 'origin'
        ? a.coordinator.send('New scope')
        : a.coordinator.selectModel({ agent: 'b', id: 'b-model' });
    const settled = replacing.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await within(entered.promise, 5000, 'native replacement');
      assert.equal(
        (await callControl(bound, { kind: 'release', claim: claim.id })).kind,
        'error',
      );
      assert.equal(await ledger(), before);
    } finally {
      finish.resolve();
    }
    const error = await settled;
    if (replacement === 'rollback')
      assert.match(String(error), /Destination unavailable/);
    else assert.equal(error, undefined);
    const current = await a.binding();
    assert.notEqual(current.activation, bound.activation);
    assert.equal(current.conversation, bound.conversation);
    assert.equal(
      (await callControl(bound, { kind: 'release', claim: claim.id })).kind,
      'error',
    );
    assert.equal(await ledger(), before);
    if (peer) {
      assert.equal(a.coordinator.snapshot.phase, 'idle');
      assert.equal(a.coordinator.snapshot.conversation!.agent, 'a');
      assert.equal(await store.isOpen(bound.conversation), true);
      assert.deepEqual((await peer.query()).unregistered, []);
      assert.equal(a.a.sessions.length, 1);
      assert.deepEqual(a.a.inputs, []);
      assert.deepEqual(a.b.inputs, []);
      assert.equal((await peer.claim('task:independent')).kind, 'claimed');
      assert.deepEqual((await a.query()).ownClaim, claim);
    }
    if (replacement !== 'origin')
      await a.coordinator.send('Check current prefix');
    const active = replacement === 'handoff' ? a.b : a.a;
    assert.ok(active.inputs.at(-1)!.context!.includes(current.activation));
    if (replacement === 'rollback')
      assert.equal(active.inputs.at(-1)!.session, native.info.id);
    await a.coordinator.send('Reuse current prefix');
    assert.doesNotMatch(active.inputs.at(-1)!.context!, /Control command:/);
  });
}

test('an interrupted handoff summary restores registration before source resume', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, store } = await coordinationFixture(cleanup);
  const a = await start(),
    peer = await start('B');
  await a.coordinator.send('Seed source history');
  assert.equal((await a.claim('task:source')).kind, 'claimed');
  const claim = (await a.query()).ownClaim!,
    bound = await a.binding(),
    source = a.a.sessions.at(-1)!.session.info.id;
  const gate = new TurnGate();
  a.a.gate = gate;
  const switching = a.coordinator.selectModel({ agent: 'b', id: 'b-model' });
  const rejected = assert.rejects(switching, /interrupted/);
  try {
    await within(gate.entered, 5000, 'handoff summary');
    const inputs = a.a.inputs.length;
    await a.coordinator.interrupt();
    await rejected;
    assert.equal(a.coordinator.snapshot.phase, 'idle');
    assert.equal(a.coordinator.snapshot.conversation!.agent, 'a');
    assert.equal(await store.isOpen(bound.conversation), true);
    assert.deepEqual((await peer.query()).unregistered, []);
    const current = await a.binding();
    assert.notEqual(current.activation, bound.activation);
    assert.equal(current.conversation, bound.conversation);
    assert.equal(
      (await callControl(bound, { kind: 'release', claim: claim.id })).kind,
      'error',
    );
    assert.deepEqual((await a.query()).ownClaim, claim);
    assert.equal(a.a.sessions.length, 1);
    assert.equal(a.a.inputs.length, inputs);
    assert.deepEqual(a.b.inputs, []);
    const choosing = await selectionTurn(cleanup, peer);
    assert.equal((await choosing.select()).position, 1);
    await choosing.finish();
    assert.equal((await peer.claim('task:independent')).kind, 'claimed');
    assert.deepEqual((await a.query()).ownClaim, claim);
    a.a.gate = undefined;
    await a.coordinator.send('Resume source');
    assert.equal(a.a.inputs.at(-1)!.session, source);
    assert.ok(a.a.inputs.at(-1)!.context!.includes(current.activation));
    assert.match(a.a.inputs.at(-1)!.context!, /^Control command:/m);
    assert.ok(!a.a.inputs.at(-1)!.context!.includes(bound.activation));
    await a.coordinator.send('Continue source');
    assert.doesNotMatch(a.a.inputs.at(-1)!.context!, /Control command:/);
  } finally {
    gate.open();
    await switching.catch(() => {});
  }
});

test('closing during a handoff summary does not restore registration', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, store, registry } = await coordinationFixture(cleanup);
  const a = await start(),
    peer = await start('B');
  await a.coordinator.send('Seed source history');
  assert.equal((await a.claim('task:source')).kind, 'claimed');
  const bound = await a.binding();
  const gate = new TurnGate();
  a.a.gate = gate;
  const switching = a.coordinator.selectModel({ agent: 'b', id: 'b-model' });
  const rejected = assert.rejects(switching, /interrupted/);
  try {
    await within(gate.entered, 5000, 'handoff summary');
    await a.coordinator.close();
    await rejected;
    assert.equal(
      (await registry.presences()).some(
        (entry) => entry.id === bound.conversation,
      ),
      false,
    );
    assert.equal(
      (await registry.activeActivations([bound.activation])).has(
        bound.activation,
      ),
      false,
    );
    assert.equal(
      (await registry.claims()).some(
        (entry) => entry.owner.conversation === bound.conversation,
      ),
      false,
    );
    const acquired = await store.claim(bound.conversation);
    await acquired.close();
    assert.equal((await peer.claim('task:independent')).kind, 'claimed');
  } finally {
    gate.open();
    await switching.catch(() => {});
  }
});

test('reopening starts without a claim and old authority cannot release newly claimed work', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start } = await coordinationFixture(cleanup);
  const a = await start();
  await a.claim();
  const before = (await a.query()).ownClaim!,
    bound = await a.binding();
  await a.coordinator.close();
  const reopened = await start('A', { conversation: bound.conversation });
  const current = await reopened.binding();
  assert.notEqual(current.activation, bound.activation);
  assert.equal((await reopened.query()).ownClaim, undefined);
  const next = await reopened.claim();
  if (next.kind !== 'claimed') assert.fail(JSON.stringify(next));
  assert.notEqual(next.claim.id, before.id);
  const stale = await callControl(
    { ...bound, directory: current.directory },
    { kind: 'release', claim: next.claim.id },
  );
  assert.equal(stale.kind, 'error');
  assert.deepEqual((await reopened.query()).ownClaim, next.claim);
});

test('target lock and preparation failures keep source authority and free a prepared target lock', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { root, start, store } = await coordinationFixture(cleanup);
  const a = await start(),
    bound = await a.binding();
  const target = await store.create(record(randomUUID(), join(root, 'A')));
  try {
    await assert.rejects(
      a.coordinator.selectConversation(target.record.id),
      LockedElsewhere,
    );
    assert.equal((await callControl(bound, { kind: 'peers' })).kind, 'peers');
  } finally {
    await target.close();
  }
  const items = ConversationStore.prototype.items;
  vi.spyOn(ConversationStore.prototype, 'items').mockImplementation(function (
    this: ConversationStore,
  ) {
    return this.record.id === target.record.id
      ? Promise.reject(new Error('target history unreadable'))
      : items.call(this);
  });
  await assert.rejects(
    a.coordinator.selectConversation(target.record.id),
    /target history unreadable/,
  );
  assert.equal((await callControl(bound, { kind: 'peers' })).kind, 'peers');
  const acquired = await store.claim(target.record.id);
  await acquired.close();
  await a.coordinator.send('Source still usable');
  assert.equal(a.a.sessions.length, 1);
  assert.ok(a.a.inputs.at(-1)!.context!.includes(bound.activation));
});

for (const boundary of ['write', 'remove'] as const) {
  for (const preparation of ['ordinary', 'delayed'] as const) {
    test(`a failed source presence ${boundary} still revokes authority and adopts the prepared target (${preparation} preparation)`, async (t) => {
      const cleanup = orderedCleanup(t.onTestFinished);
      const { start, store, registry } = await coordinationFixture(cleanup);
      const a = await start(),
        bound = await a.binding();
      const entered = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<void>(),
        starting = Promise.withResolvers<void>();
      const publish = CoordinationStore.prototype.publish;
      let writes = 0;
      let writesAtRemoval: number | undefined;
      vi.spyOn(CoordinationStore.prototype, 'publish').mockImplementation(
        async function (
          this: CoordinationStore,
          presence: Parameters<typeof publish>[0],
        ) {
          if (presence.activation === bound.activation) {
            writes++;
            if (presence.phase === 'starting' && presence.requests === 1)
              starting.resolve();
            entered.resolve();
            await finish.promise;
            if (boundary === 'write') throw new Error('presence flush failed');
          }
          return publish.call(this, presence);
        },
      );
      const remove = CoordinationStore.prototype.removePresence;
      vi.spyOn(
        CoordinationStore.prototype,
        'removePresence',
      ).mockImplementation(function (
        this: CoordinationStore,
        id: string,
        activation: string,
      ) {
        if (activation === bound.activation) {
          writesAtRemoval = writes;
          if (boundary === 'remove')
            return Promise.reject(new Error('presence removal failed'));
        }
        return remove.call(this, id, activation);
      });
      if (preparation === 'delayed') {
        const create = store.create.bind(store);
        vi.spyOn(store, 'create').mockImplementation(
          async (...args: Parameters<typeof create>) => {
            await within(starting.promise, 5000, 'starting presence');
            return create(...args);
          },
        );
      }
      let switching: Promise<void> | undefined;
      try {
        a.a.sessions.at(-1)!.options.onEvent({
          type: 'request',
          request: { id: 'q', kind: 'approval', title: 'Wait', detail: '' },
        });
        await within(entered.promise, 5000, 'old writer');
        switching = a.coordinator.newConversation();
        finish.resolve();
        await switching;
        const current = await a.binding();
        assert.notEqual(current.conversation, bound.conversation);
        assert.equal(
          (await callControl(bound, { kind: 'peers' })).kind,
          'error',
        );
        assert.equal(
          (await callControl(current, { kind: 'peers' })).kind,
          'peers',
        );
        assert.match(
          a.coordinator.snapshot.error ?? '',
          boundary === 'write'
            ? /presence flush failed/
            : /presence removal failed/,
        );
        const old = await store.claim(bound.conversation);
        await old.close();
        assert.equal(writes, writesAtRemoval);
        assert.ok(
          (await registry.presences()).some(
            (p) => p.activation === current.activation,
          ),
        );
      } finally {
        finish.resolve();
        starting.resolve();
        await switching?.catch(() => {});
      }
    });
  }
}

test('failed target activation holds its selected lock without starting native work and retries with fresh authority', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, store, registry } = await coordinationFixture(cleanup);
  const a = await start(),
    bound = await a.binding();
  await a.claim();
  const publish = CoordinationStore.prototype.publish;
  let failing = true,
    rejected = '';
  vi.spyOn(CoordinationStore.prototype, 'publish').mockImplementation(
    async function (
      this: CoordinationStore,
      presence: Parameters<typeof publish>[0],
    ) {
      await publish.call(this, presence);
      if (failing && presence.id !== bound.conversation) {
        rejected = presence.activation;
        throw new Error('target presence failed');
      }
    },
  );
  await assert.rejects(
    a.coordinator.newConversation(),
    /target presence failed/,
  );
  const target = a.coordinator.snapshot.conversation!.id;
  assert.notEqual(target, bound.conversation);
  assert.equal(a.a.sessions.length, 1);
  assert.equal((await callControl(bound, { kind: 'peers' })).kind, 'error');
  assert.equal(
    (
      await callControl(
        { ...bound, conversation: target, activation: rejected },
        { kind: 'peers' },
      )
    ).kind,
    'error',
  );
  assert.deepEqual(await registry.presences(), []);
  assert.equal(
    (await registry.activeActivations([rejected])).has(rejected),
    false,
  );
  assert.equal(a.coordination.snapshot.ownClaim, undefined);
  assert.deepEqual(await registry.claims(), []);
  const source = await store.claim(bound.conversation);
  await source.close();
  await assert.rejects(store.claim(target), LockedElsewhere);
  failing = false;
  await a.coordinator.send('Retry activation');
  assert.notEqual((await a.binding()).activation, rejected);
  assert.equal(a.a.sessions.length, 2);
  await a.coordinator.close();
  const released = await store.claim(target);
  await released.close();
});

test('compaction publishes a running presence and refuses a held native turn', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start } = await coordinationFixture(cleanup);
  const a = await start(),
    b = await start('B');
  await a.coordinator.send('seed');
  const gate = new TurnGate();
  a.a.gate = gate;
  const compact = a.coordinator.compact();
  try {
    await within(gate.entered, 3000, 'native compaction');
    assert.equal(a.coordinator.snapshot.phase, 'compacting');
    await until(
      'compatible presence',
      async () => (await b.query()).peers[0]?.presence.phase === 'running',
    );
  } finally {
    gate.open();
    await compact;
  }
  a.a.gate = new TurnGate();
  const sending = a.coordinator.send('held turn');
  try {
    await within(a.a.gate.entered, 3000, 'held native turn');
    a.a.replied = true;
    await assert.rejects(a.coordinator.compact(), /familiars or workflows/);
    assert.equal(a.a.compactions.length, 1);
  } finally {
    a.a.gate.open();
    await sending;
  }
});
