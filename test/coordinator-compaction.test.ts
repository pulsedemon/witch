import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { Workspace } from '../src/memory/workspace.js';
import { fixture, holdSettlement, readRecord } from './fixtures/coordinator.js';
import { TurnGate } from './fixtures/agent.js';
import { settled, within, until } from './fixtures/within.js';
import type { TurnResult } from '../src/agents/types.js';

test('manual compaction preserves the conversation and makes persisted resume receive full accepted memory', async () => {
  const f = await fixture();
  const c = f.coordinator;
  try {
    await c.send('remember-port');
    await c.send('latest revision');
    const before = c.snapshot;
    const native = f.a.sessions.at(-1)!;
    const compact = native.session.compact.bind(native.session);
    native.session.compact = async () => {
      await writeFile(
        join(f.workspace().root, await f.note()),
        'Use port 7777.',
      );
      return compact();
    };
    await c.compact();
    assert.equal(c.snapshot.conversation!.id, before.conversation!.id);
    assert.equal(c.snapshot.conversation!.title, 'remember-port');
    assert.equal(c.snapshot.completedTurn, before.completedTurn);
    assert.deepEqual(
      c.snapshot.items.slice(0, before.items.length),
      before.items,
    );
    assert.deepEqual(
      c.snapshot.items.slice(before.items.length).map((i) => [i.kind, i.text]),
      [['notice', 'Conversation compacted']],
    );
    assert.equal(f.a.inputs.length, 2);
    assert.equal(
      (await readRecord(f.root, before.conversation!.id)).sessions.a!
        .deliveredRevision,
      undefined,
    );
    assert.equal(await f.memory.read('main', await f.note()), 'Use port 7777.');
    await c.close();
    const reopened = await f.reopen();
    try {
      await reopened.send('continue');
      assert.match(f.a.inputs.at(-1)!.context!, /Use port 7777/);
      assert.match(f.a.inputs.at(-1)!.context!, /Accepted shared memory/);
      assert.match(f.a.inputs.at(-1)!.context!, /You are running inside Witch/);
      assert.equal(f.a.inputs.at(-1)!.session, native.session.info.id);
      await reopened.send('again');
      assert.equal(f.a.inputs.at(-1)!.context, undefined);
    } finally {
      await reopened.close();
    }
  } finally {
    await c.close();
  }
});

test('automatic native replacement cannot be undone by successful ordinary-turn finalization', async () => {
  const f = await fixture();
  try {
    await f.coordinator.send('remember-port');
    await f.coordinator.send('latest revision');
    const native = f.a.sessions.at(-1)!;
    const send = native.session.send.bind(native.session);
    native.session.send = async (...args) => {
      native.options.onEvent({ type: 'compacted' });
      return send(...args);
    };
    await f.coordinator.send('normal turn');
    assert.equal(
      (await readRecord(f.root, f.coordinator.snapshot.conversation!.id))
        .sessions.a!.deliveredRevision,
      undefined,
    );
    native.session.send = send;
    await f.coordinator.send('after replacement');
    assert.match(f.a.inputs.at(-1)!.context!, /Use port 4567/);
    assert.match(f.a.inputs.at(-1)!.context!, /Accepted shared memory/);
    assert.match(f.a.inputs.at(-1)!.context!, /You are running inside Witch/);
  } finally {
    await f.coordinator.close();
  }
});

test('a compaction inside a turn steers memory and the fixed instructions back into it', async () => {
  const f = await fixture(),
    c = f.coordinator,
    gate = new TurnGate();
  try {
    await c.send('remember-port');
    await c.send('latest revision');
    f.a.gate = gate;
    const turn = c.send('long turn');
    await within(gate.entered, 3000, 'turn start');
    assert.equal(f.a.inputs.at(-1)!.context, undefined);
    f.a.sessions.at(-1)!.options.onEvent({ type: 'compacted' });
    await until('resent context', () => f.a.contextSteers.length === 1);
    const [resent] = f.a.contextSteers;
    assert.match(resent!, /^Witch context, sent again after/);
    assert.match(resent!, /You are running inside Witch/);
    assert.match(resent!, /Accepted shared memory/);
    assert.match(resent!, /Use port 4567/);
    gate.open();
    await turn;
    const record = await readRecord(f.root, c.snapshot.conversation!.id);
    assert.equal(record.lastTurn?.status, 'completed');
  } finally {
    gate.open();
    await c.close();
  }
});

test('a compaction inside a turn resends once a refused steer is admitted after the compaction completes', async () => {
  const f = await fixture(),
    c = f.coordinator,
    gate = new TurnGate();
  try {
    await c.send('remember-port');
    f.a.gate = gate;
    const parent = c.send('parent result');
    await within(gate.entered, 3000, 'turn start');
    f.a.replied = true;
    const native = f.a.sessions.at(-1)!,
      completed = Promise.withResolvers<TurnResult>();
    native.session.compactDuringTurn = () => completed.promise;
    let refused = 0;
    const steer = native.session.steer.bind(native.session);
    native.session.steer = async (prompt, options) => {
      if (f.a.refuseSteer && options?.contextOnly) refused++;
      return steer(prompt, options);
    };
    // Claude refuses steering while its manual compaction runs
    f.a.refuseSteer = true;
    const compact = c.compact();
    native.options.onEvent({ type: 'compacted' });
    await until('refused resend', () => refused === 1);
    assert.deepEqual(f.a.contextSteers, []);
    f.a.refuseSteer = false;
    completed.resolve({ status: 'completed', text: '' });
    assert.equal(await within(compact, 3000, 'busy compact'), true);
    await until('resent context', () => f.a.contextSteers.length === 1);
    assert.match(f.a.contextSteers[0]!, /You are running inside Witch/);
    assert.match(f.a.contextSteers[0]!, /Use port 4567/);
    gate.open();
    await parent;
  } finally {
    gate.open();
    await c.close();
  }
});

for (const outcome of [
  'cancelled',
  'failed',
  'replaced then cancelled',
] as const) {
  test(`manual compaction ${outcome} holds queued input until explicit user action`, async () => {
    const f = await fixture();
    const gate = new TurnGate();
    try {
      await f.coordinator.send('remember-port');
      await f.coordinator.send('latest revision');
      const native = f.a.sessions.at(-1)!;
      if (outcome === 'replaced then cancelled') {
        const compact = native.session.compact.bind(native.session);
        native.session.compact = () => {
          native.options.onEvent({ type: 'compacted' });
          return compact();
        };
      }
      f.a.gate = gate;
      const compacting = f.coordinator.compact();
      await within(gate.entered, 3000, 'native compaction');
      assert.equal(f.coordinator.snapshot.phase, 'compacting');
      await f.coordinator.send('distinct queued input');
      if (outcome === 'failed') {
        f.a.failNext = true;
        gate.open();
      } else await f.coordinator.interrupt();
      await compacting;
      assert.equal(f.coordinator.snapshot.phase, 'idle');
      assert.deepEqual(f.coordinator.snapshot.queue, ['distinct queued input']);
      assert.equal(f.a.inputs.length, 2);
      assert.deepEqual(f.a.steers, []);
      if (outcome === 'replaced then cancelled')
        assert.equal(
          (await readRecord(f.root, f.coordinator.snapshot.conversation!.id))
            .sessions.a!.deliveredRevision,
          undefined,
        );
      f.a.gate = undefined;
      assert.deepEqual(f.coordinator.unqueue(''), ['distinct queued input']);
      await f.coordinator.send('distinct queued input');
      assert.equal(f.a.inputs.length, 3);
      if (outcome === 'replaced then cancelled')
        assert.match(f.a.inputs.at(-1)!.context!, /Use port 4567/);
      assert.equal(
        f.a.inputs.at(-1)!.context?.includes('You are running inside Witch') ??
          false,
        outcome === 'replaced then cancelled',
      );
    } finally {
      gate.open();
      await f.coordinator.close();
    }
  });
}

for (const outcome of ['cancelled', 'failed'] as const) {
  test(`a ${outcome} compaction keeps hook memory pending for recovery`, async () => {
    const f = await fixture();
    const gate = new TurnGate();
    try {
      await f.coordinator.send('seed');
      const native = f.a.sessions.at(-1)!.session;
      const compact = native.compact.bind(native);
      native.compact = async () => {
        await writeFile(
          join(f.workspace().root, await f.note()),
          'Pending hook memory.',
        );
        return compact();
      };
      f.a.gate = gate;
      const compacting = f.coordinator.compact();
      await within(gate.entered, 3000, 'hook write');
      if (outcome === 'cancelled') await f.coordinator.interrupt();
      else {
        f.a.failNext = true;
        gate.open();
      }
      await compacting;
      assert.equal(f.coordinator.snapshot.recovery?.kind, 'pending');
      assert.match(
        f.coordinator.snapshot.recovery!.diff,
        /Pending hook memory/,
      );
      await f.coordinator.send('wait for recovery');
      assert.equal(f.a.inputs.length, 1);
      assert.deepEqual(f.coordinator.snapshot.queue, ['wait for recovery']);
      await assert.rejects(f.coordinator.compact(), /Resolve pending memory/);
    } finally {
      gate.open();
      await f.coordinator.close();
    }
  });
}

test('a successful compaction whose hook conflicts with accepted memory holds later input', async () => {
  const f = await fixture();
  try {
    await f.coordinator.send('remember:initial');
    const other = await f.outsider();
    const native = f.a.sessions.at(-1)!.session;
    const compact = native.compact.bind(native);
    native.compact = async () => {
      await writeFile(join(f.workspace().root, await f.notes()), 'hook edit');
      await writeFile(join(other.root, await f.notes()), 'accepted outside');
      await other.commit('outside edit');
      await other.publish();
      return compact();
    };
    await f.coordinator.compact();
    assert.equal(f.coordinator.snapshot.recovery?.kind, 'conflict');
    await f.coordinator.send('held after conflict');
    assert.equal(f.a.inputs.length, 1);
    assert.deepEqual(f.coordinator.snapshot.queue, ['held after conflict']);
  } finally {
    await f.coordinator.close();
  }
});

test('manual compaction without native history sends nothing', async () => {
  const f = await fixture();
  try {
    f.a.sessions[0]!.session.info.hasHistory = false;
    await f.coordinator.compact();
    assert.deepEqual(f.a.compactions, []);
    assert.deepEqual(f.a.inputs, []);
    assert.equal(f.coordinator.snapshot.phase, 'idle');
    assert.equal(f.coordinator.snapshot.completedTurn, undefined);
  } finally {
    await f.coordinator.close();
  }
});

test('an interrupt from the no-history notice keeps hook memory pending for recovery', async () => {
  const f = await fixture();
  try {
    await f.coordinator.send('seed');
    f.a.sessions.at(-1)!.session.info.hasHistory = false;
    const begin = Workspace.prototype.begin;
    vi.spyOn(Workspace.prototype, 'begin').mockImplementation(async function (
      this: Workspace,
      ...args: Parameters<Workspace['begin']>
    ) {
      const result = await begin.apply(this, args);
      await writeFile(
        join(f.workspace().root, await f.note()),
        'Pending hook memory.',
      );
      return result;
    });
    const unsubscribe = f.coordinator.subscribe(() => {
      if (
        f.coordinator.snapshot.items.some(
          ({ text }) => text === 'No conversation history to compact',
        )
      ) {
        unsubscribe();
        void f.coordinator.interrupt();
      }
    });
    await f.coordinator.compact();
    assert.equal(f.coordinator.snapshot.recovery?.kind, 'pending');
    assert.match(f.coordinator.snapshot.recovery!.diff, /Pending hook memory/);
  } finally {
    await f.coordinator.close();
  }
});

test('an interrupt before compaction delivery sends nothing', async () => {
  const f = await fixture();
  try {
    await f.coordinator.send('seed');
    const begin = Workspace.prototype.begin;
    vi.spyOn(Workspace.prototype, 'begin').mockImplementation(async function (
      this: Workspace,
      ...args: Parameters<Workspace['begin']>
    ) {
      const result = await begin.apply(this, args);
      await f.coordinator.interrupt();
      return result;
    });
    await f.coordinator.compact();
    assert.deepEqual(f.a.compactions, []);
    assert.equal(f.a.inputs.length, 1);
    assert.equal(f.coordinator.snapshot.phase, 'idle');
  } finally {
    await f.coordinator.close();
  }
});

test('compaction preserves the last ordinary-turn outcome', async () => {
  const f = await fixture();
  try {
    f.a.interruptNext = true;
    await f.coordinator.send('unfinished task');
    const id = f.coordinator.snapshot.conversation!.id;
    const previous = (await readRecord(f.root, id)).lastTurn;
    assert.equal(previous?.status, 'interrupted');
    await f.coordinator.compact();
    assert.equal(f.a.compactions.length, 1);
    assert.equal(f.a.inputs.length, 1);
    assert.deepEqual((await readRecord(f.root, id)).lastTurn, previous);
  } finally {
    await f.coordinator.close();
  }
});

test('compaction preserves active background records and pending handoff context', async () => {
  const f = await fixture();
  try {
    await f.coordinator.send('seed');
    await f.coordinator.selectModel({ agent: 'b', id: 'b-model' });
    const handoff = f.coordinator.snapshot.conversation!.handoff;
    assert.ok(handoff?.summary);
    const native = f.b.sessions.at(-1)!;
    native.options.onEvent({
      type: 'command',
      command: { id: 'brew', description: 'background', status: 'running' },
    });
    native.options.onEvent({
      type: 'subagent',
      subagent: {
        id: 'helper',
        name: 'helper',
        kind: 'worker',
        status: 'running',
      },
    });
    await f.coordinator.compact();
    assert.deepEqual(f.coordinator.snapshot.conversation!.handoff, handoff);
    assert.equal(f.coordinator.snapshot.backgroundCommands[0]!.id, 'brew');
    assert.equal(f.coordinator.snapshot.subagents[0]!.id, 'helper');
    await f.coordinator.send('continue handoff');
    assert.ok(f.b.inputs.at(-1)!.context!.includes(handoff.summary));
    assert.equal(f.coordinator.snapshot.conversation!.handoff, undefined);
  } finally {
    await f.coordinator.close();
  }
});

for (const usage of [79, 80, undefined]) {
  test(`queued work at ${usage ?? 'unknown'} percent makes one scheduling decision before delivery`, async () => {
    const f = await fixture();
    try {
      await f.coordinator.send('seed');
      const session = f.a.sessions[0]!.session;
      session.contextUsage = async () => usage;
      const order: string[] = [];
      const compact = session.compact.bind(session),
        send = session.send.bind(session);
      session.compact = () => {
        order.push('compact');
        return compact();
      };
      session.send = (...args) => {
        order.push('send');
        return send(...args);
      };
      await f.coordinator.refreshModels();
      assert.deepEqual(order, []);
      await f.coordinator.send('next');
      assert.deepEqual(order, usage === 80 ? ['compact', 'send'] : ['send']);
      assert.equal(f.a.inputs.length, 2);
      assert.equal(f.a.inputs[1]!.prompt, 'next');
    } finally {
      await f.coordinator.close();
    }
  });
}

test('automatic compaction awaits fresh usage and preserves original input when interrupted during the read', async () => {
  const f = await fixture();
  const read = Promise.withResolvers<number>();
  const entered = Promise.withResolvers<void>();
  try {
    await f.coordinator.send('seed');
    f.a.sessions[0]!.session.contextUsage = () => {
      entered.resolve();
      return read.promise;
    };
    const sending = f.coordinator.send('original');
    await within(entered.promise, 3000, 'fresh usage read');
    assert.equal(f.a.inputs.length, 1);
    assert.deepEqual(f.a.compactions, []);
    await f.coordinator.send('later');
    await f.coordinator.interrupt();
    read.resolve(80);
    await sending;
    assert.deepEqual(f.coordinator.snapshot.queue, ['original', 'later']);
    assert.equal(f.a.inputs.length, 1);
    assert.deepEqual(f.a.compactions, []);
  } finally {
    read.resolve(80);
    await f.coordinator.close();
  }
});

for (const outcome of ['cancelled', 'failed', 'completed'] as const) {
  test(`automatic compaction ${outcome} preserves delivery order for input received meanwhile`, async () => {
    const f = await fixture();
    const gate = new TurnGate();
    try {
      await f.coordinator.send('seed');
      f.a.sessions[0]!.session.contextUsage = async () => 80;
      f.a.gate = gate;
      const sending = f.coordinator.send('original');
      await within(gate.entered, 3000, 'automatic compaction');
      await f.coordinator.send('later');
      if (outcome === 'cancelled') await f.coordinator.interrupt();
      else {
        f.a.failNext = outcome === 'failed';
        gate.open();
      }
      await sending;
      if (outcome === 'completed') {
        assert.deepEqual(f.a.steers, ['later']);
        assert.deepEqual(
          f.a.inputs.slice(1).map((i) => i.prompt),
          ['original'],
        );
        assert.deepEqual(f.coordinator.snapshot.queue, []);
        assert.equal(f.a.compactions.length, 1);
      } else {
        assert.equal(f.a.inputs.length, 1);
        assert.deepEqual(f.coordinator.snapshot.queue, ['original', 'later']);
        assert.equal(f.a.compactions.length, 1);
        assert.deepEqual(f.a.steers, []);
      }
    } finally {
      gate.open();
      await f.coordinator.close();
    }
  });
}

test('automatic compaction does not deliver its batch over a memory publication conflict', async () => {
  const f = await fixture();
  try {
    await f.coordinator.send('remember:initial');
    const other = await f.outsider(),
      native = f.a.sessions[0]!.session;
    native.contextUsage = async () => 80;
    const compact = native.compact.bind(native);
    native.compact = async () => {
      await writeFile(join(f.workspace().root, await f.notes()), 'hook edit');
      await writeFile(join(other.root, await f.notes()), 'accepted outside');
      await other.commit('outside edit');
      await other.publish();
      return compact();
    };
    await f.coordinator.send('blocked batch');
    assert.equal(f.coordinator.snapshot.recovery?.kind, 'conflict');
    assert.equal(f.a.inputs.length, 1);
    assert.deepEqual(f.coordinator.snapshot.queue, ['blocked batch']);
  } finally {
    await f.coordinator.close();
  }
});

for (const prompt of ['/review exact target', '!printf exact-command']) {
  test(`${prompt} compacts before its native delivery`, async () => {
    const f = await fixture(undefined, (a) => {
      a.skills = [{ name: 'review', description: 'Review' }];
    });
    try {
      await f.coordinator.send('seed');
      const native = f.a.sessions[0]!.session;
      native.contextUsage = async () => 80;
      const compact = native.compact.bind(native),
        shell = native.shell.bind(native),
        send = native.send.bind(native);
      const order: string[] = [];
      native.compact = () => {
        order.push('compact');
        return compact();
      };
      native.shell = (...args) => {
        order.push('shell');
        return shell(...args);
      };
      native.send = (...args) => {
        order.push('send');
        return send(...args);
      };
      await f.coordinator.send(prompt);
      assert.deepEqual(
        order,
        prompt.startsWith('!')
          ? ['compact', 'shell', 'send']
          : ['compact', 'send'],
      );
      assert.equal(f.a.inputs.length, 2);
      if (prompt.startsWith('!'))
        assert.deepEqual(f.a.shells, ['printf exact-command']);
      else
        assert.deepEqual(f.a.inputs.at(-1)!.skill, {
          name: 'review',
          args: 'exact target',
        });
    } finally {
      await f.coordinator.close();
    }
  });
}

test('a resumed native context sample schedules compaction and a model with no sample does not', async () => {
  const f = await fixture();
  try {
    await f.coordinator.send('seed');
    const id = f.a.sessions[0]!.session.info.id;
    await f.coordinator.close();
    f.a.connectUsage = { context: 80 };
    const reopened = await f.reopen();
    try {
      const reads = vi.spyOn(f.memory, 'scopePaths');
      await reopened.send('resumed');
      assert.deepEqual(f.a.compactions, [id]);
      // the compaction begins from the scope its turn read
      assert.equal(reads.mock.calls.length, 1);
      assert.equal(f.a.inputs.at(-1)!.session, id);
      const native = f.a.sessions.at(-1)!.session;
      const select = native.selectModel.bind(native);
      native.selectModel = async (...args) => {
        await select(...args);
        native.contextUsage = async () => undefined;
      };
      await reopened.selectModel({ agent: 'a', id: 'a-big' });
      await reopened.send('different model');
      assert.deepEqual(f.a.compactions, [id]);
      assert.equal(f.a.inputs.length, 3);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.coordinator.close();
  }
});

for (const interrupted of [false, true]) {
  test(`a command whose native history changes refreshes memory before its reply${interrupted ? ' and still honors interruption' : ''}`, async () => {
    const f = await fixture();
    try {
      await f.coordinator.send('remember-port');
      await f.coordinator.send('latest revision');
      const entry = f.a.sessions.at(-1)!,
        shell = entry.session.shell.bind(entry.session);
      entry.session.shell = async (...args) => {
        entry.options.onEvent({ type: 'compacted' });
        return shell(...args);
      };
      if (interrupted) {
        const snapshot = f.memory.snapshot.bind(f.memory);
        f.memory.snapshot = async (...args) => {
          await f.coordinator.interrupt();
          return snapshot(...args);
        };
      }
      await f.coordinator.send('!printf distinct-command');
      assert.deepEqual(f.a.shells, ['printf distinct-command']);
      assert.equal(f.a.inputs.length, interrupted ? 2 : 3);
      if (!interrupted) {
        assert.match(f.a.inputs.at(-1)!.context!, /Use port 4567/);
        assert.match(
          f.a.inputs.at(-1)!.context!,
          /You are running inside Witch/,
        );
      }
      assert.equal(f.coordinator.snapshot.phase, 'idle');
    } finally {
      await f.coordinator.close();
    }
  });
}

test('a direct busy compact coalesces callers and holds later input until the original turn and compact finish', async () => {
  const f = await fixture(),
    c = f.coordinator,
    gate = new TurnGate();
  try {
    f.a.gate = gate;
    const native = f.a.sessions[0]!.session;
    const order: string[] = [];
    const send = native.send.bind(native),
      compact = native.compact.bind(native);
    native.send = async (...args) => {
      const result = await send(...args);
      order.push(args[0]);
      return result;
    };
    native.compact = async () => {
      order.push('compact');
      return compact();
    };
    const parent = c.send('original parent');
    await gate.entered;
    const first = c.compact(),
      second = c.compact();
    assert.equal(first, second);
    assert.equal(c.snapshot.pendingCompaction, true);
    await c.send('distinct later prompt');
    assert.deepEqual(f.a.steers, []);
    gate.open();
    assert.equal(await within(first, 3000, 'deferred compact'), true);
    await parent;
    await until(
      'later prompt completion',
      () => f.a.inputs.length === 2 && c.snapshot.phase === 'idle',
    );
    assert.deepEqual(order, [
      'original parent',
      'compact',
      'distinct later prompt',
    ]);
    assert.equal(c.snapshot.pendingCompaction, false);
    assert.deepEqual(f.a.stops, []);
  } finally {
    gate.open();
    await c.close();
  }
});

for (const success of [true, false]) {
  test(`busy compact ${success ? 'applies the next model before steering and defers memory publication' : 'keeps hook edits pending without changing the ordinary outcome'}`, async () => {
    const f = await fixture(),
      c = f.coordinator,
      gate = new TurnGate();
    try {
      await c.send('remember-port');
      f.a.gate = gate;
      const parent = c.send('parent result');
      await gate.entered;
      f.a.replied = true;
      const native = f.a.sessions.at(-1)!,
        completed = Promise.withResolvers<TurnResult>();
      native.session.compactDuringTurn = () => completed.promise;
      const release = c.holdPromptDelivery();
      const compact = c.compact();
      await c.send('later under new model');
      const note = await f.note();
      await writeFile(join(f.workspace().root, note), 'unfinished hook note');
      assert.deepEqual(f.a.steers, []);
      if (success) native.options.onEvent({ type: 'compacted' });
      completed.resolve(
        success
          ? { status: 'completed', text: '' }
          : { status: 'failed', text: '', error: 'compact failed' },
      );
      assert.equal(await within(compact, 3000, 'busy compact'), success);
      assert.equal(await f.workspace().isDirty(), true);
      assert.equal(await f.memory.read('main', note), 'Use port 4567.');
      const steered: [string, string][] = [];
      const steer = native.session.steer.bind(native.session);
      native.session.steer = async (prompt, options) => {
        steered.push([prompt, native.session.info.model]);
        return steer(prompt, options);
      };
      if (success)
        await c.selectModel({ agent: 'a', id: 'a-big', effort: 'high' });
      release();
      release();
      assert.equal(c.snapshot.commandsPending, false);
      if (success) {
        await until('new-model steering', () => f.a.steers.length === 1);
        assert.deepEqual(steered, [['later under new model', 'a-big']]);
      }
      gate.open();
      await parent;
      const record = await readRecord(f.root, c.snapshot.conversation!.id);
      assert.equal(record.lastTurn?.status, 'completed');
      assert.equal(c.snapshot.phase, success ? 'idle' : 'recovery');
      if (success) {
        assert.equal(record.sessions.a!.deliveredRevision, undefined);
        assert.equal(await f.memory.read('main', note), 'unfinished hook note');
      } else {
        assert.deepEqual(c.snapshot.queue, ['later under new model']);
        assert.deepEqual(steered, []);
        assert.match(c.snapshot.recovery!.diff, /unfinished hook note/);
      }
    } finally {
      gate.open();
      await c.close();
    }
  });
}

test('busy foreground compact waits for parent settlement before admitting model selection', async () => {
  const f = await fixture(),
    c = f.coordinator,
    gate = new TurnGate();
  try {
    f.a.gate = gate;
    const parent = c.send('foreground');
    await gate.entered;
    const native = f.a.sessions.at(-1)!,
      completed = Promise.withResolvers<TurnResult>();
    native.session.compactDuringTurn = () => completed.promise;
    const compact = c.compact();
    const isSettled = settled(compact);
    completed.resolve({ status: 'completed', text: '' });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(isSettled(), false);
    gate.open();
    assert.equal(await within(compact, 3000, 'parent settlement'), true);
    assert.equal(c.snapshot.phase, 'idle');
    await c.selectModel({ agent: 'a', id: 'a-big' });
    assert.equal(native.session.info.model, 'a-big');
    await parent;
  } finally {
    gate.open();
    await c.close();
  }
});

test('a model choice after a busy compaction waits for the finished turn to settle', async () => {
  const f = await fixture(),
    c = f.coordinator,
    gate = new TurnGate();
  const native = f.a.sessions.at(-1)!.session;
  const settlement = holdSettlement(native);
  try {
    f.a.gate = gate;
    const parent = c.send('foreground');
    await gate.entered;
    f.a.replied = true;
    native.compactDuringTurn = () =>
      Promise.resolve({ status: 'completed', text: '' });
    assert.equal(await within(c.compact(), 3000, 'busy compact'), true);
    const before = f.a.selections.length;
    gate.open();
    await within(settlement.entered, 2000, 'the post-turn save');
    assert.equal(c.snapshot.phase, 'running');
    assert.equal(native.replied, false);
    const choice = c.selectModel({ agent: 'a', id: 'a-big' });
    settlement.release();
    await within(choice, 2000, 'the model choice');
    assert.equal(native.info.model, 'a-big');
    assert.deepEqual(f.a.selections.slice(before), [['a-big', undefined]]);
    assert.equal(c.snapshot.phase, 'idle');
    await parent;
  } finally {
    settlement.restore();
    gate.open();
    await c.close();
  }
});

test('manual compact joins an automatic compact and restores the removed batch before the next command', async () => {
  const f = await fixture(),
    c = f.coordinator,
    gate = new TurnGate();
  try {
    await c.send('seed');
    const native = f.a.sessions.at(-1)!.session;
    native.contextUsage = async () => 80;
    f.a.gate = gate;
    const sending = c.send('dequeued original');
    await gate.entered;
    const release = c.holdPromptDelivery();
    const compact = c.compact();
    await c.send('later');
    native.contextUsage = async () => 0;
    gate.open();
    assert.equal(await within(compact, 3000, 'joined automatic'), true);
    await sending;
    assert.deepEqual(c.snapshot.queue, ['dequeued original', 'later']);
    assert.equal(f.a.compactions.length, 1);
    const observed: [string, string][] = [];
    const send = native.send.bind(native);
    native.send = (...args) => {
      observed.push([args[0], native.info.model]);
      return send(...args);
    };
    await c.selectModel({ agent: 'a', id: 'a-big' });
    release();
    await until(
      'restored batch completion',
      () => c.snapshot.phase === 'idle' && f.a.inputs.length === 2,
    );
    assert.deepEqual(observed, [['dequeued original\nlater', 'a-big']]);
  } finally {
    gate.open();
    await c.close();
  }
});

for (const outcome of ['interrupt', 'failure', 'close'] as const) {
  test(`a deferred compact ${outcome} holds queued input and settles its request`, async () => {
    const f = await fixture(),
      c = f.coordinator,
      gate = new TurnGate();
    try {
      f.a.gate = gate;
      const parent = c.send('ordinary');
      await gate.entered;
      const compact = c.compact();
      await c.send('held later');
      if (outcome === 'failure') {
        f.a.failNext = true;
        gate.open();
      } else if (outcome === 'interrupt') await c.interrupt();
      else await c.close();
      assert.equal(
        await within(compact, 3000, 'stopped pending compact'),
        false,
      );
      await parent;
      assert.deepEqual(f.a.compactions, []);
      assert.deepEqual(c.snapshot.queue, ['held later']);
      assert.equal(c.snapshot.pendingCompaction, false);
    } finally {
      gate.open();
      await c.close();
    }
  });
}

test('a compaction requested while a conversation changes never runs in the replacement conversation', async () => {
  const f = await fixture(),
    c = f.coordinator;
  try {
    const before = c.snapshot.conversation!.id;
    const changing = c.newConversation();
    const compact = c.compact();
    await changing;
    assert.equal(
      await within(compact, 3000, 'conversation-scoped compact'),
      false,
    );
    assert.notEqual(c.snapshot.conversation!.id, before);
    assert.deepEqual(f.a.compactions, []);
    assert.equal(c.snapshot.pendingCompaction, false);
  } finally {
    await c.close();
  }
});

for (const closed of [false, true])
  test(`releasing a delivery hold during settlement ${closed ? 'keeps a closed session prompt queued' : 'resumes the restored batch'}`, async () => {
    const f = await fixture(),
      c = f.coordinator;
    const read = Promise.withResolvers<number>(),
      reading = Promise.withResolvers<void>();
    const settling = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    // the held batch skips the turn's begin, so settlement reads the next status
    const status = Workspace.prototype.status;
    let armed = false;
    const override = vi
      .spyOn(Workspace.prototype, 'status')
      .mockImplementation(async function (this: Workspace) {
        if (armed) {
          armed = false;
          settling.resolve();
          await finish.promise;
        }
        return status.call(this);
      });
    try {
      f.a.sessions[0]!.session.contextUsage = () => {
        reading.resolve();
        return read.promise;
      };
      const sending = c.send('original awaiting delivery');
      await reading.promise;
      const release = c.holdPromptDelivery();
      armed = true;
      read.resolve(0);
      await within(settling.promise, 3000, 'settling held batch');
      assert.deepEqual(c.snapshot.queue, []);
      if (closed) await f.a.sessions[0]!.session.close();
      release();
      finish.resolve();
      await sending;
      if (closed) {
        assert.deepEqual(c.snapshot.queue, ['original awaiting delivery']);
        assert.equal(f.a.inputs.length, 0);
      } else {
        await until(
          'restored original resumed',
          () => f.a.inputs.length === 1 && c.snapshot.phase === 'idle',
        );
        assert.equal(f.a.inputs[0]!.prompt, 'original awaiting delivery');
      }
    } finally {
      finish.resolve();
      read.resolve(0);
      override.mockRestore();
      await c.close();
    }
  });
