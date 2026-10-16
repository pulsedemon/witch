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
import type { Subagent } from '../src/agents/types.js';
import { Coordinator } from '../src/core/coordinator.js';
import type { Conversation, ConversationRecord } from '../src/core/state.js';
import { Memory, main } from '../src/memory/memory.js';
import { identifyProcess } from '../src/persistence/process.js';
import { ConversationStore, StateStore } from '../src/persistence/store.js';
import { FixtureAgent, TurnGate } from './fixtures/agent.js';
import { hookedGit, passThrough } from './fixtures/git.js';
import type { GitHook } from './fixtures/git.js';
import { until, within } from './fixtures/within.js';

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

function activity(): ConversationRecord['activity'] {
  return {
    id: 'stale-turn',
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
    assert.doesNotMatch(b.inputs.at(-1)!.prompt, /Pending task context/);
    assert.equal(a.inputs.length, 1);
  } finally {
    await coordinator.close();
  }
});

await test("a session's usage at connect and while it lists its models reaches the snapshot, a closed session's later usage does not, and a failed handoff clears it", async () => {
  const { coordinator, a } = await fixture(undefined, (a, b) => {
    a.connectUsage = { cost: 1 };
    b.connectUsage = { cost: 2 };
    b.modelsUsage = { cost: 3 };
  });
  try {
    assert.deepEqual(coordinator.snapshot.usage, { cost: 1 });
    await coordinator.switchAgent('b');
    assert.deepEqual(coordinator.snapshot.usage, { cost: 3 });
    a.sessions[0]!.options.onEvent({ type: 'usage', usage: { cost: 9 } });
    assert.deepEqual(coordinator.snapshot.usage, { cost: 3 });
    a.failConnect = true;
    await assert.rejects(
      coordinator.switchAgent('a'),
      /Destination unavailable/,
    );
    assert.deepEqual(coordinator.snapshot.usage, {});
  } finally {
    await coordinator.close();
  }
});

await test("the live session's subagents update in place, a turn drops the finished ones, and a handoff, a closed session or a new conversation leaves none", async () => {
  const { coordinator, a, b } = await fixture();
  const subagent = (
    id: string,
    status: 'running' | 'completed',
    parent?: string,
  ) => ({ id, parent, name: `Task ${id}`, kind: 'Explore', status });
  // times have their own test
  const listed = () =>
    coordinator.snapshot.subagents.map(
      ({ id, parent, name, kind, status }) => ({
        id,
        parent,
        name,
        kind,
        status,
      }),
    );
  try {
    const emit = (
      session: (typeof a.sessions)[number],
      ...[id, status, parent]: Parameters<typeof subagent>
    ) =>
      session.options.onEvent({
        type: 'subagent',
        subagent: subagent(id, status, parent),
      });
    emit(a.sessions[0]!, 'outer', 'running');
    emit(a.sessions[0]!, 'inner', 'running', 'outer');
    emit(a.sessions[0]!, 'outer', 'completed');
    assert.deepEqual(listed(), [
      subagent('outer', 'completed'),
      subagent('inner', 'running', 'outer'),
    ]);
    await coordinator.send('hello');
    assert.deepEqual(listed(), [subagent('inner', 'running', 'outer')]);
    emit(a.sessions[0]!, 'outer', 'completed');
    assert.deepEqual(listed(), [subagent('inner', 'running', 'outer')]);
    await coordinator.switchAgent('b');
    assert.deepEqual(listed(), []);
    emit(a.sessions[0]!, 'late', 'running');
    assert.deepEqual(listed(), []);
    emit(b.sessions[0]!, 'other', 'running');
    assert.deepEqual(listed(), [subagent('other', 'running')]);
    await coordinator.newConversation('b');
    assert.deepEqual(listed(), []);
  } finally {
    await coordinator.close();
  }
});

await test("a familiar's start and end each add a transcript row, the end with its tool count and report, its time runs from its start, and a restart starts a new run, even one under a new run id while the last still shows as running", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const { coordinator, a } = await fixture();
  const emit = (status: Subagent['status'], fields: Partial<Subagent> = {}) =>
    a.sessions[0]!.options.onEvent({
      type: 'subagent',
      subagent: {
        id: 'w',
        name: 'Map code',
        kind: 'Explore',
        status,
        ...fields,
      },
    });
  const rows = () =>
    coordinator.snapshot.items
      .filter((item) => item.kind === 'tool')
      .map(({ title, text, done }) => [title, text, done]);
  const starts = () =>
    coordinator.snapshot.subagents.map(({ startedAt }) => startedAt);
  try {
    emit('running');
    t.mock.timers.tick(2000);
    emit('running', { activity: 'Read  a.ts', tools: 1 });
    assert.deepEqual(rows(), [
      ['Familiar started  Map code  Explore', '', true],
    ]);
    assert.deepEqual(starts(), [1000]);

    t.mock.timers.tick(2000);
    emit('completed', { tools: 3, report: 'All good.' });
    t.mock.timers.tick(1000);
    // a later update to a finished familiar, such as its name arriving
    emit('completed', { tools: 3, report: 'All good.' });
    assert.deepEqual(rows().slice(1), [
      ['Familiar completed  Map code  3 tools', 'All good.', true],
    ]);

    t.mock.timers.tick(1000);
    emit('running');
    assert.deepEqual(starts(), [7000]);
    emit('stopped', { tools: 1 });
    assert.deepEqual(rows().slice(2), [
      ['Familiar started  Map code  Explore', '', true],
      ['Familiar stopped  Map code  1 tool', '', true],
    ]);

    // a resumed run can start before the last run's end arrives
    emit('running', { run: '1' });
    t.mock.timers.tick(1000);
    emit('running', { run: '2' });
    emit('running', { run: '2', tools: 1 });
    assert.deepEqual(rows().slice(4), [
      ['Familiar started  Map code  Explore', '', true],
      ['Familiar started  Map code  Explore', '', true],
    ]);
    assert.deepEqual(starts(), [8000]);
  } finally {
    await coordinator.close();
  }
});

await test('a familiar still running when its session closes ends stopped, with its tool count and report', async () => {
  const { coordinator, a } = await fixture();
  const rows = () =>
    coordinator.snapshot.items
      .filter(({ title }) => title?.startsWith('Familiar'))
      .map(({ title, text }) => [title, text]);
  try {
    a.sessions[0]!.options.onEvent({
      type: 'subagent',
      subagent: {
        id: 'w',
        name: 'Map code',
        kind: 'Explore',
        status: 'running',
        tools: 2,
        report: 'Halfway.',
      },
    });
    await coordinator.switchAgent('b');
    assert.deepEqual(rows(), [
      ['Familiar started  Map code  Explore', ''],
      ['Familiar stopped  Map code  2 tools', 'Halfway.'],
    ]);
  } finally {
    await coordinator.close();
  }
});

await test("a familiar's name and kind arriving after its rows retitle them in place, as a Codex thread's do", async () => {
  const { coordinator, a } = await fixture();
  const emit = (status: Subagent['status'], fields: Partial<Subagent> = {}) =>
    a.sessions[0]!.options.onEvent({
      type: 'subagent',
      subagent: { id: 't', name: 'agent', kind: '', status, ...fields },
    });
  const rows = () =>
    coordinator.snapshot.items
      .filter((item) => item.kind === 'tool')
      .map(({ title, text }) => [title, text]);
  try {
    emit('running');
    emit('running', { name: 'Euclid', kind: 'explorer' });
    assert.deepEqual(rows(), [['Familiar started  Euclid  explorer', '']]);

    emit('running', { run: 'next' });
    emit('completed', { run: 'next', tools: 2, report: 'Found it.' });
    emit('completed', {
      run: 'next',
      tools: 2,
      report: 'Found it.',
      name: 'Hypatia',
    });
    assert.deepEqual(rows().slice(1), [
      ['Familiar started  Hypatia', ''],
      ['Familiar completed  Hypatia  2 tools', 'Found it.'],
    ]);
  } finally {
    await coordinator.close();
  }
});

await test('a skills change while a session lists its models reaches the snapshot', async () => {
  const { coordinator } = await fixture(undefined, (a) => {
    a.skills = [{ name: 'older', description: '' }];
    a.modelsSkills = [{ name: 'newer', description: '' }];
  });
  try {
    assert.deepEqual(
      coordinator.snapshot.skills.map((skill) => skill.name),
      ['newer'],
    );
  } finally {
    await coordinator.close();
  }
});

await test("the live session's usage reaches the snapshot, and a new conversation starts with none and its own open time even when its agent fails to connect", async () => {
  const { coordinator, a, b } = await fixture();
  try {
    a.turnUsage = { cost: 0.5, context: 10 };
    await coordinator.send('hello');
    assert.deepEqual(coordinator.snapshot.usage, { cost: 0.5, context: 10 });
    b.failConnect = true;
    const before = Date.now();
    await coordinator.newConversation('b').catch(() => {});
    assert.deepEqual(coordinator.snapshot.usage, {});
    assert.ok(coordinator.snapshot.openedAt! >= before);
  } finally {
    await coordinator.close();
  }
});

await test('unfinished memory holds a prompt until recovery, which preserves the original attribution', async () => {
  const { coordinator, memory, a, workspace, note } = await fixture();
  try {
    a.interruptNext = true;
    await coordinator.send('remember-port');
    assert.equal(coordinator.snapshot.phase, 'recovery');
    await coordinator.send('unrelated task');
    assert.deepEqual(coordinator.snapshot.queue, ['unrelated task']);
    assert.equal(a.inputs.length, 1);
    await coordinator.recoverMemory('accept');
    assert.equal(
      (await memory.history(main, await note()))[0]!.subject,
      'chore(memory): recover a changes',
    );
    assert.equal(await workspace().isDirty(), false);
    await until(
      'the held prompt',
      () => a.inputs.length === 2 && coordinator.snapshot.phase === 'idle',
    );
    assert.match(a.inputs[1]!.prompt, /User request:\nunrelated task$/);
  } finally {
    await coordinator.close();
  }
});

await test('handoff returns to the original native session with updated context, and a switch to the current or an uninstalled agent sends nothing', async () => {
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
    const sent = a.inputs.length;
    await coordinator.switchAgent('a');
    await assert.rejects(coordinator.switchAgent('c'), /c is not installed/);
    assert.equal(a.inputs.length, sent);
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

await test('memory another conversation publishes refreshes an existing session before its next turn', async () => {
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

await test("a turn after an origin moves the project key resumes the session with the new key's memory and its snapshot", async () => {
  const { coordinator, memory, a, project, notes } = await fixture();
  const git = (...args: string[]) =>
    promisify(execFile)('git', ['-C', project, ...args]);
  try {
    await git('init', '--quiet');
    await coordinator.send('Start');
    const before = await notes();
    await git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
    assert.notEqual(await notes(), before);
    await coordinator.send('remember:moved');
    assert.equal(await memory.read(main, await notes()), 'moved');
    assert.match(a.inputs.at(-1)!.prompt, /Accepted shared memory/);
    assert.equal(a.inputs.at(-1)!.session, a.inputs[0]!.session);
    await coordinator.send('Again');
    assert.equal(a.sessions.length, 2);
  } finally {
    await coordinator.close();
  }
});

await test('a turn back on a project key gets its snapshot after an interrupted turn on another key', async () => {
  const { coordinator, a, project } = await fixture();
  const git = (...args: string[]) =>
    promisify(execFile)('git', ['-C', project, ...args]);
  try {
    await git('init', '--quiet');
    await coordinator.send('Start');
    await git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
    a.interruptNext = true;
    await coordinator.send('Moved');
    await git('remote', 'remove', 'origin');
    await coordinator.send('Back');
    assert.match(a.inputs.at(-1)!.prompt, /Accepted shared memory/);
  } finally {
    await coordinator.close();
  }
});

await test('a reopened conversation skips the snapshot it was sent, unless its marker was saved without a project', async () => {
  const { coordinator, store, memory, a, b, root, project } = await fixture();
  const reopen = async (prompt: string) => {
    const reopened = new Coordinator(
      store,
      memory,
      [a, b].map((adapter) => ({ adapter, executable: adapter.id })),
    );
    try {
      await reopened.initialize(project, { continue: true });
      await reopened.send(prompt);
    } finally {
      await reopened.close();
    }
    return a.inputs.at(-1)!.prompt;
  };
  await coordinator.send('Start');
  const id = coordinator.snapshot.conversation!.id;
  await coordinator.close();
  assert.doesNotMatch(await reopen('Same'), /Accepted shared memory/);
  const file = join(root, 'state', 'conversations', id, 'state.json');
  const saved = await readRecord(root, id);
  delete saved.sessions.a!.deliveredProject;
  await writeFile(file, JSON.stringify(saved));
  assert.match(await reopen('Older'), /Accepted shared memory/);
});

await test("opening Witch moves its checkout's path-key notes to the origin's project before a turn", async () => {
  const { coordinator, store, memory, a, b, project, note } = await fixture();
  await promisify(execFile)('git', ['-C', project, 'init', '--quiet']);
  await coordinator.send('remember-port');
  await coordinator.close();
  await promisify(execFile)('git', [
    ...['-C', project, 'remote', 'add', 'origin'],
    'https://github.com/owner/repo.git',
  ]);
  const reopened = new Coordinator(
    store,
    memory,
    [a, b].map((adapter) => ({ adapter, executable: adapter.id })),
  );
  try {
    await reopened.initialize(project, { continue: true });
    assert.equal(await memory.read(main, await note()), 'Use port 4567.');
    assert.equal(a.inputs.length, 1);
  } finally {
    await reopened.close();
  }
});

await test("an interrupt that aborts a moved key's reconnect leaves the prompt queued without an error", async () => {
  const { coordinator, a, project } = await fixture();
  const git = (...args: string[]) =>
    promisify(execFile)('git', ['-C', project, ...args]);
  try {
    await git('init', '--quiet');
    await coordinator.send('Start');
    await git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
    const connecting = Promise.withResolvers<void>();
    a.beforeConnect = (options) =>
      new Promise((_, reject) => {
        connecting.resolve();
        options.signal?.addEventListener('abort', () =>
          reject(new Error('Connect aborted')),
        );
      });
    const sending = coordinator.send('Moved');
    await within(connecting.promise, 2000, 'the reconnect');
    await coordinator.interrupt();
    await within(sending, 2000, 'the send');
    assert.equal(coordinator.snapshot.error, undefined);
    assert.deepEqual(coordinator.snapshot.queue, ['Moved']);
    assert.equal(a.inputs.length, 1);
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

await test('startup failures leave an exit-capable error state whose lookups reject rather than throw', async () => {
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

await test('memory edit and restore notices resolve their note against the memory worktree', async () => {
  const { coordinator, memory, workspace, note } = await fixture(
    async (path) => {
      await writeFile(path, 'Use port 9001.');
    },
  );
  try {
    await coordinator.editMemory();
    const revision = await memory.resolve(main);
    await coordinator.restoreMemory(await note(), revision);
    assert.deepEqual(
      coordinator.snapshot.items
        .filter((item) => item.kind === 'notice')
        .map(({ text, cwd }) => [text, cwd]),
      [
        [`Memory edit: ${await note()}`, workspace().root],
        [
          `Memory restore: ${await note()} at ${revision.slice(0, 8)}`,
          workspace().root,
        ],
      ],
    );
  } finally {
    await coordinator.close();
  }
});

await test('memory notices quote a note name on one line with its brackets escaped', async () => {
  const { coordinator, memory } = await fixture(async (path) => {
    await writeFile(path, 'Use port 9001.');
  });
  try {
    const name = 'global/a\n[b].md';
    await coordinator.editMemory(name);
    const revision = await memory.resolve(main);
    await coordinator.restoreMemory(name, revision);
    assert.deepEqual(
      coordinator.snapshot.items
        .filter((item) => item.kind === 'notice')
        .map(({ text }) => text),
      [
        'Memory edit: global/a\\[b\\].md',
        `Memory restore: global/a\\[b\\].md at ${revision.slice(0, 8)}`,
      ],
    );
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
    b.interruptNext = true;
    await assert.rejects(coordinator.switchAgent('a'), /interrupted/);
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

await test('one conversation the sweep fails on does not stop the launch', async () => {
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

await test("the launch sweep clears a clean conversation's stale activity", async () => {
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

await test('an unreadable state file is named by its full path in the launch report and skipped', async () => {
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

await test('a claim that fails for a reason other than a held lock is reported', async () => {
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
      const connects = a.sessions.length;
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
      assert.equal(a.sessions.length, connects);
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

await test('discard mine after a conflict between two coordinators keeps the other side', async () => {
  const context = await fixture();
  const { store, memory, project, notes } = context;
  const agents = [context.a, new FixtureAgent('a')];
  const gates = agents.map((agent) => (agent.gate = new TurnGate()));
  const coordinators = [
    context.coordinator,
    new Coordinator(store, memory, [{ adapter: agents[1]!, executable: 'a' }]),
  ];
  try {
    await coordinators[1]!.initialize(project);
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
    await second.recoverMemory('discard');
    assert.equal(second.snapshot.phase, 'idle');
    assert.equal(await memory.read(main, await notes()), 'text-0');
    assert.equal(
      await context.workspace(second.snapshot.conversation!.id).revision(),
      await memory.resolve(main),
    );
  } finally {
    for (const gate of gates) gate.open();
    for (const coordinator of coordinators) await coordinator.close();
  }
});

await test('the launch sweep publishes what it can and reports the rest in one message', async () => {
  const context = await fixture();
  const { root, memory, store } = context;
  await context.coordinator.close();
  const conflict = await stranded(
    context,
    { 'global/one.md': 'Mine.\n' },
    join(root, 'deleted-project'),
  );
  await conflict.files.close();
  await publishOutside(context, { 'global/one.md': 'Theirs.\n' });
  const unpublished = await stranded(
    context,
    { 'global/two.md': 'Two.' },
    join(root, 'deleted-project'),
  );
  await unpublished.files.close();
  const dirty = await stranded(context, {});
  dirty.files.record.activity = activity();
  await dirty.files.save(dirty.files.record);
  await dirty.files.close();
  await writeFile(join(dirty.memory.root, 'global', 'three.md'), 'Three.');
  const stateless = randomUUID();
  const orphan = await context.outsider(stateless);
  await writeFile(join(orphan.root, 'global', 'four.md'), 'Four.');
  await orphan.commit('chore(memory): save outside notes');
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
          new RegExp(
            `Title ${conflict.id} in .*deleted-project \\(recreate this directory first\\): memory conflicts`,
          ),
        );
        assert.match(
          report ?? '',
          new RegExp(`Title ${dirty.id} in [^(\n]*: unfinished`),
        );
        assert.doesNotMatch(
          report ?? '',
          new RegExp(`Title ${unpublished.id}`),
        );
        assert.match(
          report ?? '',
          new RegExp(`conversations/${stateless} has unpublished memory`),
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
  broken.files.record.activity = activity();
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

await test('continue opens the newest conversation in this directory, ignoring newer ones elsewhere', async () => {
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

await test('continue with nothing in this directory starts a new conversation here', async () => {
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

await test('a plain launch starts a new conversation even when this directory has one', async () => {
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

await test("/sessions lists only this directory's conversations", async () => {
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

await test('continue into a held conversation shows the lock error with the launch report', async () => {
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

await test('a publish failure while settling the launch is added to its report', async () => {
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

await test('an interrupt during the memory snapshot delivers nothing and leaves the prompt queued', async () => {
  const { coordinator, a, hook } = await fixture();
  try {
    await coordinator.send('remember-port');
    const before = a.inputs.length;
    const snapshot = holdSnapshot(hook);
    const sending = coordinator.send('Second');
    await within(snapshot.entered, 2000, 'the snapshot');
    await coordinator.interrupt();
    snapshot.release();
    await within(sending, 2000, 'the send');
    assert.deepEqual(coordinator.snapshot.queue, ['Second']);
    assert.equal(a.inputs.length, before);
  } finally {
    await coordinator.close();
  }
});

await test('a connect failure leaves the prompt queued, and the next prompt sends both, a line each, and clears the error', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.failConnect = true;
  });
  try {
    await coordinator.send('Start');
    assert.deepEqual(coordinator.snapshot.queue, ['Start']);
    assert.match(coordinator.snapshot.error ?? '', /Destination unavailable/);
    a.failConnect = false;
    await coordinator.send('Again');
    assert.deepEqual(coordinator.snapshot.queue, []);
    assert.match(a.inputs.at(-1)!.prompt, /User request:\nStart\nAgain$/);
    assert.equal(coordinator.snapshot.error, undefined);
  } finally {
    await coordinator.close();
  }
});

await test('a blank prompt starts no turn', async () => {
  const { coordinator, a } = await fixture();
  try {
    await coordinator.send(' \n');
    assert.deepEqual(coordinator.snapshot.queue, []);
    assert.deepEqual(a.inputs, []);
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
    await within(sending, 2000, 'the send');
    assert.deepEqual(coordinator.snapshot.queue, ['Second']);
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
    await sending;
    assert.deepEqual(coordinator.snapshot.queue, []);
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
    await coordinator.send('symlink-note');
    assert.deepEqual(coordinator.snapshot.queue, []);
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
    // the summary turn saves first, without a handoff
    ConversationStore.prototype.save = function (record) {
      if (!record.handoff) return save.call(this, record);
      ConversationStore.prototype.save = save;
      holding.resolve();
      return held.promise.then(() => save.call(this, record));
    };
    gate.open();
    await within(holding.promise, 2000, 'the save of the summary');
    const connects = b.sessions.length;
    await coordinator.interrupt();
    held.resolve();
    await assert.rejects(switching, /interrupted/);
    assert.equal(b.sessions.length, connects);
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
    await coordinator.selectModel('a-big');
    const record = await readRecord(
      root,
      coordinator.snapshot.conversation!.id,
    );
    assert.equal(record.sessions.a?.effort, 'high');
  } finally {
    await coordinator.close();
  }
});

await test('an effort the agent rejects while disconnected keeps the stored one, so the next turn still connects', async () => {
  const { coordinator, a, root } = await fixture();
  try {
    await coordinator.selectModel('a-big', 'high');
    a.invalidEffort = 'hgih';
    await a.sessions.at(-1)!.session.close();
    await assert.rejects(
      coordinator.selectModel('a-big', 'hgih'),
      /Invalid effort/,
    );
    const id = coordinator.snapshot.conversation!.id;
    assert.equal((await readRecord(root, id)).sessions.a?.effort, 'high');
    await a.sessions.at(-1)!.session.close();
    const opened = a.sessions.length;
    await coordinator.send('Continue');
    assert.equal(a.sessions.length, opened + 1);
    assert.equal(a.sessions.at(-1)!.options.effort, 'high');
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
    await coordinator.send('Start');
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
    await coordinator.send('/review');
    assert.deepEqual(a.inputs.at(-1)!.skill, { name: 'review', args: '' });
    await coordinator.send('/reviewer x');
    assert.equal(a.inputs.at(-1)!.skill, undefined);
  } finally {
    await coordinator.close();
  }
});

await test('a prompt sent during a turn joins it and shows at once, and a spell and the prompts behind it wait, the spell for a turn alone and the rest for one turn, a line each', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [{ name: 'review', description: 'Review changes' }];
  });
  const gate = new TurnGate();
  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    for (const prompt of ['Also this', '/review now', 'One', 'Two'])
      await coordinator.send(prompt);
    assert.deepEqual(a.steers, ['Also this']);
    assert.equal(coordinator.snapshot.items.at(-1)!.text, 'Also this');
    assert.deepEqual(coordinator.snapshot.queue, ['/review now', 'One', 'Two']);
    gate.open();
    await within(sending, 2000, 'the queued turns');
    assert.deepEqual(
      a.inputs.map(({ prompt, skill }) => [
        prompt.split('User request:\n')[1],
        skill,
      ]),
      [
        ['Start', undefined],
        ['/review now', { name: 'review', args: 'now' }],
        ['One\nTwo', undefined],
      ],
    );
    assert.deepEqual(coordinator.snapshot.queue, []);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

await test('a queued prompt taken back never runs', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [{ name: 'review', description: 'Review changes' }];
  });
  const gate = new TurnGate();
  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    await coordinator.send('/review now');
    assert.deepEqual(coordinator.unqueue(), ['/review now']);
    assert.deepEqual(coordinator.snapshot.queue, []);
    gate.open();
    await within(sending, 2000, 'the turn');
    assert.equal(a.inputs.length, 1);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

await test('steered prompts an interrupt leaves unread go as the next turn, ahead of what was queued', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    a.unreadOnInterrupt = true;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    await coordinator.send('Also this');
    await coordinator.send('/clear');
    await coordinator.interrupt();
    gate.open();
    await within(sending, 2000, 'the next turns');
    assert.equal((await gate.result).status, 'interrupted');
    assert.deepEqual(
      a.inputs.map(({ prompt }) => prompt.split('User request:\n')[1]),
      ['Start', 'Also this', '/clear'],
    );
  } finally {
    gate.open();
    await coordinator.close();
  }
});

for (const [name, prompt, prepare] of [
  [
    'a prompt the turn refuses',
    'Later',
    async (_coordinator: Coordinator, a: FixtureAgent) => {
      a.refuseSteer = true;
    },
  ],
  [
    'a prompt sent after an interrupt',
    'Later',
    async (coordinator: Coordinator, a: FixtureAgent) => {
      // the turn runs on after the interrupt, as a Codex turn does until Codex completes it
      a.failInterrupt = true;
      await assert.rejects(coordinator.interrupt(), /Interrupt failed/);
      a.failInterrupt = false;
    },
  ],
  ['an unlisted slash command', '  /clear', async () => {}],
] as const)
  await test(`${name} waits in the queue, unseen until it goes as the next turn`, async () => {
    const { coordinator, a } = await fixture();
    const gate = new TurnGate();
    try {
      a.gate = gate;
      const sending = coordinator.send('Start');
      await within(gate.entered, 2000, 'the gated turn');
      await prepare(coordinator, a);
      await coordinator.send(prompt);
      assert.deepEqual(a.steers, []);
      assert.deepEqual(coordinator.snapshot.queue, [prompt]);
      assert.ok(
        !coordinator.snapshot.items.some(({ text }) => text === prompt),
      );
      gate.open();
      await within(sending, 2000, 'the queued turn');
      assert.deepEqual(
        a.inputs.map((input) => [
          input.prompt.split('User request:\n')[1],
          input.skill,
        ]),
        [
          ['Start', undefined],
          [prompt, undefined],
        ],
      );
    } finally {
      gate.open();
      await coordinator.close();
    }
  });

/** each turn's prompt and spell, in the order the agent got them. */
const turns = (a: FixtureAgent) =>
  a.inputs.map(({ prompt, skill }) => [
    prompt.split('User request:\n')[1],
    skill,
  ]);

await test('prompts queued ahead of a spell go as one turn, then the spell alone, then the prompts after it', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [{ name: 'review', description: 'Review changes' }];
  });
  const gate = new TurnGate();
  try {
    a.gate = gate;
    a.refuseSteer = true;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    for (const prompt of ['One', 'Two', '/review now', 'Three'])
      await coordinator.send(prompt);
    gate.open();
    await within(sending, 2000, 'the queued turns');
    assert.deepEqual(turns(a), [
      ['Start', undefined],
      ['One\nTwo', undefined],
      ['/review now', { name: 'review', args: 'now' }],
      ['Three', undefined],
    ]);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

await test('a report after a queued turn stays on screen, and the prompts after it wait', async () => {
  const { coordinator, a, hook } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    a.refuseSteer = true;
    hook.current = async (command, run) => {
      if (command[0] !== 'update-ref') return run();
      hook.current = passThrough;
      return { stdout: '', stderr: 'cannot lock ref', code: 1 };
    };
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    await coordinator.send('remember-port');
    await coordinator.send('/clear');
    gate.open();
    await within(sending, 2000, 'the queued turns');
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.match(coordinator.snapshot.error ?? '', /cannot lock ref/);
    assert.deepEqual(coordinator.snapshot.queue, ['/clear']);
    assert.deepEqual(turns(a), [
      ['Start', undefined],
      ['remember-port', undefined],
    ]);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

await test('prompts sent together steer or queue in the order sent', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    await Promise.all([
      coordinator.send('/review now'),
      coordinator.send('One'),
    ]);
    assert.deepEqual(a.steers, []);
    assert.deepEqual(coordinator.snapshot.queue, ['/review now', 'One']);
    gate.open();
    await within(sending, 2000, 'the queued turns');
    assert.deepEqual(turns(a), [
      ['Start', undefined],
      ['/review now', undefined],
      ['One', undefined],
    ]);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

await test('a spell a failed connect leaves queued still goes alone once the agent connects, ahead of what was queued behind it', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [{ name: 'review', description: 'Review changes' }];
    a.failConnect = true;
  });
  try {
    await coordinator.send('/review now');
    await coordinator.send('One');
    assert.deepEqual(coordinator.snapshot.queue, ['/review now', 'One']);
    assert.deepEqual(coordinator.snapshot.skills, []);
    a.failConnect = false;
    await coordinator.send('Two');
    assert.deepEqual(turns(a), [
      ['/review now', { name: 'review', args: 'now' }],
      ['One\nTwo', undefined],
    ]);
  } finally {
    await coordinator.close();
  }
});

await test('a prompt sent during a handoff waits and goes to the destination', async () => {
  const { coordinator, a, b } = await handoffFixture();
  const gate = new TurnGate();
  a.gate = gate;
  try {
    const switching = coordinator.switchAgent('b');
    await within(gate.entered, 2000, 'the summary turn');
    await coordinator.send('During');
    assert.deepEqual(a.steers, []);
    assert.deepEqual(coordinator.snapshot.queue, ['During']);
    gate.open();
    await within(switching, 2000, 'the handoff');
    await until('the queued prompt', () =>
      b.inputs.some(({ prompt }) => prompt.endsWith('User request:\nDuring')),
    );
  } finally {
    gate.open();
    await coordinator.close();
  }
});

await test('a prompt sent while the launch connects goes once the load ends', async () => {
  const { coordinator: original, root, project, memory, a } = await fixture();
  await original.close();
  const coordinator = new Coordinator(
    await StateStore.open(join(root, 'state')),
    memory,
    [{ adapter: a, executable: 'a' }],
  );
  const connecting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  a.beforeConnect = async () => {
    connecting.resolve();
    await release.promise;
  };
  try {
    const initializing = coordinator.initialize(project);
    await within(connecting.promise, 2000, 'the launch connect');
    await coordinator.send('Early');
    assert.deepEqual(coordinator.snapshot.queue, ['Early']);
    release.resolve();
    await initializing;
    await until('the early prompt', () =>
      a.inputs.some(({ prompt }) => prompt.endsWith('User request:\nEarly')),
    );
  } finally {
    release.resolve();
    await coordinator.close();
  }
});

await test('a prompt sent while a switch opens the next conversation is refused, so it never runs there', async () => {
  const { coordinator, a } = await fixture();
  try {
    const switching = coordinator.newConversation();
    await assert.rejects(coordinator.send('Leak'), /next conversation/);
    await switching;
    await delay(60);
    assert.deepEqual(a.inputs, []);
    assert.deepEqual(coordinator.snapshot.queue, []);
  } finally {
    await coordinator.close();
  }
});

await test('a failed turn leaves what was queued behind it for the composer instead of running it', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    a.failNext = true;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    await coordinator.send('/review');
    gate.open();
    await sending;
    await delay(60);
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.deepEqual(coordinator.snapshot.queue, ['/review']);
    assert.deepEqual(
      a.inputs.map(({ prompt }) => prompt.split('User request:\n')[1]),
      ['Start'],
    );
  } finally {
    gate.open();
    await coordinator.close();
  }
});

await test('a prompt whose steer is refused after a failed turn has ended stays for the composer, and one sent at idle still runs', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    a.failNext = true;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    const refusal = Promise.withResolvers<void>();
    a.sessions.at(-1)!.session.steer = async () => {
      await refusal.promise;
      return false;
    };
    const steering = coordinator.send('Follow up');
    gate.open();
    await sending;
    refusal.resolve();
    await steering;
    await delay(60);
    assert.deepEqual(coordinator.snapshot.queue, ['Follow up']);
    assert.equal(a.inputs.length, 1);
    coordinator.unqueue();
    await coordinator.send('Retry');
    assert.deepEqual(
      a.inputs.map(({ prompt }) => prompt.split('User request:\n')[1]),
      ['Start', 'Retry'],
    );
  } finally {
    gate.open();
    await coordinator.close();
  }
});

await test('a failed handoff continuation leaves what was queued during the switch for the composer', async () => {
  const { coordinator, b } = await fixture();
  const gate = new TurnGate();
  try {
    await coordinator.send('Start');
    b.gate = gate;
    b.failNext = true;
    const switching = coordinator.switchAgent('b');
    await within(gate.entered, 2000, 'the continuation');
    await coordinator.send('/review');
    gate.open();
    await switching;
    await delay(60);
    assert.equal(coordinator.snapshot.conversation!.agent, 'b');
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.deepEqual(coordinator.snapshot.queue, ['/review']);
    assert.equal(b.inputs.length, 1);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

await test('a prompt sent just before a switch stays queued for its conversation, so the switch is refused', async () => {
  const { coordinator, a } = await fixture();
  try {
    const { id } = coordinator.snapshot.conversation!;
    const sending = coordinator.send('Stay');
    await assert.rejects(coordinator.newConversation(), /still queued/);
    await sending;
    await delay(60);
    assert.equal(coordinator.snapshot.conversation!.id, id);
    assert.deepEqual(coordinator.snapshot.queue, ['Stay']);
    assert.deepEqual(a.inputs, []);
  } finally {
    await coordinator.close();
  }
});

await test('a conversation switch is refused while prompts are queued, which wait with their report showing', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.failConnect = true;
  });
  try {
    await coordinator.send('Start');
    const { id } = coordinator.snapshot.conversation!;
    a.failConnect = false;
    await assert.rejects(coordinator.newConversation(), /still queued/);
    await delay(60);
    assert.equal(coordinator.snapshot.conversation!.id, id);
    assert.match(coordinator.snapshot.error ?? '', /still queued/);
    assert.deepEqual(coordinator.snapshot.queue, ['Start']);
    assert.deepEqual(a.inputs, []);
  } finally {
    await coordinator.close();
  }
});

await test("a model list that fails at connect is reported, and the session's skills and usage still reach the snapshot", async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [{ name: 'review', description: 'Review changes' }];
    a.connectUsage = { cost: 5 };
    a.failModels = true;
  });
  try {
    assert.equal(coordinator.snapshot.error, 'model/list failed');
    assert.deepEqual(
      coordinator.snapshot.skills.map((skill) => skill.name),
      ['review'],
    );
    assert.deepEqual(coordinator.snapshot.usage, { cost: 5 });
    await coordinator.send('/review now');
    assert.deepEqual(a.inputs.at(-1)!.skill, { name: 'review', args: 'now' });
  } finally {
    await coordinator.close();
  }
});

await test('a native session that replaces the stored one gets the memory snapshot again', async () => {
  const { coordinator, a } = await fixture();
  try {
    await coordinator.send('remember-port');
    await coordinator.send('Again');
    // the native agent starts a fresh session instead of resuming
    a.beforeConnect = async (options) => {
      options.resume = undefined;
    };
    await a.sessions.at(-1)!.session.close();
    await coordinator.send('Next');
    assert.match(a.inputs.at(-1)!.prompt, /Use port 4567/);
  } finally {
    await coordinator.close();
  }
});

for (const stop of ['interrupt', 'close'] as const)
  await test(`${stop}() during a model change closes the session that holds it`, async () => {
    const { coordinator, a } = await fixture();
    try {
      const { session } = a.sessions.at(-1)!;
      const entered = Promise.withResolvers<void>();
      // as Codex's does, the change ends only when its session closes
      session.selectModel = async () => {
        entered.resolve();
        for (let wait = 0; wait < 100 && !session.closed; wait++)
          await delay(10);
        throw new Error(session.closed ? 'Session closed' : 'Still open');
      };
      const selecting = coordinator.selectModel('next');
      await within(entered.promise, 2000, 'the model change');
      // close() awaits the change, so its rejection needs a handler first
      const rejected = assert.rejects(selecting, /Session closed/);
      await coordinator[stop]();
      await rejected;
    } finally {
      await coordinator.close();
    }
  });

await test('the memory view reads accepted memory, and links into the worktree only while it holds that revision', async () => {
  const { coordinator, memory, workspace, notes, outsider } = await fixture();
  try {
    const other = await outsider();
    await writeFile(join(other.root, await notes()), 'Published elsewhere.');
    await other.commit('save elsewhere');
    await other.publish();
    const behind = await coordinator.memoryView();
    assert.equal(behind.revision, await memory.resolve(main));
    assert.equal(behind.root, undefined);
    await coordinator.send('Next');
    assert.equal((await coordinator.memoryView()).root, workspace().root);
  } finally {
    await coordinator.close();
  }
});

await test('agent events reach the transcript with their own replace, append and cwd', async () => {
  const { coordinator, a, project } = await fixture();
  try {
    const { options } = a.sessions.at(-1)!;
    const shown = () =>
      coordinator.snapshot.items.map(({ text, cwd }) => [text, cwd]);
    options.onEvent({ type: 'text', id: 'm', text: 'Hel' });
    options.onEvent({ type: 'text', id: 'm', text: 'lo' });
    assert.deepEqual(shown(), [['Hello', project]]);
    options.onEvent({ type: 'text', id: 'm', text: 'Hello!', replace: true });
    const tool = { type: 'tool', id: 't', title: 'ls' } as const;
    options.onEvent({ ...tool, text: 'a', done: false, cwd: '/elsewhere' });
    options.onEvent({ ...tool, text: 'b', done: false, append: true });
    assert.deepEqual(shown()[1], ['ab', '/elsewhere']);
    options.onEvent({ ...tool, text: 'out', done: true, cwd: '/elsewhere' });
    assert.deepEqual(shown(), [
      ['Hello!', project],
      ['out', '/elsewhere'],
    ]);
  } finally {
    await coordinator.close();
  }
});

await test('each history line records when Witch received it', async () => {
  const { coordinator, a, root } = await fixture();
  const id = coordinator.snapshot.conversation!.id;
  const start = Date.now();
  let middle: number;
  let end: number;
  try {
    const { options } = a.sessions.at(-1)!;
    options.onEvent({ type: 'text', id: 'm', text: 'Hel' });
    await delay(20);
    middle = Date.now();
    options.onEvent({ type: 'text', id: 'm', text: 'lo' });
    end = Date.now();
  } finally {
    await coordinator.close();
  }
  const times = (
    await readFile(
      join(root, 'state', 'conversations', id, 'history.jsonl'),
      'utf8',
    )
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { kind: string; at: string })
    .filter((update) => update.kind === 'assistant')
    .map(({ at }) => Date.parse(at));
  assert.equal(times.length, 2);
  assert.ok(start <= times[0]! && times[0]! < middle, 'first update');
  assert.ok(middle <= times[1]! && times[1]! <= end, 'second update');
});

await test('a native info event reaches the footer and the next resume', async () => {
  const { coordinator, a } = await fixture();
  try {
    const { options, session } = a.sessions.at(-1)!;
    options.onEvent({
      type: 'info',
      info: { ...session.info, id: 'later', permissionMode: 'plan' },
    });
    assert.equal(coordinator.snapshot.native?.permissionMode, 'plan');
    await session.close();
    await coordinator.send('Next');
    assert.equal(a.sessions.at(-1)!.options.resume, 'later');
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

await test('answers reach the agent and only a cancel interrupts the turn, a resolved request leaves the queue, and the settled turn leaves none', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    const { options } = a.sessions.at(-1)!;
    const [first, second] = ['r1', 'r2'].map((id) => ({
      id,
      kind: 'approval' as const,
      title: id,
      detail: '',
    }));
    options.onEvent({ type: 'request', request: first! });
    options.onEvent({ type: 'request', request: second! });
    let ended = false;
    void gate.result.then(() => {
      ended = true;
    });
    await coordinator.respond('r1', { decision: 'accept' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ended, false);
    options.onEvent({ type: 'request-resolved', id: 'r1' });
    assert.deepEqual(coordinator.snapshot.requests, [second]);
    await coordinator.respond('r2', { decision: 'cancel' });
    assert.deepEqual(a.responses, [
      ['r1', { decision: 'accept' }],
      ['r2', { decision: 'cancel' }],
    ]);
    assert.equal(
      (await within(gate.result, 2000, 'the turn result')).status,
      'interrupted',
    );
    await sending;
    assert.deepEqual(coordinator.snapshot.requests, []);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

await test('an answered question stays in the transcript as the reply with each question and its answers, a secret answer hidden, and a declined question adds nothing', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    const { options } = a.sessions.at(-1)!;
    const question = (id: string) => ({
      id,
      kind: 'question' as const,
      title: id,
      detail: '',
      questions: [
        {
          id: 'colors',
          title: 'Colors?',
          options: ['red', 'green', 'blue'],
          multiple: true,
        },
        { id: 'token', title: 'Token?', options: [], secret: true },
      ],
    });
    const replies = () =>
      coordinator.snapshot.items
        .filter((item) => item.kind === 'user')
        .map((item) => item.text);
    options.onEvent({ type: 'request', request: question('q1') });
    await coordinator.respond('q1', {
      decision: 'accept',
      answers: { colors: ['red', 'blue'], token: ['s3cret'] },
    });
    assert.deepEqual(replies(), [
      'Start',
      '**Colors?**\n→ red, blue\n\n**Token?**\n→ (hidden)',
    ]);
    options.onEvent({ type: 'request', request: question('q2') });
    await coordinator.respond('q2', { decision: 'decline' });
    assert.equal(replies().length, 2);
    gate.open();
    await sending;
  } finally {
    gate.open();
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

await test('/new copies this conversation for its own agent, starts another agent on its default, and refuses an uninstalled one', async () => {
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
