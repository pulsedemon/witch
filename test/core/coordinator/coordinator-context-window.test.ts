import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createConversation } from '../../../src/core/state.js';
import { readRecord, unitFixture } from '../../fixtures/coordinator.js';

test('a context window choice survives reconnect, clear and new with fresh thread identities', async () => {
  const f = await unitFixture();
  let coordinator = f.coordinator;

  try {
    await coordinator.selectModel({
      agent: 'a',
      id: 'a-big',
      effort: 'high',
      contextWindow: 'maximum',
    });

    const original = coordinator.snapshot.native!.id;
    await coordinator.send('retain the window choice');
    const id = coordinator.snapshot.conversation!.id;

    assert.equal(
      (await readRecord(f.root, id)).sessions.a!.contextWindow,
      'maximum',
    );

    await coordinator.close();
    coordinator = await f.reopen();
    assert.equal(f.a.sessions.at(-1)!.options.contextWindow, 'maximum');
    assert.equal(coordinator.snapshot.native!.contextWindow, 'maximum');
    assert.equal(coordinator.snapshot.native!.id, original);
    await coordinator.clear();
    assert.notEqual(coordinator.snapshot.native!.id, original);
    assert.equal(coordinator.snapshot.native!.contextWindow, 'maximum');
    assert.equal(f.a.sessions.at(-1)!.options.contextWindow, 'maximum');
    const cleared = coordinator.snapshot.native!.id;
    await coordinator.newConversation();
    assert.notEqual(coordinator.snapshot.conversation!.id, id);
    assert.notEqual(coordinator.snapshot.native!.id, cleared);
    assert.equal(coordinator.snapshot.native!.contextWindow, 'maximum');
    assert.equal(f.a.sessions.at(-1)!.options.resume, undefined);
    assert.equal(f.a.sessions.at(-1)!.options.contextWindow, 'maximum');
    assert.equal(coordinator.snapshot.native!.effort, 'high');
  } finally {
    await coordinator.close();
  }
});

test('new inherits an explicit window with an implicit model but never its thread or delivery receipts', () => {
  const source = createConversation('/project', 'a');

  source.sessions.a = {
    id: 'old-native-thread',
    model: 'native-default',
    contextWindow: 'maximum',
    hasHistory: true,
    deliveredRevision: 'old-revision',
  };

  const next = createConversation('/project', 'a', source);
  assert.equal(next.sessions.a!.contextWindow, 'maximum');
  assert.equal(next.sessions.a!.requestedModel, undefined);
  assert.equal(next.sessions.a!.id, '');
  assert.equal(next.sessions.a!.hasHistory, false);
  assert.equal(next.sessions.a!.deliveredRevision, undefined);
  assert.deepEqual(createConversation('/project', 'b', source).sessions, {});
});

test('a rejected model selection preserves the saved and applied window preference', async () => {
  const f = await unitFixture();

  try {
    await f.coordinator.selectModel({
      agent: 'a',
      id: 'a-big',
      effort: 'low',
      contextWindow: 'maximum',
    });

    f.a.invalidEffort = 'high';

    await assert.rejects(
      f.coordinator.selectModel({
        agent: 'a',
        id: 'a-big',
        effort: 'high',
        contextWindow: 'default',
      }),
      /Invalid effort/,
    );

    assert.equal(f.coordinator.snapshot.native!.contextWindow, 'maximum');

    const saved = await readRecord(
      f.root,
      f.coordinator.snapshot.conversation!.id,
    );

    assert.equal(saved.sessions.a!.contextWindow, 'maximum');
    assert.equal(saved.sessions.a!.effort, 'low');
  } finally {
    await f.coordinator.close();
  }
});

test('a destination receives its window before exactly one continuation, and runtimes retain separate choices', async () => {
  const f = await unitFixture();

  try {
    await f.coordinator.selectModel({
      agent: 'a',
      id: 'a-big',
      contextWindow: 'maximum',
    });

    f.a.interruptNext = true;
    await f.coordinator.send('unfinished context-window task');

    f.b.beforeConnect = async (options) => {
      assert.equal(options.contextWindow, 'default');
    };

    await f.coordinator.selectModel({
      agent: 'b',
      id: 'b-big',
      contextWindow: 'default',
    });

    assert.equal(f.b.inputs.length, 1);
    assert.equal(f.b.sessions.at(-1)!.options.contextWindow, 'default');
    assert.equal(f.coordinator.snapshot.native!.contextWindow, 'default');

    assert.equal(
      f.coordinator.snapshot.conversation!.sessions.a!.contextWindow,
      'maximum',
    );

    await f.coordinator.selectModel({ agent: 'a', id: 'a-big' });
    assert.equal(f.coordinator.snapshot.native!.contextWindow, 'maximum');
  } finally {
    await f.coordinator.close();
  }
});
