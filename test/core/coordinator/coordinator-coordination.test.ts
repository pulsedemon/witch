import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import { test, vi } from 'vitest';
import { writeJson } from '../../../src/persistence/json.js';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../../../src/agents/claude/adapter.js';
import { CodexAdapter } from '../../../src/agents/codex/adapter.js';
import { unreportedContextCatalog } from '../../fixtures/codex-adapter.js';
import { boundCommandTitle } from '../../../src/agents/tool-title.js';
import { Coordinator } from '../../../src/core/coordinator.js';
import { Workspace } from '../../../src/memory/workspace.js';
import { callControl } from '../../../src/persistence/control.js';
import { holdConnect, TurnGate } from '../../fixtures/agent.js';
import { frameWriter } from '../../fixtures/claude-adapter.js';
import {
  coordinationFixture,
  unitCoordinationFixture,
} from '../../fixtures/coordination.js';
import { orderedCleanup } from '../../fixtures/cleanup.js';
import { record } from '../../fixtures/coordinator.js';
import { appears, until, within } from '../../fixtures/within.js';

test('a peer joining and leaving updates ongoing work without adding user input', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start } = await unitCoordinationFixture(cleanup);
  const a = await start();
  const gate = new TurnGate();
  a.a.gate = gate;
  const sending = a.coordinator.send('Inspect current exports');

  try {
    await within(gate.entered, 5000, 'solo turn');
    const b = await start('B');
    await a.query();
    await until('required policy', () => a.a.contextSteers.length === 1);
    assert.match(a.a.contextSteers[0]!, /--claim/);

    assert.match(
      a.a.contextSteers[0]!,
      /Claim any unclaimed task already underway/,
    );

    await b.claim('task:peer', 'Peer summary 291');
    await a.query();
    assert.equal(a.a.contextSteers.length, 1);
    assert.doesNotMatch(a.a.contextSteers[0]!, /Peer summary 291/);
    assert.equal((await a.claim('task:exports')).kind, 'claimed');
    await b.coordinator.close();
    await a.query();
    await until('solo policy', () => a.a.contextSteers.length === 2);
    assert.match(a.a.contextSteers[1]!, /New work needs no claim/);
    assert.match(a.a.contextSteers[1]!, /--release/);
    assert.deepEqual(a.a.steers, []);
    assert.deepEqual(a.coordinator.snapshot.queue, []);
    assert.equal(a.a.inputs.length, 1);

    assert.deepEqual(
      a.coordinator.snapshot.items
        .filter(({ kind }) => kind === 'user')
        .map(({ text }) => text),
      ['Inspect current exports'],
    );
  } finally {
    gate.open();
    await sending;
  }
});

test('a peer arriving during prompt construction reaches the newly started turn', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, memory } = await unitCoordinationFixture(cleanup);
  const a = await start();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const snapshot = memory.snapshot.bind(memory);

  vi.spyOn(memory, 'snapshot').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;

    return snapshot(...args);
  });

  const gate = new TurnGate();
  a.a.gate = gate;
  const sending = a.coordinator.send('Original request');

  try {
    await within(entered.promise, 5000, 'prompt construction');
    await start('B');
    await a.query();
    release.resolve();
    await within(gate.entered, 5000, 'native send');
    await until('late policy', () => a.a.contextSteers.length === 1);
    assert.match(a.a.inputs[0]!.context!, /New work needs no claim/);
    assert.match(a.a.contextSteers[0]!, /Claim coordination is required/);
    assert.equal(a.a.inputs[0]!.prompt, 'Original request');
  } finally {
    release.resolve();
    gate.open();
    await sending;
  }
});

test('a refused policy steer waits for fresh context on the next user turn', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start } = await unitCoordinationFixture(cleanup);
  const a = await start();
  a.a.refuseSteer = true;
  const steer = vi.spyOn(a.a.sessions[0]!.session, 'steer');
  const gate = new TurnGate();
  a.a.gate = gate;
  const sending = a.coordinator.send('Current task');

  try {
    await within(gate.entered, 5000, 'solo turn');
    const b = await start('B');
    await a.query();
    await until('refused policy', () => steer.mock.calls.length === 1);
    await b.claim('task:peer', 'Changed summary');
    await a.query();
    assert.equal(steer.mock.calls.length, 1);
    assert.deepEqual(a.a.contextSteers, []);
    assert.deepEqual(a.coordinator.snapshot.queue, []);
  } finally {
    gate.open();
    await sending;
  }

  assert.equal(a.a.inputs.length, 1);
  a.a.refuseSteer = false;
  await a.coordinator.send('Next user request');

  assert.deepEqual(
    a.a.inputs.map(({ prompt }) => prompt),
    ['Current task', 'Next user request'],
  );

  assert.match(a.a.inputs[1]!.context!, /Claim coordination is required/);
  assert.match(a.a.inputs[1]!.context!, /--claim/);
});

for (const finishFirst of [false, true]) {
  test(`a policy change during a pending reply ${finishFirst ? 'returns in the next turn after the current turn ends' : 'follows the accepted update'}`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);
    const { start } = await unitCoordinationFixture(cleanup);
    const a = await start();
    const session = a.a.sessions[0]!.session;
    const steer = session.steer.bind(session);
    const entered = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<void>();
    let first = true;

    session.steer = async (...args) => {
      const accepted = await steer(...args);

      if (args[1]?.contextOnly && first) {
        first = false;
        entered.resolve();
        await reply.promise;
      }

      return accepted;
    };

    const gate = new TurnGate();
    a.a.gate = gate;
    const sending = a.coordinator.send('Solo request');

    try {
      await within(gate.entered, 5000, 'solo turn');
      const b = await start('B');
      await a.query();
      await within(entered.promise, 5000, 'pending policy reply');
      await b.coordinator.close();
      await a.query();
      assert.equal(a.a.contextSteers.length, 1);

      if (finishFirst) {
        gate.open();
        await sending;
        await a.coordinator.send('Later solo request');
        assert.match(a.a.inputs[1]!.context!, /New work needs no claim/);
        assert.doesNotMatch(a.a.inputs[1]!.context!, /Control command:/);
        reply.resolve();
        await nextTick();
        assert.equal(a.a.contextSteers.length, 1);
        assert.equal(a.a.inputs.length, 2);
      } else {
        reply.resolve();
        await until('corrected policy', () => a.a.contextSteers.length === 2);
        assert.match(a.a.contextSteers[1]!, /New work needs no claim/);
      }

      assert.deepEqual(a.coordinator.snapshot.queue, []);
    } finally {
      reply.resolve();
      gate.open();
      await sending;
    }
  });
}

test('unread coordination context never becomes queued user work', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start } = await unitCoordinationFixture(cleanup);
  const a = await start();
  a.a.unreadOnInterrupt = true;
  const gate = new TurnGate();
  a.a.gate = gate;
  const sending = a.coordinator.send('Current task');

  try {
    await within(gate.entered, 5000, 'solo turn');
    await start('B');
    await a.query();
    await until('context update', () => a.a.contextSteers.length === 1);
    await a.coordinator.send('Real user follow-up');
    a.a.gate = undefined;
    await a.coordinator.interrupt();
    await sending;
    await until('user follow-up', () => a.a.inputs.length >= 2);

    assert.deepEqual(
      a.a.inputs.map(({ prompt }) => prompt),
      ['Current task', 'Real user follow-up'],
    );

    assert.deepEqual(a.coordinator.snapshot.queue, []);
  } finally {
    gate.open();
    await sending;
  }
});

test('a compaction inside a turn keeps claim policy current', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start } = await unitCoordinationFixture(cleanup);
  const a = await start();
  const gate = new TurnGate();
  a.a.gate = gate;
  const sending = a.coordinator.send('Current task');

  const compact = async () => {
    const before = a.a.contextSteers.length;
    a.a.sessions[0]!.options.onEvent({ type: 'compacted' });
    await until('resent context', () => a.a.contextSteers.length > before);

    return a.a.contextSteers.at(-1)!;
  };

  try {
    await within(gate.entered, 5000, 'solo turn');
    assert.doesNotMatch(await compact(), /Claim coordination is required/);
    await start('B');
    await a.query();

    await until('policy update', () =>
      a.a.contextSteers.some((text) =>
        /^Witch coordination update:\nClaim coordination is required/.test(
          text,
        ),
      ),
    );

    assert.match(await compact(), /Claim coordination is required/);
    assert.deepEqual(a.coordinator.snapshot.queue, []);
  } finally {
    gate.open();
    await sending;
  }

  await a.coordinator.send('After compaction');
  assert.match(a.a.inputs[1]!.context!, /Control command:/);
  assert.match(a.a.inputs[1]!.context!, /Claim coordination is required/);
});

test('a coordination failure and its recovery inside a solo turn send no policy update', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, store } = await unitCoordinationFixture(cleanup);
  const a = await start();
  const id = randomUUID();

  const held = await store.create(
    record(id, a.coordinator.snapshot.conversation!.cwd),
  );

  cleanup(() => held.close());
  const state = join(store.root, 'conversations', id, 'state.json');
  const saved = await readFile(state);
  const gate = new TurnGate();
  a.a.gate = gate;
  const sending = a.coordinator.send('Current task');

  try {
    await within(gate.entered, 5000, 'solo turn');
    await writeFile(state, '{broken');
    const failed = (await a.coordination.context()).snapshot;
    assert.ok(failed.error);
    assert.deepEqual(failed.peers, []);
    assert.deepEqual(failed.reservations, []);
    assert.deepEqual(failed.unregistered, []);
    await writeFile(state, saved);
    await a.query();
    const before = a.a.contextSteers.length;
    const b = await start('B');
    await a.query();

    await until(
      'claims update',
      () =>
        a.a.contextSteers.length > before &&
        /Claim coordination is required/.test(a.a.contextSteers.at(-1)!),
    );

    assert.equal(a.a.contextSteers.length, 1);

    assert.ok(
      a.a.contextSteers[0]!.includes(b.coordinator.snapshot.conversation!.id),
    );
  } finally {
    gate.open();
    await sending;
  }
});

test('clear preserves the same exclusive claim while the native runtime reconnects', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const f = await unitCoordinationFixture(cleanup);
  const owner = await f.start('A');
  const peer = await f.start('B');
  const claimed = await owner.claim('task:clear');
  assert.equal(claimed.kind, 'claimed');
  const before = (await owner.query()).ownClaim;
  assert.ok(before);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  owner.a.beforeConnect = holdConnect(entered, release);
  const clearing = owner.coordinator.clear();

  try {
    await within(entered.promise, 3000, 'the clear reconnect');
    assert.equal((await peer.claim('task:clear')).kind, 'conflict');
    assert.deepEqual((await owner.query()).ownClaim, before);
  } finally {
    release.resolve();
    await clearing;
  }

  assert.equal((await peer.claim('task:clear')).kind, 'conflict');
  assert.deepEqual((await owner.query()).ownClaim, before);
});

test('a model refused while disconnected keeps the exclusive claim', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const f = await unitCoordinationFixture(cleanup);
  const owner = await f.start('A');
  const peer = await f.start('B');
  assert.equal((await owner.claim('task:model')).kind, 'claimed');
  const before = (await owner.query()).ownClaim;
  assert.ok(before);
  await owner.a.sessions.at(-1)!.session.close();
  owner.a.invalidModel = 'a-typo';

  await assert.rejects(
    owner.coordinator.selectModel({ agent: 'a', id: 'a-typo' }),
    /Unknown model/,
  );

  assert.equal((await peer.claim('task:model')).kind, 'conflict');
  assert.deepEqual((await owner.query()).ownClaim, before);
});

test('a reconnect that fails before activating keeps the activation and claim', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const f = await coordinationFixture(cleanup);
  const owner = await f.start('A');
  assert.equal((await owner.claim('task:reconnect')).kind, 'claimed');
  const binding = await owner.binding();
  const claim = (await owner.query()).ownClaim;
  assert.ok(claim);
  await owner.a.sessions.at(-1)!.session.close();

  vi.spyOn(Workspace.prototype, 'ensureWorktree').mockRejectedValueOnce(
    new Error('Worktree unavailable'),
  );

  await assert.rejects(
    owner.coordinator.selectModel({ agent: 'a', id: 'a-big' }),
    /Worktree unavailable/,
  );

  assert.deepEqual(await owner.binding(), binding);
  assert.deepEqual((await owner.query()).ownClaim, claim);
});

for (const stage of ['close', 'reconnect'] as const) {
  test(`a clear whose ${stage} fails keeps the claim under a new activation`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);
    const f = await coordinationFixture(cleanup);
    const owner = await f.start('A');
    assert.equal((await owner.claim('task:clear')).kind, 'claimed');
    const bound = await owner.binding();
    const claim = (await owner.query()).ownClaim;
    assert.ok(claim);

    if (stage === 'close') owner.a.failClose = true;
    else
      vi.spyOn(Workspace.prototype, 'ensureWorktree').mockRejectedValueOnce(
        new Error('Worktree unavailable'),
      );

    await assert.rejects(
      owner.coordinator.clear(),
      stage === 'close' ? /Close failed/ : /Worktree unavailable/,
    );

    owner.a.failClose = false;
    const current = await owner.binding();
    assert.notEqual(current.activation, bound.activation);

    assert.equal(
      (await callControl(bound, { kind: 'release', claim: claim.id })).kind,
      'error',
    );

    assert.deepEqual((await owner.query()).ownClaim, claim);
    await owner.coordinator.clear();
    assert.notEqual((await owner.binding()).activation, current.activation);
    assert.deepEqual((await owner.query()).ownClaim, claim);
  });
}

test('a clear whose close and reactivation both fail reports both', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const f = await unitCoordinationFixture(cleanup);
  const owner = await f.start('A');
  owner.a.failClose = true;

  vi.spyOn(owner.coordination, 'activate').mockRejectedValueOnce(
    new Error('Activation unavailable'),
  );

  await assert.rejects(
    owner.coordinator.clear(),
    /Close failed\n\nActivation unavailable/,
  );
});

test('bound tool titles use the delivered prefixes, refresh on reconnect and survive results and reopening', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const f = await unitCoordinationFixture(cleanup);
  const client = await f.start();
  const native = client.a.sessions[0]!;

  native.session.familiar = {
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
      const { root, start, registry } = await unitCoordinationFixture(cleanup);
      const cwd = join(root, 'A');

      const executable = fileURLToPath(
        new URL(`../../fixtures/${name}.mjs`, import.meta.url),
      );

      let child: ChildProcessWithoutNullStreams | undefined;

      // the session spawns first; later children read models or usage
      const launch = (signal?: AbortSignal) => {
        const spawned = spawn(
          process.execPath,
          [executable, name === 'claude' ? 'background' : 'brews'],
          { cwd, stdio: 'pipe', signal },
        );

        child ??= spawned;

        return spawned;
      };

      const adapter =
        name === 'claude'
          ? new ClaudeAdapter((options) => launch(options.signal))
          : new CodexAdapter(
              (_, __, signal) => launch(signal),
              unreportedContextCatalog,
            );

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
          await appears(join(cwd, 'turn-1.json'), 'Codex turn');

          await writeJson(join(cwd, 'events-1.json'), [
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
          ]);

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
  const { start } = await unitCoordinationFixture(cleanup);
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
  const { root, start } = await unitCoordinationFixture(cleanup);

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

      const { root, start, store, memory } =
        await unitCoordinationFixture(cleanup);

      const script = fileURLToPath(
        new URL(`../../fixtures/${name}.mjs`, import.meta.url),
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
          : new CodexAdapter(
              (_, cwd, signal) =>
                spawn(process.execPath, [script], {
                  cwd,
                  stdio: 'pipe',
                  signal,
                }),
              unreportedContextCatalog,
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
                  'Delegate work only through Witch',
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
          // the account usage line goes with every turn, coordinated or not
          const usage =
            name === 'claude'
              ? input[0].text
              : JSON.parse(
                  await readFile(join(root, 'A', 'context.json'), 'utf8'),
                ).items[0].content[0].text;

          assert.match(
            usage,
            /^Account usage: [^\n]+\.(?:\n\nUser request:\n|$)/,
          );

          assert.ok(!usage.includes('You are running inside Witch'));

          if (name === 'claude')
            assert.ok(input[0].text.endsWith(`User request:\n${prompt}`));
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
