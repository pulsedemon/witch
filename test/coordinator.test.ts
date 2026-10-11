import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
  readFile,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Coordinator } from '../src/core/coordinator.js';
import type { Conversation, ConversationRecord } from '../src/core/state.js';
import { Memory } from '../src/memory/memory.js';
import { identifyProcess } from '../src/persistence/process.js';
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
  readonly sessions: { options: SessionOptions; session: AgentSession }[] = [];
  failConnect = false;
  failClose = false;
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
    // a bounded stand-in for the native process, never the test runner's pid
    const sleeper = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    sleeper.unref();
    await options.onProcess(sleeper.pid);
    let closed = false;
    const session: AgentSession = {
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
        try {
          if (this.failClose) throw new Error('Close failed');
        } finally {
          sleeper.kill();
          await options.onProcess(undefined);
        }
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
    this.sessions.push({ options, session });
    return session;
  }
}

function record(id: string, cwd: string, agent = 'a'): Conversation {
  return {
    id,
    title: `Title ${id}`,
    cwd,
    agent,
    sessions: {},
    createdAt: new Date().toISOString(),
  };
}

function activity(conversationId: string): ConversationRecord['activity'] {
  return {
    id: 'stale-turn',
    conversationId,
    agent: 'a',
    kind: 'turn',
    baseRevision: 'unknown',
    startedAt: new Date().toISOString(),
  };
}

async function readRecord(
  root: string,
  id: string,
): Promise<ConversationRecord> {
  return JSON.parse(
    await readFile(
      join(root, 'state', 'conversations', id, 'state.json'),
      'utf8',
    ),
  ) as ConversationRecord;
}

async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} timed out`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(
  editFile?: ConstructorParameters<typeof Coordinator>[3],
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'witch-coordinator-')),
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
    assert.equal(
      (await memory.history(join(scope.project, 'MEMORY.md')))[0]!.subject,
      'chore(memory): recover a changes',
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
  const { coordinator, a, b, root } = await fixture();
  try {
    await coordinator.send('Start');
    b.failConnect = true;
    await assert.rejects(
      coordinator.switchAgent('b'),
      /Destination unavailable/,
    );
    assert.equal(coordinator.snapshot.conversation?.agent, 'a');
    const saved = await readRecord(root, coordinator.snapshot.conversation!.id);
    assert.equal(saved.sessions.a?.id, a.inputs[0]?.session);
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
      project,
    } = await fixture();
    const id = original.snapshot.conversation!.id;
    await original.close();
    const activated = ['activated', 'continuing', 'completed'].includes(stage);
    const files = await store.claim(id);
    const conversation = files.record;
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
      conversation.activity = {
        id: 'interrupted-destination-turn',
        conversationId: conversation.id,
        agent: 'b',
        kind: 'turn',
        baseRevision: await memory.revision(),
        startedAt: new Date().toISOString(),
      };
    await files.append({
      id: 'earlier',
      kind: 'user',
      text: 'Start the migration',
      cwd: project,
    });
    await files.save(conversation);
    await files.close();
    const restarted = new Coordinator(
      store,
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

await test('editing a previously committed symlink never opens its external target', async () => {
  let edits = 0;
  const { coordinator, memory, root, project } = await fixture(async () => {
    edits++;
  });
  try {
    const scope = await memory.scope(project);
    const target = join(root, 'external.md');
    const note = join(scope.project, 'linked.md');
    await writeFile(target, 'External content.');
    await symlink(target, note);
    const execute = promisify(execFile);
    await execute('git', ['add', '--all'], { cwd: memory.root });
    await execute(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@localhost',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '-m',
        'legacy symlink',
      ],
      { cwd: memory.root },
    );
    assert.equal(await memory.isDirty(), false);
    await assert.rejects(coordinator.editMemory(note), /regular file/);
    assert.equal(edits, 0);
    assert.equal(await readFile(target, 'utf8'), 'External content.');
    assert.equal(coordinator.snapshot.phase, 'idle');
  } finally {
    await coordinator.close();
  }
});

for (const action of ['interrupt', 'close'] as const) {
  await test(
    `${action} cancels an open memory editor and preserves pending-write provenance`,
    { timeout: 5000 },
    async () => {
      const opened = Promise.withResolvers<void>();
      const { coordinator, store, memory, root, project, a } = await fixture(
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
      const id = coordinator.snapshot.conversation!.id;
      const recovered = new Coordinator(store, memory, [
        { adapter: a, executable: 'a' },
      ]);
      try {
        assert.equal(
          (await readRecord(root, id)).activity?.kind,
          'memory-edit',
        );
        const files = await store.claim(id);
        await files.append({
          id: 'earlier',
          kind: 'notice',
          text: 'Earlier',
          cwd: project,
        });
        await files.close();
        await recovered.initialize(project);
        assert.equal(recovered.snapshot.conversation!.id, id);
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
    project,
  } = await fixture();
  const id = original.snapshot.conversation!.id;
  await original.close();
  const files = await store.claim(id);
  const conversation = files.record;
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
  await files.append({
    id: 'earlier',
    kind: 'user',
    text: 'Start',
    cwd: project,
  });
  await files.save(conversation);
  await files.close();
  const coordinator = new Coordinator(
    store,
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

async function sweepFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'witch-sweep-')));
  const project = join(root, 'project');
  const fresh = join(root, 'fresh');
  await mkdir(project);
  await mkdir(fresh);
  const store = await StateStore.open(join(root, 'state'));
  const memory = new Memory(join(root, 'state', 'memory'));
  const a = new FixtureAgent('a');
  const launch = async () => {
    const coordinator = new Coordinator(store, memory, [
      { adapter: a, executable: 'a' },
    ]);
    await coordinator.initialize(fresh);
    return coordinator;
  };
  const save = async (
    id: string,
    edit: (record: ConversationRecord) => void | Promise<void>,
  ) => {
    const files = await store.create(record(id, project));
    await edit(files.record);
    await files.save(files.record);
    await files.close();
  };
  return {
    root,
    store,
    launch,
    save,
    directory: (id: string) => join(root, 'state', 'conversations', id),
  };
}

await test('the launch sweep stops a live orphan in an unlocked conversation', async () => {
  const { root, launch, save } = await sweepFixture();
  const orphan = spawn('/bin/sleep', ['20'], { stdio: 'ignore' });
  try {
    const exited = once(orphan, 'exit');
    const process = await identifyProcess(orphan.pid!);
    await save('orphan', (saved) => {
      saved.process = process;
    });
    const coordinator = await launch();
    try {
      await within(exited, 2000, 'the orphan exit');
      assert.equal((await readRecord(root, 'orphan')).process, undefined);
      assert.equal(coordinator.snapshot.error, undefined);
    } finally {
      await coordinator.close();
    }
  } finally {
    orphan.kill('SIGKILL');
  }
});

await test('the launch sweep skips a conversation another instance holds', async () => {
  const { store, launch } = await sweepFixture();
  const sleeper = spawn('/bin/sleep', ['20'], { stdio: 'ignore' });
  const held = await store.create(record('held', '/elsewhere'));
  try {
    held.record.activity = activity('held');
    held.record.process = await identifyProcess(sleeper.pid!);
    await held.save(held.record);
    const coordinator = await launch();
    try {
      assert.equal(sleeper.exitCode, null);
      assert.doesNotThrow(() => process.kill(sleeper.pid!, 0));
      assert.equal(coordinator.snapshot.error, undefined);
    } finally {
      await coordinator.close();
    }
  } finally {
    await held.close();
    sleeper.kill('SIGKILL');
  }
});

await test('one conversation the sweep fails on does not stop the launch', async () => {
  const { store, launch, save, directory } = await sweepFixture();
  await save('readonly', (saved) => {
    saved.activity = activity('readonly');
  });
  await chmod(directory('readonly'), 0o500);
  try {
    const coordinator = await launch();
    try {
      assert.equal(coordinator.snapshot.phase, 'idle');
      assert.match(coordinator.snapshot.error ?? '', /Title readonly/);
    } finally {
      await coordinator.close();
    }
  } finally {
    await chmod(directory('readonly'), 0o700);
  }
  await (await store.claim('readonly')).close();
});

await test("the launch sweep clears a clean conversation's stale activity", async () => {
  const { root, launch, save } = await sweepFixture();
  await save('stale', (saved) => {
    saved.activity = activity('stale');
  });
  const coordinator = await launch();
  await coordinator.close();
  assert.equal((await readRecord(root, 'stale')).activity, undefined);
});

await test('an unreadable state file is named in the launch report and skipped', async () => {
  const { launch, directory } = await sweepFixture();
  await mkdir(directory('broken'));
  await writeFile(join(directory('broken'), 'state.json'), '{"id":');
  const coordinator = await launch();
  try {
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.match(
      coordinator.snapshot.error ?? '',
      /conversations\/broken\/state\.json/,
    );
  } finally {
    await coordinator.close();
  }
});

await test('a claim that fails for a reason other than a held lock is reported', async () => {
  const { launch, save, directory } = await sweepFixture();
  await save('blocked', (saved) => {
    saved.activity = activity('blocked');
  });
  await rm(join(directory('blocked'), 'lock'));
  await mkdir(join(directory('blocked'), 'lock'));
  const coordinator = await launch();
  try {
    assert.match(coordinator.snapshot.error ?? '', /Title blocked/);
  } finally {
    await coordinator.close();
  }
});

for (const reason of ['held', 'bad history'] as const) {
  await test(`a switch to a conversation with ${reason} keeps the current conversation, session and lock`, async () => {
    const { coordinator, store, a, root, project } = await fixture();
    const target = await store.create(record(randomUUID(), project));
    try {
      await coordinator.send('Start');
      const current = coordinator.snapshot.conversation!.id;
      if (reason === 'bad history') {
        await target.close();
        await writeFile(
          join(
            root,
            'state',
            'conversations',
            target.record.id,
            'history.jsonl',
          ),
          '{"id":\n',
        );
      }
      const resumed = a.resumed.length;
      await assert.rejects(
        coordinator.selectConversation(target.record.id),
        reason === 'held' ? /open in another Witch instance/ : /JSON/,
      );
      assert.equal(coordinator.snapshot.conversation!.id, current);
      await assert.rejects(
        store.claim(current),
        /open in another Witch instance/,
      );
      assert.equal(a.sessions.at(-1)!.session.closed, false);
      assert.equal(a.resumed.length, resumed);
      if (reason === 'bad history')
        await (await store.claim(target.record.id)).close();
    } finally {
      await target.close();
      await coordinator.close();
    }
  });
}

await test('selecting the current conversation keeps its session and claim', async () => {
  const { coordinator, store, a } = await fixture();
  try {
    await coordinator.send('Start');
    const current = coordinator.snapshot.conversation!.id;
    await coordinator.selectConversation(current);
    assert.equal(a.sessions.at(-1)!.session.closed, false);
    await assert.rejects(
      store.claim(current),
      /open in another Witch instance/,
    );
    assert.equal(coordinator.snapshot.error, undefined);
  } finally {
    await coordinator.close();
  }
});

async function failedCloseSwitch() {
  const context = await fixture();
  const { coordinator, store, a, project } = context;
  await coordinator.send('Start');
  const previous = coordinator.snapshot.conversation!.id;
  const released = a.sessions.at(-1)!.options;
  const target = await store.create({
    ...record(randomUUID(), project),
    handoff: { from: 'b', to: 'a', activated: false },
  });
  await target.close();
  a.failClose = true;
  await coordinator.selectConversation(target.record.id);
  a.failClose = false;
  return { ...context, previous, released, target: target.record.id };
}

await test('a disconnect that throws during a switch still adopts the new conversation', async () => {
  const { coordinator, store, previous, target } = await failedCloseSwitch();
  try {
    assert.equal(coordinator.snapshot.conversation!.id, target);
    assert.equal(coordinator.snapshot.conversation!.handoff, undefined);
    assert.match(coordinator.snapshot.error ?? '', /Close failed/);
    await (await store.claim(previous)).close();
  } finally {
    await coordinator.close();
  }
});

await test('a late event from a released session reaches neither conversation', async () => {
  const { coordinator, root, previous, released, target } =
    await failedCloseSwitch();
  const sleeper = spawn('/bin/sleep', ['5'], { stdio: 'ignore' });
  try {
    const reported = coordinator.snapshot.error;
    const errors: (string | undefined)[] = [];
    coordinator.subscribe(() => errors.push(coordinator.snapshot.error));
    const files = (id: string) =>
      Promise.all(
        ['state.json', 'history.jsonl'].map((name) =>
          readFile(
            join(root, 'state', 'conversations', id, name),
            'utf8',
          ).catch(() => ''),
        ),
      );
    const before = await files(previous);
    const adopted = await files(target);
    const items = coordinator.snapshot.items;
    released.onEvent({ type: 'text', id: 'late', text: 'Late text' });
    let rejection: unknown;
    await within(
      released.onProcess(sleeper.pid).catch((error: unknown) => {
        rejection = error;
      }),
      2000,
      'the late process report',
    );
    assert.equal(rejection, undefined);
    for (let elapsed = 0; elapsed < 200; elapsed += 20) {
      assert.deepEqual(await files(previous), before);
      assert.deepEqual(await files(target), adopted);
      await delay(20);
    }
    assert.equal(coordinator.snapshot.items, items);
    assert.equal((await readRecord(root, target)).process, undefined);
    assert.deepEqual(
      errors.filter((error) => error !== reported),
      [],
    );
  } finally {
    sleeper.kill('SIGKILL');
    await coordinator.close();
  }
});

await test('switching between conversations on one agent connects a fresh native session', async () => {
  const { coordinator, a, root } = await fixture();
  try {
    await coordinator.send('First');
    const first = coordinator.snapshot.conversation!.id;
    assert.ok((await readRecord(root, first)).process);
    await coordinator.newConversation('a');
    assert.equal((await readRecord(root, first)).process, undefined);
    await coordinator.send('Second');
    assert.notEqual(a.inputs.at(-1)!.session, a.inputs[0]!.session);
  } finally {
    await coordinator.close();
  }
});
