import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { Workspace } from '../src/memory/workspace.js';
import { Attachments } from '../src/core/attachments.js';
import { callControl } from '../src/persistence/control.js';
import { ConversationStore } from '../src/persistence/store.js';
import { FixtureAgent, TurnGate } from './fixtures/agent.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import {
  pauseDiscovery,
  unitCoordinationFixture,
} from './fixtures/coordination.js';
import { passThrough } from './fixtures/git.js';
import { png } from './fixtures/png.js';
import { scratch } from './fixtures/scratch.js';
import { until, within } from './fixtures/within.js';
import { notices } from './fixtures/coordinator.js';
import {
  continuation,
  exhaustion,
  models,
  reading,
} from './fixtures/coordinator-exhaustion.js';

async function completedForBackground(
  prepare?: (claude: FixtureAgent, codex: FixtureAgent) => void,
) {
  const f = await exhaustion(prepare);

  await f.coordinator.send('Review schema changes');

  return { ...f, emit: f.claude.sessions.at(-1)!.options.onEvent };
}

test('background exhaustion continues completed work with reports before queued input, once', async () => {
  const { coordinator, claude, codex, emit } = await completedForBackground();

  try {
    const before = coordinator.snapshot.conversation!;

    emit({ type: 'running', running: true });

    emit({
      type: 'tool',
      id: 'review',
      title: 'Review completed',
      done: true,
      text: 'Keep the unique index.',
    });

    emit({ type: 'exhausted' });

    emit({ type: 'exhausted' });

    await coordinator.send('Queued separately');

    assert.equal(codex.inputs.length, 0);

    emit({ type: 'running', running: false });

    await until(
      'background continuation and queued input',
      () => codex.inputs.length === 2 && coordinator.snapshot.phase === 'idle',
    );

    assert.equal(coordinator.snapshot.conversation!.id, before.id);

    assert.equal(
      coordinator.snapshot.conversation!.sessions.codex!.model,
      'gpt-6.1-astra',
    );

    assert.deepEqual(
      codex.inputs.map(({ prompt }) => prompt),
      [continuation, 'Queued separately'],
    );

    assert.match(codex.inputs[0]!.context!, /Keep the unique index/);

    assert.match(codex.inputs[0]!.context!, /Review schema changes/);

    assert.ok(!codex.inputs[0]!.context!.includes('User: Queued separately'));

    assert.equal(claude.inputs.length, 1);

    emit({ type: 'exhausted' });

    await coordinator.send('Still on destination');

    assert.equal(codex.inputs.length, 3);

    assert.equal(claude.inputs.length, 1);
  } finally {
    await coordinator.close();
  }
});

test('a pending compact runs on the destination after background continuation', async () => {
  const { coordinator, claude, codex, emit } = await completedForBackground();

  try {
    emit({ type: 'running', running: true });

    emit({ type: 'exhausted' });

    const compacting = coordinator.compact();

    await coordinator.send('After compact');

    emit({ type: 'running', running: false });

    assert.equal(await within(compacting, 5000, 'destination compact'), true);

    await until(
      'queued prompt after compact',
      () => codex.inputs.length === 2 && coordinator.snapshot.phase === 'idle',
    );

    assert.equal(claude.compactions.length, 0);

    assert.equal(codex.compactions.length, 1);

    assert.deepEqual(
      codex.inputs.map(({ prompt }) => prompt),
      [continuation, 'After compact'],
    );
  } finally {
    await coordinator.close();
  }
});

test('background exhaustion blocked by a command leaves the queue for the composer', async () => {
  const { coordinator, claude, codex, emit } = await completedForBackground();
  const release = coordinator.holdPromptDelivery();

  try {
    emit({ type: 'running', running: true });

    emit({ type: 'exhausted' });

    await coordinator.send('Queued');

    emit({ type: 'running', running: false });

    await until('command blocker', () =>
      notices(coordinator).includes(
        "claude is out of usage. Witch won't switch while commands are pending.",
      ),
    );

    release();

    assert.equal(codex.inputs.length, 0);

    assert.equal(claude.inputs.length, 1);

    assert.deepEqual(coordinator.snapshot.queue, ['Queued']);
  } finally {
    release();

    await coordinator.close();
  }
});

test('Escape cancels a pending background switch and late events cannot revive it', async () => {
  const { coordinator, claude, codex, emit } = await completedForBackground();

  try {
    emit({ type: 'running', running: true });

    emit({ type: 'exhausted' });

    await coordinator.interrupt();

    emit({ type: 'running', running: false });

    emit({ type: 'exhausted' });

    assert.equal(coordinator.snapshot.conversation!.agent, 'claude');

    assert.equal(codex.inputs.length, 0);

    await coordinator.send('User resumed');

    assert.equal(claude.inputs.length, 2);

    assert.equal(codex.inputs.length, 0);
  } finally {
    await coordinator.close();
  }
});

test('background memory waits for recovery, then continues completed work on the destination', async () => {
  const { coordinator, claude, codex, emit, store } =
    await completedForBackground();

  try {
    emit({ type: 'running', running: true });

    await writeFile(
      join(claude.sessions.at(-1)!.options.memoryDirectories[1]!, 'MEMORY.md'),
      'Background note.',
    );

    emit({ type: 'exhausted' });

    emit({ type: 'running', running: false });

    await until(
      'background memory recovery',
      () => coordinator.snapshot.phase === 'recovery',
    );

    assert.equal(codex.inputs.length, 0);

    assert.equal(
      (await store.records()).records.find(
        ({ id }) => id === coordinator.snapshot.conversation!.id,
      )!.lastTurn!.status,
      'completed',
    );

    await assert.rejects(
      coordinator.recoverMemory('keep'),
      /Accept these memory changes/,
    );

    await coordinator.send('Queued during recovery');

    await coordinator.recoverMemory('accept');

    await until(
      'recovered background continuation',
      () => codex.inputs.length === 2 && coordinator.snapshot.phase === 'idle',
    );

    assert.deepEqual(
      codex.inputs.map(({ prompt }) => prompt),
      [continuation, 'Queued during recovery'],
    );

    assert.match(codex.inputs[0]!.context!, /Background note/);

    assert.equal(claude.inputs.length, 1);
  } finally {
    await coordinator.close();
  }
});

for (const stage of ['add', 'commit'] as const)
  test(`background exhaustion during memory ${stage} retains dirty notes without changing the completed outcome`, async () => {
    const { coordinator, claude, codex, hook, store } = await exhaustion();
    let armed = false;
    const emit = claude.sessions.at(-1)!.options.onEvent;

    claude.onSend = async () => {
      armed = true;
    };

    hook.current = async (command, run) => {
      const result = await run();

      if (armed && command[0] === stage) {
        armed = false;

        emit({ type: 'running', running: true });

        emit({ type: 'exhausted' });

        emit({ type: 'running', running: false });
      }

      return result;
    };

    try {
      await coordinator.send('remember-port');

      assert.equal(coordinator.snapshot.phase, 'recovery');

      assert.equal(
        (await store.records()).records.find(
          ({ id }) => id === coordinator.snapshot.conversation!.id,
        )!.lastTurn!.status,
        'completed',
      );

      assert.match(coordinator.snapshot.recovery!.diff, /4567/);

      assert.equal(codex.inputs.length, 0);

      assert.ok(
        (await store.records()).records.find(
          ({ id }) => id === coordinator.snapshot.conversation!.id,
        )!.activity,
      );

      hook.current = passThrough;

      await coordinator.recoverMemory('discard');

      await until(
        'continuation after discarding background memory',
        () =>
          codex.inputs.length === 1 && coordinator.snapshot.phase === 'idle',
      );

      assert.deepEqual(
        codex.inputs.map(({ prompt }) => prompt),
        [continuation],
      );
    } finally {
      hook.current = passThrough;

      await coordinator.close();
    }
  });

test('a background switch with no destination reports a blocker and retains queued input', async () => {
  const { coordinator, claude, codex, emit } = await completedForBackground(
    (_, codex) => {
      codex.accountRead = reading(100);
    },
  );

  try {
    emit({ type: 'running', running: true });

    emit({ type: 'exhausted' });

    await coordinator.send('Retain this');

    emit({ type: 'running', running: false });

    await until('background capacity blocker', () =>
      notices(coordinator).some((text) =>
        text.includes('no other runtime can continue'),
      ),
    );

    assert.equal(coordinator.snapshot.conversation!.agent, 'claude');

    assert.equal(claude.inputs.length, 1);

    assert.equal(codex.inputs.length, 0);

    assert.deepEqual(coordinator.snapshot.queue, ['Retain this']);
  } finally {
    await coordinator.close();
  }
});

test('a background continuation that exhausts the destination stops after one hop', async () => {
  const { coordinator, claude, codex, emit } = await completedForBackground(
    (_, codex) => {
      codex.exhaust = () => true;
    },
  );

  try {
    emit({ type: 'exhausted' });

    await until('destination exhaustion', () =>
      notices(coordinator).some((text) => text.includes('also out of usage')),
    );

    assert.equal(coordinator.snapshot.conversation!.agent, 'codex');

    assert.equal(claude.inputs.length, 1);

    assert.equal(codex.inputs.length, 1);
  } finally {
    await coordinator.close();
  }
});

test('a peer pause cancels background switching and a later continuation preserves the claim', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);
  const initiator = await f.start('A');
  const claude = new FixtureAgent('claude');
  const codex = new FixtureAgent('codex');

  claude.catalog.splice(0, Infinity, ...models(['claude-fable-5-2']));

  codex.catalog.splice(0, Infinity, ...models(['gpt-6-astra']));

  for (const adapter of [claude, codex]) adapter.accountRead = reading(10);

  const target = await f.start(
    'B',
    {},
    [claude, codex].map((adapter) => ({ adapter, executable: adapter.id })),
  );

  await target.coordinator.selectModel({
    agent: 'claude',
    id: 'claude-fable-5-2',
  });

  const claim = await target.claim('task:background-work', 'background task');

  if (claim.kind !== 'claimed') assert.fail(JSON.stringify(claim));

  await target.coordinator.send('Work on the task');

  const emit = claude.sessions.at(-1)!.options.onEvent;

  emit({ type: 'running', running: true });

  emit({ type: 'exhausted' });

  const pause = await callControl(await initiator.binding(), {
    kind: 'pause',
    to: [target.coordinator.snapshot.conversation!.id],
  });

  if (pause.kind !== 'pause') assert.fail(JSON.stringify(pause));

  await target.coordination.context();

  await until('pause interrupt', () =>
    claude.stops.some(({ operation }) => operation === 'interrupt'),
  );

  emit({ type: 'running', running: false });

  emit({ type: 'exhausted' });

  assert.equal(codex.inputs.length, 0);

  await callControl(await initiator.binding(), {
    kind: 'resume',
    pause: pause.pause.id,
  });

  await target.coordination.context();

  await target.coordinator.send('Resume the task');

  emit({ type: 'running', running: true });

  emit({ type: 'exhausted' });

  emit({ type: 'running', running: false });

  await until(
    'resumed background continuation',
    () =>
      codex.inputs.length === 1 && target.coordinator.snapshot.phase === 'idle',
  );

  assert.equal((await target.query()).ownClaim?.id, claim.claim.id);

  assert.equal(claude.inputs.length, 2);

  assert.equal(target.coordinator.snapshot.conversation!.agent, 'codex');
});

test('background settlement failure releases pending compaction and keeps the source', async () => {
  const { coordinator, codex, emit, hook } = await completedForBackground();

  try {
    emit({ type: 'running', running: true });

    emit({ type: 'exhausted' });

    hook.current = async (command, run) => {
      if (command[0] === 'status') {
        hook.current = passThrough;

        throw new Error('background memory unavailable');
      }

      return run();
    };

    const compacting = coordinator.compact();

    emit({ type: 'running', running: false });

    assert.equal(
      await within(compacting, 5000, 'failed background settlement'),
      false,
    );

    assert.match(coordinator.snapshot.error!, /background memory unavailable/);

    assert.equal(codex.inputs.length, 0);

    assert.equal(coordinator.snapshot.conversation!.agent, 'claude');
  } finally {
    hook.current = passThrough;

    await coordinator.close();
  }
});

for (const blocked of ['capacity', 'command'] as const)
  test(`background recovery attempts a ${blocked}-blocked switch only once`, async () => {
    const { coordinator, claude, codex, emit } = await completedForBackground();
    let release = () => {};

    try {
      await writeFile(
        join(
          claude.sessions.at(-1)!.options.memoryDirectories[1]!,
          'MEMORY.md',
        ),
        'Unfinished background note.',
      );

      emit({ type: 'exhausted' });

      await until(
        'memory decision',
        () => coordinator.snapshot.phase === 'recovery',
      );

      let attempts = 0;

      codex.accountRead = async () => {
        attempts++;

        return reading(100)();
      };

      if (blocked === 'command') release = coordinator.holdPromptDelivery();

      await coordinator.send('Retained input');

      await coordinator.recoverMemory('accept');

      await until(
        'single blocker',
        () =>
          coordinator.snapshot.phase === 'idle' &&
          notices(coordinator).some((text) =>
            text.includes(
              blocked === 'capacity'
                ? 'no other runtime can continue'
                : 'commands are pending',
            ),
          ),
      );

      const count = notices(coordinator).filter((text) =>
        text.includes(
          blocked === 'capacity'
            ? 'no other runtime can continue'
            : 'commands are pending',
        ),
      ).length;

      assert.equal(count, 1);

      assert.equal(attempts, blocked === 'capacity' ? 1 : 0);

      assert.deepEqual(coordinator.snapshot.queue, ['Retained input']);

      assert.equal(claude.inputs.length, 1);

      assert.equal(codex.inputs.length, 0);
    } finally {
      release();

      await coordinator.close();
    }
  });

for (const preparing of ['context', 'images'] as const)
  test(`background exhaustion stops a queued prompt during ${preparing} preparation`, async () => {
    const { coordinator, claude, codex, emit } = await completedForBackground();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    try {
      if (preparing === 'context') {
        const session = claude.sessions.at(-1)!.session;
        const context = session.contextUsage.bind(session);

        vi.spyOn(session, 'contextUsage').mockImplementationOnce(async () => {
          entered.resolve();

          await release.promise;

          return context();
        });
      } else {
        const prepare = Attachments.prototype.prepare;

        vi.spyOn(Attachments.prototype, 'prepare').mockImplementationOnce(
          async function (this: Attachments, ...args) {
            entered.resolve();

            await release.promise;

            return prepare.apply(this, args);
          },
        );
      }

      const sending = coordinator.send('Prepared follow-up');

      await within(entered.promise, 3000, 'input preparation');

      emit({ type: 'exhausted' });

      release.resolve();

      await sending;

      await until(
        'destination receives prepared input',
        () =>
          codex.inputs.length === 2 && coordinator.snapshot.phase === 'idle',
      );

      assert.equal(claude.inputs.length, 1);

      assert.deepEqual(
        codex.inputs.map(({ prompt }) => prompt),
        [continuation, 'Prepared follow-up'],
      );
    } finally {
      release.resolve();

      await coordinator.close();
    }
  });

test('a steering image prepared across exhaustion stays queued for the destination', async () => {
  const { coordinator, claude, codex, emit } = await completedForBackground();
  const gate = new TurnGate();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  try {
    claude.gate = gate;
    const active = coordinator.send('Continue working');

    await gate.entered;

    const image = join(await scratch('witch-exhaustion-steer-'), 'image.png');

    await writeFile(image, png(2, 2));

    const marker = coordinator.paste(image, '')!;
    const prepare = Attachments.prototype.prepare;

    vi.spyOn(Attachments.prototype, 'prepare').mockImplementationOnce(
      async function (this: Attachments, ...args) {
        entered.resolve();

        await release.promise;

        return prepare.apply(this, args);
      },
    );

    const steering = coordinator.send(`Follow-up ${marker}`);

    await entered.promise;

    emit({ type: 'exhausted' });

    release.resolve();

    await steering;

    gate.open();

    await active;

    await until(
      'image reaches destination',
      () => codex.inputs.length === 2 && coordinator.snapshot.phase === 'idle',
    );

    assert.deepEqual(claude.steerImages, []);

    assert.equal(codex.inputs[1]!.images!.length, 1);

    assert.equal(claude.inputs.length, 2);
  } finally {
    gate.open();

    release.resolve();

    await coordinator.close();
  }
});

test('background rejection during transcript flush keeps dirty memory for recovery', async () => {
  const { coordinator, claude, codex, emit, store } =
    await completedForBackground();

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const flush = ConversationStore.prototype.flush;
  let armed = false;

  const send = claude.sessions
    .at(-1)!
    .session.send.bind(claude.sessions.at(-1)!.session);

  vi.spyOn(claude.sessions.at(-1)!.session, 'send').mockImplementation(
    async (...args) => {
      const result = await send(...args);
      armed = true;

      return result;
    },
  );

  vi.spyOn(ConversationStore.prototype, 'flush').mockImplementation(
    async function (this: ConversationStore) {
      if (armed) {
        armed = false;

        entered.resolve();

        await release.promise;
      }

      return flush.call(this);
    },
  );

  try {
    const sending = coordinator.send('remember-port');

    await entered.promise;

    emit({ type: 'exhausted' });

    release.resolve();

    await sending;

    assert.equal(coordinator.snapshot.phase, 'recovery');

    assert.match(coordinator.snapshot.recovery!.diff, /4567/);

    assert.equal(
      (await store.records()).records[0]!.lastTurn!.status,
      'completed',
    );

    assert.equal(codex.inputs.length, 0);
  } finally {
    release.resolve();

    await coordinator.close();
  }
});

test('an old connection cannot exhaust a reconnected session with the same native id', async () => {
  const { coordinator, claude, codex, emit } = await completedForBackground();

  try {
    const old = claude.sessions.at(-1)!.session;

    await old.close();

    await coordinator.send('Reconnect');

    const current = claude.sessions.at(-1)!;

    assert.notEqual(current.session, old);

    assert.equal(current.session.info.id, old.info.id);

    emit({ type: 'exhausted' });

    await coordinator.send('Stay on the current connection');

    assert.equal(codex.inputs.length, 0);

    assert.equal(claude.inputs.length, 3);

    current.options.onEvent({ type: 'exhausted' });

    await until(
      'current connection exhaustion',
      () => codex.inputs.length === 1 && coordinator.snapshot.phase === 'idle',
    );
  } finally {
    await coordinator.close();
  }
});

for (const stage of [
  'settlement',
  'refresh',
  'save',
  'connection',
  'task',
] as const)
  test(`background work restarted during ${stage} waits for its final report`, async () => {
    const { coordinator, claude, codex, emit, hook } =
      await completedForBackground();

    let restarted = false;

    const restart = () => {
      if (restarted) return;

      restarted = true;

      emit({ type: 'running', running: true });

      emit({
        type: 'subagent',
        subagent: {
          id: 'late',
          name: 'late review',
          kind: 'review',
          status: 'running',
        },
      });
    };

    const save = ConversationStore.prototype.save;
    const scope = Workspace.prototype.scope;

    if (stage === 'settlement')
      hook.current = async (command, run) => {
        if (command[0] === 'status') restart();

        return run();
      };

    if (stage === 'refresh')
      codex.accountRead = async () => {
        restart();

        return reading(40)();
      };

    if (stage === 'save')
      vi.spyOn(ConversationStore.prototype, 'save').mockImplementation(
        async function (this: ConversationStore, record) {
          await save.call(this, record);

          if (record.handoff?.to === 'codex' && !record.handoff.activated)
            restart();
        },
      );

    if (stage === 'connection')
      vi.spyOn(Workspace.prototype, 'scope').mockImplementation(async function (
        this: Workspace,
        cwd,
      ) {
        const result = await scope.call(this, cwd);

        if (coordinator.snapshot.conversation?.handoff?.to === 'codex')
          restart();

        return result;
      });

    try {
      emit({ type: 'running', running: true });

      if (stage === 'task') restart();

      emit({ type: 'exhausted' });

      await coordinator.send('Queued after report');

      emit({ type: 'running', running: false });

      await until(
        'deferred background switch',
        () => restarted && coordinator.snapshot.phase === 'idle',
      );

      assert.equal(coordinator.snapshot.conversation!.agent, 'claude');

      assert.equal(claude.sessions.at(-1)!.session.closed, false);

      assert.equal(codex.inputs.length, 0);

      emit({ type: 'running', running: false });

      assert.equal(codex.inputs.length, 0);

      emit({
        type: 'subagent',
        subagent: {
          id: 'late',
          name: 'late review',
          kind: 'review',
          status: 'completed',
          report: 'Keep the foreign key.',
        },
      });

      await until(
        'report then queued input',
        () =>
          codex.inputs.length === 2 && coordinator.snapshot.phase === 'idle',
      );

      assert.deepEqual(
        codex.inputs.map(({ prompt }) => prompt),
        [continuation, 'Queued after report'],
      );

      assert.match(codex.inputs[0]!.context!, /Keep the foreign key/);

      assert.equal(claude.inputs.length, 1);
    } finally {
      hook.current = passThrough;

      await coordinator.close();
    }
  });
