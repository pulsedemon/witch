import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  BackgroundCommand,
  FileDiff,
  Subagent,
} from '../src/agents/types.js';
import { Coordinator } from '../src/core/coordinator.js';
import { identifyProcess } from '../src/persistence/process.js';
import { TurnGate } from './fixtures/agent.js';
import { readRecord, fixture } from './fixtures/coordinator.js';
import { passThrough } from './fixtures/git.js';
import { until, within } from './fixtures/within.js';

await test('the pentacle follows foreground work and every running local task', async () => {
  const { coordinator, a, store, memory } = await fixture();
  const activity = coordinator.pentacle;
  const gate = new TurnGate();
  const source = Symbol('independent work');
  const switching: boolean[] = [];
  const unsubscribe = coordinator.subscribe(() => {
    if (coordinator.snapshot.phase === 'switching')
      switching.push(activity.active);
  });
  const brew = (id: string, status: BackgroundCommand['status']) =>
    a.sessions[0]!.options.onEvent({
      type: 'command',
      command: { id, description: `Run ${id}`, status },
    });
  const familiar = (status: Subagent['status']) =>
    a.sessions[0]!.options.onEvent({
      type: 'subagent',
      subagent: { id: 'worker', name: 'Inspect code', kind: 'Explore', status },
    });
  try {
    assert.equal(new Coordinator(store, memory, []).pentacle.active, true);
    assert.equal(activity.active, false);
    a.gate = gate;
    const turn = coordinator.send('hello');
    await within(gate.entered, 2000, 'the gated turn');
    assert.equal(activity.active, true);
    brew('first', 'running');
    brew('second', 'running');
    gate.open();
    await turn;
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.equal(activity.active, true);
    brew('first', 'completed');
    assert.equal(activity.active, true);
    familiar('running');
    brew('second', 'completed');
    assert.equal(activity.active, true);
    familiar('completed');
    assert.equal(coordinator.snapshot.subagents[0]!.status, 'completed');
    assert.equal(activity.active, false);

    activity.set(source, true);
    await coordinator.send('hello again');
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.equal(activity.active, true);
    activity.set(source, false);
    assert.equal(activity.active, false);

    await coordinator.switchAgent('b');
    assert.ok(switching.length > 0);
    assert.ok(switching.every(Boolean));
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.equal(activity.active, false);
  } finally {
    unsubscribe();
    activity.set(source, false);
    gate.open();
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
    assert.equal(coordinator.pentacle.active, true);
    await coordinator.switchAgent('b');
    assert.equal(coordinator.pentacle.active, false);
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

await test('a brew lists from its start until its end and through a turn, its start and end each add a transcript row, and a repeated start or an unlisted end changes nothing', async () => {
  const { coordinator, a } = await fixture();
  const emit = (id: string, status: BackgroundCommand['status']) =>
    a.sessions[0]!.options.onEvent({
      type: 'command',
      command: { id, description: 'Start the server', status },
    });
  const rows = () =>
    coordinator.snapshot.items
      .filter((item) => item.kind === 'tool')
      .map(({ title, text, done }) => [title, text, done]);
  const serve = {
    id: 'serve',
    description: 'Start the server',
    status: 'running',
  };
  try {
    emit('serve', 'running');
    assert.deepEqual(coordinator.snapshot.backgroundCommands, [serve]);
    assert.deepEqual(rows(), [['Brew started  Start the server', '', true]]);

    emit('serve', 'running');
    assert.deepEqual(coordinator.snapshot.backgroundCommands, [serve]);
    assert.equal(rows().length, 1);

    await coordinator.send('hello');
    assert.deepEqual(coordinator.snapshot.backgroundCommands, [serve]);

    emit('ghost', 'failed');
    assert.deepEqual(coordinator.snapshot.backgroundCommands, [serve]);
    assert.equal(rows().length, 1);

    emit('serve', 'failed');
    assert.deepEqual(coordinator.snapshot.backgroundCommands, []);
    assert.deepEqual(rows().at(-1), [
      'Brew failed  Start the server',
      '',
      true,
    ]);
  } finally {
    await coordinator.close();
  }
});

await test("a brew still running when its session closes ends stopped, and the closed session's later start lists nothing", async () => {
  const { coordinator, a } = await fixture();
  const emit = (id: string) =>
    a.sessions[0]!.options.onEvent({
      type: 'command',
      command: { id, description: 'Start the server', status: 'running' },
    });
  try {
    emit('serve');
    assert.equal(coordinator.pentacle.active, true);
    await coordinator.switchAgent('b');
    assert.equal(coordinator.pentacle.active, false);
    assert.deepEqual(
      coordinator.snapshot.items
        .filter(({ title }) => title?.startsWith('Brew'))
        .map(({ title }) => title),
      ['Brew started  Start the server', 'Brew stopped  Start the server'],
    );
    assert.deepEqual(coordinator.snapshot.backgroundCommands, []);
    emit('late');
    assert.deepEqual(coordinator.snapshot.backgroundCommands, []);
    assert.equal(coordinator.pentacle.active, false);
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

await test('a reported shell is in the state, handed to the jobs, and cleared by the end report', async () => {
  const { coordinator, a, root, tracked } = await fixture();
  const sleeper = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    const id = coordinator.snapshot.conversation!.id;
    const { onShell } = a.sessions[0]!.options;
    await onShell!(sleeper.pid);
    assert.deepEqual(
      (await readRecord(root, id)).shell,
      await identifyProcess(sleeper.pid!),
    );
    assert.deepEqual(tracked, [sleeper.pid]);
    await onShell!(undefined);
    assert.equal((await readRecord(root, id)).shell, undefined);
  } finally {
    sleeper.kill('SIGKILL');
    await coordinator.close();
  }
});

await test("an agent connects with the job watch's mark", async () => {
  const { coordinator, a, jobs } = await fixture();
  try {
    assert.equal(a.sessions[0]!.options.mark, jobs);
  } finally {
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
  a.sessions[0]!.options.onEvent({
    type: 'command',
    command: {
      id: 'serve',
      description: 'Start the server',
      status: 'running',
    },
  });
  assert.equal(coordinator.pentacle.active, true);
  a.failClose = true;
  await assert.rejects(coordinator.close(), /Close failed/);
  assert.equal(coordinator.pentacle.active, false);
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
    await until('the error', () => errors.length > 0);
    assert.match(errors[0]!, /^Restart Witch/);
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

await test("a tool's diff reaches its transcript row and comes back when the conversation reopens", async () => {
  const { coordinator, a, project, reopen } = await fixture();
  const diff: FileDiff[] = [
    {
      path: join(project, 'a.txt'),
      kind: 'update',
      movePath: join(project, 'b.txt'),
      hunks: [{ oldStart: 1, newStart: 1, lines: [' a', '-b', '+B'] }],
    },
  ];
  try {
    a.sessions.at(-1)!.options.onEvent({
      type: 'tool',
      id: 't',
      title: 'Edit',
      text: '',
      done: true,
      diff,
    });
    assert.deepEqual(coordinator.snapshot.items.at(-1)?.diff, diff);
  } finally {
    await coordinator.close();
  }
  const reopened = await reopen();
  try {
    assert.deepEqual(reopened.snapshot.items.at(-1)?.diff, diff);
  } finally {
    await reopened.close();
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
