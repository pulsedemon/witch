import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  utimes,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { Coordinator } from '../src/core/coordinator.js';
import type { Conversation, ConversationRecord } from '../src/core/state.js';
import { Memory } from '../src/memory/memory.js';
import { identifyProcess } from '../src/persistence/process.js';
import { StateStore } from '../src/persistence/store.js';
import { recoverDirectory } from '../src/persistence/directory-recovery.js';
import { FixtureAgent } from './fixtures/agent.js';
import {
  record,
  activity,
  readRecord,
  fixture,
  stranded,
} from './fixtures/coordinator.js';
import { passThrough } from './fixtures/git.js';
import { scratch } from './fixtures/scratch.js';
import { within } from './fixtures/within.js';

async function relocatedFixture() {
  const f = await fixture();
  await f.coordinator.close();
  await f.git('init', '-b', 'main');
  await f.git(
    'remote',
    'add',
    'origin',
    'https://example.invalid/directory-recovery.git',
  );
  const scope = await f.memory.scopePaths(f.project);
  const destination = join(f.root, 'renamed project');
  const move = async () => {
    await rename(f.project, destination);
    const report = await recoverDirectory(
      f.store,
      f.memory,
      f.project,
      destination,
      true,
    );
    assert.equal(report.applied, true, report.blockers.join('\n'));
  };
  const coordinator = new Coordinator(f.store, f.memory, [
    { adapter: f.a, executable: 'a' },
    { adapter: f.b, executable: 'b' },
  ]);
  return { ...f, scope, destination, move, coordinator };
}

test('recovered conversations reconnect with their saved IDs in the destination', async () => {
  const f = await relocatedFixture();
  for (const [id, agent, model, effort, date] of [
    ['old-a', 'a', 'a-big', 'high', '2020-01-01'],
    ['old-b', 'b', 'b-model', undefined, '2020-01-02'],
  ] as const) {
    const saved = record(id, f.project, agent);
    saved.sessions[agent] = {
      id: `native-${agent}`,
      model,
      requestedModel: model,
      effort,
      hasHistory: true,
      deliveredProject: f.scope.project,
    };
    const files = await f.store.create(saved);
    await files.append({
      id: `history-${agent}`,
      kind: 'assistant',
      cwd: f.project,
      text: `original ${agent}`,
    });
    await files.close();
    await utimes(
      join(f.root, 'state', 'conversations', id, 'history.jsonl'),
      new Date(date),
      new Date(date),
    );
  }
  await f.move();
  try {
    await f.coordinator.initialize(f.destination, { continue: true });
    assert.equal(f.coordinator.snapshot.conversation!.id, 'old-b');
    assert.equal(f.coordinator.snapshot.native!.id, 'native-b');
    assert.ok(
      f.coordinator.snapshot.items.some(({ text }) => text === 'original b'),
    );
    assert.deepEqual(
      (await f.coordinator.conversations()).map(({ id }) => id),
      ['old-b', 'old-a'],
    );
    await f.coordinator.selectConversation('old-a');
    assert.equal(f.coordinator.snapshot.native!.id, 'native-a');
    assert.ok(
      f.coordinator.snapshot.items.some(({ text }) => text === 'original a'),
    );
    for (const [agent, id, model, effort] of [
      [f.a, 'old-a', 'a-big', 'high'],
      [f.b, 'old-b', 'b-model', undefined],
    ] as const) {
      const options = agent.sessions.at(-1)!.options;
      assert.deepEqual(
        {
          cwd: options.cwd,
          resume: options.resume,
          model: options.model,
          effort: options.effort,
          memoryDirectories: options.memoryDirectories,
        },
        {
          cwd: f.destination,
          resume: `native-${agent.id}`,
          model,
          effort,
          memoryDirectories: [f.scope.global, f.scope.project].map((scope) =>
            join(f.root, 'state', 'conversations', id, 'memory', scope),
          ),
        },
      );
      assert.equal(agent.inputs.length, 0);
    }
    assert.deepEqual(
      await f.coordinator.memoryDirectories(),
      [f.scope.global, f.scope.project].map((scope) =>
        join(f.root, 'state', 'conversations', 'old-a', 'memory', scope),
      ),
    );
  } finally {
    await f.coordinator.close();
  }
});

test('directory recovery preserves pending memory and keeps a new turn queued', async () => {
  const f = await relocatedFixture();
  const note = `${f.scope.project}/pending.md`;
  const dirty = await stranded(f, { [note]: 'committed' });
  const pending = 'pending edit';
  await writeFile(join(dirty.memory.root, note), pending);
  dirty.files.record.activity = {
    ...activity()!,
    baseRevision: await dirty.memory.revision(),
  };
  await dirty.files.save(dirty.files.record);
  await dirty.files.close();
  const before = await readRecord(f.root, dirty.id);
  await f.move();
  assert.deepEqual(
    (await readRecord(f.root, dirty.id)).activity,
    before.activity,
  );
  assert.equal(await readFile(join(dirty.memory.root, note), 'utf8'), pending);
  try {
    await f.coordinator.initialize(f.destination, { continue: true });
    assert.equal(f.coordinator.snapshot.conversation!.id, dirty.id);
    assert.equal(f.coordinator.snapshot.recovery?.kind, 'pending');
    await f.coordinator.send('wait for memory recovery');
    assert.equal(f.a.inputs.length, 0);
    assert.deepEqual(f.coordinator.snapshot.queue, [
      'wait for memory recovery',
    ]);
    assert.equal(
      await readFile(join(dirty.memory.root, note), 'utf8'),
      pending,
    );
  } finally {
    await f.coordinator.close();
  }
});

test('a recovered conversation with missing native history keeps its ID and transcript', async () => {
  const f = await relocatedFixture();
  const saved = record('missing-native', f.project);
  saved.sessions.a = {
    id: 'original-native-id',
    model: 'a-model',
    hasHistory: true,
    deliveredProject: f.scope.project,
  };
  const files = await f.store.create(saved);
  await files.append({
    id: 'prior',
    kind: 'assistant',
    cwd: f.project,
    text: 'retained transcript',
  });
  await files.close();
  await f.move();
  const sessions = f.a.sessions.length;
  f.a.beforeConnect = async ({ resume }) => {
    if (resume === 'original-native-id')
      throw new Error('No native history for original-native-id');
  };
  try {
    await f.coordinator.initialize(f.destination, { continue: true });
    assert.match(f.coordinator.snapshot.error ?? '', /No native history/);
    assert.equal(
      f.coordinator.snapshot.conversation!.sessions.a!.id,
      'original-native-id',
    );
    assert.ok(
      f.coordinator.snapshot.items.some(
        ({ text }) => text === 'retained transcript',
      ),
    );
    assert.equal(f.a.sessions.length, sessions);
    assert.equal(f.a.inputs.length, 0);
    assert.equal(
      (await readRecord(f.root, 'missing-native')).sessions.a!.id,
      'original-native-id',
    );
  } finally {
    await f.coordinator.close();
  }
});

test('startup failures leave an exit-capable error state whose lookups reject rather than throw', async () => {
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
    await assert.rejects(coordinator.conversations(), /No active conversation/);
    await assert.rejects(coordinator.projectFiles(), /No active conversation/);
  } finally {
    await coordinator.close();
  }
});

async function sweepFixture() {
  const root = await scratch('witch-sweep-');
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

test('the launch sweep stops a live orphan in an unlocked conversation', async () => {
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

test('the launch sweep skips a conversation another instance holds', async () => {
  const { store, launch } = await sweepFixture();
  const sleeper = spawn('/bin/sleep', ['20'], { stdio: 'ignore' });
  const held = await store.create(record('held', '/elsewhere'));
  try {
    held.record.activity = activity();
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

test('one conversation the sweep fails on does not stop the launch', async () => {
  const { store, launch, save, directory } = await sweepFixture();
  await save('readonly', (saved) => {
    saved.activity = activity();
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

test("the launch sweep clears a clean conversation's stale activity", async () => {
  const { root, launch, save, memory } = await sweepFixture();
  await save('stale', (saved) => {
    saved.activity = activity();
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

test('an unreadable state file is named by its full path in the launch report and skipped', async () => {
  const { launch, directory } = await sweepFixture();
  await mkdir(directory('broken'));
  await writeFile(join(directory('broken'), 'state.json'), '{"id":');
  const coordinator = await launch();
  try {
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.ok(
      coordinator.snapshot.error?.includes(
        `- ${join(directory('broken'), 'state.json')} can't be read`,
      ),
    );
  } finally {
    await coordinator.close();
  }
});

test('a claim that fails for a reason other than a held lock is reported', async () => {
  const { launch, save, directory } = await sweepFixture();
  await save('blocked', (saved) => {
    saved.activity = activity();
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

test('continue opens the newest conversation in this directory, ignoring newer ones elsewhere', async () => {
  const { coordinator: first, store, root, project, a } = await fixture();
  await first.close();
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere);
  await used(store, root, record('a1', project), 1000);
  await used(store, root, record('a2', project), 3000);
  await used(store, root, record('a3', project), 2000);
  await used(store, root, record('b1', elsewhere), 4000);
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

test('a conversation id opens that conversation, even one with nothing sent', async () => {
  const { coordinator: first, store, root, project, a } = await fixture();
  await first.close();
  await used(store, root, record('fresh', project));
  const coordinator = new Coordinator(store, first.memory, [
    { adapter: a, executable: 'a' },
  ]);
  try {
    await coordinator.initialize(project, { conversation: 'fresh' });
    assert.equal(coordinator.snapshot.conversation!.id, 'fresh');
    assert.equal(coordinator.snapshot.phase, 'idle');
  } finally {
    await coordinator.close();
  }
});

test('continue with nothing in this directory starts a new conversation here', async () => {
  const { coordinator: first, store, root, project, a } = await fixture();
  await first.close();
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere);
  await used(store, root, record('b1', elsewhere), 1000);
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

test('a plain launch starts a new conversation even when this directory has one', async () => {
  const { coordinator: first, store, root, project, a } = await fixture();
  await first.close();
  await used(store, root, record('earlier', project), 1000);
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

test("/sessions lists only this directory's conversations", async () => {
  const { coordinator, store, root, project } = await fixture();
  try {
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    await used(store, root, record('here', project), 1000);
    await used(store, root, record('there', elsewhere), 1000);
    assert.deepEqual(
      (await coordinator.conversations()).map(({ id }) => id),
      ['here'],
    );
  } finally {
    await coordinator.close();
  }
});

test('continue into a held conversation shows the lock error with the launch report', async () => {
  const context = await fixture();
  const { coordinator: first, store, root, project, a, memory } = context;
  await first.close();
  await used(store, root, record('held', project), 1000);
  const holder = await store.claim('held');
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere);
  const dirty = await stranded(context, {}, elsewhere);
  dirty.files.record.activity = activity();
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

test('a publish failure while settling the launch is added to its report', async () => {
  const context = await fixture();
  const { coordinator: first, store, root, memory, hook, a } = context;
  await first.close();
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere);
  const dirty = await stranded(context, {}, elsewhere);
  dirty.files.record.activity = activity();
  await dirty.files.save(dirty.files.record);
  await dirty.files.close();
  await writeFile(join(dirty.memory.root, 'global', 'pending.md'), 'Pending.');
  const own = await stranded(context, { 'global/own.md': 'Own.' });
  await own.files.close();
  hook.current = async (command, run, options) => {
    if (command[0] !== 'update-ref' || options.cwd !== own.memory.root)
      return run();
    hook.current = passThrough;
    return { stdout: Buffer.alloc(0), stderr: 'cannot lock ref', code: 1 };
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

test('opening a conversation connects its agent, at launch, on /new and from /sessions', async () => {
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

test('a connect failure at launch joins the launch report and leaves the conversation open', async () => {
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

test('a launch takes the agent, model and effort of the newest used conversation in any directory', async () => {
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

test('a launch whose newest agent is uninstalled starts the first installed one on its default', async () => {
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

test('a failed first connect keeps the remembered model, and a model chosen next connects with it', async () => {
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
    await coordinator.selectModel({ agent: 'a', id: 'a-new' });
    const { options } = a.sessions.at(-1)!;
    assert.deepEqual([options.model, options.effort], ['a-new', 'high']);
  } finally {
    await coordinator.close();
  }
});

test('/new copies this conversation for its own agent, starts another agent on its default, and refuses an uninstalled one', async () => {
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
    const started = b.sessions.length;
    await coordinator.newConversation();
    assert.equal(coordinator.snapshot.conversation!.agent, 'b');
    assert.equal(b.sessions.length, started + 1);
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
    const current = coordinator.snapshot.conversation!.id;
    await assert.rejects(
      coordinator.newConversation('c'),
      /c is not installed/,
    );
    assert.equal(coordinator.snapshot.conversation!.id, current);
  } finally {
    await coordinator.close();
  }
});

test('a transient native notice shows without making an unused conversation resumable', async () => {
  const { coordinator, a, root } = await fixture();
  const id = coordinator.snapshot.conversation!.id;
  try {
    a.sessions[0]!.options.onEvent({
      type: 'notice',
      text: 'MCP diagnostic',
      transient: true,
    });
    assert.ok(
      coordinator.snapshot.items.some(
        ({ kind, text }) => kind === 'notice' && text === 'MCP diagnostic',
      ),
    );
  } finally {
    await coordinator.close();
  }
  // after close, so a saved append would have flushed
  const history = await readFile(
    join(root, 'state', 'conversations', id, 'history.jsonl'),
    'utf8',
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  assert.equal(history, '');
});
