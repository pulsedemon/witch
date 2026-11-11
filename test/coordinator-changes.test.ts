import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'vitest';
import type { AgentEvent, FileDiff } from '../src/agents/types.js';
import type { Coordinator } from '../src/core/coordinator.js';
import { WorkTreeChanges } from '../src/core/work-tree-changes.js';
import type { Changes } from '../src/core/work-tree-changes.js';
import type { FixtureAgent } from './fixtures/agent.js';
import { fixture } from './fixtures/coordinator.js';
import { until } from './fixtures/within.js';

const none: Changes = { files: [], withHead: 0, more: 0 };

/** records what the session asks of the watcher and answers each read from `reads`, in order. */
class Watcher extends WorkTreeChanges {
  readonly calls: unknown[][] = [];
  reads: Promise<Changes>[] = [];
  watching = () => Promise.resolve();
  absorbing: Promise<void> = Promise.resolve();

  constructor() {
    super('/unused');
  }

  override watch(cwd: string) {
    this.calls.push(['watch', cwd]);
    return this.watching();
  }

  override absorb(cwd: string, paths: readonly string[]) {
    this.calls.push(['absorb', cwd, paths]);
    return this.absorbing;
  }

  override read(cwd: string) {
    this.calls.push(['read', cwd]);
    return this.reads.shift() ?? Promise.resolve(none);
  }
}

/** Claude's shape: only the start says a shell command ran. */
function command(
  onEvent: (event: AgentEvent) => void,
  id: string,
  output = 'out',
) {
  onEvent({
    type: 'tool',
    id,
    title: `Bash  $ ${id}`,
    text: '{}',
    done: false,
    command: true,
  });
  onEvent({ type: 'tool', id, title: '', text: output, done: true });
}

const row = (coordinator: Coordinator, title: string) =>
  coordinator.snapshot.items.find((item) => item.title === title);
const notices = (coordinator: Coordinator) =>
  coordinator.snapshot.items.flatMap((item) =>
    item.kind === 'notice' && item.text.startsWith("Couldn't")
      ? [item.text]
      : [],
  );

test("a finished shell command's row gains what changed, keeps its output and survives a reopen", async () => {
  const watcher = new Watcher();
  const { coordinator, a, project, reopen } = await fixture(
    undefined,
    undefined,
    true,
    watcher,
  );
  let reopened: Coordinator | undefined;
  const diff: FileDiff[] = [
    {
      path: `${project}/a.txt`,
      kind: 'update',
      hunks: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }],
    },
    {
      path: `${project}/big.txt`,
      kind: 'add',
      hunks: [],
      unshown: { added: 401, removed: 0 },
    },
  ];
  try {
    // connecting asks for the baseline before any tool can report
    assert.deepEqual(watcher.calls, [['watch', project]]);
    await coordinator.send('first');
    watcher.reads = [Promise.resolve({ files: diff, withHead: 2, more: 1 })];
    command(a.sessions.at(-1)!.options.onEvent, 'sed');
    await until('the diff', () => !!row(coordinator, 'Bash  $ sed')?.diff);
    const shown = row(coordinator, 'Bash  $ sed')!;
    assert.deepEqual(shown.diff, diff);
    assert.equal(
      shown.text,
      'out\n… 2 files changed with HEAD\n… 1 more file changed',
    );
    assert.equal(shown.done, true);
    assert.deepEqual(watcher.calls.at(-1), ['read', project]);
    await coordinator.close();
    reopened = await reopen();
    assert.deepEqual(row(reopened, 'Bash  $ sed')?.diff, diff);
  } finally {
    await coordinator.close();
    await reopened?.close();
  }
});

test("the native session starts only once its checkout's baseline has settled", async () => {
  const watcher = new Watcher();
  const baseline = Promise.withResolvers<void>();
  watcher.watching = () => baseline.promise;
  let agent: FixtureAgent | undefined;
  const opening = fixture(
    undefined,
    (a) => {
      agent = a;
    },
    true,
    watcher,
  );
  await until('the baseline request', () => watcher.calls.length === 1);
  await setImmediate();
  assert.equal(agent!.sessions.length, 0);
  baseline.resolve();
  const { coordinator, a } = await opening;
  try {
    assert.equal(a.sessions.length, 1);
  } finally {
    await coordinator.close();
  }
});

test('an interrupt during the baseline wait starts no native session', async () => {
  const watcher = new Watcher();
  const { coordinator, a } = await fixture(undefined, undefined, true, watcher);
  const baseline = Promise.withResolvers<void>();
  let clearing: Promise<void> | undefined;
  try {
    watcher.watching = () => baseline.promise;
    clearing = coordinator.clear();
    await until('the baseline request', () => watcher.calls.length === 2);
    await coordinator.interrupt();
    baseline.resolve();
    await assert.rejects(clearing, { name: 'AbortError' });
    assert.equal(a.sessions.length, 1);
  } finally {
    baseline.resolve();
    await clearing?.catch(() => undefined);
    await coordinator.close();
  }
});

test('only shell commands are read, and counts alone append without a diff', async () => {
  const watcher = new Watcher();
  const { coordinator, a } = await fixture(undefined, undefined, true, watcher);
  try {
    await coordinator.send('first');
    const { onEvent } = a.sessions.at(-1)!.options;
    onEvent({
      type: 'tool',
      id: 'read',
      title: 'Read  a.ts',
      text: '',
      done: false,
    });
    onEvent({ type: 'tool', id: 'read', title: '', text: 'a', done: true });
    assert.equal(watcher.calls.filter(([name]) => name === 'read').length, 0);

    // Codex's shape: a finish that says a command ran, with no start before it
    watcher.reads = [Promise.resolve({ files: [], withHead: 1, more: 0 })];
    onEvent({
      type: 'tool',
      id: 'switch',
      title: 'git switch main',
      text: 'switched',
      done: true,
      command: true,
    });
    await until('the count', () =>
      row(coordinator, 'git switch main')!.text.includes('HEAD'),
    );
    const counted = row(coordinator, 'git switch main')!;
    assert.equal(counted.text, 'switched\n… 1 file changed with HEAD');
    assert.equal(counted.diff, undefined);

    // a command that changed nothing leaves its row alone
    command(onEvent, 'ls', 'listing');
    await setImmediate();
    assert.equal(row(coordinator, 'Bash  $ ls')!.text, 'listing');
    assert.equal(watcher.calls.filter(([name]) => name === 'read').length, 2);
  } finally {
    await coordinator.close();
  }
});

test("a tool's own diff moves the baseline past its files, unless the tool failed", async () => {
  const watcher = new Watcher();
  const { coordinator, a, project } = await fixture(
    undefined,
    undefined,
    true,
    watcher,
  );
  const diff: FileDiff[] = [
    {
      path: `${project}/old.ts`,
      kind: 'update',
      movePath: `${project}/new.ts`,
      hunks: [],
    },
  ];
  try {
    await coordinator.send('first');
    const { onEvent } = a.sessions.at(-1)!.options;
    onEvent({
      type: 'tool',
      id: 'edit',
      title: 'Edit',
      text: '',
      done: true,
      diff,
    });
    onEvent({
      type: 'tool',
      id: 'declined',
      title: 'Edit',
      text: 'Patch declined',
      done: true,
      diff,
      failed: true,
    });
    assert.deepEqual(watcher.calls.slice(1), [
      ['absorb', project, [`${project}/old.ts`, `${project}/new.ts`]],
    ]);
  } finally {
    await coordinator.close();
  }
});

test('a failure posts one notice until its text changes, and a failed baseline leaves the turn running', async () => {
  const watcher = new Watcher();
  watcher.watching = () => Promise.reject(new Error("Couldn't read: baseline"));
  const { coordinator, a } = await fixture(undefined, undefined, true, watcher);
  try {
    await until('the baseline notice', () => notices(coordinator).length === 1);
    await coordinator.send('first');
    assert.equal(a.inputs.length, 1);
    const { onEvent } = a.sessions.at(-1)!.options;
    const failure = () => Promise.reject(new Error("Couldn't read: twice"));
    watcher.reads = [failure(), failure()];
    command(onEvent, 'one');
    command(onEvent, 'two');
    await until('the read notice', () => notices(coordinator).length === 2);
    await setImmediate();
    watcher.absorbing = Promise.reject(new Error("Couldn't read: absorb"));
    onEvent({
      type: 'tool',
      id: 'edit',
      title: 'Edit',
      text: '',
      done: true,
      diff: [],
    });
    await until('the absorb notice', () => notices(coordinator).length === 3);
    assert.deepEqual(notices(coordinator), [
      "Couldn't read: baseline",
      "Couldn't read: twice",
      "Couldn't read: absorb",
    ]);
  } finally {
    await coordinator.close();
  }
});

test('a read that settles after its conversation closed shows and posts nothing', async () => {
  const watcher = new Watcher();
  const { coordinator, a, project } = await fixture(
    undefined,
    undefined,
    true,
    watcher,
  );
  try {
    await coordinator.send('first');
    const { onEvent } = a.sessions.at(-1)!.options;
    const shown = Promise.withResolvers<Changes>();
    const failed = Promise.withResolvers<Changes>();
    watcher.reads = [shown.promise, failed.promise];
    command(onEvent, 'late');
    command(onEvent, 'failing');
    await coordinator.newConversation();
    shown.resolve({
      files: [{ path: `${project}/a.txt`, kind: 'add', hunks: [] }],
      withHead: 0,
      more: 0,
    });
    failed.reject(new Error("Couldn't read: late"));
    await setImmediate();
    assert.deepEqual(
      coordinator.snapshot.items.filter(
        (item) => item.kind === 'tool' || item.text.startsWith("Couldn't"),
      ),
      [],
    );
  } finally {
    await coordinator.close();
  }
});
