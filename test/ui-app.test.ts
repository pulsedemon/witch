import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { render } from 'ink';
import type { ReactElement } from 'react';
import { createElement } from 'react';
import stripAnsi from 'strip-ansi';
import { Coordinator } from '../src/core/coordinator.js';
import type { Snapshot } from '../src/core/coordinator.js';
import { Memory } from '../src/memory/memory.js';
import { StateStore } from '../src/persistence/store.js';
import { App } from '../src/ui/app.js';
import { FixtureAgent } from './fixtures/agent.js';
import { hookedGit, passThrough } from './fixtures/git.js';

/** a terminal of a fixed size; without rows, Ink reads the real terminal. Not a TTY, so every write is a whole frame. */
class Terminal extends EventEmitter {
  readonly frames: string[] = [];
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super();
  }
  write = (frame: string) => {
    this.frames.push(frame);
    return true;
  };
}

class Keys extends EventEmitter {
  readonly isTTY = true;
  private data: string | null = null;
  write(data: string) {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  }
  read = () => {
    const data = this.data;
    this.data = null;
    return data;
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
}

function show(element: ReactElement, columns = 100, rows = 40) {
  const stdout = new Terminal(columns, rows);
  const stdin = new Keys();
  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    stdin,
    frame: () => stdout.frames.at(-1) ?? '',
    text: () => stripAnsi(stdout.frames.at(-1) ?? ''),
    unmount: () => instance.unmount(),
  };
}

async function until(
  what: string,
  predicate: () => boolean | Promise<boolean>,
) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** a coordinator stand-in that publishes snapshots and records the calls the app makes. */
function fake(snapshot: Partial<Snapshot>) {
  const listeners = new Set<() => void>();
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const coordinator = {
    snapshot: {
      phase: 'idle',
      items: [],
      requests: [],
      models: [],
      agents: [],
      conversation: {
        id: 'c',
        title: 't',
        cwd: '/work',
        agent: 'a',
        sessions: {},
        createdAt: '',
      },
      ...snapshot,
    } as Snapshot,
    memory: { root: '/state/memory.git' },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(update: Partial<Snapshot>) {
      coordinator.snapshot = { ...coordinator.snapshot, ...update };
      for (const listener of listeners) listener();
    },
    send: record('send'),
    interrupt: record('interrupt'),
    respond: record('respond'),
    recoverMemory: record('recoverMemory'),
    report: (error: unknown) => calls.push(['report', String(error)]),
    conversations: async () => [],
  };
  return { coordinator, calls, app: coordinator as unknown as Coordinator };
}

await test('the conflict view resolves with k and d, ignores a, and links notes into the worktree', async () => {
  const { app, calls } = fake({
    phase: 'recovery',
    recovery: {
      kind: 'conflict',
      paths: ['global/one.md'],
      diff: '+mine in global/one.md',
      root: '/state/conversations/c/memory',
    },
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await until('the conflict view', () =>
      ui
        .text()
        .includes('k keep mine (your side of each conflicting change wins)'),
    );
    assert.ok(
      ui
        .frame()
        .includes('vscode://file/state/conversations/c/memory/global/one.md'),
    );
    assert.ok(!ui.frame().includes('memory.git'));
    for (const key of ['a', 'k', 'd']) {
      ui.stdin.write(key);
      await delay(30);
    }
    assert.deepEqual(calls, [
      ['recoverMemory', 'keep'],
      ['recoverMemory', 'discard'],
    ]);
  } finally {
    ui.unmount();
  }
});

await test('the pending view ignores k', async () => {
  const { app, calls } = fake({
    phase: 'recovery',
    recovery: { kind: 'pending', paths: [], diff: 'New file: x', root: '/m' },
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await until('the pending view', () =>
      ui.text().includes('a accept · d discard'),
    );
    for (const key of ['k', 'a']) {
      ui.stdin.write(key);
      await delay(30);
    }
    assert.deepEqual(calls, [['recoverMemory', 'accept']]);
  } finally {
    ui.unmount();
  }
});

await test('an error shows in the recovery view', async () => {
  const { app } = fake({
    phase: 'recovery',
    recovery: { kind: 'pending', paths: [], diff: 'New file: x', root: '/m' },
    error: 'The publish failed for a reason.',
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await until('the error', () =>
      ui.text().includes('The publish failed for a reason.'),
    );
    assert.ok(ui.text().includes('Unfinished memory changes'));
  } finally {
    ui.unmount();
  }
});

await test('a launch report shows every line, and a taller message ends with a row count', async () => {
  const titles = [1, 2, 3].map((n) => `${n}`.repeat(80));
  const report = `These conversations need attention. Open each from /sessions in its directory:\n${titles
    .map((title) => `- ${title} in /work/project: unfinished memory changes`)
    .join('\n')}`;
  const { app, coordinator } = fake({ error: report });
  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    100,
    40,
  );
  try {
    await until('the report', () =>
      ui.text().includes('Open each from /sessions'),
    );
    for (const title of titles) assert.ok(ui.text().includes(title), title);
    coordinator.publish({
      error: Array.from({ length: 20 }, (_, n) => `row ${n + 1}`).join('\n'),
    });
    await until('the long message', () => ui.text().includes('more rows'));
    const rows = ui
      .text()
      .split('\n')
      .map((row) => row.trim());
    assert.ok(rows.includes('row 12'));
    assert.ok(!rows.includes('row 13'));
    assert.ok(rows.includes('+8 more rows'));
  } finally {
    ui.unmount();
  }
});

async function memoryApp() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'witch-ui-app-')));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const hook = { current: passThrough };
  const memory = new Memory(join(root, 'state', 'memory.git'), hookedGit(hook));
  await memory.initialize();
  const directory = join(root, 'state', 'conversations', 'seed');
  await mkdir(directory, { recursive: true });
  const seed = memory.workspace(directory, 'seed');
  await seed.ensureWorktree();
  await writeFile(join(seed.root, 'global', 'other.md'), 'Another note.');
  await seed.commit('chore(memory): save seed notes');
  await seed.publish();
  const coordinator = new Coordinator(
    await StateStore.open(join(root, 'state')),
    memory,
    [{ adapter: new FixtureAgent('a'), executable: 'a' }],
  );
  await coordinator.initialize(cwd);
  return { root, hook, seed, coordinator };
}

await test('/memory reads one commit even when main moves during the action', async () => {
  const { hook, seed, coordinator } = await memoryApp();
  hook.current = async (command, run) => {
    const result = await run();
    if (command[0] === 'log' && command.includes('--name-only')) {
      hook.current = passThrough;
      await rm(join(seed.root, 'global', 'other.md'));
      await seed.commit('chore(memory): delete other');
      await seed.publish();
    }
    return result;
  };
  const ui = show(createElement(App, { coordinator, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write('/memory');
    await delay(30);
    ui.stdin.write('\r');
    await until('the memory picker', () =>
      ui.text().includes('global/other.md'),
    );
    assert.equal(coordinator.snapshot.error, undefined);
  } finally {
    ui.unmount();
    await coordinator.close();
  }
});

await test('memory without a worktree shows no links, builds no worktree, and keeps history', async () => {
  const { root, coordinator } = await memoryApp();
  const ui = show(createElement(App, { coordinator, onExit: () => {} }));
  const row = (text: string) =>
    ui
      .frame()
      .split('\n')
      .find((line) => stripAnsi(line).includes(text)) ?? '';
  try {
    await delay(60);
    ui.stdin.write('/memory');
    await delay(30);
    ui.stdin.write('\r');
    await until('the memory picker', () =>
      ui.text().includes('global/MEMORY.md'),
    );
    assert.ok(!row('global/MEMORY.md').includes('\u001b]8;'));
    await delay(30);
    ui.stdin.write('global/mem');
    await delay(30);
    ui.stdin.write('\r');
    await until('the note page', () =>
      ui.text().includes('e edit · h history'),
    );
    assert.ok(!row('global/MEMORY.md').includes('\u001b]8;'));
    ui.stdin.write('h');
    await until('the history picker', () =>
      ui.text().includes('Restore a memory version'),
    );
    await assert.rejects(
      access(
        join(
          root,
          'state',
          'conversations',
          coordinator.snapshot.conversation!.id,
          'memory',
        ),
      ),
    );
  } finally {
    ui.unmount();
    await coordinator.close();
  }
});
