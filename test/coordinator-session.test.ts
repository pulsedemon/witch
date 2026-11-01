import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../src/agents/codex.js';
import type { RpcMessage } from '../src/agents/json-rpc.js';
import type {
  AgentSession,
  BackgroundCommand,
  FileDiff,
  Subagent,
} from '../src/agents/types.js';
import { Coordinator } from '../src/core/coordinator.js';
import { Memory } from '../src/memory/memory.js';
import { identifyProcess } from '../src/persistence/process.js';
import { StateStore } from '../src/persistence/store.js';
import { TranscriptLayout } from '../src/ui/transcript-layout.js';
import { TurnGate } from './fixtures/agent.js';
import { jsonLines, launcher } from './fixtures/claude-adapter.js';
import { readRecord, fixture } from './fixtures/coordinator.js';
import { passThrough } from './fixtures/git.js';
import { scratch } from './fixtures/scratch.js';
import { until, within } from './fixtures/within.js';

test('the pentacle follows foreground work and every running local task', async () => {
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

    await coordinator.selectModel({ agent: 'b', id: 'b-model' });
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

test("a session's usage at connect and while it lists its models reaches the snapshot, a closed session's later usage does not, and a failed handoff clears it", async () => {
  const { coordinator, a } = await fixture(undefined, (a, b) => {
    a.connectUsage = { context: 1 };
    b.connectUsage = { context: 2 };
    b.modelsUsage = { context: 3 };
  });
  try {
    assert.deepEqual(coordinator.snapshot.usage, { context: 1 });
    await coordinator.selectModel({ agent: 'b', id: 'b-model' });
    assert.deepEqual(coordinator.snapshot.usage, { context: 3 });
    a.sessions[0]!.options.onEvent({ type: 'usage', usage: { context: 9 } });
    assert.deepEqual(coordinator.snapshot.usage, { context: 3 });
    a.failConnect = true;
    await assert.rejects(
      coordinator.selectModel({ agent: 'a', id: 'a-model' }),
      /Destination unavailable/,
    );
    assert.deepEqual(coordinator.snapshot.usage, {});
  } finally {
    await coordinator.close();
  }
});

test("the live session's subagents update in place, a turn drops the finished ones, and a handoff, a closed session or a new conversation leaves none", async () => {
  const { coordinator, a, b } = await fixture();
  const subagent = (
    id: string,
    status: 'running' | 'completed',
    parent?: string,
  ) => ({ id, parent, name: `Task ${id}`, kind: 'Explore', status });
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
    await coordinator.selectModel({ agent: 'b', id: 'b-model' });
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

test("a familiar's start and end each add a transcript row, the end with its tool count and report, its time runs from its start, and a restart starts a new run, even one under a new run id while the last still shows as running", async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: 1000 });
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
    vi.advanceTimersByTime(2000);
    emit('running', { activity: 'Read  a.ts', tools: 1 });
    assert.deepEqual(rows(), [
      ['Familiar started  Map code  Explore', '', true],
    ]);
    assert.deepEqual(starts(), [1000]);

    vi.advanceTimersByTime(2000);
    emit('completed', { tools: 3, report: 'All good.' });
    vi.advanceTimersByTime(1000);
    emit('completed', { tools: 3, report: 'All good.' });
    assert.deepEqual(rows().slice(1), [
      ['Familiar completed  Map code  3 tools', 'All good.', true],
    ]);

    vi.advanceTimersByTime(1000);
    emit('running');
    assert.deepEqual(starts(), [7000]);
    emit('stopped', { tools: 1 });
    assert.deepEqual(rows().slice(2), [
      ['Familiar started  Map code  Explore', '', true],
      ['Familiar stopped  Map code  1 tool', '', true],
    ]);

    emit('running', { run: '1' });
    vi.advanceTimersByTime(1000);
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

test('a familiar still running when its session closes ends stopped, with its tool count and report', async () => {
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
    await coordinator.selectModel({ agent: 'b', id: 'b-model' });
    assert.equal(coordinator.pentacle.active, false);
    assert.deepEqual(rows(), [
      ['Familiar started  Map code  Explore', ''],
      ['Familiar stopped  Map code  2 tools', 'Halfway.'],
    ]);
  } finally {
    await coordinator.close();
  }
});

test("a familiar's name and kind arriving after its rows retitle them in place, as a Codex thread's do", async () => {
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

describe('Codex brew events keep the coordinator active after its reply', () => {
  for (const loss of [false, true])
    test(loss ? 'process exit' : 'completion in a later turn', async () => {
      const root = await scratch('witch-codex-brews-');
      const cwd = join(root, 'project');
      await mkdir(cwd);
      const store = await StateStore.open(join(root, 'state'));
      const memory = new Memory(join(root, 'state', 'memory.git'));
      const executable = fileURLToPath(
        new URL('fixtures/codex.mjs', import.meta.url),
      );
      const adapter = new CodexAdapter(() =>
        spawn(process.execPath, [executable, 'brews'], {
          cwd,
          stdio: 'pipe',
        }),
      );
      const coordinator = new Coordinator(store, memory, [
        { adapter, executable },
      ]);
      let sequence = 0;
      const write = async (name: string, value: unknown) => {
        await writeFile(join(cwd, `${name}.next`), JSON.stringify(value));
        await rename(join(cwd, `${name}.next`), join(cwd, name));
      };
      const emit = (...frames: RpcMessage[]) =>
        write(`events-${++sequence}.json`, frames);
      const appears = (name: string) =>
        until(name, () =>
          access(join(cwd, name)).then(
            () => true,
            () => false,
          ),
        );
      const command = {
        type: 'commandExecution',
        id: 'command',
        command: 'fixture command',
        cwd,
        source: 'unifiedExecStartup',
        processId: '1',
      };
      const rows = () =>
        coordinator.snapshot.items.filter(({ id }) =>
          id.endsWith('/codex/command'),
        );
      try {
        await coordinator.initialize(cwd);
        const first = coordinator.send('first');
        await appears('turn-1.json');
        await emit(
          {
            method: 'item/started',
            params: {
              threadId: 'native-thread',
              turnId: 'turn-1',
              item: {
                ...command,
                status: 'inProgress',
                aggregatedOutput: null,
              },
            },
          },
          {
            method: 'item/commandExecution/outputDelta',
            params: {
              threadId: 'native-thread',
              turnId: 'turn-1',
              itemId: 'command',
              delta: 'start\n',
            },
          },
          {
            method: 'turn/completed',
            params: {
              threadId: 'native-thread',
              turn: { id: 'turn-1', status: 'completed', error: null },
            },
          },
        );
        await first;
        const originalId = rows()[0]!.id;
        await appears('list-1.json');
        await write('list-reply-1.json', {
          result: {
            data: [
              {
                itemId: 'command',
                processId: '1',
                command: 'run the fixture command',
                cwd,
                osPid: null,
                cpuPercent: null,
                rssKb: null,
              },
            ],
            nextCursor: null,
          },
        });
        await until(
          'the admitted brew',
          () => coordinator.snapshot.backgroundCommands.length === 1,
        );
        assert.equal(coordinator.snapshot.phase, 'idle');
        assert.deepEqual(
          coordinator.snapshot.backgroundCommands.map(
            ({ description }) => description,
          ),
          ['run the fixture command'],
        );
        assert.equal(coordinator.pentacle.active, true);
        if (loss) {
          await writeFile(join(cwd, 'exit'), '');
          await until(
            'the stopped brew',
            () => coordinator.snapshot.backgroundCommands.length === 0,
          );
          assert.equal(
            coordinator.snapshot.items.filter(
              ({ title }) => title === 'Brew stopped  run the fixture command',
            ).length,
            1,
          );
        } else {
          const second = coordinator.send('second');
          await appears('turn-2.json');
          await emit({
            method: 'item/completed',
            params: {
              threadId: 'native-thread',
              turnId: 'turn-1',
              item: {
                ...command,
                status: 'completed',
                aggregatedOutput: 'start\nend\n',
                exitCode: 0,
              },
            },
          });
          await until('the completed command', () => rows()[0]!.done === true);
          assert.equal(rows().length, 1);
          assert.equal(rows()[0]!.id, originalId);
          assert.equal(rows()[0]!.text, 'start\nend\n');
          assert.deepEqual(coordinator.snapshot.backgroundCommands, []);
          assert.equal(coordinator.snapshot.phase, 'running');
          assert.equal(coordinator.pentacle.active, true);
          await emit({
            method: 'turn/completed',
            params: {
              threadId: 'native-thread',
              turn: { id: 'turn-2', status: 'completed', error: null },
            },
          });
          await second;
        }
        assert.equal(coordinator.pentacle.active, false);
      } finally {
        await writeFile(join(cwd, 'release'), '');
        await coordinator.close();
      }
    });
});

test('brew lifecycle preserves start order and ignores repeated starts and unlisted ends', async () => {
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

    emit('preview', 'running');
    assert.deepEqual(coordinator.snapshot.backgroundCommands, [
      serve,
      { ...serve, id: 'preview' },
    ]);
    emit('preview', 'completed');
    assert.deepEqual(coordinator.snapshot.backgroundCommands, [serve]);

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

test("a brew still running when its session closes ends stopped, and the closed session's later start lists nothing", async () => {
  const { coordinator, a } = await fixture();
  const emit = (id: string) =>
    a.sessions[0]!.options.onEvent({
      type: 'command',
      command: { id, description: 'Start the server', status: 'running' },
    });
  try {
    emit('serve');
    assert.equal(coordinator.pentacle.active, true);
    await coordinator.selectModel({ agent: 'b', id: 'b-model' });
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

test('a skills change while a session lists its models reaches the snapshot', async () => {
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

test("the live session's usage reaches the snapshot, and a new conversation starts with none and its own open time even when its agent fails to connect", async () => {
  const { coordinator, a, b } = await fixture();
  try {
    a.turnUsage = { context: 10 };
    await coordinator.send('hello');
    assert.deepEqual(coordinator.snapshot.usage, { context: 10 });
    b.failConnect = true;
    const before = Date.now();
    await coordinator.newConversation('b').catch(() => {});
    assert.deepEqual(coordinator.snapshot.usage, {});
    assert.ok(coordinator.snapshot.openedAt! >= before);
  } finally {
    await coordinator.close();
  }
});

test('a reported shell is in the state, handed to the jobs, and cleared by the end report', async () => {
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

test("an agent connects with the job watch's mark", async () => {
  const { coordinator, a, jobs } = await fixture();
  try {
    assert.equal(a.sessions[0]!.options.mark, jobs);
  } finally {
    await coordinator.close();
  }
});

test('close ends a held turn when its interrupt throws', async () => {
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

test('close releases the conversation when its disconnect throws', async () => {
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

test('close rejects with a publish failure and still closes the session and the conversation', async () => {
  const { coordinator, a, hook, store } = await fixture();
  a.interruptNext = true;
  await coordinator.send('remember-port');
  const id = coordinator.snapshot.conversation!.id;
  let attempted = false;
  hook.current = async (command, run) => {
    if (command[0] !== 'update-ref') return run();
    attempted = true;
    return { stdout: Buffer.alloc(0), stderr: 'cannot publish', code: 1 };
  };
  const recovering = coordinator.recoverMemory('accept');
  await assert.rejects(coordinator.close(), /cannot publish/);
  await recovering.catch(() => {});
  assert.equal(attempted, true);
  assert.equal(a.sessions.at(-1)!.session.closed, true);
  await (await store.claim(id)).close();
});

test('a failed state write in settle needs a restart, and later messages keep it', async () => {
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

test('a failed state write while continuing at launch needs a restart', async () => {
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

test('a failed history write outside any operation needs a restart', async () => {
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

test('idle tool output reaches history without another operation', async () => {
  const { coordinator, a, root } = await fixture();
  const path = join(
    root,
    'state',
    'conversations',
    coordinator.snapshot.conversation!.id,
    'history.jsonl',
  );
  try {
    assert.equal(coordinator.snapshot.phase, 'idle');
    a.sessions.at(-1)!.options.onEvent({
      type: 'tool',
      id: 'idle',
      title: 'background',
      text: 'partial output',
      done: false,
      append: true,
    });
    assert.equal(coordinator.snapshot.items.at(-1)?.text, 'partial output');
    let content = '';
    await until('idle output persisted', async () => {
      content = await readFile(path, 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      });
      return content.endsWith('\n');
    });
    assert.equal(
      (JSON.parse(content.trim()) as { text: string }).text,
      'partial output',
    );
    assert.equal(coordinator.snapshot.phase, 'idle');
  } finally {
    await coordinator.close();
  }
});

test('an idle tool timer write failure needs a restart without another operation', async () => {
  const { coordinator, a, root } = await fixture();
  const directory = join(
    root,
    'state',
    'conversations',
    coordinator.snapshot.conversation!.id,
  );
  try {
    await chmod(directory, 0o500);
    a.sessions.at(-1)!.options.onEvent({
      type: 'tool',
      id: 'idle',
      title: 'background',
      text: 'partial output',
      done: false,
      append: true,
    });
    assert.equal(coordinator.snapshot.items.at(-1)?.text, 'partial output');
    await until(
      'timer write error',
      () => coordinator.snapshot.phase === 'error',
    );
    assert.match(coordinator.snapshot.error ?? '', /^Restart Witch: .*EACCES/);
  } finally {
    await chmod(directory, 0o700);
    await coordinator.close().catch(() => {});
  }
});

test('a git failure in settle tells the user to restart before continuing', async () => {
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
      return { stdout: Buffer.alloc(0), stderr: 'git path failed', code: 128 };
    };
    gate.open();
    await assert.rejects(sending, /Restart Witch: git path failed/);
    assert.equal(coordinator.snapshot.phase, 'error');
    assert.equal(coordinator.snapshot.error, 'Restart Witch: git path failed');
    await assert.rejects(coordinator.send('Again'), /Restart Witch/);
    await assert.rejects(coordinator.refreshModels(), /Restart Witch/);
  } finally {
    gate.open();
    await coordinator.close().catch(() => {});
  }
});

test('a model chosen to keep the current effort stores the effort in force', async () => {
  const { coordinator, root } = await fixture();
  try {
    await coordinator.selectModel({ agent: 'a', id: 'first', effort: 'high' });
    await coordinator.selectModel({ agent: 'a', id: 'second' });
    await coordinator.selectModel({ agent: 'a', id: 'a-big' });
    const record = await readRecord(
      root,
      coordinator.snapshot.conversation!.id,
    );
    assert.equal(record.sessions.a?.effort, 'high');
  } finally {
    await coordinator.close();
  }
});

test('catalog refresh preserves the active session, process, transcript, usage and skills and reports each failed runtime', async () => {
  const { coordinator, a, b, root } = await fixture(undefined, (a) => {
    a.connectUsage = { context: 0.75 };
    a.skills = [{ name: 'spell', description: 'Current spell' }];
  });
  try {
    await coordinator.send('Keep this conversation');
    const before = structuredClone(coordinator.snapshot);
    const saved = await readRecord(root, before.conversation!.id);
    assert.equal(await coordinator.refreshModels(), true);
    assert.deepEqual(
      coordinator.snapshot.models.map(({ agent, id }) => [agent, id]),
      [
        ['a', 'a-model'],
        ['a', 'a-big'],
        ['b', 'b-model'],
        ['b', 'b-big'],
      ],
    );
    assert.deepEqual(coordinator.snapshot.native, before.native);
    assert.deepEqual(coordinator.snapshot.items, before.items);
    assert.deepEqual(coordinator.snapshot.usage, before.usage);
    assert.deepEqual(coordinator.snapshot.skills, before.skills);
    const after = await readRecord(root, before.conversation!.id);
    assert.deepEqual(after.sessions, saved.sessions);
    assert.deepEqual(after.process, saved.process);
    assert.equal(a.sessions.length, 1);
    assert.equal(a.sessions[0]!.session.closed, false);
    assert.equal(b.sessions.length, 0);
    b.failDiscovery = true;
    assert.equal(await coordinator.refreshModels(), true);
    assert.deepEqual(
      coordinator.snapshot.models.map((model) => model.agent),
      ['a', 'a'],
    );
    assert.equal(coordinator.snapshot.error, undefined);
    assert.equal(
      coordinator.snapshot.items.at(-1)?.text,
      'b: Discovery failed',
    );
    assert.equal(coordinator.snapshot.native!.id, before.native!.id);
    a.failModels = true;
    assert.equal(await coordinator.refreshModels(), true);
    assert.deepEqual(coordinator.snapshot.models, []);
    assert.equal(
      coordinator.snapshot.items.at(-1)?.text,
      'a: model/list failed\nb: Discovery failed',
    );
    assert.equal(coordinator.snapshot.error, undefined);
  } finally {
    await coordinator.close();
  }
});

test('standalone catalogs recover from a failed active startup without reconnecting it', async () => {
  const { coordinator, a, b } = await fixture(undefined, (a) => {
    a.failConnect = true;
  });
  try {
    assert.match(coordinator.snapshot.error!, /Destination unavailable/);
    await coordinator.refreshModels();
    assert.deepEqual(
      coordinator.snapshot.models.map((model) => model.agent),
      ['a', 'a', 'b', 'b'],
    );
    assert.equal(a.sessions.length, 0);
    assert.equal(b.sessions.length, 0);
    await coordinator.selectModel({ agent: 'b', id: 'b-big', effort: 'high' });
    assert.equal(coordinator.snapshot.conversation!.agent, 'b');
    assert.equal(coordinator.snapshot.native!.model, 'b-big');
    assert.equal(coordinator.snapshot.native!.effort, 'high');
    assert.deepEqual(b.inputs, []);
  } finally {
    await coordinator.close();
  }
});

test('closing during catalog discovery cancels and joins its cleanup', async () => {
  const { coordinator, a, b } = await fixture();
  const entered = Promise.withResolvers<AbortSignal>();
  const aborted = Promise.withResolvers<void>();
  const cleaned = Promise.withResolvers<void>();
  b.models = async (options) => {
    entered.resolve(options.signal!);
    options.signal!.addEventListener('abort', () => aborted.resolve(), {
      once: true,
    });
    await aborted.promise;
    await cleaned.promise;
    options.signal!.throwIfAborted();
    return b.catalog;
  };
  const refreshing = coordinator.refreshModels();
  const rejected = assert.rejects(refreshing, { name: 'AbortError' });
  let closing: Promise<void> | undefined;
  try {
    const signal = await within(entered.promise, 2000, 'inactive discovery');
    let closed = false;
    closing = coordinator.close().then(() => {
      closed = true;
    });
    assert.equal(signal.aborted, true);
    await until('active shutdown', () => a.sessions.at(-1)!.session.closed);
    assert.equal(closed, false);
    cleaned.resolve();
    await within(Promise.all([closing, rejected]), 2000, 'catalog shutdown');
    assert.equal(b.sessions.length, 0);
  } finally {
    aborted.resolve();
    cleaned.resolve();
    await Promise.allSettled([refreshing, rejected, closing]);
    await coordinator.close();
  }
});

test('an effort the agent rejects while disconnected keeps the stored one, so the next turn still connects', async () => {
  const { coordinator, a, root } = await fixture();
  try {
    await coordinator.selectModel({ agent: 'a', id: 'a-big', effort: 'high' });
    a.invalidEffort = 'hgih';
    await a.sessions.at(-1)!.session.close();
    await assert.rejects(
      coordinator.selectModel({ agent: 'a', id: 'a-big', effort: 'hgih' }),
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

test('a model that lists no efforts resets the effort', async () => {
  const { coordinator, a, root } = await fixture();
  try {
    await coordinator.selectModel({ agent: 'a', id: 'first', effort: 'high' });
    await coordinator.selectModel({ agent: 'a', id: 'a-model' });
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

test('the live session publishes its skills, and a failed connect after /new shows none', async () => {
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

test('a skills failure while connecting is reported and keeps the session', async () => {
  const { coordinator, a } = await fixture();
  try {
    a.failSkills = true;
    await coordinator.newConversation();
    assert.equal(coordinator.snapshot.error, undefined);
    assert.deepEqual(
      coordinator.snapshot.items.map(({ kind, text }) => [kind, text]),
      [['notice', 'Skills unavailable']],
    );
    assert.deepEqual(coordinator.snapshot.skills, []);
    await coordinator.send('Start');
    assert.equal(a.sessions.length, 2);
  } finally {
    await coordinator.close();
  }
});

test('a listed /skill reaches the agent as a skill call, and an unlisted one stays a prompt', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [{ name: 'review', description: 'Review changes' }];
  });
  try {
    await coordinator.send(' /review  the\ndiff ');
    assert.deepEqual(a.inputs.at(-1)!.skill, {
      name: 'review',
      args: 'the\ndiff',
    });
    assert.match(a.inputs.at(-1)!.prompt, /^ \/review {2}the/);
    await coordinator.send('/review');
    assert.deepEqual(a.inputs.at(-1)!.skill, { name: 'review', args: '' });
    await coordinator.send('/reviewer x');
    assert.equal(a.inputs.at(-1)!.skill, undefined);
  } finally {
    await coordinator.close();
  }
});

test("a model list that fails at connect is reported, and the session's skills and usage still reach the snapshot", async () => {
  const { coordinator, a, store, project } = await fixture(undefined, (a) => {
    a.skills = [{ name: 'review', description: 'Review changes' }];
    a.connectUsage = { context: 5 };
    a.failModels = true;
  });
  try {
    assert.equal(coordinator.snapshot.error, undefined);
    assert.deepEqual(
      coordinator.snapshot.items.map(({ kind, text }) => [kind, text]),
      [['notice', 'a: model/list failed']],
    );
    assert.deepEqual(await store.conversations(project), []);
    assert.deepEqual(
      coordinator.snapshot.skills.map((skill) => skill.name),
      ['review'],
    );
    assert.deepEqual(coordinator.snapshot.usage, { context: 5 });
    await coordinator.send('/review now');
    assert.deepEqual(a.inputs.at(-1)!.skill, { name: 'review', args: 'now' });
  } finally {
    await coordinator.close();
  }
});

for (const stop of ['interrupt', 'close'] as const)
  test(`${stop}() during a model change closes the session that holds it`, async () => {
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
      const selecting = coordinator.selectModel({ agent: 'a', id: 'next' });
      await within(entered.promise, 2000, 'the model change');
      // close() awaits the change, so its rejection needs a handler first
      const rejected = assert.rejects(selecting, /Session closed/);
      await coordinator[stop]();
      await rejected;
    } finally {
      await coordinator.close();
    }
  });

for (const stop of ['interrupt', 'close'] as const)
  for (const ended of [false, true])
    test(`${stop}() cancels a replied model change ${ended ? 'after native idle' : 'during the native turn'}`, async () => {
      const { coordinator, a, store } = await fixture();
      const { session } = a.sessions.at(-1)!;
      const gate = new TurnGate();
      const entered = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const order: string[] = [];
      let selecting: Promise<void> | undefined;
      let sending: Promise<void> | undefined;
      let stopping: Promise<void> | undefined;
      try {
        session.selectModel = async () => {
          entered.resolve();
          await closed.promise;
          await release.promise;
          throw new Error('Selection cancelled');
        };
        const interrupt = session.interrupt.bind(session);
        session.interrupt = async () => {
          if (!order.includes('interrupt entered'))
            order.push('interrupt entered');
          await interrupt();
        };
        const close = session.close.bind(session);
        session.close = async () => {
          if (!session.closed) order.push('session close entered');
          await close();
          closed.resolve();
        };
        a.gate = gate;
        sending = coordinator.send('Start');
        await within(gate.entered, 2000, 'the first turn');
        a.replied = true;
        selecting = assert
          .rejects(
            coordinator.selectModel({
              agent: 'a',
              id: 'a-big',
              effort: 'high',
            }),
            {
              message: 'Selection cancelled',
            },
          )
          .then(() => {
            order.push('selection settled');
          });
        await within(entered.promise, 2000, 'the model change');
        if (ended) {
          gate.open();
          await within(gate.result, 2000, 'the native turn');
        }
        stopping = coordinator[stop]().then(() => {
          if (stop === 'close') order.push('coordinator closed');
        });
        await within(closed.promise, 2000, 'the cancelled native session');
        if (stop === 'close') {
          // keep the rejection pending beyond the native close, which alone must not release the conversation
          await delay(400);
          assert.ok(!order.includes('coordinator closed'));
        }
        release.resolve();
        await within(
          Promise.all([selecting, sending, stopping]),
          3000,
          'the cancelled model change',
        );
        assert.deepEqual(order, [
          'interrupt entered',
          'session close entered',
          'selection settled',
          ...(stop === 'close' ? ['coordinator closed'] : []),
        ]);
        assert.equal(
          (await gate.result).status,
          ended ? 'completed' : 'interrupted',
        );
        if (stop === 'close') {
          const reclaimed = await store.claim(
            coordinator.snapshot.conversation!.id,
          );
          await reclaimed.close();
        } else {
          gate.open();
          const before = a.sessions.length;
          await within(coordinator.send('After'), 3000, 'the resumed turn');
          assert.equal(a.sessions.length, before + 1);
          assert.equal(a.sessions.at(-1)!.session.info.id, session.info.id);
          assert.ok(a.inputs.at(-1)!.prompt === 'After');
        }
      } finally {
        release.resolve();
        gate.open();
        await session.close();
        await Promise.allSettled([selecting, sending, stopping]);
        await coordinator.close();
      }
    });

test('interrupting a pending replied model change preserves unread Claude prompts', async () => {
  const { cwd, children, connect, adapter } = await launcher('pending-model');
  const store = await StateStore.open(join(cwd, 'state'));
  const memory = new Memory(join(cwd, 'state', 'memory.git'));
  let session: AgentSession | undefined;
  const coordinator = new Coordinator(store, memory, [
    {
      adapter: {
        id: 'claude',
        label: 'Claude',
        models: (options) => adapter.models(options),
        accountUsage: async () => ({ limits: [] }),
        connect: async (options) => (session = await connect(options)),
      },
      executable: '/fake/claude',
    },
  ]);
  let sending: Promise<void> | undefined;
  let selecting: Promise<void> | undefined;
  try {
    await coordinator.initialize(cwd);
    assert.equal(coordinator.snapshot.error, undefined);
    sending = coordinator.send('reporting familiar');
    await until('the replied turn', () => !!session?.replied);
    selecting = assert.rejects(
      coordinator.selectModel({
        agent: 'claude',
        id: 'claude-next',
        effort: 'high',
      }),
      /Query closed/,
    );
    await until('the held model request', () =>
      readFile(join(cwd, 'model-entered')).then(
        () => true,
        () => false,
      ),
    );
    await coordinator.send('keep this unread prompt');
    await until('the unread prompt', async () =>
      (await jsonLines(join(cwd, 'steered.jsonl'))).includes(
        'keep this unread prompt',
      ),
    );
    await within(coordinator.interrupt(), 3000, 'the interrupt receipt');
    await within(
      Promise.all([sending, selecting]),
      3000,
      'the interrupted operation',
    );
    assert.deepEqual(coordinator.snapshot.queue, ['keep this unread prompt']);
    assert.ok(
      coordinator.snapshot.items.some(
        ({ kind, text }) => kind === 'notice' && text === 'Turn interrupted',
      ),
    );
  } finally {
    await coordinator.close();
    await Promise.allSettled([sending, selecting]);
    assert.ok(
      children.every(
        (child) => child.exitCode !== null || child.signalCode !== null,
      ),
    );
  }
});

test('agent events reach the transcript with their own replace, append and cwd', async () => {
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
    const layout = new TranscriptLayout();
    const expanded = new Map([[coordinator.snapshot.items[1]!.id, true]]);
    assert.equal(
      layout.render(coordinator.snapshot.items, 80, expanded).blocks[1]!.at(1),
      'a',
    );
    options.onEvent({ ...tool, text: 'b', done: false, append: true });
    assert.deepEqual(shown()[1], ['ab', '/elsewhere']);
    assert.equal(
      layout.render(coordinator.snapshot.items, 80, expanded).blocks[1]!.at(1),
      'ab',
    );
    options.onEvent({ ...tool, text: 'out', done: true, cwd: '/elsewhere' });
    assert.deepEqual(shown(), [
      ['Hello!', project],
      ['out', '/elsewhere'],
    ]);
    assert.equal(
      layout.render(coordinator.snapshot.items, 80, expanded).blocks[1]!.at(1),
      'out',
    );
  } finally {
    await coordinator.close();
  }
});

test("a tool's diff reaches its transcript row and comes back when the conversation reopens", async () => {
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

test('coalesced history retains the latest receipt time instead of the write time', async () => {
  const { coordinator, a, root } = await fixture();
  const id = coordinator.snapshot.conversation!.id;
  vi.useFakeTimers({
    toFake: ['Date'],
    now: Date.parse('2026-10-23T10:00:00.000Z'),
  });
  try {
    const { options } = a.sessions.at(-1)!;
    options.onEvent({ type: 'text', id: 'm', text: 'Hel' });
    vi.advanceTimersByTime(20);
    options.onEvent({ type: 'text', id: 'm', text: 'lo' });
    vi.advanceTimersByTime(1000);
  } finally {
    try {
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  }
  const records = (
    await readFile(
      join(root, 'state', 'conversations', id, 'history.jsonl'),
      'utf8',
    )
  )
    .trim()
    .split('\n')
    .map(
      (line) => JSON.parse(line) as { kind: string; text: string; at: string },
    )
    .filter((update) => update.kind === 'assistant')
    .map(({ at, text }) => ({ at, text }));
  assert.deepEqual(records, [
    { at: '2026-10-23T10:00:00.020Z', text: 'Hello' },
  ]);
});

test('a native info event reaches the footer and the next resume', async () => {
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

test('a native skills change replaces the list, unless its session has closed', async () => {
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

test('answers reach the agent and only a cancel interrupts the turn, a resolved request leaves the queue, and the settled turn leaves none', async () => {
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

test('an answered question stays in the transcript as the reply with each question and its answers, a secret answer hidden, and a declined question adds nothing', async () => {
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
