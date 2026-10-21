import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Workspace } from '../src/memory/workspace.js';
import { fixture, readRecord } from './fixtures/coordinator.js';
import { TurnGate } from './fixtures/agent.js';
import { within } from './fixtures/within.js';

await test('manual compaction preserves the conversation and makes persisted resume receive full accepted memory', async () => {
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
      assert.match(f.a.inputs.at(-1)!.prompt, /Use port 7777/);
      assert.match(f.a.inputs.at(-1)!.prompt, /Accepted shared memory/);
      assert.equal(f.a.inputs.at(-1)!.session, native.session.info.id);
      await reopened.send('again');
      assert.doesNotMatch(f.a.inputs.at(-1)!.prompt, /Accepted shared memory/);
    } finally {
      await reopened.close();
    }
  } finally {
    await c.close();
  }
});

await test('automatic native replacement cannot be undone by successful ordinary-turn finalization', async () => {
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
    assert.match(f.a.inputs.at(-1)!.prompt, /Use port 4567/);
    assert.match(f.a.inputs.at(-1)!.prompt, /Accepted shared memory/);
  } finally {
    await f.coordinator.close();
  }
});

for (const outcome of [
  'cancelled',
  'failed',
  'replaced then cancelled',
] as const) {
  await test(`manual compaction ${outcome} holds queued input until explicit user action`, async () => {
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
        assert.match(f.a.inputs.at(-1)!.prompt, /Use port 4567/);
    } finally {
      gate.open();
      await f.coordinator.close();
    }
  });
}

for (const outcome of ['cancelled', 'failed'] as const) {
  await test(`a ${outcome} compaction keeps hook memory pending for recovery`, async () => {
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

await test('a successful compaction whose hook conflicts with accepted memory holds later input', async () => {
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

await test('manual compaction without native history sends nothing', async () => {
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

await test('an interrupt before compaction delivery sends nothing', async (t) => {
  const f = await fixture();
  try {
    await f.coordinator.send('seed');
    const begin = Workspace.prototype.begin;
    t.mock.method(
      Workspace.prototype,
      'begin',
      async function (
        this: Workspace,
        ...args: Parameters<Workspace['begin']>
      ) {
        const result = await begin.apply(this, args);
        await f.coordinator.interrupt();
        return result;
      },
    );
    await f.coordinator.compact();
    assert.deepEqual(f.a.compactions, []);
    assert.equal(f.a.inputs.length, 1);
    assert.equal(f.coordinator.snapshot.phase, 'idle');
  } finally {
    await f.coordinator.close();
  }
});

await test('compaction preserves active background records and pending handoff context', async () => {
  const f = await fixture();
  try {
    await f.coordinator.send('seed');
    f.b.failNext = true;
    await f.coordinator.switchAgent('b');
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
    assert.ok(f.b.inputs.at(-1)!.prompt.includes(handoff.summary));
    assert.equal(f.coordinator.snapshot.conversation!.handoff, undefined);
  } finally {
    await f.coordinator.close();
  }
});
