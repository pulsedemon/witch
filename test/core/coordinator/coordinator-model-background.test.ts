import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { CodexAdapter } from '../../../src/agents/codex/adapter.js';
import type { RpcMessage } from '../../../src/agents/codex/json-rpc.js';
import { Coordinator } from '../../../src/core/coordinator.js';
import { StateStore } from '../../../src/persistence/store.js';
import { frameWriter, turnFrame } from '../../fixtures/codex-adapter.js';
import { unitFixture } from '../../fixtures/coordinator.js';
import { EmptyMemory } from '../../fixtures/empty-memory.js';
import { scratch } from '../../fixtures/scratch.js';
import { settled, until, within } from '../../fixtures/within.js';

async function codexCoordinator() {
  const cwd = await scratch('witch-model-background-');

  await writeFile(
    join(cwd, 'config.json'),
    JSON.stringify({ model_context_window: 1_000_000 }),
  );

  const calls: RpcMessage[] = [];

  const adapter = new CodexAdapter(
    (_, directory, signal) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('../../fixtures/codex.mjs', import.meta.url)),
          'compaction',
        ],
        { cwd: directory, stdio: 'pipe', signal },
      );

      const write = child.stdin.write;

      child.stdin.write = (...args) => {
        calls.push(JSON.parse(String(args[0])) as RpcMessage);

        return Reflect.apply(write, child.stdin, args) as boolean;
      };

      return child;
    },
    async () => ({
      models: [
        {
          slug: 'model-a',
          context_window: 500_000,
          max_context_window: 1_000_000,
          effective_context_window_percent: 100,
        },
        {
          slug: 'model-b',
          context_window: 256_000,
          max_context_window: 256_000,
          effective_context_window_percent: 100,
        },
      ],
    }),
  );

  const store = await StateStore.open(join(cwd, 'state'));

  const coordinator = new Coordinator(
    store,
    new EmptyMemory(join(cwd, 'memory')),
    [{ adapter, executable: 'scripted-codex' }],
  );

  await coordinator.initialize(cwd);

  const emit = frameWriter(cwd, (text) =>
    coordinator.snapshot.items.some((item) => item.text === text),
  );

  return { coordinator, calls, emit };
}

for (const duringTurn of [false, true])
  test(`a Codex model reload chosen ${duringTurn ? 'during a turn' : 'at idle'} waits for native background work before queued input`, async () => {
    const { coordinator: c, calls, emit } = await codexCoordinator();
    let sending: Promise<void> | undefined;

    try {
      if (duringTurn) {
        sending = c.send('hold');

        await until('the main turn', () =>
          calls.some((call) => call.method === 'turn/start'),
        );
      }

      await emit(turnFrame('child-run', 'inProgress', 'child-thread'));
      const release = c.holdPromptDelivery();
      const selection = { agent: 'codex', id: 'model-b' };
      const choosing = c.selectModel(selection);
      const complete = settled(choosing);
      await c.send('/queued-after-model');

      if (duringTurn) {
        await emit(turnFrame());
        await within(sending!, 3000, 'the main turn');
      }

      assert.equal(c.snapshot.phase, 'idle');
      assert.deepEqual(c.snapshot.pendingModel, selection);
      assert.equal(complete(), false);
      assert.equal(c.snapshot.native!.model, 'model-a');

      assert.equal(
        calls.some((call) => call.method === 'thread/settings/update'),
        false,
      );

      await emit(turnFrame('child-run', 'completed', 'child-thread'));
      await within(choosing, 3000, 'selection after background completion');
      assert.equal(c.snapshot.native!.model, 'model-b');
      assert.equal(c.snapshot.pendingModel, undefined);

      const changes = calls.filter(
        (call) => call.method === 'thread/settings/update',
      );

      assert.equal(changes.length, 1);
      assert.equal((changes[0]!.params as { model: string }).model, 'model-b');
      release();
      const expectedTurns = duringTurn ? 2 : 1;

      await until(
        'the queued turn',
        () =>
          calls.filter((call) => call.method === 'turn/start').length ===
          expectedTurns,
      );

      const next = calls.filter((call) => call.method === 'turn/start').at(-1)!;
      assert.ok(calls.indexOf(changes[0]!) < calls.indexOf(next));

      assert.deepEqual((next.params as { input: unknown }).input, [
        { type: 'text', text: '/queued-after-model', text_elements: [] },
      ]);

      await emit(turnFrame('turn-1', 'completed', c.snapshot.native!.id));

      await until(
        'the completed queued turn',
        () => c.snapshot.phase === 'idle',
      );

      assert.deepEqual(c.snapshot.queue, []);
    } finally {
      await c.close();
      await sending;
    }
  });

test('interrupting an idle model wait cancels it before background work completes', async () => {
  const { coordinator: c, calls, emit } = await codexCoordinator();

  try {
    await emit(turnFrame('child-run', 'inProgress', 'child-thread'));
    const release = c.holdPromptDelivery();

    const choosing = assert.rejects(
      c.selectModel({ agent: 'codex', id: 'model-b' }),
      { message: 'Model change canceled' },
    );

    await c.interrupt();
    await within(choosing, 2000, 'the canceled selection');
    assert.equal(c.snapshot.pendingModel, undefined);
    await emit(turnFrame('child-run', 'completed', 'child-thread'));
    assert.equal(c.snapshot.native!.model, 'model-a');

    assert.equal(
      calls.some((call) => call.method === 'thread/settings/update'),
      false,
    );

    release();
  } finally {
    await c.close();
  }
});

for (const nativeRunning of [false, true])
  test(`a handoff waits for ${nativeRunning ? 'native execution after its ordinary turn' : 'adapter-owned background work before it appears in the snapshot'}`, async () => {
    const { coordinator: c, a, b } = await unitFixture();
    const source = a.sessions[0]!;
    let active = !nativeRunning;

    Object.defineProperty(source.session, 'backgroundActive', {
      get: () => active,
    });

    try {
      if (nativeRunning)
        source.options.onEvent({ type: 'running', running: true });

      const release = c.holdPromptDelivery();
      const selection = { agent: 'b', id: 'b-big' };
      const choosing = c.selectModel(selection);

      await until(
        'the pending handoff',
        () => c.snapshot.pendingModel !== undefined,
      );

      assert.deepEqual(c.snapshot.backgroundCommands, []);
      assert.deepEqual(c.snapshot.subagents, []);
      assert.equal(source.session.closed, false);
      assert.deepEqual(a.inputs, []);
      assert.equal(b.sessions.length, 0);
      active = false;
      source.options.onEvent({ type: 'running', running: false });
      await within(choosing, 3000, 'the released handoff');
      assert.equal(c.snapshot.conversation!.agent, 'b');
      assert.equal(c.snapshot.native!.model, 'b-big');
      release();
    } finally {
      await c.close();
    }
  });

test('a closed source with stale native familiar state hands off and delivers queued input', async () => {
  const { coordinator: c, a, b } = await unitFixture();
  const source = a.sessions[0]!;
  Object.defineProperty(source.session, 'backgroundActive', { value: true });

  try {
    source.options.onEvent({
      type: 'subagent',
      subagent: { id: 'child', name: 'child', kind: 'task', status: 'running' },
    });

    await source.session.close();
    source.options.onEvent({ type: 'closed' });
    assert.equal(c.snapshot.subagents[0]!.status, 'stopped');
    const release = c.holdPromptDelivery();
    const choosing = c.selectModel({ agent: 'b', id: 'b-big' });
    await c.send('/after');
    await within(choosing, 3000, 'the closed-source handoff');
    release();

    await until('the queued destination turn', () =>
      b.inputs.some(({ prompt }) => prompt === '/after'),
    );

    assert.equal(c.snapshot.native!.model, 'b-big');

    assert.equal(
      b.inputs.filter(({ prompt }) => prompt === '/after').length,
      1,
    );

    assert.equal(c.snapshot.pendingModel, undefined);
  } finally {
    await c.close();
  }
});
