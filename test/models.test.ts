import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { ModelCatalog, modelKey, modelTarget } from '../src/core/models.js';
import { FixtureAgent } from './fixtures/agent.js';
import { scratch } from './fixtures/scratch.js';
import { within } from './fixtures/within.js';

test('catalogs preserve runtime order and identity, and reuse inactive lists until a refresh, without connecting inactive agents', async () => {
  const [a, b, missing] = ['a', 'b', 'missing'].map(
    (id) => new FixtureAgent(id),
  );
  a!.catalog.splice(0, 2, { id: 'same', label: 'First', efforts: ['high'] });
  b!.catalog.splice(0, 2, { id: 'same', label: 'Second', efforts: ['low'] });
  const cwd = await scratch('witch-models-');
  const active = await a!.connect({
    cwd,
    executable: 'a',
    memoryDirectories: [],
    onEvent: () => {},
    onProcess: async () => {},
  });
  const models = active.models;
  active.models = async (refresh) =>
    refresh
      ? [{ id: 'same', label: 'Refreshed', efforts: ['high'] }]
      : models();
  const errors: unknown[] = [];
  const catalog = new ModelCatalog(
    [
      { adapter: a!, executable: 'a' },
      { adapter: b!, executable: 'b' },
      { adapter: missing! },
    ],
    (error) => errors.push(error),
  );
  try {
    assert.deepEqual(await catalog.read(cwd, active, true), [
      { agent: 'a', id: 'same', label: 'Refreshed', efforts: ['high'] },
      { agent: 'b', id: 'same', label: 'Second', efforts: ['low'] },
    ]);
    assert.deepEqual(a!.discoveries, []);
    assert.equal(b!.discoveries[0]!.cwd, cwd);
    assert.equal(b!.discoveries[0]!.executable, 'b');
    assert.equal(b!.sessions.length, 0);
    assert.deepEqual(missing!.discoveries, []);
    assert.equal(active.closed, false);
    assert.deepEqual((await catalog.read(cwd, active)).map(modelKey), [
      'a:same',
      'b:same',
    ]);
    assert.equal(b!.discoveries.length, 1);
    b!.failDiscovery = true;
    assert.deepEqual((await catalog.read(cwd, active, true)).map(modelKey), [
      'a:same',
    ]);
    assert.match(String(errors[0]), /b: Discovery failed/);
    assert.deepEqual((await catalog.read(cwd)).map(modelKey), [
      'a:same',
      'b:same',
    ]);
    assert.equal(a!.discoveries.length, 1);
    assert.equal(b!.discoveries.length, 2);
    assert.equal(a!.sessions.length, 1);
    assert.equal(b!.sessions.length, 0);
  } finally {
    await active.close();
  }
});

test('catalog cancellation waits for every discovery to finish cleanup before rejecting', async () => {
  const agents = ['a', 'b'].map((id) => new FixtureAgent(id));
  const entered = agents.map(() => Promise.withResolvers<AbortSignal>());
  const closed = agents.map(() => Promise.withResolvers<void>());
  const cancelled = agents.map(() => Promise.withResolvers<void>());
  agents.forEach((agent, index) => {
    agent.models = async (options) => {
      entered[index]!.resolve(options.signal!);
      options.signal!.addEventListener(
        'abort',
        () => cancelled[index]!.resolve(),
        {
          once: true,
        },
      );
      await cancelled[index]!.promise;
      await closed[index]!.promise;
      options.signal!.throwIfAborted();
      return [];
    };
  });
  const errors: unknown[] = [];
  const catalog = new ModelCatalog(
    agents.map((adapter) => ({ adapter, executable: adapter.id })),
    (error) => errors.push(error),
  );
  let settled = false;
  const pending = catalog.read('/fixture');
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const rejected = assert.rejects(
    within(pending, 2000, 'catalog cancellation'),
    { name: 'AbortError' },
  );
  try {
    const signals = await Promise.all(entered.map((entry) => entry.promise));
    catalog.cancel();
    assert.ok(signals.every((signal) => signal.aborted));
    closed[0]!.resolve();
    await setImmediate();
    assert.equal(settled, false);
    closed[1]!.resolve();
    await rejected;
    assert.deepEqual(errors, []);
  } finally {
    catalog.cancel();
    for (const cancel of cancelled) cancel.resolve();
    for (const close of closed) close.resolve();
    await pending.catch(() => {});
    await rejected.catch(() => {});
  }
});

test('explicit targets parse registered prefixes and retain native IDs containing colons', () => {
  for (const [text, expected] of [
    ['haiku', { agent: 'codex', id: 'haiku' }],
    ['claude:haiku', { agent: 'claude', id: 'haiku' }],
    ['vendor:model', { agent: 'codex', id: 'vendor:model' }],
    ['claude:vendor:model', { agent: 'claude', id: 'vendor:model' }],
  ] as const)
    assert.deepEqual(modelTarget(text, 'codex', ['codex', 'claude']), expected);
  assert.throws(
    () => modelTarget('claude:', 'codex', ['codex', 'claude']),
    /Choose a model ID/,
  );
});
