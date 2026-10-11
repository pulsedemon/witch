import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Coordinator } from '../src/core/coordinator.js';
import { Memory } from '../src/memory/memory.js';
import { StateStore } from '../src/persistence/store.js';
import type {
  AgentAdapter,
  AgentSession,
  SessionOptions,
  SessionInfo,
  TurnResult,
} from '../src/agents/types.js';

class FixtureAgent implements AgentAdapter {
  readonly label: string;
  readonly inputs: { session: string; prompt: string }[] = [];
  readonly resumed: (string | undefined)[] = [];
  failConnect = false;
  interruptNext = false;
  constructor(readonly id: string) {
    this.label = id;
  }
  async connect(options: SessionOptions): Promise<AgentSession> {
    if (this.failConnect) throw new Error('Destination unavailable');
    this.resumed.push(options.resume);
    const info: SessionInfo = {
      id: options.resume ?? randomUUID(),
      agent: this.id,
      cwd: options.cwd,
      model: `${this.id}-model`,
      permissionMode: 'default',
      hasHistory: true,
    };
    options.onEvent({ type: 'info', info });
    let closed = false;
    return {
      info,
      get closed() {
        return closed;
      },
      models: async () => [
        { id: info.model, label: info.model, description: '', efforts: [] },
      ],
      selectModel: async () => {},
      respond: () => {},
      interrupt: async () => {},
      close: async () => {
        closed = true;
      },
      send: async (prompt): Promise<TurnResult> => {
        this.inputs.push({ session: info.id, prompt });
        if (prompt.includes('remember-port'))
          await writeFile(
            join(options.memoryDirectories[1]!, 'MEMORY.md'),
            'Use port 4567.',
          );
        if (this.interruptNext) {
          this.interruptNext = false;
          return { status: 'interrupted', text: '' };
        }
        const text = prompt.includes('handoff summary')
          ? `${this.id}: finish the migration`
          : 'Done.';
        options.onEvent({ type: 'text', id: randomUUID(), text });
        return { status: 'completed', text };
      },
    };
  }
}

async function fixture(
  editFile?: ConstructorParameters<typeof Coordinator>[3],
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'harness-coordinator-')),
  );
  const project = join(root, 'project');
  await mkdir(project);
  const store = await StateStore.open(join(root, 'state'));
  const memory = new Memory(join(root, 'state', 'memory'));
  const a = new FixtureAgent('a');
  const b = new FixtureAgent('b');
  const coordinator = new Coordinator(
    store,
    memory,
    [a, b].map((adapter) => ({ adapter, executable: adapter.id })),
    editFile,
  );
  await coordinator.initialize(project);
  return { coordinator, store, memory, a, b, root, project };
}

await test('a fresh conversation receives committed memory without a handoff', async () => {
  const { coordinator, a, b } = await fixture();
  try {
    await coordinator.send('remember-port');
    await coordinator.newConversation('b');
    await coordinator.send('Which port should this project use?');
    assert.match(b.inputs.at(-1)!.prompt, /Use port 4567/);
    assert.doesNotMatch(b.inputs.at(-1)!.prompt, /handoff summary/);
    assert.equal(a.inputs.length, 1);
  } finally {
    await coordinator.close();
  }
});

await test('unfinished memory blocks execution until recovery preserves the original attribution', async () => {
  const { coordinator, memory, a } = await fixture();
  try {
    a.interruptNext = true;
    await coordinator.send('remember-port');
    assert.equal(coordinator.snapshot.phase, 'recovery');
    await assert.rejects(coordinator.send('unrelated task'), /pending memory/);
    await coordinator.recoverMemory('accept');
    const scope = await memory.scope(coordinator.snapshot.conversation!.cwd);
    assert.match(
      (await memory.history(join(scope.project, 'MEMORY.md')))[0]!.subject,
      /a/,
    );
    assert.equal(await memory.isDirty(), false);
    await coordinator.send('continue');
    assert.equal(a.inputs.length, 2);
  } finally {
    await coordinator.close();
  }
});

await test('handoff returns to the original native session with updated context', async () => {
  const { coordinator, a, b } = await fixture();
  try {
    await coordinator.send('Start the migration');
    const original = a.inputs[0]!.session;
    await coordinator.switchAgent('b');
    assert.match(b.inputs[0]!.prompt, /a: finish the migration/);
    await coordinator.switchAgent('a');
    assert.equal(a.inputs.at(-1)!.session, original);
    assert.match(a.inputs.at(-1)!.prompt, /b: finish the migration/);
    assert.equal(coordinator.snapshot.conversation?.agent, 'a');
  } finally {
    await coordinator.close();
  }
});

await test('destination startup failure retains the source conversation and session', async () => {
  const { coordinator, a, b, store } = await fixture();
  try {
    await coordinator.send('Start');
    b.failConnect = true;
    await assert.rejects(
      coordinator.switchAgent('b'),
      /Destination unavailable/,
    );
    assert.equal(coordinator.snapshot.conversation?.agent, 'a');
    const saved = await store.load();
    assert.equal(saved.conversations[0]?.sessions.a?.id, a.inputs[0]?.session);
    await coordinator.send('Continue the original task');
    assert.equal(a.inputs.at(-1)?.session, a.inputs[0]?.session);
  } finally {
    await coordinator.close();
  }
});

await test('restored memory refreshes an existing session before the next turn', async () => {
  const { coordinator, memory, a } = await fixture();
  try {
    await coordinator.send('remember-port');
    const scope = await memory.scope(coordinator.snapshot.conversation!.cwd);
    await writeFile(join(scope.project, 'MEMORY.md'), 'Use port 9001.');
    await memory.commit('change port');
    await coordinator.send('Continue');
    assert.match(a.inputs.at(-1)!.prompt, /Use port 9001/);
    assert.doesNotMatch(a.inputs.at(-1)!.prompt, /Use port 4567/);
    assert.equal(a.inputs[0]?.session, a.inputs.at(-1)?.session);
  } finally {
    await coordinator.close();
  }
});

await test('recovery has one owner and shutdown waits for its accepted commit', async () => {
  const { coordinator, memory, a } = await fixture();
  a.interruptNext = true;
  await coordinator.send('remember-port');
  const recovering = coordinator.recoverMemory('accept');
  await assert.rejects(
    coordinator.recoverMemory('discard'),
    /Stop the current operation/,
  );
  await Promise.all([recovering, coordinator.close()]);
  assert.equal(await memory.isDirty(), false);
  assert.match(
    await memory.read(
      (await memory.scope(coordinator.snapshot.conversation!.cwd)).project +
        '/MEMORY.md',
    ),
    /4567/,
  );
});

await test('startup failures leave an exit-capable error state', async () => {
  const { coordinator: original, root, memory, a } = await fixture();
  await original.close();
  const coordinator = new Coordinator(
    await StateStore.open(join(root, 'state')),
    memory,
    [{ adapter: a, executable: 'a' }],
  );
  try {
    await assert.rejects(coordinator.initialize(join(root, 'missing')));
    assert.equal(coordinator.snapshot.phase, 'error');
  } finally {
    await coordinator.close();
  }
});

for (const stage of [
  'summarizing',
  'summary-saved',
  'destination-connected',
  'activated',
  'continuing',
  'completed',
] as const) {
  await test(`restart at handoff stage ${stage} preserves the active agent without replaying input`, async () => {
    const {
      coordinator: original,
      store,
      memory,
      a,
      b,
      root,
      project,
    } = await fixture();
    const data = await store.load();
    await original.close();
    const activated = ['activated', 'continuing', 'completed'].includes(stage);
    const conversation = data.conversations[0]!;
    conversation.agent = activated ? 'b' : 'a';
    conversation.sessions.a = {
      id: 'original-a',
      model: 'a-model',
      hasHistory: true,
    };
    if (stage !== 'summarizing' && stage !== 'summary-saved')
      conversation.sessions.b = {
        id: 'destination-b',
        model: 'b-model',
        hasHistory: stage === 'continuing' || stage === 'completed',
      };
    conversation.handoff = {
      from: 'a',
      to: 'b',
      activated,
      summary: stage === 'summarizing' ? undefined : 'Continue the migration',
    };
    if (stage === 'continuing')
      data.activity = {
        id: 'interrupted-destination-turn',
        conversationId: conversation.id,
        agent: 'b',
        kind: 'turn',
        baseRevision: await memory.revision(),
        startedAt: new Date().toISOString(),
      };
    const pending = await StateStore.open(join(root, 'state'));
    await pending.save(data);
    await pending.close();
    const restarted = new Coordinator(
      await StateStore.open(join(root, 'state')),
      memory,
      [a, b].map((adapter) => ({ adapter, executable: adapter.id })),
    );
    try {
      await restarted.initialize(project);
      assert.equal(
        restarted.snapshot.conversation!.agent,
        activated ? 'b' : 'a',
      );
      assert.equal(restarted.snapshot.conversation!.cwd, project);
      assert.equal(a.inputs.length + b.inputs.length, 0);
      await restarted.send('Resume manually');
      const active = activated ? b : a;
      const prior = conversation.sessions[active.id]!;
      if (prior.hasHistory) assert.equal(active.inputs[0]!.session, prior.id);
      else assert.notEqual(active.inputs[0]!.session, prior.id);
      assert.ok(active.inputs[0]!.prompt.includes('Resume manually'));
      assert.equal(
        active.inputs[0]!.prompt.includes('Continue the migration'),
        activated,
      );
      assert.equal(restarted.snapshot.conversation!.handoff, undefined);
    } finally {
      await restarted.close();
    }
  });
}

for (const action of ['interrupt', 'close'] as const) {
  await test(
    `${action} cancels an open memory editor and preserves pending-write provenance`,
    { timeout: 5000 },
    async () => {
      const opened = Promise.withResolvers<void>();
      const { coordinator, memory, root, project, a } = await fixture(
        async (path, signal) => {
          await writeFile(path, 'Pending manual preference.');
          opened.resolve();
          await new Promise<void>((_, reject) =>
            signal.addEventListener(
              'abort',
              () =>
                reject(new DOMException('Editing interrupted', 'AbortError')),
              { once: true },
            ),
          );
        },
      );
      const editing = coordinator.editMemory().catch(() => {});
      await opened.promise;
      await coordinator[action]();
      await editing;
      assert.equal(await memory.isDirty(), true);
      if (action === 'interrupt')
        assert.equal(coordinator.snapshot.phase, 'recovery');
      await coordinator.close();
      const reopened = await StateStore.open(join(root, 'state'));
      const recovered = new Coordinator(reopened, memory, [
        { adapter: a, executable: 'a' },
      ]);
      try {
        assert.equal((await reopened.load()).activity?.kind, 'memory-edit');
        await recovered.initialize(project);
        await recovered.recoverMemory('accept');
        const scope = await memory.scope(project);
        assert.match(
          (await memory.history(join(scope.project, 'MEMORY.md')))[0]!.subject,
          /recover manual changes/,
        );
      } finally {
        await recovered.close();
      }
    },
  );
}

await test('undelivered handoff context survives visiting another conversation and clears only after success', async () => {
  const {
    coordinator: original,
    store,
    memory,
    a,
    b,
    root,
    project,
  } = await fixture();
  const data = await store.load();
  await original.close();
  const conversation = data.conversations[0]!;
  conversation.agent = 'b';
  conversation.handoff = {
    from: 'a',
    to: 'b',
    activated: true,
    summary: 'Unique pending objective: amber-195.',
  };
  conversation.sessions.b = {
    id: 'destination',
    model: 'b-model',
    hasHistory: false,
  };
  const pending = await StateStore.open(join(root, 'state'));
  await pending.save(data);
  await pending.close();
  const coordinator = new Coordinator(
    await StateStore.open(join(root, 'state')),
    memory,
    [a, b].map((adapter) => ({ adapter, executable: adapter.id })),
  );
  try {
    await coordinator.initialize(project);
    await coordinator.newConversation('a');
    await coordinator.send('Independent task');
    assert.doesNotMatch(a.inputs.at(-1)!.prompt, /amber-195/);
    await coordinator.selectConversation(conversation.id);
    b.interruptNext = true;
    await coordinator.send('Continue');
    assert.match(b.inputs.at(-1)!.prompt, /amber-195/);
    assert.ok(coordinator.snapshot.conversation!.handoff);
    await coordinator.send('Continue manually');
    assert.match(b.inputs.at(-1)!.prompt, /amber-195/);
    assert.equal(coordinator.snapshot.conversation!.handoff, undefined);
  } finally {
    await coordinator.close();
  }
});
