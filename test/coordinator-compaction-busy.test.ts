import assert from 'node:assert/strict';

import { writeFile } from 'node:fs/promises';

import { join } from 'node:path';

import { test, vi } from 'vitest';

import { Workspace } from '../src/memory/workspace.js';

import {
  fixture,
  holdSettlement,
  readRecord,
  unitFixture,
} from './fixtures/coordinator.js';

import { TurnGate } from './fixtures/agent.js';

import { settled, until, within } from './fixtures/within.js';

import type { TurnResult } from '../src/agents/types.js';

test('a direct busy compact coalesces callers and holds later input until the original turn and compact finish', async () => {
  const f = await unitFixture(),
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
  const f = await unitFixture(),
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
  const f = await unitFixture(),
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
  const f = await unitFixture(),
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
    const f = await unitFixture(),
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
  const f = await unitFixture(),
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
