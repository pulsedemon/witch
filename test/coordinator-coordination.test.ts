import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { CodexAdapter } from '../src/agents/codex.js';
import { CoordinationStore } from '../src/persistence/coordination.js';
import { callControl } from '../src/persistence/control.js';
import {
  ConversationStore,
  LockedElsewhere,
} from '../src/persistence/store.js';
import { TurnGate } from './fixtures/agent.js';
import { frameWriter } from './fixtures/claude-adapter.js';
import { coordinationFixture, git } from './fixtures/coordination.js';
import { record } from './fixtures/coordinator.js';
import { selectionTurn } from './fixtures/task-selection.js';
import { until, within } from './fixtures/within.js';

for (const name of ['claude', 'codex'] as const) {
  await test(
    name === 'claude'
      ? 'Claude exit stops native activity and permits task release'
      : 'Codex exit after its reply stops its familiar and permits task release',
    async (t) => {
      const { root, start, registry } = await coordinationFixture(t);
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
        if (child?.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
        await coordinator.close();
        await Promise.allSettled([turn]);
        assert.ok(child);
        assert.ok(child.exitCode !== null || child.signalCode !== null);
      }
    },
  );
}

await test('native closure preserves finished work and ends running activity once', async (t) => {
  const { start } = await coordinationFixture(t);
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

await test('coordination context stays before the exact user request and raw steered spells', async (t) => {
  const { root, start } = await coordinationFixture(t);
  const a = await start(),
    b = await start('B');
  await b.claim('task:peer', 'Distinct peer task');
  const input = '  /review alpha\n  beta with spaces';
  await a.coordinator.send(input);
  const captured = a.a.inputs[0]!;
  assert.ok(captured.prompt.includes('Distinct peer task'));
  assert.ok(captured.prompt.includes(join(root, 'B')));
  assert.ok(captured.prompt.includes((await a.binding()).activation));
  assert.ok(captured.prompt.endsWith(`User request:\n${input}`));
  assert.ok(
    captured.prompt.indexOf('Control command:') <
      captured.prompt.indexOf('User request:'),
  );
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
  await test(`${name} receives the native spell contract with fresh coordination context`, async (t) => {
    const { root, start } = await coordinationFixture(t);
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
    const a = await start('A', {}, [{ adapter, executable: name }]);
    const b = await start('B');
    await b.claim('task:peer', 'Native peer task');
    const prompt = '/review left\n  right with spaces';
    await writeFile(join(root, 'A', 'release'), 'yes');
    const sending = a.coordinator.send(prompt);
    if (name === 'codex') {
      await until(
        'fixture approval',
        () => a.coordinator.snapshot.requests.length > 0,
      );
      await a.coordinator.respond(a.coordinator.snapshot.requests[0]!.id, {
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
    assert.ok(input[0].text.includes('Native peer task'));
    assert.ok(input[0].text.includes((await a.binding()).activation));
    assert.ok(input[0].text.endsWith(`User request:\n${prompt}`));
    assert.deepEqual(
      input.slice(1),
      name === 'claude'
        ? [{ type: 'text', text: prompt }]
        : [{ type: 'skill', name: 'review', path: '/skills/review/SKILL.md' }],
    );
  });
}

await test('switch revokes old authority before native close and releases the departed claim', async (t) => {
  const { start, ledger, registry } = await coordinationFixture(t);
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
  await test(`${replacement} replaces native authority without releasing the conversation's task`, async (t) => {
    const { root, start, registry, ledger, store } =
      await coordinationFixture(t);
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
    await a.coordinator.send('Check current prefix');
    const active = replacement === 'handoff' ? a.b : a.a;
    assert.ok(active.inputs.at(-1)!.prompt.includes(current.activation));
    if (replacement === 'rollback')
      assert.equal(active.inputs.at(-1)!.session, native.info.id);
  });
}

await test('an interrupted handoff summary restores registration before source resume', async (t) => {
  const { start, store } = await coordinationFixture(t);
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
    const choosing = await selectionTurn(t, peer);
    assert.equal((await choosing.select()).position, 1);
    await choosing.finish();
    assert.equal((await peer.claim('task:independent')).kind, 'claimed');
    assert.deepEqual((await a.query()).ownClaim, claim);
    a.a.gate = undefined;
    await a.coordinator.send('Resume source');
    assert.equal(a.a.inputs.at(-1)!.session, source);
    assert.ok(a.a.inputs.at(-1)!.prompt.includes(current.activation));
  } finally {
    gate.open();
    await switching.catch(() => {});
  }
});

await test('closing during a handoff summary does not restore registration', async (t) => {
  const { start, store, registry } = await coordinationFixture(t);
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

await test('reopening starts without a claim and old authority cannot release newly claimed work', async (t) => {
  const { start } = await coordinationFixture(t);
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

await test('target lock and preparation failures keep source authority and free a prepared target lock', async (t) => {
  const { root, start, store } = await coordinationFixture(t);
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
  t.mock.method(
    ConversationStore.prototype,
    'items',
    function (this: ConversationStore) {
      return this.record.id === target.record.id
        ? Promise.reject(new Error('target history unreadable'))
        : items.call(this);
    },
  );
  await assert.rejects(
    a.coordinator.selectConversation(target.record.id),
    /target history unreadable/,
  );
  assert.equal((await callControl(bound, { kind: 'peers' })).kind, 'peers');
  const acquired = await store.claim(target.record.id);
  await acquired.close();
  await a.coordinator.send('Source still usable');
  assert.equal(a.a.sessions.length, 1);
  assert.ok(a.a.inputs.at(-1)!.prompt.includes(bound.activation));
});

for (const boundary of ['write', 'remove'] as const) {
  for (const preparation of ['ordinary', 'delayed'] as const) {
    await test(`a failed source presence ${boundary} still revokes authority and adopts the prepared target (${preparation} preparation)`, async (t) => {
      const { start, store, registry } = await coordinationFixture(t);
      const a = await start(),
        bound = await a.binding();
      const entered = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<void>(),
        starting = Promise.withResolvers<void>();
      const publish = CoordinationStore.prototype.publish;
      let writes = 0;
      let writesAtRemoval: number | undefined;
      t.mock.method(
        CoordinationStore.prototype,
        'publish',
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
      t.mock.method(
        CoordinationStore.prototype,
        'removePresence',
        function (this: CoordinationStore, id: string, activation: string) {
          if (activation === bound.activation) {
            writesAtRemoval = writes;
            if (boundary === 'remove')
              return Promise.reject(new Error('presence removal failed'));
          }
          return remove.call(this, id, activation);
        },
      );
      if (preparation === 'delayed') {
        const create = store.create.bind(store);
        t.mock.method(
          store,
          'create',
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

await test('failed target activation holds its selected lock without starting native work and retries with fresh authority', async (t) => {
  const { start, store, registry } = await coordinationFixture(t);
  const a = await start(),
    bound = await a.binding();
  await a.claim();
  const publish = CoordinationStore.prototype.publish;
  let failing = true,
    rejected = '';
  t.mock.method(
    CoordinationStore.prototype,
    'publish',
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

await test('compaction publishes a running presence and refuses a held native turn', async (t) => {
  const { start } = await coordinationFixture(t);
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
