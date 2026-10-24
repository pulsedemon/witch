import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { setImmediate as next } from 'node:timers/promises';
import type { ConversationRecord } from '../src/core/state.js';
import { ConversationStore } from '../src/persistence/store.js';
import { watchTerminal } from '../src/ui/terminal.js';
import { TurnGate } from './fixtures/agent.js';
import { fixture, readRecord } from './fixtures/coordinator.js';
import { passThrough } from './fixtures/git.js';
import { within } from './fixtures/within.js';

test('completion identifies the successful activity only after its final save', async () => {
  const { coordinator, a, root } = await fixture();
  const gate = new TurnGate();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const save = ConversationStore.prototype.save;
  const saving = vi
    .spyOn(ConversationStore.prototype, 'save')
    .mockImplementation(function (
      this: ConversationStore,
      record: ConversationRecord,
    ) {
      if (record.activity) return save.call(this, record);
      saving.mockRestore();
      entered.resolve();
      return release.promise.then(() => save.call(this, record));
    });
  try {
    a.gate = gate;
    const sending = coordinator.send('remember-port');
    await within(gate.entered, 5000, 'the native turn');
    const id = coordinator.snapshot.conversation!.id;
    const activity = (await readRecord(root, id)).activity!;
    assert.equal(coordinator.snapshot.completedTurn, undefined);
    gate.open();
    await within(entered.promise, 5000, 'the final save');
    assert.equal(coordinator.snapshot.completedTurn, undefined);
    assert.equal((await readRecord(root, id)).activity?.id, activity.id);
    release.resolve();
    await sending;
    assert.equal(coordinator.snapshot.completedTurn, activity.id);
    const stored = await readRecord(root, id);
    assert.equal(stored.activity, undefined);
    assert.equal('completedTurn' in stored, false);
  } finally {
    saving.mockRestore();
    release.resolve();
    gate.open();
    await coordinator.close();
  }
});

test('a rejected final save publishes no completion', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  const save = ConversationStore.prototype.save;
  const saving = vi
    .spyOn(ConversationStore.prototype, 'save')
    .mockImplementation(function (
      this: ConversationStore,
      record: ConversationRecord,
    ) {
      if (record.activity) return save.call(this, record);
      saving.mockRestore();
      return Promise.reject(new Error('final save rejected'));
    });
  try {
    a.gate = gate;
    const sending = coordinator.send('successful native result');
    await within(gate.entered, 5000, 'the native turn');
    gate.open();
    await sending;
    assert.match(coordinator.snapshot.error!, /final save rejected/);
    assert.equal(coordinator.snapshot.completedTurn, undefined);
  } finally {
    saving.mockRestore();
    gate.open();
    await coordinator.close();
  }
});

for (const outcome of ['failed', 'interrupted', 'preparation'] as const)
  test(`${outcome} turns clear the preceding successful completion`, async () => {
    const { coordinator, a, hook } = await fixture();
    try {
      await coordinator.send('previous success');
      assert.ok(coordinator.snapshot.completedTurn);
      const turns = a.inputs.length;
      if (outcome === 'failed') a.failNext = true;
      else if (outcome === 'interrupted') a.interruptNext = true;
      else
        hook.current = async (command, run) => {
          if (command[0] !== 'rev-parse' || command[1] !== '--git-path')
            return run();
          hook.current = passThrough;
          return {
            stdout: Buffer.alloc(0),
            stderr: 'preparation failed',
            code: 1,
          };
        };
      await coordinator.send('next turn');
      assert.equal(coordinator.snapshot.completedTurn, undefined);
      assert.equal(
        a.inputs.length,
        turns + (outcome === 'preparation' ? 0 : 1),
      );
      if (outcome === 'preparation') {
        assert.match(coordinator.snapshot.error!, /preparation failed/);
        assert.deepEqual(coordinator.snapshot.queue, ['next turn']);
      }
    } finally {
      hook.current = passThrough;
      await coordinator.close();
    }
  });

test('conversation adoption clears completion and the internal handoff summary stays silent', async () => {
  const { coordinator, a, b } = await fixture();
  const summary = new TurnGate();
  const continuation = new TurnGate();
  const signals = new Set<string>();
  const unsubscribe = coordinator.subscribe(() => {
    if (coordinator.snapshot.completedTurn)
      signals.add(coordinator.snapshot.completedTurn);
  });
  try {
    await coordinator.send('first task');
    const first = coordinator.snapshot.completedTurn;
    assert.ok(first);
    await coordinator.newConversation();
    assert.equal(coordinator.snapshot.completedTurn, undefined);
    await coordinator.send('second task');
    const previous = coordinator.snapshot.completedTurn;
    assert.ok(previous);
    assert.notEqual(previous, first);
    signals.clear();
    a.gate = summary;
    b.gate = continuation;
    const switching = coordinator.selectModel({ agent: 'b', id: 'b-model' });
    await within(summary.entered, 5000, 'the summary');
    summary.open();
    await within(continuation.entered, 5000, 'the continuation');
    assert.deepEqual([...signals], [previous]);
    assert.equal(coordinator.snapshot.completedTurn, undefined);
    continuation.open();
    await switching;
    const current = coordinator.snapshot.completedTurn;
    assert.ok(current);
    assert.notEqual(current, previous);
    assert.deepEqual([...signals], [previous, current]);
  } finally {
    unsubscribe();
    summary.open();
    continuation.open();
    await coordinator.close();
  }
});

for (const failed of [false, true])
  test(`terminal completion follows the final queued ${failed ? 'failure' : 'success'}`, async () => {
    const { coordinator, a } = await fixture();
    const gate = new TurnGate();
    const output: string[] = [];
    const stop = watchTerminal(coordinator, undefined, (data) =>
      output.push(data),
    );
    try {
      a.refuseSteer = true;
      a.gate = gate;
      const first = coordinator.send('first queued turn');
      await within(gate.entered, 5000, 'the first turn');
      await coordinator.send('second queued turn');
      void gate.result.then(() => {
        a.gate = undefined;
        a.failNext = failed;
      });
      gate.open();
      await first;
      await next();
      assert.equal(a.inputs.length, 2);
      assert.ok(a.inputs[1]!.prompt === 'second queued turn');
      assert.deepEqual(
        output.filter((data) => data.startsWith('\u001b]777;')),
        failed
          ? []
          : [
              '\u001b]777;notify;Witch;Turn complete: first queued turn\u001b\\\u0007',
            ],
      );
    } finally {
      stop();
      gate.open();
      await coordinator.close();
    }
  });

test('clearing a publication report without another turn does not replay completion', async () => {
  const { coordinator, a, hook } = await fixture();
  const output: string[] = [];
  const stop = watchTerminal(coordinator, undefined, (data) =>
    output.push(data),
  );
  try {
    hook.current = async (command, run) => {
      if (command[0] !== 'update-ref') return run();
      hook.current = passThrough;
      return { stdout: Buffer.alloc(0), stderr: 'cannot lock ref', code: 1 };
    };
    await coordinator.send('remember-port');
    await next();
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.match(coordinator.snapshot.error!, /cannot lock ref/);
    const completed = coordinator.snapshot.completedTurn;
    assert.ok(completed);
    assert.equal(a.inputs.length, 1);
    assert.deepEqual(
      output.filter((data) => data.startsWith('\u001b]777;')),
      [],
    );
    await coordinator.selectModel({ agent: 'a', id: 'a-big' });
    await next();
    assert.equal(coordinator.snapshot.error, undefined);
    assert.equal(coordinator.snapshot.completedTurn, completed);
    assert.equal(a.inputs.length, 1);
    assert.deepEqual(
      output.filter((data) => data.startsWith('\u001b]777;')),
      [],
    );
  } finally {
    hook.current = passThrough;
    stop();
    await coordinator.close();
  }
});
