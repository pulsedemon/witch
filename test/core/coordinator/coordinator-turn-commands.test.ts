import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { ranCommand } from '../../../src/core/prompts.js';
import { TurnGate } from '../../fixtures/agent.js';
import {
  notices,
  readRecord,
  turns,
  unitFixture,
} from '../../fixtures/coordinator.js';
import { until, within } from '../../fixtures/within.js';

test('an unsent follow-up prompt never reruns an executed command', async () => {
  const { coordinator, a } = await unitFixture();
  const session = a.sessions[0]!.session;
  const send = session.send.bind(session);

  session.send = async () => ({
    status: 'failed',
    text: '',
    error: 'Input delivery failed',
    inputUnsent: true,
  });

  try {
    await coordinator.send('!echo once');
    assert.deepEqual(a.shells, ['echo once']);
    assert.deepEqual(coordinator.snapshot.queue, []);
    session.send = send;
    await coordinator.send('followup 29');
    assert.deepEqual(a.shells, ['echo once']);

    assert.deepEqual(
      a.inputs.map(({ prompt }) => prompt),
      ['followup 29'],
    );
  } finally {
    await coordinator.close();
  }
});

test('a ! prompt runs its command, then a turn that sends the prompt as typed and says it ran, and its open row survives a reopen', async () => {
  const { coordinator, a, reopen } = await unitFixture();

  try {
    await coordinator.send('!git status');
    assert.deepEqual(a.shells, ['git status']);
    assert.equal(a.inputs.length, 1);
    assert.equal(a.inputs[0]!.prompt, '!git status');
    assert.ok(a.inputs[0]!.context!.includes(ranCommand));
    const { items } = coordinator.snapshot;

    assert.deepEqual(
      items.map(({ kind }) => kind),
      ['user', 'tool', 'assistant'],
    );

    assert.equal(items[0]!.text, '!git status');
    assert.equal(items[1]!.title, 'git status');
    assert.equal(items[1]!.shell, true);
  } finally {
    await coordinator.close();
  }

  const reopened = await reopen();

  try {
    const row = reopened.snapshot.items.find(({ kind }) => kind === 'tool');
    assert.equal(row?.shell, true);
  } finally {
    await reopened.close();
  }
});

test('a ! prompt sent during a turn waits in the queue and runs alone before the prompts after it', async () => {
  const { coordinator, a } = await unitFixture();
  const gate = new TurnGate();

  try {
    a.gate = gate;
    const first = coordinator.send('first');
    await within(gate.entered, 2000, 'the gated turn');
    await coordinator.send('!ls');
    await coordinator.send('after');
    assert.deepEqual(coordinator.snapshot.queue, ['!ls', 'after']);
    assert.deepEqual(a.steers, []);
    gate.open();
    await within(first, 5000, 'the queue');
    const prompts = a.inputs.map(({ prompt }) => prompt);
    assert.equal(prompts.length, 3);
    assert.ok(prompts[0]! === 'first');
    assert.ok(prompts[1]! === '!ls');
    assert.ok(prompts[2]! === 'after');
    assert.deepEqual(a.shells, ['ls']);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a ! command that fails posts its error and sends no turn', async () => {
  const { coordinator, a } = await unitFixture();

  try {
    a.failNext = true;
    await coordinator.send('!x');
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.deepEqual(a.inputs, []);
    const last = coordinator.snapshot.items.at(-1);
    assert.equal(last?.kind, 'notice');
    assert.equal(last?.text, 'Overloaded');
  } finally {
    await coordinator.close();
  }
});

test('an interrupt that lands as a ! command finishes sends no turn', async () => {
  const { coordinator, a } = await unitFixture();
  const gate = new TurnGate();

  try {
    a.gate = gate;
    a.finishShellOnInterrupt = true;
    const sending = coordinator.send('!x');
    await within(gate.entered, 2000, 'the gated command');
    await coordinator.interrupt();
    await within(sending, 3000, 'the turn');
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.deepEqual(a.inputs, []);
    const last = coordinator.snapshot.items.at(-1);
    assert.equal(last?.kind, 'notice');
    assert.equal(last?.text, 'Turn interrupted');
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('after the reply, while a familiar holds the turn, a ! prompt runs at once and steers its reply, shown after the prompt', async () => {
  const { coordinator, a } = await unitFixture();
  const gate = new TurnGate();

  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    a.replied = true;
    await coordinator.send('!git status');
    assert.deepEqual(a.shells, ['git status']);

    assert.deepEqual(a.steers, [
      '!git status\n\nThe user ran this command themselves, and its output is above. Reply to it without running it again.',
    ]);

    assert.deepEqual(coordinator.snapshot.queue, []);
    const [prompt, row] = coordinator.snapshot.items.slice(-2);
    assert.equal(prompt?.kind, 'user');
    assert.equal(prompt?.text, '!git status');
    assert.equal(row?.kind, 'tool');
    assert.equal(row?.title, 'git status');
    assert.equal(row?.shell, true);
    gate.open();
    await within(sending, 2000, 'the turn');
    assert.deepEqual(turns(a), [['Start', undefined]]);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('after the reply, a listed spell steers trimmed with its call, and an unlisted slash command steers as a prompt', async () => {
  const { coordinator, a } = await unitFixture(undefined, (a) => {
    a.skills = [{ name: 'review', description: 'Review changes' }];
  });

  const gate = new TurnGate();

  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    a.replied = true;
    await coordinator.send(' /review now');
    await coordinator.send('/unlisted-command');
    assert.deepEqual(a.steers, ['/review now', '/unlisted-command']);
    assert.deepEqual(a.skillSteers, [{ name: 'review', args: 'now' }]);
    assert.deepEqual(coordinator.snapshot.queue, []);
    gate.open();
    await within(sending, 2000, 'the turn');
    assert.deepEqual(turns(a), [['Start', undefined]]);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test("a model change runs during a replied turn without waiting, and is refused during one that hasn't replied", async () => {
  const { coordinator, a, b } = await unitFixture();
  const gate = new TurnGate();

  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');

    await assert.rejects(
      coordinator.selectModel({ agent: 'a', id: 'a-big', effort: 'high' }),
      {
        message: 'Stop the current operation first',
      },
    );

    a.replied = true;
    await coordinator.selectModel({ agent: 'a', id: 'a-big', effort: 'high' });
    assert.equal(coordinator.snapshot.phase, 'running');
    assert.deepEqual(a.selections.at(-1), ['a-big', 'high']);
    assert.equal(coordinator.snapshot.conversation!.sessions.a!.model, 'a-big');
    const discoveries = b.discoveries.length;
    const sourceInputs = a.inputs.length;

    await assert.rejects(
      coordinator.selectModel({ agent: 'b', id: 'b-big' }),
      /Wait for the running familiars or workflows/,
    );

    assert.equal(a.inputs.length, sourceInputs);
    assert.equal(a.sessions.at(-1)!.session.closed, false);
    assert.equal(b.sessions.length, 0);
    assert.equal(b.discoveries.length, discoveries);
    gate.open();
    await within(sending, 2000, 'the turn');
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a model change during a replied turn refuses another until it finishes, and the refusal reports as a notice', async () => {
  const { coordinator, a } = await unitFixture();
  const gate = new TurnGate();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first: Promise<void> | undefined;
  let duplicate: Promise<void> | undefined;

  try {
    const { session } = a.sessions.at(-1)!;
    const select = session.selectModel.bind(session);

    session.selectModel = async (...args) => {
      entered.resolve();
      await release.promise;
      await select(...args);
    };

    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    a.replied = true;
    const before = a.selections.length;

    first = coordinator.selectModel({
      agent: 'a',
      id: 'a-big',
      effort: 'high',
    });

    await within(entered.promise, 2000, 'the model change');
    duplicate = coordinator.selectModel({ agent: 'a', id: 'a-model' });

    const refusal = await within(
      duplicate.catch((error: unknown) => error),
      2000,
      'the overlapping model change refusal',
    );

    assert.ok(refusal instanceof Error);
    assert.equal(refusal.message, 'Stop the current operation first');
    coordinator.report(refusal);
    assert.equal(coordinator.snapshot.error, undefined);
    const notice = coordinator.snapshot.items.at(-1);

    assert.deepEqual(
      [notice?.kind, notice?.text],
      ['notice', 'Stop the current operation first'],
    );

    release.resolve();
    await first;
    assert.deepEqual(a.selections.slice(before), [['a-big', 'high']]);
    assert.equal(coordinator.snapshot.conversation!.sessions.a!.model, 'a-big');
    await coordinator.selectModel({ agent: 'a', id: 'a-model' });

    assert.equal(
      coordinator.snapshot.conversation!.sessions.a!.model,
      'a-model',
    );

    gate.open();
    await within(sending, 2000, 'the turn');
  } finally {
    release.resolve();
    await Promise.allSettled([first, duplicate]);
    gate.open();
    await coordinator.close();
  }
});

for (const rejected of [false, true])
  test(
    rejected
      ? 'a rejected replied model change leaves queued prompts unsent'
      : 'a replied model change finishes before the next queued turn starts',
    async () => {
      const { coordinator, a, root } = await unitFixture();
      const gate = new TurnGate();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const atNextSend: { model: string; effort?: string }[] = [];
      const order: string[] = [];
      let selecting: Promise<void> | undefined;
      let sending: Promise<void> | undefined;

      try {
        const { session } = a.sessions.at(-1)!;
        const select = session.selectModel.bind(session);

        session.selectModel = async (...args) => {
          entered.resolve();
          await release.promise;

          if (rejected) throw new Error('Model rejected');

          await select(...args);
          order.push('selection completed');
        };

        const send = session.send.bind(session);

        session.send = async (prompt, options) => {
          if (prompt === '/queued') {
            atNextSend.push({
              model: session.info.model,
              effort: session.info.effort,
            });

            order.push('queued send');
          }

          return send(prompt, options);
        };

        a.gate = gate;
        sending = coordinator.send('Start');
        await within(gate.entered, 2000, 'the first turn');
        a.replied = true;

        const change = coordinator.selectModel({
          agent: 'a',
          id: 'a-big',
          effort: 'high',
        });

        selecting = rejected
          ? assert.rejects(change, { message: 'Model rejected' })
          : change;

        await within(entered.promise, 2000, 'the model change');
        a.refuseSteer = true;
        await coordinator.send('/queued');
        gate.open();
        await within(gate.result, 2000, 'the native turn');
        // the native result precedes coordinator persistence and its next queue read
        await delay(400);
        assert.deepEqual(atNextSend, []);
        assert.deepEqual(coordinator.snapshot.queue, ['/queued']);
        release.resolve();

        await within(
          Promise.all([selecting, sending]),
          3000,
          'the settled model change',
        );

        if (rejected) {
          assert.equal(coordinator.snapshot.error, 'Model rejected');
          assert.deepEqual(coordinator.snapshot.queue, ['/queued']);
          assert.equal(a.inputs.length, 1);

          assert.equal(
            coordinator.snapshot.conversation!.sessions.a!.model,
            'a-model',
          );
        } else {
          assert.deepEqual(atNextSend, [{ model: 'a-big', effort: 'high' }]);
          assert.deepEqual(order, ['selection completed', 'queued send']);

          const saved = await readRecord(
            root,
            coordinator.snapshot.conversation!.id,
          );

          assert.equal(saved.sessions.a!.model, 'a-big');
          assert.equal(saved.sessions.a!.effort, 'high');
          assert.deepEqual(coordinator.snapshot.queue, []);

          assert.deepEqual(turns(a), [
            ['Start', undefined],
            ['/queued', undefined],
          ]);
        }
      } finally {
        release.resolve();
        gate.open();
        await selecting;
        await coordinator.close();
        await sending;
      }
    },
  );

test('a replied turn opens the model list from its connect without refreshing', async () => {
  const { coordinator, a } = await unitFixture();
  const gate = new TurnGate();

  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    a.replied = true;
    const { models } = coordinator.snapshot;
    a.failModels = true;
    assert.equal(await coordinator.refreshModels(), true);
    assert.equal(coordinator.snapshot.models, models);
    assert.equal(a.failModels, true);
    gate.open();
    await within(sending, 2000, 'the turn');
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('commands that need idle say familiars or workflows hold the turn, and the usual refusal otherwise', async () => {
  const { coordinator, a } = await unitFixture();
  const gate = new TurnGate();

  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');

    await assert.rejects(coordinator.newConversation(), {
      message: 'Stop the current operation first',
    });

    a.replied = true;

    await assert.rejects(coordinator.newConversation(), {
      message:
        'Wait for the running familiars or workflows to report, or press Escape to stop them',
    });

    gate.open();
    await within(sending, 2000, 'the turn');
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a ! command whose shell ran gets its reply when a delivery hold arrived meanwhile', async () => {
  const f = await unitFixture();
  const gate = new TurnGate();

  try {
    f.a.gate = gate;
    const sending = f.coordinator.send('!pnpm test');
    await within(gate.entered, 2000, 'the gated shell');
    const release = f.coordinator.holdPromptDelivery();
    gate.open();
    await within(sending, 2000, 'the command turn');
    assert.deepEqual(f.a.shells, ['pnpm test']);
    assert.deepEqual(turns(f.a), [['!pnpm test', undefined]]);
    assert.deepEqual(notices(f.coordinator), []);
    assert.ok(f.coordinator.snapshot.completedTurn);
    release();
    await f.coordinator.send('after');

    assert.deepEqual(turns(f.a), [
      ['!pnpm test', undefined],
      ['after', undefined],
    ]);

    assert.deepEqual(f.a.shells, ['pnpm test']);
  } finally {
    gate.open();
    await f.coordinator.close();
  }
});

test("a /compact requested while a ! command runs waits for the command's reply", async () => {
  const f = await unitFixture();
  const gate = new TurnGate();

  try {
    await f.coordinator.send('seed');
    const native = f.a.sessions[0]!.session;

    const compact = native.compact.bind(native),
      send = native.send.bind(native);

    const order: string[] = [];

    native.compact = () => {
      order.push('compact');

      return compact();
    };

    native.send = (...args) => {
      order.push('send');

      return send(...args);
    };

    f.a.gate = gate;
    const sending = f.coordinator.send('!pnpm test');
    await until('the shell', () => f.a.shells.length === 1);
    const compacting = f.coordinator.compact();
    gate.open();
    await within(sending, 2000, 'the command turn');
    assert.equal(await within(compacting, 2000, 'the compaction'), true);
    assert.deepEqual(order, ['send', 'compact']);

    assert.deepEqual(turns(f.a), [
      ['seed', undefined],
      ['!pnpm test', undefined],
    ]);

    assert.deepEqual(notices(f.coordinator), ['Conversation compacted']);
  } finally {
    gate.open();
    await f.coordinator.close();
  }
});

test('a prompt queued behind a ! command stays queued when a hold releases into its open turn', async () => {
  const { coordinator, a } = await unitFixture();
  const shell = new TurnGate();
  const reply = new TurnGate();

  try {
    a.gate = shell;
    const sending = coordinator.send('!ls');
    await within(shell.entered, 2000, 'the gated shell');
    await coordinator.send('C');
    a.gate = reply;
    // the reply's turn has replied and a familiar holds it open
    a.replied = true;
    shell.open();
    await within(reply.entered, 2000, 'the gated reply');
    coordinator.holdPromptDelivery()();
    // the skipped steer has no event to wait on
    await delay(100);
    assert.deepEqual(a.steers, []);
    assert.deepEqual(coordinator.snapshot.queue, ['C']);
    reply.open();
    await within(sending, 5000, 'the queued turns');

    assert.deepEqual(turns(a), [
      ['!ls', undefined],
      ['C', undefined],
    ]);
  } finally {
    shell.open();
    reply.open();
    await coordinator.close();
  }
});
