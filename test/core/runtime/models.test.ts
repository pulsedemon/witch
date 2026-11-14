import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import {
  LATEST_READ_MS,
  ModelCatalog,
  modelKey,
  modelTarget,
} from '../../../src/core/runtime/models.js';
import { FixtureAgent } from '../../fixtures/agent.js';
import { scratch } from '../../fixtures/scratch.js';
import { settled, within } from '../../fixtures/within.js';

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

  const pending = catalog.read('/fixture');
  const isSettled = settled(pending);

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

    assert.equal(isSettled(), false);

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

test('latest models are read once per process, again on a refresh or after a failure, and cancel with discovery', async () => {
  const [a, b] = [new FixtureAgent('a'), new FixtureAgent('b')];
  const reads: (AbortSignal | undefined)[] = [];
  let failing = true;
  const gate: { hold?: Promise<void> } = {};

  a.latest = async ({ signal }) => {
    reads.push(signal);

    await gate.hold;

    signal?.throwIfAborted();

    if (failing) throw new Error('latest failed');

    return { opus: 'a-opus-2' };
  };

  const errors: unknown[] = [];

  const catalog = new ModelCatalog(
    [
      { adapter: a, executable: 'a' },
      { adapter: b, executable: 'b' },
    ],
    (error) => errors.push(error),
  );

  const cwd = await scratch('witch-latest-');

  await catalog.read(cwd);

  assert.deepEqual(catalog.latest, { a: {} });

  assert.match(String(errors[0]), /a: latest failed/);

  failing = false;

  await catalog.read(cwd);

  assert.deepEqual(catalog.latest, { a: { opus: 'a-opus-2' } });

  await catalog.read(cwd);

  assert.equal(reads.length, 2);

  await catalog.read(cwd, undefined, true);

  assert.equal(reads.length, 3);

  let release!: () => void;
  gate.hold = new Promise((resolve) => (release = resolve));
  const reading = catalog.read(cwd, undefined, true);

  await setImmediate();

  catalog.cancel(new Error('stop'));

  release();

  await assert.rejects(reading);

  assert.equal(reads.at(-1)!.aborted, true);
});

test('a latest read that has not answered in time is stopped and reported, and the catalog read finishes', async () => {
  const a = new FixtureAgent('a');
  let signal: AbortSignal | undefined;

  a.latest = (options) =>
    new Promise((_resolve, reject) => {
      signal = options.signal;

      signal?.addEventListener('abort', () => reject(signal!.reason));
    });

  const errors: unknown[] = [];

  const catalog = new ModelCatalog([{ adapter: a, executable: 'a' }], (error) =>
    errors.push(error),
  );

  const cwd = await scratch('witch-latest-');

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  try {
    const reading = catalog.read(cwd);

    vi.advanceTimersByTime(LATEST_READ_MS - 1);

    assert.equal(signal!.aborted, false);

    vi.advanceTimersByTime(1);

    await reading;
  } finally {
    vi.useRealTimers();
  }

  assert.match(String(errors[0]), /a: the alias read timed out/);

  assert.deepEqual(catalog.latest, { a: {} });
});

// the other runtime comes first, so a lost active-runtime preference picks it
const catalog = {
  models: [
    { agent: 'claude', id: 'only-claude', label: 'Only', efforts: [] },
    { agent: 'claude', id: 'shared', label: 'Shared', efforts: [] },
    { agent: 'codex', id: 'shared', label: 'Shared', efforts: [] },
  ],
  latest: { claude: { sonnet: 'claude-sonnet-x' } },
};

test('explicit targets parse registered prefixes and retain native IDs containing colons', () => {
  for (const [text, expected] of [
    ['haiku', { agent: 'codex', id: 'haiku' }],
    ['claude:haiku', { agent: 'claude', id: 'haiku' }],
    ['vendor:model', { agent: 'codex', id: 'vendor:model' }],
    ['claude:vendor:model', { agent: 'claude', id: 'vendor:model' }],
  ] as const)
    assert.deepEqual(
      modelTarget(text, 'codex', ['codex', 'claude'], catalog),
      expected,
    );

  assert.throws(
    () => modelTarget('claude:', 'codex', ['codex', 'claude'], catalog),
    /Choose a model ID/,
  );
});

test('unprefixed IDs go to the runtime whose models or alias targets list them, preferring the active one', () => {
  for (const [text, agent] of [
    ['only-claude', 'claude'],
    ['claude-sonnet-x', 'claude'],
    ['shared', 'codex'],
  ] as const)
    assert.deepEqual(modelTarget(text, 'codex', ['codex', 'claude'], catalog), {
      agent,
      id: text,
    });
});
