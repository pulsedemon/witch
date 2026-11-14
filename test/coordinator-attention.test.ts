import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { setImmediate as next } from 'node:timers/promises';
import { Coordinator } from '../src/core/coordinator.js';
import type { ConversationRecord } from '../src/core/state.js';
import { ConversationStore } from '../src/persistence/store.js';
import { watchTerminal } from '../src/ui/terminal.js';
import { TurnGate } from './fixtures/agent.js';
import { fixture, unitFixture, readRecord } from './fixtures/coordinator.js';
import { passThrough } from './fixtures/git.js';
import { within } from './fixtures/within.js';

test('completion identifies the successful activity only after its final save', async () => {
  const { coordinator, a, root } = await fixture();
  const gate = new TurnGate();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const save = ConversationStore.prototype.save;
  let saving: { mockRestore(): void } | undefined;

  try {
    a.gate = gate;

    const sending = coordinator.send('remember-port');

    await within(gate.entered, 5000, 'the native turn');

    // admitting the prompt saves the record too, so the spy starts once the turn holds its activity
    const spy = vi
      .spyOn(ConversationStore.prototype, 'save')
      .mockImplementation(function (
        this: ConversationStore,
        record: ConversationRecord,
      ) {
        if (record.activity) return save.call(this, record);

        spy.mockRestore();

        entered.resolve();

        return release.promise.then(() => save.call(this, record));
      });

    saving = spy;

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

    assert.deepEqual(stored.lastTurn, { id: activity.id, status: 'completed' });

    assert.equal(coordinator.snapshot.completedTurn, stored.lastTurn.id);
  } finally {
    saving?.mockRestore();

    release.resolve();

    gate.open();

    await coordinator.close();
  }
});

test('a rejected final save publishes no completion', async () => {
  const { coordinator, a } = await unitFixture();
  const gate = new TurnGate();
  const save = ConversationStore.prototype.save;
  let saving: { mockRestore(): void } | undefined;

  try {
    a.gate = gate;

    const sending = coordinator.send('successful native result');

    await within(gate.entered, 5000, 'the native turn');

    const spy = vi
      .spyOn(ConversationStore.prototype, 'save')
      .mockImplementation(function (
        this: ConversationStore,
        record: ConversationRecord,
      ) {
        if (record.activity) return save.call(this, record);

        spy.mockRestore();

        return Promise.reject(new Error('final save rejected'));
      });

    saving = spy;

    gate.open();

    await sending;

    assert.match(coordinator.snapshot.error!, /final save rejected/);

    assert.equal(coordinator.snapshot.completedTurn, undefined);
  } finally {
    saving?.mockRestore();

    gate.open();

    await coordinator.close();
  }
});

for (const outcome of ['failed', 'interrupted', 'preparation'] as const)
  test(`${outcome} turns clear the preceding successful completion`, async () => {
    const { coordinator, a, hook, root } = await fixture();
    const gate = new TurnGate();

    try {
      await coordinator.send('previous success');

      assert.ok(coordinator.snapshot.completedTurn);

      const id = coordinator.snapshot.conversation!.id;
      const previous = (await readRecord(root, id)).lastTurn;
      const turns = a.inputs.length;

      if (outcome === 'preparation')
        hook.current = async (command, run) => {
          if (command[0] !== 'status') return run();

          hook.current = passThrough;

          return {
            stdout: Buffer.alloc(0),
            stderr: 'preparation failed',
            code: 1,
          };
        };
      else {
        a.gate = gate;

        a.failNext = outcome === 'failed';
      }

      const sending = coordinator.send('next turn');

      if (outcome !== 'preparation') {
        await within(gate.entered, 5000, 'the next turn');

        const activity = (await readRecord(root, id)).activity!;

        if (outcome === 'interrupted') await coordinator.interrupt();
        else gate.open();

        await sending;

        const stored = await readRecord(root, id);

        assert.deepEqual(stored.lastTurn, { id: activity.id, status: outcome });

        assert.notEqual(stored.lastTurn.id, previous!.id);
      } else await sending;

      assert.equal(coordinator.snapshot.completedTurn, undefined);

      assert.equal(
        a.inputs.length,
        turns + (outcome === 'preparation' ? 0 : 1),
      );

      if (outcome === 'preparation') {
        assert.match(coordinator.snapshot.error!, /preparation failed/);

        assert.deepEqual(coordinator.snapshot.queue, ['next turn']);

        assert.deepEqual((await readRecord(root, id)).lastTurn, previous);
      }
    } finally {
      hook.current = passThrough;

      gate.open();

      await coordinator.close();
    }
  });

test('reconnect and restart retain the ordinary outcome without replaying completion', async () => {
  const f = await unitFixture();
  const output: string[] = [];

  const stop = watchTerminal(f.coordinator, undefined, (data) =>
    output.push(data),
  );

  let reopened: Coordinator | undefined;
  let stopReopened: (() => void) | undefined;

  try {
    await f.coordinator.send('finished task');

    await next();

    const id = f.coordinator.snapshot.conversation!.id;
    const previous = (await readRecord(f.root, id)).lastTurn!;

    assert.equal(previous.status, 'completed');

    assert.equal(previous.id, f.coordinator.snapshot.completedTurn);

    assert.equal(
      output.filter((data) => data.includes('Turn complete:')).length,
      1,
    );

    await f.a.sessions.at(-1)!.session.close();

    await f.coordinator.selectModel({ agent: 'a', id: 'a-big' });

    await next();

    assert.deepEqual((await readRecord(f.root, id)).lastTurn, previous);

    assert.equal(f.a.inputs.length, 1);

    assert.equal(
      output.filter((data) => data.includes('Turn complete:')).length,
      1,
    );

    stop();

    await f.coordinator.close();

    reopened = new Coordinator(
      f.store,
      f.memory,
      [f.a, f.b].map((adapter) => ({ adapter, executable: adapter.id })),
    );

    const resumedOutput: string[] = [];

    stopReopened = watchTerminal(reopened, undefined, (data) =>
      resumedOutput.push(data),
    );

    await reopened.initialize(f.project, { continue: true });

    await next();

    assert.deepEqual((await readRecord(f.root, id)).lastTurn, previous);

    assert.equal(reopened.snapshot.completedTurn, undefined);

    assert.equal(f.a.inputs.length, 1);

    assert.deepEqual(
      resumedOutput.filter((data) => data.includes('Turn complete:')),
      [],
    );

    await reopened.send('new request');

    await next();

    const current = (await readRecord(f.root, id)).lastTurn!;

    assert.equal(current.status, 'completed');

    assert.notEqual(current.id, previous.id);

    assert.equal(reopened.snapshot.completedTurn, current.id);

    assert.equal(
      resumedOutput.filter((data) => data.includes('Turn complete:')).length,
      1,
    );
  } finally {
    stop();

    stopReopened?.();

    await reopened?.close();

    await f.coordinator.close();
  }
});

test('conversation adoption clears completion and the internal handoff summary stays silent', async () => {
  const { coordinator, a, b } = await unitFixture();
  const summary = new TurnGate();
  const destination = new TurnGate();
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

    b.gate = destination;

    const switching = coordinator.selectModel({ agent: 'b', id: 'b-model' });

    await within(summary.entered, 5000, 'the summary');

    summary.open();

    await within(switching, 5000, 'the switch without continuation');

    assert.deepEqual(b.inputs, []);

    assert.equal(coordinator.snapshot.completedTurn, previous);

    assert.deepEqual([...signals], [previous]);

    const sending = coordinator.send('Destination task');

    await within(destination.entered, 5000, 'the destination prompt');

    assert.equal(coordinator.snapshot.completedTurn, undefined);

    destination.open();

    await sending;

    const current = coordinator.snapshot.completedTurn;

    assert.ok(current);

    assert.notEqual(current, previous);

    assert.deepEqual([...signals], [previous, current]);
  } finally {
    unsubscribe();

    summary.open();

    destination.open();

    await coordinator.close();
  }
});

for (const failed of [false, true])
  test(`terminal completion follows the final queued ${failed ? 'failure' : 'success'}`, async () => {
    const { coordinator, a } = await unitFixture();
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
