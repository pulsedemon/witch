import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, vi } from 'vitest';
import { PresencePublisher } from '../../../src/core/coordination/presence.js';
import type { Activation } from '../../../src/core/coordination/coordination.js';
import type { SessionPresence } from '../../../src/core/coordination/coordination-state.js';
import { initialSnapshot } from '../../../src/core/snapshot.js';
import { record } from '../../fixtures/coordinator.js';

test('presence counts familiars by runtime and unchanged counts do not publish another record', async () => {
  vi.useFakeTimers();
  const conversation = record(randomUUID(), '/project', 'a');
  const state = initialSnapshot([]);
  state.conversation = conversation;
  state.phase = 'idle';

  state.subagents = [
    {
      id: 'native',
      name: 'native',
      kind: 'worker',
      status: 'running',
      startedAt: 1,
      rows: { start: 'native' },
    },
    {
      id: 'remote',
      name: 'remote',
      kind: 'worker',
      runtime: 'b',
      status: 'running',
      startedAt: 2,
      rows: { start: 'remote' },
    },
    {
      id: 'finished',
      name: 'finished',
      kind: 'worker',
      runtime: 'b',
      status: 'completed',
      startedAt: 3,
      rows: { start: 'finished', end: 'done' },
    },
  ];

  const active: Activation = {
    conversation,
    project: 'project',
    openedAt: 1,
    accepting: true,
    publishing: true,
    binding: {
      directory: '/control',
      conversation: conversation.id,
      activation: randomUUID(),
    },
    release: async () => {},
  };

  const written: SessionPresence[] = [];

  const publisher = new PresencePublisher({
    registry: {
      publish: async (presence) => {
        written.push(presence);
      },
    },
    process: { pid: process.pid, started: 'test process' },
    state: () => state,
    active: () => active,
    branch: () => undefined,
    closed: () => false,
    ending: () => false,
    failure: () => false,
    written: () => {},
    failed: (error) => {
      assert.fail(String(error));
    },
  });

  await publisher.publish(active);
  assert.equal(written[0]!.familiars, 2);
  assert.equal(written[0]!.nativeRunning, false);
  assert.deepEqual(written[0]!.familiarRuntimes, { a: 1, b: 1 });
  state.usage = { context: 42 };
  publisher.schedule(active);
  await vi.advanceTimersByTimeAsync(100);
  await publisher.idle();
  assert.equal(written.length, 1);

  state.subagents = state.subagents.map((familiar) =>
    familiar.id === 'native' ? { ...familiar, status: 'completed' } : familiar,
  );

  publisher.schedule(active);
  await vi.advanceTimersByTimeAsync(100);
  await publisher.idle();
  assert.equal(written.length, 2);
  assert.equal(written[1]!.familiars, 1);
  assert.deepEqual(written[1]!.familiarRuntimes, { b: 1 });
  state.nativeRunning = true;
  publisher.schedule(active);
  await vi.advanceTimersByTimeAsync(100);
  await publisher.idle();
  assert.equal(written[2]!.phase, 'running');
  assert.equal(written[2]!.nativeRunning, true);
  publisher.cancel();
});
