import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BackgroundCommand, Model } from '../src/agents/types.js';
import { identifyProcess } from '../src/persistence/process.js';
import { ConversationStore } from '../src/persistence/store.js';
import { TurnGate } from './fixtures/agent.js';
import { fixture, readRecord } from './fixtures/coordinator.js';
import { until, within } from './fixtures/within.js';

await test('interrupting inactive model discovery keeps the connected session', async () => {
  const { coordinator, a, b, root } = await fixture(undefined, (a) => {
    a.connectUsage = { context: 0.75 };
    a.skills = [{ name: 'spell', description: 'Current spell' }];
  });
  const entered = Promise.withResolvers<AbortSignal>();
  const aborted = Promise.withResolvers<void>();
  const cleaned = Promise.withResolvers<void>();
  let refreshing: Promise<boolean> | undefined;
  try {
    await coordinator.send('before refresh');
    const { session, options } = a.sessions[0]!;
    const command: BackgroundCommand = {
      id: 'brew',
      description: 'Watch output',
      status: 'running',
    };
    options.onEvent({ type: 'command', command });
    options.onEvent({
      type: 'tool',
      id: 'output',
      title: 'Watch output',
      text: 'before\n',
      done: false,
    });
    const before = structuredClone(coordinator.snapshot);
    const saved = await readRecord(root, before.conversation!.id);
    b.models = async (options) => {
      entered.resolve(options.signal!);
      options.signal!.addEventListener('abort', () => aborted.resolve(), {
        once: true,
      });
      await aborted.promise;
      await cleaned.promise;
      options.signal!.throwIfAborted();
      return b.catalog;
    };
    let settled = false;
    refreshing = coordinator.refreshModels();
    void refreshing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const signal = await within(entered.promise, 2000, 'inactive discovery');
    await assert.rejects(
      coordinator.refreshModels(),
      /Stop the current operation first/,
    );
    await coordinator.interrupt();
    await coordinator.interrupt();
    assert.equal(signal.aborted, true);
    assert.equal(session.closed, false);
    assert.equal(settled, false);
    cleaned.resolve();
    assert.equal(await within(refreshing, 2000, 'refresh cleanup'), false);
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.equal(coordinator.snapshot.error, undefined);
    assert.deepEqual(coordinator.snapshot.models, before.models);
    assert.deepEqual(coordinator.snapshot.native, before.native);
    assert.deepEqual(coordinator.snapshot.items, before.items);
    assert.deepEqual(coordinator.snapshot.skills, before.skills);
    assert.deepEqual(coordinator.snapshot.usage, before.usage);
    assert.deepEqual(coordinator.snapshot.backgroundCommands, [command]);
    const after = await readRecord(root, before.conversation!.id);
    assert.deepEqual(after.process, saved.process);
    assert.ok(saved.process);
    assert.deepEqual(await identifyProcess(saved.process.pid), saved.process);
    options.onEvent({
      type: 'tool',
      id: 'output',
      title: 'Watch output',
      text: 'after\n',
      append: true,
      done: true,
    });
    options.onEvent({
      type: 'command',
      command: { ...command, status: 'completed' },
    });
    assert.equal(
      coordinator.snapshot.items.find((item) => item.title === 'Watch output')!
        .text,
      'before\nafter\n',
    );
    assert.deepEqual(coordinator.snapshot.backgroundCommands, []);
    assert.ok(
      coordinator.snapshot.items.some((item) =>
        item.title?.startsWith('Brew completed'),
      ),
    );
    await coordinator.send('after canceled refresh');
    assert.equal(a.sessions.length, 1);
    assert.equal(b.sessions.length, 0);
    assert.equal(a.inputs.at(-1)!.session, session.info.id);
    assert.match(a.inputs.at(-1)!.prompt, /^after canceled refresh$/);
  } finally {
    aborted.resolve();
    cleaned.resolve();
    await refreshing?.catch(() => {});
    await coordinator.close();
  }
});

await test('interrupting an active model read discards its result', async () => {
  const { coordinator, a } = await fixture();
  const entered = Promise.withResolvers<void>();
  const models = Promise.withResolvers<Model[]>();
  let refreshing: Promise<boolean> | undefined;
  try {
    const { session } = a.sessions[0]!;
    const before = structuredClone(coordinator.snapshot);
    session.models = async () => {
      entered.resolve();
      return models.promise;
    };
    let settled = false;
    refreshing = coordinator.refreshModels();
    void refreshing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await within(entered.promise, 2000, 'active model read');
    await coordinator.interrupt();
    assert.equal(session.closed, false);
    assert.equal(settled, false);
    models.resolve([{ id: 'late-model', label: 'Late model', efforts: [] }]);
    assert.equal(
      await within(refreshing, 2000, 'active model response'),
      false,
    );
    assert.deepEqual(coordinator.snapshot.models, before.models);
    assert.equal(coordinator.snapshot.error, undefined);
    await coordinator.send('after active cancellation');
    assert.equal(a.sessions.length, 1);
    assert.equal(a.inputs.at(-1)!.session, session.info.id);
    assert.match(a.inputs.at(-1)!.prompt, /^after active cancellation$/);
  } finally {
    models.resolve(a.catalog);
    await refreshing?.catch(() => {});
    await coordinator.close();
  }
});

await test('a queued turn cannot turn a canceled refresh into a successful result', async () => {
  const { coordinator, a } = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const gate = new TurnGate();
  let refreshing: Promise<boolean> | undefined;
  try {
    const { session } = a.sessions[0]!;
    session.models = async () => {
      entered.resolve();
      await release.promise;
      return a.catalog;
    };
    a.gate = gate;
    refreshing = coordinator.refreshModels();
    void refreshing.catch(() => {});
    await within(entered.promise, 2000, 'active model read');
    await coordinator.send('queued after cancel');
    assert.deepEqual(coordinator.snapshot.queue, ['queued after cancel']);
    await coordinator.interrupt();
    release.resolve();
    assert.equal(await within(refreshing, 2000, 'canceled refresh'), false);
    await within(gate.entered, 2000, 'queued turn');
    assert.equal(coordinator.snapshot.phase, 'running');
    assert.equal(a.inputs.length, 1);
    assert.equal(a.inputs[0]!.session, session.info.id);
    assert.match(a.inputs[0]!.prompt, /^queued after cancel$/);
    assert.equal(a.sessions.length, 1);
    gate.open();
    await until('queued reply', () => coordinator.snapshot.phase === 'idle');
    assert.deepEqual(coordinator.snapshot.queue, []);
    assert.equal(coordinator.snapshot.items.at(-1)!.text, 'Done.');
  } finally {
    release.resolve();
    gate.open();
    await refreshing?.catch(() => {});
    await coordinator.close();
  }
});

await test('interrupting model refresh settlement keeps the session and cancels the picker', async (t) => {
  const { coordinator, a } = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const flush = ConversationStore.prototype.flush;
  const id = coordinator.snapshot.conversation!.id;
  let held = false;
  let refreshing: Promise<boolean> | undefined;
  try {
    t.mock.method(
      ConversationStore.prototype,
      'flush',
      async function (this: ConversationStore) {
        await flush.call(this);
        if (held || this.record.id !== id) return;
        held = true;
        entered.resolve();
        await release.promise;
      },
    );
    refreshing = coordinator.refreshModels();
    void refreshing.catch(() => {});
    await within(entered.promise, 2000, 'refresh settlement');
    await coordinator.interrupt();
    await coordinator.interrupt();
    assert.equal(a.sessions[0]!.session.closed, false);
    release.resolve();
    assert.equal(await within(refreshing, 2000, 'settled refresh'), false);
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.equal(coordinator.snapshot.error, undefined);
  } finally {
    release.resolve();
    await refreshing?.catch(() => {});
    await coordinator.close();
  }
});
