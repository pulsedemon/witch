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
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Coordinator } from '../src/core/coordinator.js';
import type { Conversation, ConversationRecord } from '../src/core/state.js';
import { Memory, main } from '../src/memory/memory.js';
import { identifyProcess } from '../src/persistence/process.js';
import { ConversationStore, StateStore } from '../src/persistence/store.js';
import { FixtureAgent, TurnGate } from './fixtures/agent.js';
import { hookedGit, passThrough } from './fixtures/git.js';
import type { GitHook } from './fixtures/git.js';
import { within } from './fixtures/within.js';

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

async function fixture(
  editFile?: ConstructorParameters<typeof Coordinator>[3],
  /** runs before the launch connects. */
  prepare?: (a: FixtureAgent, b: FixtureAgent) => void,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'witch-coordinator-')),
  );
  const project = join(root, 'project');
  await mkdir(project);
  const store = await StateStore.open(join(root, 'state'));
  const hook = { current: passThrough };
  const memory = new Memory(join(root, 'state', 'memory.git'), hookedGit(hook));
  const a = new FixtureAgent('a');
  const b = new FixtureAgent('b');
  const coordinator = new Coordinator(
    store,
    memory,
    [a, b].map((adapter) => ({ adapter, executable: adapter.id })),
    editFile,
  );
  prepare?.(a, b);
  await coordinator.initialize(project);
  const workspace = (id = coordinator.snapshot.conversation!.id) =>
    memory.workspace(join(root, 'state', 'conversations', id), id);
  const note = async () =>
    `${(await memory.scopePaths(project)).project}/MEMORY.md`;
  const notes = async () =>
    `${(await memory.scopePaths(project)).project}/notes.md`;
  /** another conversation's workspace, for publishing to main from outside. */
  const outsider = async (id = randomUUID()) => {
    await mkdir(join(root, 'state', 'conversations', id), { recursive: true });
    const other = workspace(id);
    await other.ensureWorktree();
    await other.scope(project);
    return other;
  };
  return {
    coordinator,
    store,
    memory,
    hook,
    a,
    b,
    root,
    project,
    workspace,
    note,
    notes,
    outsider,
  };
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
  const { coordinator, memory, a, workspace, note } = await fixture();
  try {
    a.interruptNext = true;
    await coordinator.send('remember-port');
    assert.equal(coordinator.snapshot.phase, 'recovery');
    await assert.rejects(coordinator.send('unrelated task'), /pending memory/);
    await coordinator.recoverMemory('accept');
    assert.equal(
      (await memory.history(main, await note()))[0]!.subject,
      'chore(memory): recover a changes',
    );
    assert.equal(await workspace().isDirty(), false);
    await coordinator.send('continue');
    assert.equal(a.inputs.length, 2);
  } finally {
    await coordinator.close();
  }
});

await test('handoff returns to the original native session with updated context', async () => {
  const { coordinator, a, b } = await fixture();
  try {
    await coordinator.send(' Start the migration\n');
    const original = a.inputs[0]!.session;
    await coordinator.switchAgent('b');
    assert.match(b.inputs[0]!.prompt, /a: finish the migration/);
    await coordinator.switchAgent('a');
    assert.equal(a.inputs.at(-1)!.session, original);
    assert.match(a.inputs.at(-1)!.prompt, /b: finish the migration/);
    assert.equal(coordinator.snapshot.conversation?.agent, 'a');
    assert.equal(
      coordinator.snapshot.conversation?.title,
      'Start the migration',
    );
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
  const { coordinator, a, note, outsider } = await fixture();
  try {
    await coordinator.send('remember-port');
    const other = await outsider();
    await writeFile(join(other.root, await note()), 'Use port 9001.');
    await other.commit('change port');
    await other.publish();
    await coordinator.send('Continue');
    assert.match(a.inputs.at(-1)!.prompt, /Use port 9001/);
    assert.doesNotMatch(a.inputs.at(-1)!.prompt, /Use port 4567/);
    assert.equal(a.inputs[0]?.session, a.inputs.at(-1)?.session);
    await coordinator.send('Again');
    assert.doesNotMatch(a.inputs.at(-1)!.prompt, /Accepted shared memory/);
  } finally {
    await coordinator.close();
  }
});

await test('recovery has one owner and shutdown waits for its accepted commit', async () => {
  const { coordinator, memory, a, workspace, note } = await fixture();
  a.interruptNext = true;
  await coordinator.send('remember-port');
  const recovering = coordinator.recoverMemory('accept');
  await assert.rejects(
    coordinator.recoverMemory('discard'),
    /Stop the current operation/,
  );
  await Promise.all([recovering, coordinator.close()]);
  assert.equal(await workspace().isDirty(), false);
  assert.match(await memory.read(main, await note()), /4567/);
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
        baseRevision: await memory.resolve(main),
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
      await restarted.initialize(project, { continue: true });
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
  const { coordinator, root, project, workspace } = await fixture(async () => {
    edits++;
  });
  try {
    const memory = workspace();
    await memory.ensureWorktree();
    const scope = await memory.scope(project);
    const target = join(root, 'external.md');
    const note = join(memory.root, scope.project, 'linked.md');
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
      const { coordinator, store, memory, root, project, a, workspace, note } =
        await fixture(async (path, signal) => {
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
        });
      const editing = coordinator.editMemory().catch(() => {});
      await opened.promise;
      await coordinator[action]();
      await editing;
      assert.equal(await workspace().isDirty(), true);
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
        await recovered.initialize(project, { continue: true });
        assert.equal(recovered.snapshot.conversation!.id, id);
        assert.equal(recovered.snapshot.phase, 'recovery');
        assert.equal(recovered.snapshot.error, undefined);
        await recovered.recoverMemory('accept');
        const [latest] = await memory.history(main, await note());
        assert.match(latest!.subject, /recover manual changes/);
        assert.match(
          await memory.git(memory.root, [
            'log',
            '-1',
            '--format=%b',
            latest!.revision,
          ]),
          new RegExp(`conversation: ${id}`),
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
    await coordinator.initialize(project, { continue: true });
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
  const memory = new Memory(join(root, 'state', 'memory.git'));
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
    memory,
    root,
    store,
    a,
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
  const { root, launch, save, memory } = await sweepFixture();
  await save('stale', (saved) => {
    saved.activity = activity('stale');
  });
  const coordinator = await launch();
  await coordinator.close();
  assert.equal((await readRecord(root, 'stale')).activity, undefined);
  assert.equal(
    await memory.git(memory.root, [
      'for-each-ref',
      'refs/heads/conversations/stale',
    ]),
    '',
  );
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
    assert.notEqual((await readRecord(root, target)).process?.pid, sleeper.pid);
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

/** a conversation whose branch holds an unpublished commit, made after any launch sweep. */
async function stranded(
  context: Awaited<ReturnType<typeof fixture>>,
  files: Record<string, string>,
  cwd = context.project,
) {
  const { store, workspace } = context;
  const created = await store.create(record(randomUUID(), cwd));
  const id = created.record.id;
  await created.append({ id: 'n', kind: 'notice', text: 'Earlier', cwd });
  const memory = workspace(id);
  await memory.ensureWorktree();
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(memory.root, path, '..'), { recursive: true });
    await writeFile(join(memory.root, path), text);
  }
  await memory.commit(`chore(memory): save a notes\n\nconversation: ${id}`);
  return { id, files: created, memory };
}

/** publishes a change to main from a workspace no conversation owns. */
async function publishOutside(
  context: Awaited<ReturnType<typeof fixture>>,
  files: Record<string, string>,
) {
  const other = await context.outsider();
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(other.root, path, '..'), { recursive: true });
    await writeFile(join(other.root, path), text);
  }
  await other.commit('chore(memory): save outside notes');
  await other.publish();
}

await test('an agent-created nested repository is refused on accept and removed on discard', async () => {
  const { coordinator, a, workspace, note } = await fixture();
  try {
    a.interruptNext = true;
    await coordinator.send('remember-port');
    const nested = join(workspace().root, await note(), '..', 'nested');
    await mkdir(nested);
    await promisify(execFile)('git', ['init', '--quiet', nested]);
    await assert.rejects(
      coordinator.recoverMemory('accept'),
      /regular file: .*nested/,
    );
    assert.equal(coordinator.snapshot.recovery?.kind, 'pending');
    await coordinator.recoverMemory('discard');
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.equal(await workspace().isDirty(), false);
  } finally {
    await coordinator.close();
  }
});

await test('a publish failure in settle is reported and the phase goes idle', async () => {
  const { coordinator, hook, memory } = await fixture();
  try {
    const before = await memory.resolve(main);
    hook.current = async (command, run) => {
      if (command[0] !== 'update-ref') return run();
      hook.current = passThrough;
      return { stdout: '', stderr: 'cannot lock ref', code: 1 };
    };
    await coordinator.send('remember-port');
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.match(coordinator.snapshot.error ?? '', /cannot lock ref/);
    assert.equal(await memory.resolve(main), before);
  } finally {
    await coordinator.close();
  }
});

await test('a failed rebase abort stops in the error phase until restart', async () => {
  const context = await fixture();
  const { coordinator, hook } = context;
  try {
    const target = await stranded(context, { 'global/one.md': 'Mine.\n' });
    await target.files.close();
    await publishOutside(context, { 'global/one.md': 'Theirs.\n' });
    hook.current = async (command, run) => {
      if (command.join(' ') !== 'rebase --abort') return run();
      hook.current = passThrough;
      throw new Error('abort failed');
    };
    await assert.rejects(
      coordinator.selectConversation(target.id),
      /Restart Witch/,
    );
    assert.equal(coordinator.snapshot.phase, 'error');
    await assert.rejects(coordinator.recoverMemory('accept'), /Restart Witch/);
  } finally {
    await coordinator.close().catch(() => {});
  }
});

await test('keep mine publishes with the attribution of the conversation that kept its side', async () => {
  const context = await fixture();
  const { coordinator, a, memory, notes } = context;
  const gate = new TurnGate();
  try {
    await coordinator.send('Start');
    a.gate = gate;
    const sending = coordinator.send('remember:mine');
    await within(gate.entered, 2000, 'the gated turn');
    await publishOutside(context, { [await notes()]: 'theirs' });
    gate.open();
    await sending;
    assert.equal(coordinator.snapshot.recovery?.kind, 'conflict');
    await coordinator.recoverMemory('keep');
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.equal(await memory.read(main, await notes()), 'mine');
    assert.match(
      await memory.git(memory.root, ['log', '-1', '--format=%b', main]),
      new RegExp(`conversation: ${coordinator.snapshot.conversation!.id}`),
    );
  } finally {
    gate.open();
    await coordinator.close();
  }
});

await test('two coordinators in two directories run turns at once and both publish', async () => {
  const context = await fixture();
  const { root, store, memory } = context;
  const other = join(root, 'other');
  await mkdir(other);
  const agents = [context.a, new FixtureAgent('a')];
  const gates = agents.map((agent) => (agent.gate = new TurnGate()));
  const coordinators = [
    context.coordinator,
    new Coordinator(store, memory, [{ adapter: agents[1]!, executable: 'a' }]),
  ];
  try {
    await coordinators[1]!.initialize(other);
    const sends = coordinators.map((coordinator, index) =>
      coordinator.send(`remember:note-${index}`),
    );
    await within(
      Promise.all(gates.map((gate) => gate.entered)),
      5000,
      'both turns',
    );
    for (const coordinator of coordinators)
      assert.equal(coordinator.snapshot.phase, 'running');
    for (const gate of gates) gate.open();
    await Promise.all(sends);
    for (const [index, cwd] of [context.project, other].entries()) {
      const path = `${(await memory.scopePaths(cwd)).project}/notes.md`;
      assert.equal(await memory.read(main, path), `note-${index}`);
      assert.match(
        await memory.git(memory.root, [
          'log',
          '-1',
          '--format=%b',
          main,
          '--',
          path,
        ]),
        new RegExp(
          `conversation: ${coordinators[index]!.snapshot.conversation!.id}`,
        ),
      );
    }
  } finally {
    for (const gate of gates) gate.open();
    for (const coordinator of coordinators) await coordinator.close();
  }
});

for (const decision of ['keep', 'discard'] as const) {
  await test(`a conflict between two coordinators resolves with ${decision}`, async () => {
    const context = await fixture();
    const { store, memory, project, notes } = context;
    await context.coordinator.close();
    const agents = [new FixtureAgent('a'), new FixtureAgent('a')];
    const gates = agents.map((agent) => (agent.gate = new TurnGate()));
    const coordinators = agents.map(
      (adapter) =>
        new Coordinator(store, memory, [{ adapter, executable: 'a' }]),
    );
    try {
      for (const coordinator of coordinators)
        await coordinator.initialize(project);
      const sends = coordinators.map((coordinator, index) =>
        coordinator.send(`remember:text-${index}`),
      );
      await within(
        Promise.all(gates.map((gate) => gate.entered)),
        5000,
        'both turns',
      );
      gates[0]!.open();
      await sends[0];
      gates[1]!.open();
      await sends[1];
      const second = coordinators[1]!;
      assert.equal(second.snapshot.recovery?.kind, 'conflict');
      await second.recoverMemory(decision);
      assert.equal(second.snapshot.phase, 'idle');
      if (decision === 'keep')
        assert.equal(await memory.read(main, await notes()), 'text-1');
      else
        assert.equal(
          await context.workspace(second.snapshot.conversation!.id).revision(),
          await memory.resolve(main),
        );
    } finally {
      for (const gate of gates) gate.open();
      for (const coordinator of coordinators) await coordinator.close();
    }
  });
}

await test('the launch sweep publishes an unpublished commit whose project directory is gone', async () => {
  const context = await fixture();
  const { root, memory } = context;
  await context.coordinator.close();
  const gone = await stranded(
    context,
    { 'global/stranded.md': 'Stranded.' },
    join(root, 'deleted-project'),
  );
  await gone.files.close();
  const fresh = join(root, 'fresh');
  await mkdir(fresh);
  const coordinator = new Coordinator(context.store, memory, [
    { adapter: context.a, executable: 'a' },
  ]);
  try {
    await coordinator.initialize(fresh);
    assert.equal(await memory.read(main, 'global/stranded.md'), 'Stranded.');
  } finally {
    await coordinator.close();
  }
});

await test('the launch sweep publishes what it can and reports the rest in one message', async () => {
  const context = await fixture();
  const { root, memory, store } = context;
  await context.coordinator.close();
  const conflict = await stranded(context, { 'global/one.md': 'Mine.\n' });
  await conflict.files.close();
  await publishOutside(context, { 'global/one.md': 'Theirs.\n' });
  const unpublished = await stranded(context, { 'global/two.md': 'Two.' });
  await unpublished.files.close();
  const dirty = await stranded(context, {});
  dirty.files.record.activity = activity(dirty.id);
  await dirty.files.save(dirty.files.record);
  await dirty.files.close();
  await writeFile(join(dirty.memory.root, 'global', 'three.md'), 'Three.');
  const fresh = join(root, 'fresh');
  await mkdir(fresh);
  for (const launch of [1, 2]) {
    const coordinator = new Coordinator(store, memory, [
      { adapter: context.a, executable: 'a' },
    ]);
    const reports: (string | undefined)[] = [];
    coordinator.subscribe(() => {
      if (coordinator.snapshot.phase !== 'starting')
        reports.push(coordinator.snapshot.error);
    });
    try {
      await coordinator.initialize(fresh);
      if (launch === 1)
        assert.equal(await memory.read(main, 'global/two.md'), 'Two.');
      assert.ok(reports.length > 0);
      for (const report of reports) {
        assert.match(report ?? '', /Open each from \/sessions/);
        assert.match(
          report ?? '',
          new RegExp(`Title ${conflict.id}.*conflicts`),
        );
        assert.match(report ?? '', new RegExp(`Title ${dirty.id}.*unfinished`));
        assert.doesNotMatch(
          report ?? '',
          new RegExp(`Title ${unpublished.id}`),
        );
      }
    } finally {
      await coordinator.close();
    }
  }
});

await test('a sweep failure after the claim is reported and releases the claim', async () => {
  const context = await fixture();
  const { root, store, memory } = context;
  await context.coordinator.close();
  const broken = await stranded(context, { 'global/x.md': 'X.' });
  broken.files.record.activity = activity(broken.id);
  await broken.files.save(broken.files.record);
  await broken.files.close();
  await writeFile(join(broken.memory.root, '.git'), 'not a worktree\n');
  const fresh = join(root, 'fresh');
  await mkdir(fresh);
  const coordinator = new Coordinator(store, memory, [
    { adapter: context.a, executable: 'a' },
  ]);
  try {
    await coordinator.initialize(fresh);
    assert.match(
      coordinator.snapshot.error ?? '',
      new RegExp(`Title ${broken.id}`),
    );
    await (await store.claim(broken.id)).close();
  } finally {
    await coordinator.close();
  }
});

await test('a switch target with a broken worktree leaves the current conversation untouched', async () => {
  const context = await fixture();
  const { coordinator, store, a } = context;
  try {
    await coordinator.send('Start');
    const current = coordinator.snapshot.conversation!.id;
    const target = await stranded(context, { 'global/x.md': 'X.' });
    await target.files.close();
    await writeFile(join(target.memory.root, '.git'), 'not a worktree\n');
    await assert.rejects(coordinator.selectConversation(target.id));
    assert.equal(coordinator.snapshot.conversation!.id, current);
    assert.equal(a.sessions.at(-1)!.session.closed, false);
    await assert.rejects(
      store.claim(current),
      /open in another Witch instance/,
    );
  } finally {
    await coordinator.close();
  }
});

await test('opening a conversation aborts its stopped rebase before classifying it', async () => {
  const context = await fixture();
  const { coordinator } = context;
  try {
    const target = await stranded(context, { 'global/one.md': 'Mine.\n' });
    await target.files.close();
    await publishOutside(context, { 'global/one.md': 'Theirs.\n' });
    await promisify(execFile)(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'rebase', main],
      { cwd: target.memory.root },
    ).catch(() => {});
    assert.equal(await target.memory.rebaseStopped(), true);
    await coordinator.selectConversation(target.id);
    assert.equal(await target.memory.rebaseStopped(), false);
    assert.equal(coordinator.snapshot.recovery?.kind, 'conflict');
  } finally {
    await coordinator.close();
  }
});

/** conversations with history, created in name order. */
async function listed(
  store: StateStore,
  root: string,
  cwd: string,
  ids: string[],
) {
  for (const id of ids) {
    const files = await store.create(record(id, cwd));
    await files.append({ id: 'n', kind: 'notice', text: id, cwd });
    await files.close();
  }
  const touch = (id: string, seconds: number) =>
    utimes(
      join(root, 'state', 'conversations', id, 'history.jsonl'),
      seconds,
      seconds,
    );
  return touch;
}

await test('continue opens the newest conversation in this directory, ignoring newer ones elsewhere', async () => {
  const { coordinator: first, store, root, project, a } = await fixture();
  await first.close();
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere);
  const touch = await listed(store, root, project, ['a1', 'a2', 'a3']);
  await listed(store, root, elsewhere, ['b1']);
  await touch('a1', 1000);
  await touch('a2', 3000);
  await touch('a3', 2000);
  await touch('b1', 4000);
  const coordinator = new Coordinator(store, first.memory, [
    { adapter: a, executable: 'a' },
  ]);
  try {
    await coordinator.initialize(project, { continue: true });
    assert.equal(coordinator.snapshot.conversation!.id, 'a2');
  } finally {
    await coordinator.close();
  }
});

await test('continue with nothing in this directory starts a new conversation here', async () => {
  const { coordinator: first, store, root, project, a } = await fixture();
  await first.close();
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere);
  await listed(store, root, elsewhere, ['b1']);
  const coordinator = new Coordinator(store, first.memory, [
    { adapter: a, executable: 'a' },
  ]);
  try {
    await coordinator.initialize(project, { continue: true });
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.notEqual(coordinator.snapshot.conversation!.id, 'b1');
    assert.equal(coordinator.snapshot.conversation!.cwd, project);
  } finally {
    await coordinator.close();
  }
});

await test('a plain launch starts a new conversation even when this directory has one', async () => {
  const { coordinator: first, store, root, project, a } = await fixture();
  await first.close();
  await listed(store, root, project, ['earlier']);
  const coordinator = new Coordinator(store, first.memory, [
    { adapter: a, executable: 'a' },
  ]);
  try {
    await coordinator.initialize(project);
    assert.notEqual(coordinator.snapshot.conversation!.id, 'earlier');
  } finally {
    await coordinator.close();
  }
});

await test("/sessions lists only this directory's conversations", async () => {
  const { coordinator, store, root, project } = await fixture();
  try {
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    await listed(store, root, project, ['here']);
    await listed(store, root, elsewhere, ['there']);
    assert.deepEqual(
      (await coordinator.conversations()).map(({ id }) => id),
      ['here'],
    );
  } finally {
    await coordinator.close();
  }
});

await test('continue into a held conversation shows the lock error with the launch report', async () => {
  const context = await fixture();
  const { coordinator: first, store, root, project, a, memory } = context;
  await first.close();
  await listed(store, root, project, ['held']);
  const holder = await store.claim('held');
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere);
  const dirty = await stranded(context, {}, elsewhere);
  dirty.files.record.activity = activity(dirty.id);
  await dirty.files.save(dirty.files.record);
  await dirty.files.close();
  await writeFile(join(dirty.memory.root, 'global', 'pending.md'), 'Pending.');
  const coordinator = new Coordinator(store, memory, [
    { adapter: a, executable: 'a' },
  ]);
  try {
    await assert.rejects(coordinator.initialize(project, { continue: true }));
    assert.equal(coordinator.snapshot.phase, 'error');
    assert.match(
      coordinator.snapshot.error ?? '',
      /open in another Witch instance/,
    );
    assert.doesNotMatch(coordinator.snapshot.error ?? '', /^Restart Witch/);
    assert.match(
      coordinator.snapshot.error ?? '',
      new RegExp(`Title ${dirty.id}`),
    );
  } finally {
    await holder.close();
    await coordinator.close();
  }
});

await test('a publish failure while settling the launch is added to its report', async () => {
  const context = await fixture();
  const { coordinator: first, store, root, memory, hook, a } = context;
  await first.close();
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere);
  const dirty = await stranded(context, {}, elsewhere);
  dirty.files.record.activity = activity(dirty.id);
  await dirty.files.save(dirty.files.record);
  await dirty.files.close();
  await writeFile(join(dirty.memory.root, 'global', 'pending.md'), 'Pending.');
  const own = await stranded(context, { 'global/own.md': 'Own.' });
  await own.files.close();
  hook.current = async (command, run, options) => {
    if (command[0] !== 'update-ref' || options.cwd !== own.memory.root)
      return run();
    hook.current = passThrough;
    return { stdout: '', stderr: 'cannot lock ref', code: 1 };
  };
  const coordinator = new Coordinator(store, memory, [
    { adapter: a, executable: 'a' },
  ]);
  try {
    await coordinator.initialize(context.project, { continue: true });
    assert.equal(coordinator.snapshot.conversation!.id, own.id);
    assert.match(
      coordinator.snapshot.error ?? '',
      new RegExp(`Title ${dirty.id}`),
    );
    assert.match(coordinator.snapshot.error ?? '', /cannot lock ref/);
  } finally {
    await coordinator.close();
  }
});

/** holds the snapshot's note listing until released. a turn takes a snapshot only after memory moves. */
function holdSnapshot(hook: { current: GitHook }) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  hook.current = async (command, run) => {
    if (command[0] === 'ls-tree' && command[1] === '-r') {
      hook.current = passThrough;
      entered.resolve();
      await release.promise;
    }
    return run();
  };
  return { entered: entered.promise, release: () => release.resolve() };
}

await test('an interrupt during the memory snapshot delivers nothing', async () => {
  const { coordinator, a, hook } = await fixture();
  try {
    await coordinator.send('remember-port');
    const before = a.inputs.length;
    const snapshot = holdSnapshot(hook);
    const sending = coordinator.send('Second');
    await within(snapshot.entered, 2000, 'the snapshot');
    await coordinator.interrupt();
    snapshot.release();
    assert.equal(await within(sending, 2000, 'the send'), false);
    assert.equal(a.inputs.length, before);
  } finally {
    await coordinator.close();
  }
});

await test('a connect failure leaves the prompt undelivered', async () => {
  const { coordinator } = await fixture(undefined, (a) => {
    a.failConnect = true;
  });
  try {
    assert.equal(await coordinator.send('Start'), false);
    assert.match(coordinator.snapshot.error ?? '', /Destination unavailable/);
  } finally {
    await coordinator.close();
  }
});

await test('a session that closes during the snapshot receives nothing', async () => {
  const { coordinator, a, hook } = await fixture();
  try {
    await coordinator.send('remember-port');
    const before = a.inputs.length;
    const snapshot = holdSnapshot(hook);
    const sending = coordinator.send('Second');
    await within(snapshot.entered, 2000, 'the snapshot');
    await a.sessions.at(-1)!.session.close();
    snapshot.release();
    assert.equal(await within(sending, 2000, 'the send'), false);
    assert.equal(a.inputs.length, before);
    assert.ok(
      !coordinator.snapshot.items.some(
        (item) => item.kind === 'user' && item.text === 'Second',
      ),
    );
  } finally {
    await coordinator.close();
  }
});

await test('Ctrl+C during the save before sending reaches the agent', async () => {
  const { coordinator, a, hook } = await fixture();
  const gate = new TurnGate();
  const save = ConversationStore.prototype.save;
  const held = Promise.withResolvers<void>();
  try {
    await coordinator.send('remember-port');
    a.gate = gate;
    let armed = false;
    hook.current = async (command, run) => {
      if (command[0] === 'ls-tree' && command[1] === '-r') {
        hook.current = passThrough;
        armed = true;
      }
      return run();
    };
    ConversationStore.prototype.save = function (record) {
      if (!armed) return save.call(this, record);
      armed = false;
      return held.promise.then(() => save.call(this, record));
    };
    const sending = coordinator.send('Second');
    await within(gate.entered, 2000, 'the gated turn');
    await coordinator.interrupt();
    assert.equal(
      (await within(gate.result, 2000, 'the turn result')).status,
      'interrupted',
    );
    held.resolve();
    assert.equal(await sending, true);
  } finally {
    ConversationStore.prototype.save = save;
    held.resolve();
    gate.open();
    await coordinator.close();
  }
});

await test('a failure after the agent has the prompt still counts as delivered', async () => {
  const { coordinator } = await fixture();
  try {
    assert.equal(await coordinator.send('symlink-note'), true);
    assert.match(coordinator.snapshot.error ?? '', /regular file/);
  } finally {
    await coordinator.close();
  }
});

/** a conversation on agent a with one turn, ready to hand off to b. */
async function handoffFixture() {
  const context = await fixture();
  await context.coordinator.send('Start the migration');
  const source = context.a.inputs[0]!.session;
  const assertSourceActive = async () => {
    const { coordinator, a, root } = context;
    const conversation = coordinator.snapshot.conversation!;
    assert.equal(conversation.agent, 'a');
    assert.equal(conversation.handoff, undefined);
    assert.equal(
      (await readRecord(root, conversation.id)).sessions.a?.id,
      source,
    );
    assert.equal(a.sessions.at(-1)!.session.closed, true);
    a.gate = undefined;
    await coordinator.send('Continue here');
    assert.equal(a.inputs.at(-1)!.session, source);
  };
  return { ...context, assertSourceActive };
}

await test('a handoff cancelled during the summary keeps the source', async () => {
  const context = await handoffFixture();
  const { coordinator, a } = context;
  const gate = new TurnGate();
  a.gate = gate;
  try {
    const switching = coordinator.switchAgent('b');
    await within(gate.entered, 2000, 'the summary turn');
    await coordinator.interrupt();
    await assert.rejects(switching, /interrupted/);
    await context.assertSourceActive();
  } finally {
    gate.open();
    await coordinator.close();
  }
});

await test('a handoff cancelled while the summary is saved never connects the destination', async () => {
  const context = await handoffFixture();
  const { coordinator, a, b } = context;
  const gate = new TurnGate();
  a.gate = gate;
  const save = ConversationStore.prototype.save;
  const held = Promise.withResolvers<void>();
  const holding = Promise.withResolvers<void>();
  try {
    const switching = coordinator.switchAgent('b');
    await within(gate.entered, 2000, 'the summary turn');
    ConversationStore.prototype.save = function (record) {
      ConversationStore.prototype.save = save;
      holding.resolve();
      return held.promise.then(() => save.call(this, record));
    };
    gate.open();
    await within(holding.promise, 2000, 'the save after the summary');
    const connects = b.resumed.length;
    await coordinator.interrupt();
    held.resolve();
    await assert.rejects(switching, /interrupted/);
    assert.equal(b.resumed.length, connects);
    await context.assertSourceActive();
  } finally {
    ConversationStore.prototype.save = save;
    held.resolve();
    gate.open();
    await coordinator.close();
  }
});

await test('a handoff cancelled during the destination connect keeps the source', async () => {
  const context = await handoffFixture();
  const { coordinator, b } = context;
  const connecting = Promise.withResolvers<void>();
  b.beforeConnect = async (options) => {
    connecting.resolve();
    await new Promise((resolve) =>
      options.signal?.addEventListener('abort', resolve, { once: true }),
    );
  };
  try {
    const switching = coordinator.switchAgent('b');
    await within(connecting.promise, 2000, 'the destination connect');
    await coordinator.interrupt();
    await assert.rejects(switching, /interrupted/);
    await context.assertSourceActive();
  } finally {
    await coordinator.close();
  }
});

await test('a handoff cancelled during the continuation stays with the destination', async () => {
  const context = await handoffFixture();
  const { coordinator, b } = context;
  const gate = new TurnGate();
  b.gate = gate;
  try {
    const switching = coordinator.switchAgent('b');
    await within(gate.entered, 2000, 'the continuation');
    await coordinator.interrupt();
    await within(switching, 2000, 'the handoff');
    const conversation = coordinator.snapshot.conversation!;
    assert.equal(conversation.agent, 'b');
    assert.equal(conversation.handoff?.activated, true);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

await test('close ends a held turn when its interrupt throws', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    await coordinator.send('Start');
    a.gate = gate;
    let sent = false;
    const sending = coordinator.send('Held').finally(() => {
      sent = true;
    });
    await within(gate.entered, 2000, 'the gated turn');
    a.failInterrupt = true;
    a.failClose = true;
    await within(
      assert.rejects(coordinator.close(), /Interrupt failed/),
      3000,
      'close',
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent, true);
    await sending.catch(() => {});
  } finally {
    gate.open();
    a.failInterrupt = false;
    a.failClose = false;
  }
});

await test('close releases the conversation when its disconnect throws', async () => {
  const { coordinator, a, store } = await fixture();
  await coordinator.send('Start');
  const id = coordinator.snapshot.conversation!.id;
  a.failClose = true;
  await assert.rejects(coordinator.close(), /Close failed/);
  await (await store.claim(id)).close();
});

await test('close rejects with a publish failure and still closes the session and the conversation', async () => {
  const { coordinator, a, hook, store } = await fixture();
  a.interruptNext = true;
  await coordinator.send('remember-port');
  const id = coordinator.snapshot.conversation!.id;
  let attempted = false;
  hook.current = async (command, run) => {
    if (command[0] !== 'update-ref') return run();
    attempted = true;
    return { stdout: '', stderr: 'cannot publish', code: 1 };
  };
  const recovering = coordinator.recoverMemory('accept');
  await assert.rejects(coordinator.close(), /cannot publish/);
  await recovering.catch(() => {});
  assert.equal(attempted, true);
  assert.equal(a.sessions.at(-1)!.session.closed, true);
  await (await store.claim(id)).close();
});

await test('a failed state write in settle needs a restart, and later messages keep it', async () => {
  const { coordinator, root } = await fixture();
  const directory = join(
    root,
    'state',
    'conversations',
    coordinator.snapshot.conversation!.id,
  );
  try {
    await coordinator.send('Start');
    await chmod(directory, 0o500);
    await assert.rejects(coordinator.send('Next'), /Restart Witch/);
    coordinator.report('x');
    assert.match(coordinator.snapshot.error ?? '', /^Restart Witch/);
    await assert.rejects(coordinator.send('Again'), /Restart Witch/);
  } finally {
    await chmod(directory, 0o700);
    await coordinator.close().catch(() => {});
  }
});

await test('a failed state write while continuing at launch needs a restart', async () => {
  const {
    coordinator: first,
    store,
    memory,
    root,
    project,
    a,
  } = await fixture();
  await first.send('Start');
  const id = first.snapshot.conversation!.id;
  await first.close();
  const directory = join(root, 'state', 'conversations', id);
  await chmod(directory, 0o500);
  const coordinator = new Coordinator(store, memory, [
    { adapter: a, executable: 'a' },
  ]);
  try {
    await assert.rejects(
      coordinator.initialize(project, { continue: true }),
      /Restart Witch/,
    );
    assert.match(coordinator.snapshot.error ?? '', /^Restart Witch/);
  } finally {
    await chmod(directory, 0o700);
    await coordinator.close().catch(() => {});
  }
});

await test('a failed history write outside any operation needs a restart', async () => {
  const { coordinator, a, root } = await fixture();
  const directory = join(
    root,
    'state',
    'conversations',
    coordinator.snapshot.conversation!.id,
  );
  try {
    await coordinator.refreshModels();
    await chmod(directory, 0o500);
    const errors: string[] = [];
    coordinator.subscribe(() => {
      if (coordinator.snapshot.error) errors.push(coordinator.snapshot.error);
    });
    a.sessions
      .at(-1)!
      .options.onEvent({ type: 'notice', text: 'Native notice' });
    for (let attempt = 0; attempt < 100 && !errors.length; attempt++)
      await delay(10);
    assert.match(errors[0] ?? '', /^Restart Witch/);
  } finally {
    await chmod(directory, 0o700);
    await coordinator.close().catch(() => {});
  }
});

await test('a git failure in settle shows its own message without a restart', async () => {
  const { coordinator, a, hook } = await fixture();
  const gate = new TurnGate();
  try {
    await coordinator.send('Start');
    a.gate = gate;
    const sending = coordinator.send('Next');
    await within(gate.entered, 2000, 'the gated turn');
    hook.current = async (command, run) => {
      if (command.join(' ') !== 'rev-parse --git-path rebase-merge')
        return run();
      hook.current = passThrough;
      return { stdout: '', stderr: 'git path failed', code: 128 };
    };
    gate.open();
    await assert.rejects(sending);
    assert.equal(coordinator.snapshot.phase, 'error');
    assert.equal(coordinator.snapshot.error, 'git path failed');
  } finally {
    gate.open();
    await coordinator.close().catch(() => {});
  }
});

await test('a model chosen to keep the current effort stores the effort in force', async () => {
  const { coordinator, root } = await fixture();
  try {
    await coordinator.selectModel('first', 'high');
    await coordinator.selectModel('second');
    const record = await readRecord(
      root,
      coordinator.snapshot.conversation!.id,
    );
    assert.equal(record.sessions.a?.effort, 'high');
  } finally {
    await coordinator.close();
  }
});

await test('a model that lists no efforts resets the effort', async () => {
  const { coordinator, a, root } = await fixture();
  try {
    await coordinator.selectModel('first', 'high');
    await coordinator.selectModel('a-model');
    assert.deepEqual(a.selections.at(-1), ['a-model', null]);
    const record = await readRecord(
      root,
      coordinator.snapshot.conversation!.id,
    );
    assert.equal(record.sessions.a?.effort, undefined);
  } finally {
    await coordinator.close();
  }
});

await test('opening a conversation connects its agent, at launch, on /new and from /sessions', async () => {
  const { coordinator, a, store, project } = await fixture();
  try {
    assert.equal(a.sessions.length, 1);
    await coordinator.newConversation();
    assert.equal(a.sessions.length, 2);
    const other = await store.create(record(randomUUID(), project));
    await other.close();
    await coordinator.selectConversation(other.record.id);
    assert.equal(a.sessions.length, 3);
  } finally {
    await coordinator.close();
  }
});

await test('a connect failure at launch joins the launch report and leaves the conversation open', async () => {
  const { launch, directory, a } = await sweepFixture();
  await mkdir(directory('broken'));
  await writeFile(join(directory('broken'), 'state.json'), '{"id":');
  a.failConnect = true;
  const coordinator = await launch();
  try {
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.ok(coordinator.snapshot.conversation);
    assert.match(
      coordinator.snapshot.error ?? '',
      /conversations\/broken\/state\.json[\s\S]*Destination unavailable/,
    );
  } finally {
    await coordinator.close();
  }
});

await test('the live session publishes its skills, and a failed connect after /new shows none', async () => {
  const review = { name: 'review', description: 'Review changes' };
  const { coordinator, b } = await fixture(undefined, (a) => {
    a.skills = [review];
  });
  try {
    assert.deepEqual(coordinator.snapshot.skills, [review]);
    b.failConnect = true;
    await assert.rejects(coordinator.newConversation('b'));
    assert.equal(coordinator.snapshot.conversation!.agent, 'b');
    assert.deepEqual(coordinator.snapshot.skills, []);
  } finally {
    await coordinator.close();
  }
});

await test('a skills failure while connecting is reported and keeps the session', async () => {
  const { coordinator, a } = await fixture();
  try {
    a.failSkills = true;
    await coordinator.newConversation();
    assert.match(coordinator.snapshot.error ?? '', /Skills unavailable/);
    assert.deepEqual(coordinator.snapshot.skills, []);
    assert.equal(await coordinator.send('Start'), true);
    assert.equal(a.sessions.length, 2);
  } finally {
    await coordinator.close();
  }
});

await test('a listed /skill reaches the agent as a skill call, and an unlisted one stays a prompt', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [{ name: 'review', description: 'Review changes' }];
  });
  try {
    await coordinator.send(' /review  the\ndiff ');
    assert.deepEqual(a.inputs.at(-1)!.skill, {
      name: 'review',
      args: 'the\ndiff',
    });
    assert.match(a.inputs.at(-1)!.prompt, /User request:\n \/review {2}the/);
    await coordinator.send('/reviewer x');
    assert.equal(a.inputs.at(-1)!.skill, undefined);
  } finally {
    await coordinator.close();
  }
});

await test('a native skills change replaces the list, unless its session has closed', async () => {
  const { coordinator, a } = await fixture();
  try {
    const { options, session } = a.sessions.at(-1)!;
    const later = [{ name: 'later', description: 'Added later' }];
    options.onEvent({ type: 'skills', skills: later });
    assert.deepEqual(coordinator.snapshot.skills, later);
    await session.close();
    options.onEvent({ type: 'skills', skills: [] });
    assert.deepEqual(coordinator.snapshot.skills, later);
  } finally {
    await coordinator.close();
  }
});

/** a conversation with history, last used at `seconds`. */
async function used(
  store: StateStore,
  root: string,
  conversation: Conversation,
  seconds?: number,
) {
  const files = await store.create(conversation);
  if (seconds !== undefined)
    await files.append({ id: 'n', kind: 'notice', text: 'used', cwd: '/' });
  await files.close();
  if (seconds !== undefined)
    await utimes(
      join(root, 'state', 'conversations', conversation.id, 'history.jsonl'),
      seconds,
      seconds,
    );
}

const chosen = (agent: string, model: string, effort?: string) => ({
  [agent]: {
    id: `${agent}-native`,
    model,
    requestedModel: model,
    hasHistory: true,
    ...(effort ? { effort } : {}),
  },
});

/** a second launch in a new directory, sharing the first one's state. */
async function relaunch(
  installed: string[],
  prepare?: (a: FixtureAgent) => void,
) {
  const context = await fixture();
  await context.coordinator.close();
  const a = new FixtureAgent('a');
  const b = new FixtureAgent('b');
  prepare?.(a);
  const launch = async (cwd: string) => {
    await mkdir(cwd, { recursive: true });
    const coordinator = new Coordinator(
      context.store,
      context.coordinator.memory,
      [a, b].map((adapter) => ({
        adapter,
        executable: installed.includes(adapter.id) ? adapter.id : undefined,
      })),
    );
    await coordinator.initialize(cwd);
    return coordinator;
  };
  return { ...context, a, b, launch };
}

await test('a launch takes the agent, model and effort of the newest used conversation in any directory', async () => {
  const { store, root, project, b, launch } = await relaunch(['a', 'b']);
  await used(
    store,
    root,
    { ...record('older', project), sessions: chosen('a', 'a-old') },
    1000,
  );
  await used(
    store,
    root,
    {
      ...record('newest', join(root, 'elsewhere'), 'b'),
      sessions: chosen('b', 'b-big', 'high'),
    },
    3000,
  );
  await used(store, root, {
    ...record('unused', project, 'a'),
    sessions: chosen('a', 'a-unused'),
  });
  const coordinator = await launch(join(root, 'third'));
  try {
    assert.equal(coordinator.snapshot.conversation!.agent, 'b');
    const { options } = b.sessions.at(-1)!;
    assert.deepEqual(
      [options.model, options.effort, options.resume],
      ['b-big', 'high', undefined],
    );
  } finally {
    await coordinator.close();
  }
});

await test('a launch whose newest agent is uninstalled starts the first installed one on its default', async () => {
  const { store, root, a, launch } = await relaunch(['a']);
  await used(
    store,
    root,
    { ...record('newest', root, 'b'), sessions: chosen('b', 'b-big') },
    3000,
  );
  const coordinator = await launch(join(root, 'next'));
  try {
    assert.equal(coordinator.snapshot.conversation!.agent, 'a');
    assert.equal(a.sessions.at(-1)!.options.model, undefined);
  } finally {
    await coordinator.close();
  }
});

await test('a failed first connect keeps the remembered model, and a model chosen next connects with it', async () => {
  const { store, root, a, launch } = await relaunch(['a', 'b'], (a) => {
    a.failConnect = true;
  });
  await used(
    store,
    root,
    { ...record('newest', root), sessions: chosen('a', 'a-big', 'high') },
    3000,
  );
  const coordinator = await launch(join(root, 'next'));
  try {
    assert.match(coordinator.snapshot.error ?? '', /Destination unavailable/);
    const id = coordinator.snapshot.conversation!.id;
    assert.equal(
      (await readRecord(root, id)).sessions.a?.requestedModel,
      'a-big',
    );
    a.failConnect = false;
    await coordinator.selectModel('a-new');
    const { options } = a.sessions.at(-1)!;
    assert.deepEqual([options.model, options.effort], ['a-new', 'high']);
  } finally {
    await coordinator.close();
  }
});

await test('/new copies this conversation for its own agent, and starts another agent on its default', async () => {
  const { coordinator, a, b, store, project } = await fixture();
  try {
    const source = await store.create({
      ...record(randomUUID(), project),
      sessions: { ...chosen('a', 'a-big', 'high'), ...chosen('b', 'b-big') },
    });
    await source.close();
    await coordinator.selectConversation(source.record.id);
    await coordinator.newConversation('b');
    assert.equal(b.sessions.at(-1)!.options.model, undefined);
    await coordinator.newConversation();
    assert.equal(b.sessions.at(-1)!.options.model, undefined);
    await coordinator.selectConversation(source.record.id);
    const opened = a.sessions.at(-1)!.session.info.id;
    await coordinator.newConversation();
    const { options, session } = a.sessions.at(-1)!;
    assert.deepEqual(
      [options.model, options.effort, options.resume],
      ['a-big', 'high', undefined],
    );
    assert.notEqual(session.info.id, opened);
  } finally {
    await coordinator.close();
  }
});
