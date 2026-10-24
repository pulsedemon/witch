import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { Workspace } from '../src/memory/workspace.js';
import { fixture, readRecord } from './fixtures/coordinator.js';
import { TurnGate } from './fixtures/agent.js';
import { within } from './fixtures/within.js';

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
      assert.equal(f.a.inputs.at(-1)!.session, native.session.info.id);
      await reopened.send('again');
      assert.doesNotMatch(
        f.a.inputs.at(-1)!.context!,
        /Accepted shared memory/,
      );
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
  } finally {
    await f.coordinator.close();
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
      assert.deepEqual(f.coordinator.unqueue(), ['distinct queued input']);
      await f.coordinator.send('distinct queued input');
      assert.equal(f.a.inputs.length, 3);
      if (outcome === 'replaced then cancelled')
        assert.match(f.a.inputs.at(-1)!.context!, /Use port 4567/);
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

test('compaction preserves active background records and pending handoff context', async () => {
  const f = await fixture();
  try {
    await f.coordinator.send('seed');
    f.b.failNext = true;
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
        assert.deepEqual(
          f.a.inputs.slice(1).map((i) => i.prompt),
          ['original', 'later'],
        );
        assert.deepEqual(f.coordinator.snapshot.queue, []);
        assert.equal(f.a.compactions.length, 2);
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
      await reopened.send('resumed');
      assert.deepEqual(f.a.compactions, [id]);
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
      if (!interrupted)
        assert.match(f.a.inputs.at(-1)!.context!, /Use port 4567/);
      assert.equal(f.coordinator.snapshot.phase, 'idle');
    } finally {
      await f.coordinator.close();
    }
  });
}
