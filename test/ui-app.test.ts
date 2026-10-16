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
import type { JobWatch } from '../src/core/jobs.js';
import { Memory } from '../src/memory/memory.js';
import { StateStore } from '../src/persistence/store.js';
import { App } from '../src/ui/app.js';
import { MouseInput } from '../src/ui/mouse.js';
import { FixtureAgent } from './fixtures/agent.js';
import { hookedGit, passThrough } from './fixtures/git.js';
import { until } from './fixtures/within.js';

/** a terminal of the given size until `resize` changes its columns; without rows, Ink reads the real terminal. not a TTY, so every write is a whole frame. */
class Terminal extends EventEmitter {
  readonly frames: string[] = [];
  constructor(
    public columns: number,
    readonly rows: number,
  ) {
    super();
  }
  resize(columns: number) {
    this.columns = columns;
    this.emit('resize');
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
    // as the CLI reads input, so keys and mouse reports share one stream
    stdin: new MouseInput(stdin) as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    stdin,
    frame: () => stdout.frames.at(-1) ?? '',
    text: () => stripAnsi(stdout.frames.at(-1) ?? ''),
    resize: (columns: number) => stdout.resize(columns),
    unmount: () => instance.unmount(),
  };
}

/** a link sequence whole, which strip-ansi removes, then split by codes whose removal joins it back up */
function forgedLink(target: string, text: string) {
  return (
    `\u001b]8;;${target}\u0007${text}\u001b]8;;\u0007` +
    `\u001b\u001b[31m]8;;${target}\u0007${text}\u001b\u001b[0m]8;;\u0007`
  );
}

/** a coordinator stand-in that publishes snapshots and records the calls the app makes. */
function fake(snapshot: Partial<Snapshot>, files: string[] = []) {
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
      queue: [],
      requests: [],
      models: [],
      skills: [],
      subagents: [],
      usage: {},
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
    unqueue: () => {
      calls.push(['unqueue']);
      const { queue } = coordinator.snapshot;
      coordinator.publish({ queue: [] });
      return [...queue];
    },
    interrupt: record('interrupt'),
    respond: record('respond'),
    recoverMemory: record('recoverMemory'),
    newConversation: record('newConversation'),
    selectConversation: record('selectConversation'),
    refreshModels: record('refreshModels'),
    selectModel: record('selectModel'),
    switchAgent: record('switchAgent'),
    report: (error: unknown) => calls.push(['report', String(error)]),
    conversations: async () => [
      { id: 'c2', title: 'Other', agent: 'a', cwd: '/work' },
    ],
    projectFiles: async () => files,
  };
  return { coordinator, calls, app: coordinator as unknown as Coordinator };
}

/** a prompt store holding `found` for the fake conversation's /work and nothing elsewhere, recording what the app adds. */
function prompts(found: string[]) {
  const added: [string, string][] = [];
  return {
    added,
    store: {
      prompts: async (cwd: string) => (cwd === '/work' ? found : []),
      addPrompt: async (cwd: string, text: string) => {
        added.push([cwd, text]);
      },
    },
  };
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
        .includes('k KEEP MINE (YOUR SIDE OF EACH CONFLICTING CHANGE WINS)'),
    );
    assert.ok(
      ui
        .frame()
        .includes('vscode://file/state/conversations/c/memory/global/one.md'),
    );
    assert.ok(!ui.frame().includes('memory.git'));
    // past the 500 ms recovery guard, so the view's kind, not the guard, ignores the key
    await delay(600);
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

await test('a conflicting note name carrying a link sequence shows as plain text', async () => {
  const { app } = fake({
    phase: 'recovery',
    recovery: {
      kind: 'conflict',
      paths: ['global/one.md', `global/${forgedLink('..:1', 'forged')}.md`],
      diff: '+mine in global/one.md',
      root: '/state/conversations/c/memory',
    },
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await until('the conflict view', () => ui.text().includes('global/forged'));
    assert.ok(
      ui
        .frame()
        .includes('vscode://file/state/conversations/c/memory/global/one.md'),
    );
    assert.ok(!ui.frame().includes('vscode://file/state/conversations/c:1'));
  } finally {
    ui.unmount();
  }
});

await test('an error naming a note drops a link forged in the name', async () => {
  const { app } = fake({
    error: `Memory notes must be regular files: global/${forgedLink('..:1', 'forged')}.md`,
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await until('the error', () => ui.text().includes('regular files'));
    assert.ok(!ui.frame().includes('vscode://file/:1'));
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
      ui.text().includes('a ACCEPT | d DISCARD'),
    );
    await delay(600);
    for (const key of ['k', 'a']) {
      ui.stdin.write(key);
      await delay(30);
    }
    assert.deepEqual(calls, [['recoverMemory', 'accept']]);
  } finally {
    ui.unmount();
  }
});

await test('a recovery that appears while typing ignores keys for its first 500 ms', async () => {
  const { app, coordinator, calls } = fake({ phase: 'running' });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  const discardOnce = async (count: number) => {
    coordinator.publish({
      phase: 'recovery',
      recovery: { kind: 'pending', paths: [], diff: 'New file: x', root: '/m' },
    });
    await until('the pending view', () =>
      ui.text().includes('a ACCEPT | d DISCARD'),
    );
    // a key in the instant the view appears beats even a 0 ms guard
    await delay(150);
    ui.stdin.write('d');
    await delay(100);
    assert.equal(calls.length, count - 1);
    await delay(500);
    ui.stdin.write('d');
    await until('the discard', () => calls.length === count);
  };
  try {
    // past 500 ms from mount, so a guard counted from mount has already lifted
    await delay(700);
    await discardOnce(1);
    coordinator.publish({ phase: 'running' });
    await until('the composer', () => !ui.text().includes('d DISCARD'));
    await discardOnce(2);
    assert.deepEqual(calls, [
      ['recoverMemory', 'discard'],
      ['recoverMemory', 'discard'],
    ]);
  } finally {
    ui.unmount();
  }
});

await test('PageDown in the recovery view starts at the first row it hid', async () => {
  const { app } = fake({
    phase: 'recovery',
    recovery: {
      kind: 'pending',
      paths: [],
      diff: Array.from({ length: 60 }, (_, n) => `+row ${n + 1}`).join('\n'),
      root: '/m',
    },
  });
  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    100,
    24,
  );
  const shown = () =>
    [...ui.text().matchAll(/row (\d+)/g)].map((match) => Number(match[1]));
  try {
    await until('the pending diff', () => shown()[0] === 1);
    const rows = shown().length;
    ui.stdin.write('\u001b[6~');
    await until('the second page', () => shown()[0] !== 1);
    assert.equal(shown()[0], rows + 1);
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

async function memoryApp(
  editFile: (
    file: string,
    signal: AbortSignal,
  ) => Promise<void> = async () => {},
) {
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
    // uninstalled, so opening the conversation builds no worktree
    [{ adapter: new FixtureAgent('a') }],
    editFile,
  );
  await coordinator.initialize(cwd);
  return { root, hook, seed, coordinator };
}

/** types /memory and waits for its picker to show `text`. */
async function openMemory(ui: ReturnType<typeof show>, text: string) {
  ui.stdin.write('/memory');
  await delay(30);
  ui.stdin.write('\r');
  await until('the memory picker', () => ui.text().includes(text));
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
    await openMemory(ui, 'global/other.md');
    // only the launch's connect report, no error from reading memory
    assert.match(coordinator.snapshot.error ?? '', /^a is not installed\./);
  } finally {
    ui.unmount();
    await coordinator.close();
  }
});

await test('/memory shows a long note whose name holds a line break on one row, linked or not', async () => {
  const { seed, coordinator } = await memoryApp();
  await writeFile(
    join(seed.root, 'global', `first\nsecond${'x'.repeat(100)}.md`),
    'A note.',
  );
  await seed.commit('chore(memory): save a note');
  await seed.publish();
  const ui = show(createElement(App, { coordinator, onExit: () => {} }));
  // the 20 cells before the x's leave room for 77 in the picker's 98
  const row = `global/first second${'x'.repeat(77)}…`;
  try {
    await delay(60);
    await openMemory(ui, row);
    ui.stdin.write('\u001b');
    await until('the chat', () => !ui.text().includes(row));
    // a worktree at main links the rows, so they render through linkify
    await coordinator.editMemory('global/other.md');
    await openMemory(ui, row);
    assert.ok(ui.frame().includes('/memory/global/other.md\u0007'));
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
    await openMemory(ui, 'global/MEMORY.md');
    assert.ok(!row('global/MEMORY.md').includes('\u001b]8;'));
    await delay(30);
    ui.stdin.write('global/mem');
    await delay(30);
    ui.stdin.write('\r');
    await until('the note page', () =>
      ui.text().includes('e EDIT | h HISTORY'),
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

await test('a note page scrolls by rows and full pages and stops at its last row', async () => {
  const { seed, coordinator } = await memoryApp();
  await writeFile(
    join(seed.root, 'global', 'long.md'),
    Array.from({ length: 60 }, (_, row) => `- row ${row + 1}\n`).join(''),
  );
  await seed.commit('chore(memory): save long note');
  await seed.publish();
  const ui = show(
    createElement(App, { coordinator, onExit: () => {} }),
    100,
    24,
  );
  const shown = () =>
    [...ui.text().matchAll(/row (\d+)/g)].map((match) => Number(match[1]));
  const pageDown = '\u001b[6~';
  try {
    await delay(60);
    await openMemory(ui, 'long.md');
    await delay(30);
    ui.stdin.write('long.md');
    await delay(30);
    ui.stdin.write('\r');
    await until('the note page', () => shown()[0] === 1);
    const rows = shown().length;
    ui.stdin.write(pageDown);
    await until('the second page', () => shown()[0] !== 1);
    assert.equal(shown()[0], rows + 1);
    for (let page = 0; page < 60 / rows + 1; page++) {
      await delay(30);
      ui.stdin.write(pageDown);
    }
    await until('the last row', () => shown().at(-1) === 60);
    await delay(30);
    ui.stdin.write('\u001b[A');
    await until('one row up', () => shown().at(-1) === 59);
    ui.stdin.write('\u001b[B');
    await until('one row down', () => shown().at(-1) === 60);
    ui.stdin.write('\u001b[5~');
    await until('a page up', () => shown()[0] === 61 - 2 * rows);
  } finally {
    ui.unmount();
    await coordinator.close();
  }
});

await test('e on a note page edits that note, and the + entry edits project essentials', async () => {
  const edited: string[] = [];
  const { coordinator } = await memoryApp(async (file) => {
    edited.push(file);
  });
  const ui = show(createElement(App, { coordinator, onExit: () => {} }));
  try {
    await delay(60);
    await openMemory(ui, 'other.md');
    await delay(30);
    ui.stdin.write('other.md');
    await delay(30);
    ui.stdin.write('\r');
    await until('the note page', () => ui.text().includes('e EDIT'));
    ui.stdin.write('e');
    await until('the edit', () => edited.length === 1);
    assert.match(edited[0]!, /\/global\/other\.md$/);
    await until('idle', () => coordinator.snapshot.phase === 'idle');
    // the edit's notice already names other.md
    await openMemory(ui, 'Edit project essentials');
    await delay(30);
    ui.stdin.write('\r');
    await until('the second edit', () => edited.length === 2);
    assert.match(edited[1]!, /\/MEMORY\.md$/);
    assert.doesNotMatch(edited[1]!, /\/global\//);
  } finally {
    ui.unmount();
    await coordinator.close();
  }
});

await test('a note page links its relative Markdown targets beside the note once its worktree holds the revision', async () => {
  const { root, seed, coordinator } = await memoryApp();
  await writeFile(join(seed.root, 'global', 'index.md'), '- [Other](other.md)');
  await seed.commit('chore(memory): add index');
  await seed.publish();
  const ui = show(createElement(App, { coordinator, onExit: () => {} }));
  const open = async () => {
    // the edit's notice already names index.md
    await openMemory(ui, 'Edit project essentials');
    await delay(30);
    ui.stdin.write('index.md');
    await delay(30);
    ui.stdin.write('\r');
    await until('the note page', () => ui.text().includes('e EDIT'));
  };
  try {
    await delay(60);
    await open();
    assert.ok(!ui.frame().includes('other.md'));
    ui.stdin.write('\u001b');
    await until('the chat', () => !ui.text().includes('e EDIT'));
    await coordinator.editMemory('global/index.md');
    await open();
    const worktree = join(
      root,
      'state',
      'conversations',
      coordinator.snapshot.conversation!.id,
      'memory',
    );
    assert.ok(
      ui.frame().includes(`vscode://file${worktree}/global/other.md\u0007`),
    );
  } finally {
    ui.unmount();
    await coordinator.close();
  }
});

await test('a note file name carrying a link sequence shows as plain text in the picker, on its page and in its notices', async () => {
  const { root, seed, coordinator } = await memoryApp();
  // a file name holds no slash, so a forged target can only be a local path. notices render Markdown, so the name forges Markdown links too
  await writeFile(
    join(
      seed.root,
      'global',
      `${forgedLink('..:1', 'forged')}[Forged note](..:1)\\[Forged note\\](..:1).md`,
    ),
    'Forged note.',
  );
  await seed.commit('chore(memory): save forged note');
  await seed.publish();
  const ui = show(createElement(App, { coordinator, onExit: () => {} }));
  const choose = async () => {
    await delay(30);
    ui.stdin.write('Forged note');
    await delay(30);
    ui.stdin.write('\r');
    await until('the note page', () => ui.text().includes('e EDIT'));
  };
  try {
    await delay(60);
    await openMemory(ui, 'global/forged');
    assert.ok(!ui.frame().includes('\u001b]8;;..:1'));
    ui.stdin.write('\u001b');
    await until('the chat', () => !ui.text().includes('global/forged'));
    // a worktree at main links the picker's rows
    await coordinator.editMemory('global/other.md');
    const conversation = join(
      root,
      'state',
      'conversations',
      coordinator.snapshot.conversation!.id,
    );
    const forged = `vscode://file${conversation}:1\u0007`;
    await openMemory(ui, 'global/forged');
    assert.ok(
      ui
        .frame()
        .includes(`vscode://file${conversation}/memory/global/other.md\u0007`),
    );
    assert.ok(!ui.frame().includes(forged));
    await choose();
    assert.ok(!ui.frame().includes(forged));
    assert.ok(!ui.frame().includes('\u001b]8;;..:1'));
    ui.stdin.write('e');
    await until(
      'the edit notice',
      () => ui.text().split('Memory edit:').length === 3,
    );
    assert.ok(!ui.frame().includes(forged));
    await until('idle', () => coordinator.snapshot.phase === 'idle');
    await openMemory(ui, 'global/forged');
    await choose();
    ui.stdin.write('h');
    await until('the history picker', () =>
      ui.text().includes('Restore a memory version'),
    );
    await delay(30);
    ui.stdin.write('\r');
    await until('the restore notice', () =>
      ui.text().includes('Memory restore:'),
    );
    assert.ok(!ui.frame().includes(forged));
  } finally {
    ui.unmount();
    await coordinator.close();
  }
});

await test('an initial prompt is sent once when the load ends idle with nothing reported', async () => {
  const { app, coordinator, calls } = fake({ phase: 'starting' });
  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      initialPrompt: 'say hello',
    }),
  );
  try {
    await delay(60);
    coordinator.publish({ phase: 'idle' });
    await until('the send', () => calls.some(([name]) => name === 'send'));
    assert.ok(ui.text().includes('Ask the agent, or type /help'));
    assert.ok(!ui.text().includes('say hello'));
    coordinator.publish({ phase: 'running' });
    await delay(60);
    coordinator.publish({ phase: 'idle' });
    await delay(60);
    assert.deepEqual(
      calls.filter(([name]) => name === 'send'),
      [['send', 'say hello']],
    );
  } finally {
    ui.unmount();
  }
});

await test('a prompt sent while the load connects goes after the initial prompt, which stays out of the draft', async () => {
  const { app, coordinator, calls } = fake({ phase: 'starting' });
  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      initialPrompt: 'say hello',
    }),
  );
  try {
    await delay(60);
    ui.stdin.write('and then this');
    await delay(30);
    ui.stdin.write('\r');
    await until('the sends', () => calls.length > 1);
    coordinator.publish({ phase: 'running' });
    await delay(60);
    assert.deepEqual(calls, [
      ['send', 'say hello'],
      ['send', 'and then this'],
    ]);
    assert.ok(!ui.text().includes('say hello'));
  } finally {
    ui.unmount();
  }
});

for (const [name, update, focusTools] of [
  [
    'recovery',
    {
      phase: 'recovery',
      recovery: { kind: 'pending', paths: [], diff: 'x', root: '/m' },
    },
    false,
  ],
  [
    'a launch report',
    { phase: 'idle', error: 'These conversations need attention.' },
    false,
  ],
  [
    'a failed open',
    { phase: 'error', error: 'Open failed.', conversation: undefined },
    false,
  ],
  ['a load that ends with tools focused', { phase: 'idle' }, true],
] as const) {
  await test(`an initial prompt stays in the composer after ${name}`, async () => {
    const { app, coordinator, calls } = fake({ phase: 'starting' });
    const ui = show(
      createElement(App, {
        coordinator: app,
        onExit: () => {},
        initialPrompt: 'say hello',
      }),
    );
    try {
      await delay(60);
      if (focusTools) {
        ui.stdin.write('\t');
        await until('tool focus', () => ui.text().includes('ESC LEAVE TOOLS'));
      }
      coordinator.publish(update as Partial<Snapshot>);
      if (update.phase === 'recovery') {
        await delay(60);
        coordinator.publish({ phase: 'idle', recovery: undefined });
      }
      await until('the seeded composer', () =>
        ui.text().includes('┃ say hello'),
      );
      await delay(60);
      assert.deepEqual(
        calls.filter(([call]) => call === 'send'),
        [],
      );
    } finally {
      ui.unmount();
    }
  });
}

await test('an initial prompt that comes back to the composer goes ahead of a draft typed while connecting', async () => {
  const { app, coordinator } = fake({ phase: 'starting' });
  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      initialPrompt: 'say hello',
    }),
  );
  try {
    await delay(60);
    ui.stdin.write('typed');
    await until('the draft', () => ui.text().includes('┃ typed'));
    coordinator.publish({
      phase: 'idle',
      error: 'These conversations need attention.',
    });
    await until('the seeded composer', () => ui.text().includes('┃ say hello'));
    const text = ui.text();
    assert.ok(text.indexOf('┃ say hello') < text.indexOf('┃ typed'));
  } finally {
    ui.unmount();
  }
});

await test('queued prompts left at idle or in an error come back ahead of the draft, also while a view covers the composer', async () => {
  for (const [phase, covered] of [
    ['idle', false],
    ['idle', true],
    ['error', false],
  ] as const) {
    const { app, coordinator, calls } = fake({ phase: 'running' });
    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
    try {
      await delay(60);
      ui.stdin.write('newer');
      await until('the draft', () => ui.text().includes('┃ newer'));
      if (covered) {
        ui.stdin.write('\u0010');
        await until('the picker', () => ui.text().includes('Commands'));
      }
      coordinator.publish({
        phase,
        queue: ['hello'],
        ...(phase === 'error' ? { error: 'Restart Witch.' } : {}),
      });
      await until('the queue taken back', () => calls.length > 0);
      if (covered) ui.stdin.write('\u001b');
      await until('the queued prompt', () => ui.text().includes('┃ hello'));
      assert.ok(ui.text().indexOf('┃ hello') < ui.text().indexOf('┃ newer'));
      assert.deepEqual(calls, [['unqueue']]);
    } finally {
      ui.unmount();
    }
  }
});

await test('the composer takes typing while an open conversation connects, and none before the load opens one', async () => {
  for (const open of [true, false]) {
    const { app } = fake({
      phase: 'starting',
      ...(open ? {} : { conversation: undefined }),
    });
    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
    try {
      await delay(60);
      ui.stdin.write('hello');
      await delay(60);
      assert.equal(ui.text().includes('┃ hello'), open);
    } finally {
      ui.unmount();
    }
  }
});

const ENTER = '\u001b[13u';
const SHIFT_ENTER = '\u001b[13;2u';
const DOWN = '\u001b[B';
const UP = '\u001b[A';
const LEFT = '\u001b[D';
const TAB = '\u001b[9u';
const tools = (prefix: string) =>
  [1, 2].map((n) => ({
    id: `${prefix}-tool-${n}`,
    kind: 'tool' as const,
    title: `${prefix} tool ${n}`,
    text: `${prefix} output ${n}`,
    cwd: '/work',
    done: true,
  }));
const approval = {
  id: 'r1',
  kind: 'approval' as const,
  title: 'rm -rf build',
  detail: '{}',
};

for (const [name, keys, decision] of [
  ['Enter accepts', ENTER, 'accept'],
  ['Down and Enter in one read decline', DOWN + ENTER, 'decline'],
  ['Down, Down and Enter cancel', DOWN + DOWN + ENTER, 'cancel'],
  ['n declines', 'n', 'decline'],
] as const)
  await test(`${name} an approval`, async () => {
    const { app, calls } = fake({ phase: 'running', requests: [approval] });
    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
    try {
      await delay(600);
      ui.stdin.write(keys);
      await until('the response', () => calls.length > 0);
      assert.deepEqual(calls, [['respond', 'r1', { decision }]]);
    } finally {
      ui.unmount();
    }
  });

await test('two questions answered in one read each get their own option', async () => {
  const { app, calls } = fake({
    phase: 'running',
    requests: [
      {
        id: 'q',
        kind: 'question',
        title: 'Questions',
        detail: '',
        questions: [
          { id: 'first', title: 'First?', options: ['a1', 'b1'] },
          { id: 'second', title: 'Second?', options: ['a2', 'b2'] },
        ],
      },
    ],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(600);
    ui.stdin.write(`1${ENTER}${DOWN}${ENTER}`);
    await until('the response', () => calls.length > 0);
    assert.deepEqual(calls, [
      [
        'respond',
        'q',
        { decision: 'accept', answers: { first: ['a1'], second: ['b2'] } },
      ],
    ]);
  } finally {
    ui.unmount();
  }
});

for (const [choice, keys, effort, outcome] of [
  ['Keep current effort', ENTER, undefined, 'without an effort'],
  ['a listed effort', `high${ENTER}`, 'high', 'with that effort'],
] as const)
  await test(`/model with ${choice} selects the model ${outcome}`, async () => {
    const { app, calls } = fake({
      models: [{ id: 'm', label: 'Model M', efforts: ['low', 'high'] }],
    });
    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
    try {
      await delay(60);
      ui.stdin.write('/model');
      await delay(30);
      ui.stdin.write(ENTER);
      await until('the model picker', () => ui.text().includes('Model M'));
      await delay(30);
      ui.stdin.write(ENTER);
      await until('the effort picker', () =>
        ui.text().includes('Keep current effort'),
      );
      await delay(30);
      ui.stdin.write(keys);
      await until('the selection', () => calls.length === 2);
      assert.deepEqual(calls, [
        ['refreshModels'],
        ['selectModel', 'm', effort],
      ]);
    } finally {
      ui.unmount();
    }
  });

await test('a model id carrying a link sequence shows as plain text in the effort picker title', async () => {
  const { app } = fake({
    models: [
      {
        id: forgedLink('x-evil:payload', 'm'),
        label: 'Model M',
        efforts: ['low', 'high'],
      },
    ],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write('/model');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the model picker', () => ui.text().includes('Model M'));
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the effort picker', () =>
      ui.text().includes('Reasoning for m'),
    );
    assert.ok(
      !ui.frame().includes('\u001b]8;;x-evil'),
      JSON.stringify(ui.frame()),
    );
  } finally {
    ui.unmount();
  }
});

for (const typed of ['gpt-5.1', 'gpt-6'])
  await test(`typing ${typed} in the model picker selects exactly it`, async () => {
    const { app, calls } = fake({
      models: ['gpt-5.1-codex', 'gpt-5.1'].map((id) => ({
        id,
        label: id,
        efforts: [],
      })),
    });
    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
    try {
      await delay(60);
      ui.stdin.write('/model');
      await delay(30);
      ui.stdin.write(ENTER);
      await until('the model picker', () =>
        ui.text().includes('gpt-5.1-codex'),
      );
      await delay(30);
      ui.stdin.write(`${typed}${ENTER}`);
      await until('the selection', () => calls.length === 2);
      assert.deepEqual(calls, [['refreshModels'], ['selectModel', typed]]);
    } finally {
      ui.unmount();
    }
  });

await test('a long picker shows as many choices as its rows hold', async () => {
  const { app } = fake({
    models: Array.from({ length: 40 }, (_, n) => ({
      id: `model-${n + 1}`,
      label: `model-${n + 1}`,
      efforts: [],
    })),
  });
  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    100,
    24,
  );
  try {
    await delay(60);
    ui.stdin.write('/model');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the model picker', () => ui.text().includes('Models ·'));
    const shown = ui
      .text()
      .split('\n')
      .filter((row) => row.trim().startsWith('model-'));
    // 24 rows less the header, status, title, filter, hint, the row every view leaves free and the status line's two
    assert.equal(shown.length, 16);
  } finally {
    ui.unmount();
  }
});

for (const [typed, call] of [
  ['/model m high', ['selectModel', 'm', 'high']],
  ['/agent b', ['switchAgent', 'b']],
  ['/new b', ['newConversation', 'b']],
] as const)
  await test(`${typed} passes its arguments`, async () => {
    const { app, calls } = fake({});
    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
    try {
      await delay(60);
      ui.stdin.write(typed);
      await delay(30);
      ui.stdin.write(ENTER);
      await until('the call', () => calls.length > 0);
      assert.deepEqual(calls, [call]);
    } finally {
      ui.unmount();
    }
  });

await test('the composer takes no typing while a switch shows the conversation it leaves, also after a second switch is refused, and takes it once the next one opens', async () => {
  const { coordinator, app, calls } = fake({});
  const switching = Promise.withResolvers<void>();
  coordinator.newConversation = async (...args: unknown[]) => {
    calls.push(['newConversation', ...args]);
    if (coordinator.snapshot.phase !== 'idle')
      throw new Error('Stop the current operation first');
    coordinator.publish({ phase: 'starting' });
    await switching.promise;
  };
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write('/new b');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the switch', () => calls.length > 0);
    await delay(60);
    ui.stdin.write('hello');
    await delay(60);
    assert.ok(!ui.text().includes('┃ hello'));
    await commands(ui);
    ui.stdin.write(`new${ENTER}`);
    await until('the refused switch', () =>
      calls.some(([call]) => call === 'report'),
    );
    await delay(60);
    ui.stdin.write('again');
    await delay(60);
    assert.ok(!ui.text().includes('┃ again'));
    coordinator.publish({
      conversation: { ...coordinator.snapshot.conversation!, id: 'c2' },
    });
    await delay(60);
    ui.stdin.write('there');
    await until('typing in the next conversation', () =>
      ui.text().includes('┃ there'),
    );
  } finally {
    switching.resolve();
    ui.unmount();
  }
});

await test('a prompt sent in the same read as a switch stays in the draft of the conversation it was typed in', async () => {
  const { coordinator, app, calls } = fake({});
  const switching = Promise.withResolvers<void>();
  coordinator.newConversation = async (...args: unknown[]) => {
    calls.push(['newConversation', ...args]);
    coordinator.publish({ phase: 'starting' });
    await switching.promise;
  };
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write(`/new b${ENTER}hello${ENTER}`);
    await until('the switch', () => calls.length > 0);
    await delay(60);
    assert.deepEqual(calls, [['newConversation', 'b']]);
    coordinator.publish({
      conversation: { ...coordinator.snapshot.conversation!, id: 'c2' },
      phase: 'idle',
    });
    switching.resolve();
    await until('the next conversation', () => !ui.text().includes('┃ hello'));
    coordinator.publish({
      conversation: { ...coordinator.snapshot.conversation!, id: 'c' },
    });
    await until('the kept draft', () => ui.text().includes('┃ hello'));
  } finally {
    switching.resolve();
    ui.unmount();
  }
});

await test('the composer takes typing again once a switch fails', async () => {
  const { coordinator, app, calls } = fake({});
  coordinator.newConversation = async (...args: unknown[]) => {
    calls.push(['newConversation', ...args]);
    throw new Error('Prompts are still queued for this conversation');
  };
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write('/new b');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the switch', () => calls.length > 0);
    await delay(60);
    ui.stdin.write('hello');
    await until('typing', () => ui.text().includes('┃ hello'));
  } finally {
    ui.unmount();
  }
});

/** opens the command picker and waits for it. */
async function commands(ui: ReturnType<typeof show>) {
  ui.stdin.write('\u0010');
  await until('the command picker', () => ui.text().includes('Commands'));
  await delay(30);
}

for (const [name, keys] of [
  ['Down and Enter', DOWN + ENTER],
  ['a filter and Enter', `sess${ENTER}`],
  ['a filter, Down past it and Enter', `sess${DOWN}${ENTER}`],
] as const)
  await test(`${name} in one read pick the selected command`, async () => {
    const { app, calls } = fake({});
    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
    try {
      await delay(60);
      await commands(ui);
      ui.stdin.write(keys);
      await until('the conversations picker', () =>
        ui.text().includes('Other · a'),
      );
      await delay(30);
      ui.stdin.write(ENTER);
      await until('the selection', () => calls.length > 0);
      assert.deepEqual(calls, [['selectConversation', 'c2']]);
    } finally {
      ui.unmount();
    }
  });

await test('a conversation picked in /sessions keeps the composer from typing until it opens', async () => {
  const { coordinator, app, calls } = fake({});
  const switching = Promise.withResolvers<void>();
  coordinator.selectConversation = async (...args: unknown[]) => {
    calls.push(['selectConversation', ...args]);
    coordinator.publish({ phase: 'starting' });
    await switching.promise;
  };
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    await commands(ui);
    ui.stdin.write(`sess${ENTER}`);
    await until('the conversations picker', () =>
      ui.text().includes('Other · a'),
    );
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the switch', () => calls.length > 0);
    await delay(60);
    ui.stdin.write('hello');
    await delay(60);
    assert.ok(!ui.text().includes('┃ hello'));
    coordinator.publish({
      conversation: { ...coordinator.snapshot.conversation!, id: 'c2' },
    });
    await delay(60);
    ui.stdin.write('there');
    await until('typing in the next conversation', () =>
      ui.text().includes('┃ there'),
    );
  } finally {
    switching.resolve();
    ui.unmount();
  }
});

await test('a filter resets the picker selection within the same read', async () => {
  const { app, calls } = fake({});
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    await commands(ui);
    ui.stdin.write(`${DOWN}conv${ENTER}`);
    await until('the new conversation', () =>
      calls.some(([call]) => call === 'newConversation'),
    );
  } finally {
    ui.unmount();
  }
});

await test('reopening the picker resets its selection', async () => {
  const { app, calls } = fake({});
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    await commands(ui);
    ui.stdin.write(DOWN);
    await delay(30);
    ui.stdin.write('\u001b');
    await until('the chat view', () => !ui.text().includes('Commands'));
    await commands(ui);
    ui.stdin.write(ENTER);
    await until('the new conversation', () =>
      calls.some(([call]) => call === 'newConversation'),
    );
  } finally {
    ui.unmount();
  }
});

await test('/jobs lists each job on one row with its CPU, age and command, also after the terminal narrows, and stops the chosen group, reporting a stop that fails', async () => {
  const { app, calls } = fake({});
  const jobs: Pick<JobWatch, 'list' | 'stop'> = {
    list: async () => [
      {
        group: 4242,
        generation: 7,
        command: `node --import tsx test/screen.test.ts ${'x'.repeat(200)}`,
        cpu: 99.6,
        startedAt: Date.now() - 72_000_000,
      },
      {
        group: 4343,
        generation: 9,
        command: 'sleep 600',
        cpu: 0,
        startedAt: Date.now(),
      },
    ],
    stop: async ({ group, generation }) => {
      calls.push(['stop', group, generation]);
      throw new Error(`Job ${group} has not stopped.`);
    },
  };
  const ui = show(
    createElement(App, { coordinator: app, jobs, onExit: () => {} }),
  );
  try {
    await delay(60);
    await commands(ui);
    ui.stdin.write(`jobs${ENTER}`);
    // the row is cut to the picker's 98 cells with an ellipsis, and the 61 cells before the command's x's leave room for 36
    await until('the jobs picker', () =>
      ui
        .text()
        .includes(
          `100% CPU · 1200M00S · node --import tsx test/screen.test.ts ${'x'.repeat(36)}…`,
        ),
    );
    ui.resize(40);
    // narrowing the terminal cuts it again, to the 38 cells left
    await until('the narrowed picker', () =>
      ui
        .text()
        .includes(
          'choose one to stop\n  100% CPU · 1200M00S · node --import …',
        ),
    );
    ui.stdin.write(DOWN);
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the report', () => calls.length > 1);
    assert.deepEqual(calls, [
      ['stop', 4343, 9],
      ['report', 'Error: Job 4343 has not stopped.'],
    ]);
    await until(
      'the chat view',
      () => !ui.text().includes('choose one to stop'),
    );
  } finally {
    ui.unmount();
  }
});

await test('/jobs without jobs or with none listed says none are running', async () => {
  for (const jobs of [
    undefined,
    { list: async () => [], stop: async () => {} },
  ]) {
    const { app } = fake({});
    const ui = show(
      createElement(App, { coordinator: app, jobs, onExit: () => {} }),
    );
    try {
      await delay(60);
      await commands(ui);
      ui.stdin.write(`jobs${ENTER}`);
      await until('the empty picker', () =>
        ui.text().includes('No jobs are running'),
      );
    } finally {
      ui.unmount();
    }
  }
});

await test('/jobs reports a list that fails', async () => {
  const { app, calls } = fake({});
  const jobs = {
    list: () => Promise.reject(new Error('ps failed')),
    stop: async () => {},
  };
  const ui = show(
    createElement(App, { coordinator: app, jobs, onExit: () => {} }),
  );
  try {
    await delay(60);
    await commands(ui);
    ui.stdin.write(`jobs${ENTER}`);
    await until('the report', () => calls.length > 0);
    assert.deepEqual(calls, [['report', 'Error: ps failed']]);
  } finally {
    ui.unmount();
  }
});

await test('Tab, Down and Enter in one read expand a tool instead of submitting the draft, and Enter collapses it', async () => {
  const { app, calls } = fake({ items: tools('first') });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write('hello');
    await delay(30);
    ui.stdin.write(`\t${DOWN}${ENTER}`);
    await until('the expanded tool', () =>
      ui.text().includes('first output 2'),
    );
    assert.ok(!ui.text().includes('first output 1'));
    const row = (text: string) =>
      ui
        .frame()
        .split('\n')
        .find((line) => line.includes(text)) ?? '';
    assert.ok(row('first tool 2').includes('\u001b[7m'));
    assert.ok(!row('first tool 1').includes('\u001b[7m'));
    ui.stdin.write(ENTER);
    await until(
      'the collapsed tool',
      () => !ui.text().includes('first output 2'),
    );
    assert.deepEqual(calls, []);
  } finally {
    ui.unmount();
  }
});

await test('Enter during a turn sends the draft and empties the composer', async () => {
  const { app, calls } = fake({ phase: 'running' });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write('hello');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the send', () => calls.length > 0);
    assert.deepEqual(calls, [['send', 'hello']]);
    await until('the empty composer', () =>
      ui.text().includes('┃ Ask the agent'),
    );
  } finally {
    ui.unmount();
  }
});

await test('queued prompts show above the activity row with a hint, and ↑ on the first line takes them back ahead of the draft, where ↑ on a later line moves the cursor', async () => {
  const { app, calls } = fake({
    phase: 'running',
    queue: ['one', 'two\nlines'],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await until('the queue', () => ui.text().includes('❯ two lines'));
    const lines = ui.text().split('\n');
    const activity = lines.findIndex((line) =>
      line.includes('ESC TO INTERRUPT'),
    );
    assert.deepEqual(
      lines.slice(activity - 2, activity).map((line) => line.trim()),
      ['❯ one', '❯ two lines'],
    );
    assert.ok(ui.text().includes('┃ Press ↑ to edit queued messages'));
    ui.stdin.write('first');
    ui.stdin.write(SHIFT_ENTER);
    ui.stdin.write('second');
    await until('the draft', () => ui.text().includes('┃ second'));
    ui.stdin.write(UP);
    await delay(60);
    assert.deepEqual(calls, []);
    ui.stdin.write(UP);
    await until('the queue taken back', () => !ui.text().includes('❯ one'));
    assert.deepEqual(calls, [['unqueue']]);
    const rows = ['┃ one', '┃ two', '┃ lines', '┃ first', '┃ second'].map(
      (row) => ui.text().indexOf(row),
    );
    assert.ok(
      rows.every((row, index) => row >= 0 && row > (rows[index - 1] ?? -1)),
      ui.text(),
    );
  } finally {
    ui.unmount();
  }
});

await test('a queue longer than the free rows shows its first prompts and keeps the composer in view', async () => {
  const { app } = fake({
    phase: 'running',
    queue: Array.from({ length: 60 }, (_, index) => `prompt ${index}`),
  });
  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    100,
    20,
  );
  try {
    await until('the queue', () => ui.text().includes('❯ prompt 0'));
    assert.ok(ui.text().includes('┃ Press ↑ to edit queued messages'));
    assert.ok(!ui.text().includes('❯ prompt 59'));
  } finally {
    ui.unmount();
  }
});

await test('↑ in an open list moves its selection and leaves the queue', async () => {
  const { app, calls } = fake({ phase: 'running', queue: ['one'] });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await until('the queue', () => ui.text().includes('❯ one'));
    ui.stdin.write('/');
    await delay(60);
    ui.stdin.write(UP);
    await delay(60);
    assert.deepEqual(calls, []);
    assert.ok(ui.text().includes('❯ one'));
  } finally {
    ui.unmount();
  }
});

await test('Tab and ↑ in one read move through tools and leave the queue', async () => {
  const { app, calls } = fake({
    phase: 'running',
    items: tools('first'),
    queue: ['one'],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await until('the queue', () => ui.text().includes('❯ one'));
    ui.stdin.write(`\t${UP}`);
    await until('the focused tools', () => ui.text().includes('TAB COMPOSE'));
    await delay(60);
    assert.deepEqual(calls, []);
    assert.ok(ui.text().includes('❯ one'));
  } finally {
    ui.unmount();
  }
});

await test('↑ with nothing queued and no earlier prompts leaves the draft as typed', async () => {
  const { app, calls } = fake({});
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write('abc');
    await delay(30);
    ui.stdin.write(UP);
    await delay(60);
    assert.deepEqual(calls, []);
    assert.ok(ui.text().includes('┃ abc'));
  } finally {
    ui.unmount();
  }
});

await test('↑ on the first line shows older prompts from this directory with the cursor at the end, and ↓ on the last line newer ones with the cursor at the start, back to the draft', async () => {
  const { app } = fake({});
  const { store } = prompts(['newer\nlines', 'older']);
  const ui = show(
    createElement(App, { coordinator: app, store, onExit: () => {} }),
  );
  try {
    await delay(60);
    ui.stdin.write('draft');
    await until('the draft', () => ui.text().includes('┃ draft'));
    ui.stdin.write(UP);
    await until('the newer prompt', () => ui.text().includes('┃ newer'));
    ui.stdin.write(UP);
    await delay(60);
    assert.ok(!ui.text().includes('┃ older'), ui.text());
    ui.stdin.write(UP);
    await until('the older prompt', () => ui.text().includes('┃ older'));
    ui.stdin.write(DOWN);
    await until('the newer prompt again', () => ui.text().includes('┃ newer'));
    ui.stdin.write(DOWN);
    await delay(60);
    assert.ok(!ui.text().includes('┃ draft'), ui.text());
    ui.stdin.write(DOWN);
    await until('the draft again', () => ui.text().includes('┃ draft'));
  } finally {
    ui.unmount();
  }
});

await test('an edit to a recalled prompt survives browsing and is sent and recorded, the recalled prompt stays as it was, and browsing then starts at the newest', async () => {
  const { app, calls } = fake({});
  const { store, added } = prompts(['first', 'second']);
  const ui = show(
    createElement(App, { coordinator: app, store, onExit: () => {} }),
  );
  try {
    await delay(60);
    ui.stdin.write(UP);
    await until('the first prompt', () => ui.text().includes('┃ first'));
    ui.stdin.write(' edited');
    await until('the edit', () => ui.text().includes('┃ first edited'));
    ui.stdin.write(UP);
    await until('the second prompt', () => ui.text().includes('┃ second'));
    ui.stdin.write(DOWN);
    await until('the edit kept', () => ui.text().includes('┃ first edited'));
    ui.stdin.write(ENTER);
    await until('the send', () => calls.length > 0);
    assert.deepEqual(calls, [['send', 'first edited']]);
    assert.deepEqual(added, [['/work', 'first edited']]);
    ui.stdin.write(UP);
    await until('the sent prompt', () => ui.text().includes('┃ first edited'));
    ui.stdin.write(UP);
    await until('the first prompt as it was', () =>
      /┃ first +┃/.test(ui.text()),
    );
  } finally {
    ui.unmount();
  }
});

await test('a prompt and a Witch command are recorded once each, and neither a blank send nor a repeat of the newest is', async () => {
  const { app, calls } = fake({});
  const { store, added } = prompts([]);
  const ui = show(
    createElement(App, { coordinator: app, store, onExit: () => {} }),
  );
  try {
    await delay(60);
    ui.stdin.write(ENTER);
    await delay(30);
    ui.stdin.write('hello');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the send', () => calls.some(([, text]) => text === 'hello'));
    ui.stdin.write(UP);
    await until('the recalled prompt', () => ui.text().includes('┃ hello'));
    ui.stdin.write(ENTER);
    await until(
      'the second send',
      () => calls.filter(([, text]) => text === 'hello').length === 2,
    );
    ui.stdin.write('/model gpt');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the model', () =>
      calls.some(([name]) => name === 'selectModel'),
    );
    assert.deepEqual(added, [
      ['/work', 'hello'],
      ['/work', '/model gpt'],
    ]);
  } finally {
    ui.unmount();
  }
});

await test('↑ takes queued prompts back before it shows earlier ones, and ↓ returns to them', async () => {
  const { app, calls } = fake({ phase: 'running', queue: ['queued'] });
  const { store } = prompts(['earlier']);
  const ui = show(
    createElement(App, { coordinator: app, store, onExit: () => {} }),
  );
  try {
    await until('the queue', () => ui.text().includes('❯ queued'));
    ui.stdin.write(UP);
    await until('the queue taken back', () => ui.text().includes('┃ queued'));
    assert.deepEqual(calls, [['unqueue']]);
    ui.stdin.write(UP);
    await until('the earlier prompt', () => ui.text().includes('┃ earlier'));
    ui.stdin.write(DOWN);
    await until('the queue again', () => ui.text().includes('┃ queued'));
  } finally {
    ui.unmount();
  }
});

await test('prompts that come back mid-browse end browsing and go ahead of the draft typed before it', async () => {
  const { app, coordinator } = fake({});
  const { store } = prompts(['one']);
  const ui = show(
    createElement(App, { coordinator: app, store, onExit: () => {} }),
  );
  try {
    await delay(60);
    ui.stdin.write('draft');
    await until('the draft', () => ui.text().includes('┃ draft'));
    ui.stdin.write(UP);
    await until('the recalled prompt', () => ui.text().includes('┃ one'));
    coordinator.publish({ queue: ['late'] });
    await until('the returned prompt', () => ui.text().includes('┃ late'));
    const [late, draft] = ['┃ late', '┃ draft'].map((row) =>
      ui.text().indexOf(row),
    );
    assert.ok(late! >= 0 && draft! > late!, ui.text());
    assert.ok(!ui.text().includes('┃ one'), ui.text());
    ui.stdin.write(DOWN);
    ui.stdin.write(DOWN);
    await delay(60);
    assert.ok(ui.text().includes('┃ late'), ui.text());
  } finally {
    ui.unmount();
  }
});

await test('an initial prompt sent mid-browse leaves the browsed prompt in place without a list, and comes back between it and the draft', async () => {
  const { app, coordinator, calls } = fake({ phase: 'starting' });
  const { store } = prompts(['/mo', 'older']);
  const ui = show(
    createElement(App, {
      coordinator: app,
      store,
      onExit: () => {},
      initialPrompt: 'say hello',
    }),
  );
  try {
    await delay(60);
    ui.stdin.write(UP);
    await until('the recalled command', () => ui.text().includes('┃ /mo'));
    coordinator.publish({ phase: 'idle' });
    await until('the initial prompt sent', () =>
      calls.some(([name]) => name === 'send'),
    );
    await delay(60);
    assert.ok(ui.text().includes('┃ /mo'), ui.text());
    assert.ok(!ui.text().includes('Choose model and reasoning'), ui.text());
    ui.stdin.write(UP);
    await until('the older prompt', () => ui.text().includes('┃ older'));
    ui.stdin.write(DOWN);
    await until('the command again', () => ui.text().includes('┃ /mo'));
    ui.stdin.write(DOWN);
    await until('the initial prompt', () => ui.text().includes('┃ say hello'));
    ui.stdin.write(DOWN);
    await until('the draft', () => ui.text().includes('┃ Ask the agent'));
  } finally {
    ui.unmount();
  }
});

await test('an initial prompt sent after browsing back to the draft is the first prompt ↑ shows', async () => {
  const { app, coordinator, calls } = fake({ phase: 'starting' });
  const { store } = prompts(['newest', 'older']);
  const ui = show(
    createElement(App, {
      coordinator: app,
      store,
      onExit: () => {},
      initialPrompt: 'say hello',
    }),
  );
  try {
    await delay(60);
    ui.stdin.write(UP);
    await until('the newest prompt', () => ui.text().includes('┃ newest'));
    ui.stdin.write(DOWN);
    await until('the draft', () => ui.text().includes('┃ Ask the agent'));
    coordinator.publish({ phase: 'idle' });
    await until('the initial prompt sent', () =>
      calls.some(([name]) => name === 'send'),
    );
    ui.stdin.write(UP);
    await until('the initial prompt', () => ui.text().includes('┃ say hello'));
    ui.stdin.write(UP);
    await until('the newest prompt again', () =>
      ui.text().includes('┃ newest'),
    );
    ui.stdin.write(UP);
    await until('the older prompt', () => ui.text().includes('┃ older'));
  } finally {
    ui.unmount();
  }
});

await test('a recalled prompt opens no completion list until it is edited, even with the cursor in its file token, so ↑ goes on to older prompts', async () => {
  const { app } = fake({}, ['src/a.ts']);
  const { store } = prompts(['@src/a.ts\nnext', '/mo', 'older']);
  const ui = show(
    createElement(App, { coordinator: app, store, onExit: () => {} }),
  );
  try {
    await delay(60);
    ui.stdin.write(UP);
    await until('the prompt naming a file', () => ui.text().includes('┃ next'));
    ui.stdin.write(UP);
    await delay(60);
    assert.doesNotMatch(ui.text(), /^ *@src\/a\.ts *$/m);
    ui.stdin.write(UP);
    await until('the command', () => ui.text().includes('┃ /mo'));
    assert.ok(!ui.text().includes('Choose model and reasoning'), ui.text());
    ui.stdin.write(UP);
    await until('the older prompt', () => ui.text().includes('┃ older'));
    ui.stdin.write(DOWN);
    await until('the command again', () => ui.text().includes('┃ /mo'));
    ui.stdin.write('\u001b[F');
    ui.stdin.write('d');
    await until('the list once edited', () =>
      ui.text().includes('Choose model and reasoning'),
    );
  } finally {
    ui.unmount();
  }
});

await test('a conversation switch starts browsing again at the newest prompt as recorded, and the conversation left gets back the draft typed before browsing', async () => {
  const { app, coordinator } = fake({});
  const { store } = prompts(['one', 'two']);
  const conversation = coordinator.snapshot.conversation!;
  const ui = show(
    createElement(App, { coordinator: app, store, onExit: () => {} }),
  );
  try {
    await delay(60);
    ui.stdin.write('draft');
    await until('the draft', () => ui.text().includes('┃ draft'));
    ui.stdin.write(UP);
    await until('the newest prompt', () => ui.text().includes('┃ one'));
    ui.stdin.write(' edited');
    await until('the edit', () => ui.text().includes('┃ one edited'));
    ui.stdin.write(UP);
    await until('the older prompt', () => ui.text().includes('┃ two'));
    coordinator.publish({ conversation: { ...conversation, id: 'c2' } });
    await until('the next conversation', () =>
      ui.text().includes('┃ Ask the agent'),
    );
    ui.stdin.write(DOWN);
    await delay(60);
    assert.ok(ui.text().includes('┃ Ask the agent'), ui.text());
    ui.stdin.write(UP);
    await until('the newest prompt as recorded', () =>
      /┃ one +┃/.test(ui.text()),
    );
    coordinator.publish({ conversation });
    await until('the draft back', () => ui.text().includes('┃ draft'));
  } finally {
    ui.unmount();
  }
});

await test('the header shows the stored model until the session reports one, and the status its permission mode', async () => {
  const { app, coordinator } = fake({
    conversation: {
      id: 'c',
      title: 't',
      cwd: '/work',
      agent: 'a',
      sessions: { a: { id: '', model: 'stored-model', hasHistory: false } },
      createdAt: '',
    },
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  const row = (index: number) => ui.text().split('\n')[index] ?? '';
  try {
    await until('the stored model', () => row(0).includes('STORED-MODEL'));
    coordinator.publish({
      native: {
        id: 's',
        agent: 'a',
        model: 'live-model',
        permissionMode: 'on-request',
        hasHistory: true,
      },
    });
    await until('the live model', () => row(0).includes('LIVE-MODEL'));
    assert.match(row(1), /^IDLE \| ON-REQUEST/);
  } finally {
    ui.unmount();
  }
});

await test('a project name, model and permission mode carrying a link sequence show as plain text in the header', async () => {
  const forged = (name: string) => forgedLink('x-evil:payload', name);
  const { app } = fake({
    conversation: {
      id: 'c',
      title: 't',
      cwd: `/work/${forged('project')}`,
      agent: 'a',
      sessions: {},
      createdAt: '',
    },
    native: {
      id: 's',
      agent: 'a',
      model: forged('model'),
      permissionMode: forged('mode'),
      hasHistory: true,
    },
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await until('the header', () => ui.text().includes('MODEL'));
    assert.match(ui.text(), /project\]8;;x-evil:payloadproject\]8;; \| A/);
    assert.ok(
      !ui.frame().includes('\u001b]8;;x-evil'),
      JSON.stringify(ui.frame()),
    );
  } finally {
    ui.unmount();
  }
});

await test('a conversation switch resets the tool selection within the next read', async () => {
  const { app, coordinator } = fake({ items: tools('first') });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write(`\t${DOWN}`);
    await delay(30);
    ui.stdin.write('\u001b');
    await delay(30);
    coordinator.publish({
      conversation: { ...coordinator.snapshot.conversation!, id: 'c2' },
      items: tools('second'),
    });
    await until('the new conversation', () =>
      ui.text().includes('second tool 1'),
    );
    ui.stdin.write(`\t${ENTER}`);
    await until('the expanded tool', () =>
      ui.text().includes('second output 1'),
    );
  } finally {
    ui.unmount();
  }
});

await test('two page keys in one read scroll two pages, PageDown back to the bottom follows output again, and PageUp scrolls a request back', async () => {
  const transcript = Array.from({ length: 300 }, (_, n) => `row ${n + 1}`).join(
    '\n',
  );
  const { app, coordinator } = fake({
    items: [{ id: 'long', kind: 'assistant', text: transcript, cwd: '/work' }],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  const rows = () =>
    ui
      .text()
      .split('\n')
      .map((row) => row.trim());
  try {
    await delay(60);
    ui.stdin.write('\u001b[5~\u001b[5~');
    // 302 lines in a 32-row transcript start at row 270; two pages up is 206
    await until('two pages up', () => rows()[2] === 'row 206');
    assert.ok(ui.text().includes('READING EARLIER OUTPUT'));
    ui.stdin.write('\u001b[6~\u001b[6~');
    await until(
      'live output',
      () => !ui.text().includes('READING EARLIER OUTPUT'),
    );
    coordinator.publish({
      phase: 'running',
      requests: [
        {
          ...approval,
          detail: Array.from({ length: 200 }, (_, n) => `d${n + 1}`).join('\n'),
        },
      ],
    });
    await delay(600);
    ui.stdin.write('\u001b[6~\u001b[6~');
    // the detail starts on line 4, and two 29-row pages down show line 59
    await until('two pages down', () => {
      const all = rows();
      return all[all.indexOf('Approval required') + 1] === 'd56';
    });
    ui.stdin.write('\u001b[5~');
    await until('a page up', () => {
      const all = rows();
      return all[all.indexOf('Approval required') + 1] === 'd27';
    });
  } finally {
    ui.unmount();
  }
});

const wheelUp = '\u001b[<64;10;10M';
const wheelDown = '\u001b[<65;10;10M';

await test('the wheel scrolls the transcript a row a step, and back at the bottom follows output again', async () => {
  const transcript = Array.from({ length: 300 }, (_, n) => `row ${n + 1}`).join(
    '\n',
  );
  const { app } = fake({
    items: [{ id: 'long', kind: 'assistant', text: transcript, cwd: '/work' }],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  const first = () => Number(/row (\d+)/.exec(ui.text())?.[1]);
  try {
    await until('the transcript', () => first() > 0);
    const bottom = first();
    ui.stdin.write(wheelUp.repeat(3));
    await until('three rows up', () => first() === bottom - 3);
    assert.ok(ui.text().includes('READING EARLIER OUTPUT'));
    ui.stdin.write(wheelDown.repeat(3));
    await until(
      'live output',
      () => !ui.text().includes('READING EARLIER OUTPUT'),
    );
    assert.equal(first(), bottom);
  } finally {
    ui.unmount();
  }
});

await test('the wheel scrolls a page and a request by rows', async () => {
  const { app, coordinator } = fake({});
  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    100,
    16,
  );
  try {
    await delay(60);
    ui.stdin.write('/help');
    await delay(30);
    ui.stdin.write('\r');
    await until('the help page', () => ui.text().includes('/new  New'));
    ui.stdin.write(wheelDown.repeat(2));
    await until(
      'two rows down',
      () => !ui.text().includes('/sessions') && ui.text().includes('/agent'),
    );
    ui.stdin.write(wheelUp);
    await until('a row up', () => ui.text().includes('/sessions'));
    assert.ok(!ui.text().includes('/new  New'));
    ui.stdin.write('\u001b');
    coordinator.publish({
      phase: 'running',
      requests: [
        {
          ...approval,
          detail: Array.from({ length: 200 }, (_, n) => `d${n + 1}`).join('\n'),
        },
      ],
    });
    await until('the request', () => ui.text().includes('d1\n'));
    // the detail starts on line 4, so five rows down show d3 first
    ui.stdin.write(wheelDown.repeat(5));
    await until('five rows down', () => {
      const rows = ui
        .text()
        .split('\n')
        .map((row) => row.trim());
      return rows[rows.indexOf('Approval required') + 1] === 'd3';
    });
  } finally {
    ui.unmount();
  }
});

const CMD_C = '\u001b[99;9u';
/** an SGR report of the left button at a zero-based cell: down, held moving there, or up. */
const left = (
  kind: 'press' | 'drag' | 'release',
  column: number,
  row: number,
) =>
  `\u001b[<${kind === 'drag' ? 32 : 0};${column + 1};${row + 1}${kind === 'release' ? 'm' : 'M'}`;

await test('a drag over the transcript highlights it and Cmd+C copies it with wrapped rows joined, a click or a resize clears it, and a drag from above the transcript, the composer or the sidebar selects nothing', async () => {
  const words =
    'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi';
  const { app } = fake({
    items: [{ id: 'u', kind: 'user', text: words, cwd: '/work' }],
  });
  const copied: string[] = [];
  const mount = (columns: number) =>
    show(
      createElement(App, {
        coordinator: app,
        onExit: () => {},
        copy: (text: string) => copied.push(text),
      }),
      columns,
      20,
    );
  const ui = mount(60);
  try {
    // the transcript starts at row 2 and column 1 under the phase row, the message wraps onto rows 3 and 4, and the composer's text is on row 15
    await until('the wrapped message', () => ui.text().includes(' omicron pi'));
    // each write renders before the next, so Cmd+C reads what the mouse left selected
    for (const data of [
      left('press', 1, 3) + left('release', 1, 3),
      left('press', 5, 1),
      left('drag', 5, 3),
      left('release', 5, 3),
      CMD_C,
      left('press', 5, 15),
      left('drag', 5, 3),
      left('release', 5, 3),
      CMD_C,
    ]) {
      ui.stdin.write(data);
      await delay(60);
    }
    assert.deepEqual(copied, []);
    ui.stdin.write(left('press', 1, 3));
    ui.stdin.write(left('drag', 58, 4));
    ui.stdin.write(left('release', 58, 4));
    await until('the highlight', () => ui.frame().includes('\u001b[7malpha'));
    ui.stdin.write(CMD_C);
    await until('the copy', () => copied.length > 0);
    assert.deepEqual(copied, [words]);
    ui.stdin.write(left('press', 1, 3) + left('release', 1, 3));
    await until('no highlight', () => !ui.frame().includes('\u001b[7m'));
    ui.stdin.write(CMD_C);
    await delay(60);
    assert.deepEqual(copied, [words]);
    ui.stdin.write(left('press', 1, 3));
    ui.stdin.write(left('drag', 58, 4));
    ui.stdin.write(left('release', 58, 4));
    await until('the highlight again', () =>
      ui.frame().includes('\u001b[7malpha'),
    );
    ui.resize(120);
    await until(
      'no highlight once resized',
      () => !ui.frame().includes('\u001b[7m'),
    );
    ui.stdin.write(left('press', 50, 3));
    await delay(60);
    ui.resize(60);
    await until('the narrow layout', () => ui.text().includes(' omicron pi'));
    for (const data of [left('drag', 5, 3), left('release', 5, 3), CMD_C]) {
      ui.stdin.write(data);
      await delay(60);
    }
    assert.ok(!ui.frame().includes('\u001b[7m'));
    assert.deepEqual(copied, [words]);
  } finally {
    ui.unmount();
  }
  // mounted at its width, so the first press runs on a handler measured at it
  const wide = mount(120);
  try {
    // the sidebar takes the 25 columns from 95, and the message fits on row 3
    await until('the message', () => wide.text().includes(' omicron pi'));
    for (const data of [
      left('press', 110, 3),
      left('drag', 5, 3),
      left('release', 5, 3),
      CMD_C,
    ]) {
      wide.stdin.write(data);
      await delay(60);
    }
    assert.deepEqual(copied, [words]);
    // the title row reads the same at both widths, so only the width drops a selection past its text
    wide.stdin.write(left('press', 1, 2));
    wide.stdin.write(left('drag', 90, 2));
    wide.stdin.write(left('release', 90, 2));
    await until('the highlight on the title', () =>
      wide.frame().includes('\u001b[7mYou'),
    );
    wide.resize(60);
    await until('the narrow layout', () =>
      wide.text().includes('\n lambda mu'),
    );
    assert.ok(!wide.frame().includes('\u001b[7m'));
  } finally {
    wide.unmount();
  }
});

await test('a drag past the transcript top or bottom scrolls it a row a move, and past the top selects the row it brings in', async () => {
  const transcript = Array.from({ length: 300 }, (_, n) => `row ${n + 1}`).join(
    '\n',
  );
  const { app } = fake({
    items: [{ id: 'long', kind: 'assistant', text: transcript, cwd: '/work' }],
  });
  const copied: string[] = [];
  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      copy: (text: string) => copied.push(text),
    }),
  );
  const first = () => Number(/row (\d+)/.exec(ui.text())?.[1]);
  try {
    await until('the transcript', () => first() > 0);
    const bottom = first();
    ui.stdin.write(left('press', 1, 2));
    ui.stdin.write(left('drag', 1, 0));
    await until('a row up', () => first() === bottom - 1);
    ui.stdin.write(left('drag', 1, 0));
    await until('two rows up', () => first() === bottom - 2);
    ui.stdin.write(left('release', 1, 0) + CMD_C);
    await until('the copy', () => copied.length > 0);
    assert.deepEqual(copied, [`row ${bottom - 2}\nrow ${bottom - 1}\nr`]);
    ui.stdin.write(left('press', 1, 2));
    ui.stdin.write(left('drag', 1, 39));
    await until('a row down', () => first() === bottom - 1);
  } finally {
    ui.unmount();
  }
});

await test('a drag inside the view leaves it where it is, on its first and last rows too', async () => {
  const transcript = Array.from({ length: 300 }, (_, n) => `row ${n + 1}`).join(
    '\n',
  );
  const { app } = fake({
    items: [{ id: 'long', kind: 'assistant', text: transcript, cwd: '/work' }],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  const first = () => Number(/row (\d+)/.exec(ui.text())?.[1]);
  try {
    await until('the transcript', () => first() > 0);
    const bottom = first();
    // scrolled up, so a drag could scroll either way
    ui.stdin.write(wheelUp + wheelUp);
    await until('two rows up', () => first() === bottom - 2);
    const last = ui
      .text()
      .split('\n')
      .findLastIndex((row) => /row \d+/.test(row));
    ui.stdin.write(left('press', 1, 5));
    ui.stdin.write(left('drag', 1, 8));
    ui.stdin.write(left('drag', 1, 2));
    await delay(60);
    assert.equal(first(), bottom - 2);
    ui.stdin.write(left('drag', 1, last));
    await delay(60);
    assert.equal(first(), bottom - 2);
  } finally {
    ui.unmount();
  }
});

await test('copying a wrapped tool title keeps the space its wrap trimmed', async () => {
  const title =
    'echo alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';
  const { app } = fake({
    items: [
      { id: 't', kind: 'tool', title, text: '', cwd: '/work', done: true },
    ],
  });
  const copied: string[] = [];
  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      copy: (text: string) => copied.push(text),
    }),
    60,
    20,
  );
  try {
    // the title starts at row 2 and wraps onto row 3
    await until('the wrapped title', () => ui.text().includes(' lambda'));
    ui.stdin.write(left('press', 1, 2));
    ui.stdin.write(left('drag', 58, 3));
    ui.stdin.write(left('release', 58, 3));
    await until('the highlight', () => ui.frame().includes('\u001b[7m'));
    ui.stdin.write(CMD_C);
    await until('the copy', () => copied.length > 0);
    assert.deepEqual(copied, [`+ ✓ ${title}`]);
  } finally {
    ui.unmount();
  }
});

await test('a wrapped title row the wrap changed beyond trimming joins the rows beside it with a space', async () => {
  // the wrap drops the space after the zero-width space, so the title's second row is not found in it
  const title = `${'a'.repeat(53)} \u00a0\u200b ${'b'.repeat(55)} tail`;
  const { app } = fake({
    items: [
      { id: 'u', kind: 'user', text: 'hello', cwd: '/work' },
      { id: 't', kind: 'tool', title, text: '', cwd: '/work', done: true },
    ],
  });
  const copied: string[] = [];
  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      copy: (text: string) => copied.push(text),
    }),
    60,
    20,
  );
  try {
    // the message is on row 3 and the title wraps from row 5 onto rows 6 and 7
    await until('the wrapped title', () => ui.text().includes('tail'));
    ui.stdin.write(left('press', 1, 3));
    ui.stdin.write(left('drag', 58, 7));
    ui.stdin.write(left('release', 58, 7));
    await until('the highlight', () => ui.frame().includes('\u001b[7mhello'));
    ui.stdin.write(CMD_C);
    await until('the copy', () => copied.length > 0);
    assert.deepEqual(copied, [
      `hello\n\n+ ✓ ${'a'.repeat(53)} ${'b'.repeat(55)} tail`,
    ]);
  } finally {
    ui.unmount();
  }
});

await test('a drag past the last transcript row or its right edge selects to the end without wrapping a row, and Cmd+C over blank cells copies nothing', async () => {
  const { app } = fake({
    items: [
      { id: 'u', kind: 'user', text: 'first message', cwd: '/work' },
      { id: 'a', kind: 'assistant', text: 'second reply', cwd: '/work' },
    ],
  });
  const copied: string[] = [];
  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      copy: (text: string) => copied.push(text),
    }),
    60,
    20,
  );
  const rows = () =>
    ui
      .text()
      .split('\n')
      .map((row) => row.trimEnd());
  try {
    // the messages take rows 2 to 7 and the transcript runs on to row 13, between columns 1 and 58
    await until('the reply', () => ui.text().includes('second reply'));
    const before = rows();
    ui.stdin.write(left('press', 1, 4));
    ui.stdin.write(left('drag', 30, 4));
    ui.stdin.write(left('release', 30, 4));
    await until('the blank highlight', () => ui.frame().includes('\u001b[7m'));
    ui.stdin.write(CMD_C);
    await delay(60);
    assert.deepEqual(copied, []);
    // ending above the reply, so a highlighted row that wrapped would push the reply down
    ui.stdin.write(left('press', 1, 3));
    ui.stdin.write(left('drag', 59, 5));
    ui.stdin.write(left('release', 59, 5));
    await until('the highlight', () => ui.frame().includes('\u001b[7mfirst'));
    assert.deepEqual(rows(), before);
    ui.stdin.write(left('press', 1, 3));
    ui.stdin.write(left('drag', 5, 12));
    ui.stdin.write(left('release', 5, 12));
    await until('the highlight to the end', () =>
      ui.frame().includes('\u001b[7msecond reply'),
    );
    ui.stdin.write(CMD_C);
    await until('the copy', () => copied.length > 0);
    assert.deepEqual(copied, ['first message\n\nAssistant\nsecond reply\n']);
  } finally {
    ui.unmount();
  }
});

await test('a selection that runs past the bottom of the view stays drawn as the wheel scrolls', async () => {
  const transcript = Array.from({ length: 300 }, (_, n) => `row ${n + 1}`).join(
    '\n',
  );
  const { app } = fake({
    items: [{ id: 'long', kind: 'assistant', text: transcript, cwd: '/work' }],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  const first = () => Number(/row (\d+)/.exec(ui.text())?.[1]);
  try {
    await until('the transcript', () => first() > 0);
    const bottom = first();
    const last = ui
      .text()
      .split('\n')
      .findLastIndex((row) => /row \d+/.test(row));
    // the view ends with the blank row under the last row of text
    ui.stdin.write(left('press', 1, 2));
    ui.stdin.write(left('drag', 5, last + 1));
    ui.stdin.write(left('release', 5, last + 1));
    await until('the highlight', () => ui.frame().includes('\u001b[7m'));
    ui.stdin.write(wheelUp);
    await until('a row up', () => first() === bottom - 1);
    assert.ok(ui.frame().includes(`\u001b[7mrow ${bottom}`));
  } finally {
    ui.unmount();
  }
});

await test('a selection follows its text as output above it grows, and drops for good when its tool collapses or its item leaves', async () => {
  const items = (first: string) => [
    { id: 'u', kind: 'user' as const, text: first, cwd: '/work' },
    {
      id: 'a',
      kind: 'assistant' as const,
      text: 'selected words',
      cwd: '/work',
    },
    {
      id: 't',
      kind: 'tool' as const,
      title: 'run',
      text: 'line one\nline two\nline three',
      cwd: '/work',
      done: true,
    },
  ];
  const { app, coordinator } = fake({ items: items('first') });
  const copied: string[] = [];
  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      copy: (text: string) => copied.push(text),
    }),
    60,
    20,
  );
  const select = async (
    from: number,
    to: number,
    row: number,
    shown: string,
  ) => {
    ui.stdin.write(left('press', from, row));
    ui.stdin.write(left('drag', to, row));
    ui.stdin.write(left('release', to, row));
    await until(`the highlight on ${shown}`, () =>
      ui.frame().includes(`\u001b[7m${shown}`),
    );
  };
  try {
    // the message's title is on row 2, the reply's text on row 6, and the expanded tool's output on rows 9 to 11
    await until('the reply', () => ui.text().includes('selected words'));
    await select(1, 8, 6, 'selected');
    coordinator.publish({ items: items('first\nsecond\nthird') });
    await until('the taller message', () => ui.text().includes('third'));
    assert.ok(ui.frame().includes('\u001b[7mselected'));
    ui.stdin.write(CMD_C);
    await until('the copy', () => copied.length > 0);
    assert.deepEqual(copied, ['selected']);
    coordinator.publish({ items: items('first') });
    ui.stdin.write(`\t${ENTER}`);
    await until('the expanded tool', () => ui.text().includes('line two'));
    await select(1, 8, 10, 'line two');
    ui.stdin.write(CMD_C);
    await until('the second copy', () => copied.length > 1);
    assert.deepEqual(copied.at(-1), 'line two');
    ui.stdin.write(ENTER);
    await until('the collapsed tool', () => !ui.text().includes('line two'));
    ui.stdin.write(CMD_C);
    await delay(60);
    assert.equal(copied.length, 2);
    ui.stdin.write(ENTER);
    await until('the tool expanded again', () =>
      ui.text().includes('line two'),
    );
    ui.stdin.write(CMD_C);
    await delay(60);
    assert.equal(copied.length, 2);
    // the new transcript starts with a title like the one selected, so only the item drops it
    await select(1, 3, 2, 'You');
    coordinator.publish({
      items: [{ id: 'b', kind: 'user', text: 'first', cwd: '/work' }],
    });
    await until('the new transcript', () => !ui.text().includes('run'));
    assert.ok(!ui.frame().includes('\u001b[7m'));
    ui.stdin.write(CMD_C);
    await delay(60);
    assert.equal(copied.length, 2);
  } finally {
    ui.unmount();
  }
});

await test('a selection drops when output arrives under one of its ends', async () => {
  const reply = (text: string) => ({
    items: [{ id: 'a', kind: 'assistant' as const, text, cwd: '/work' }],
  });
  const { app, coordinator } = fake(reply('alpha\nbeta'));
  const copied: string[] = [];
  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      copy: (text: string) => copied.push(text),
    }),
    60,
    20,
  );
  try {
    // the reply's lines are on rows 3 and 4, and the blank row under them is the next line's first
    await until('the reply', () => ui.text().includes('beta'));
    ui.stdin.write(left('press', 1, 3));
    ui.stdin.write(left('drag', 30, 5));
    ui.stdin.write(left('release', 30, 5));
    await until('the highlight', () => ui.frame().includes('\u001b[7malpha'));
    coordinator.publish(reply('alpha\nbeta\ngamma'));
    await until('the longer reply', () => ui.text().includes('gamma'));
    assert.ok(!ui.frame().includes('\u001b[7m'));
    ui.stdin.write(CMD_C);
    await delay(60);
    assert.deepEqual(copied, []);
  } finally {
    ui.unmount();
  }
});

await test('a drag into the left margin or above a transcript at its top reaches the edge cell or row, and a press under a short transcript selects nothing', async () => {
  const words =
    'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi';
  const { app } = fake({
    items: [{ id: 'u', kind: 'user', text: words, cwd: '/work' }],
  });
  const copied: string[] = [];
  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      copy: (text: string) => copied.push(text),
    }),
    60,
    20,
  );
  try {
    // the title is on row 2, the message wraps onto rows 3 and 4 from column 1, and the blank row under it is row 5
    await until('the wrapped message', () => ui.text().includes(' omicron pi'));
    ui.stdin.write(left('press', 5, 3));
    ui.stdin.write(left('drag', 0, 4));
    ui.stdin.write(left('release', 0, 4));
    await until('the highlight', () => ui.frame().includes('\u001b[7ma beta'));
    ui.stdin.write(CMD_C);
    await until('the copy', () => copied.length > 0);
    assert.deepEqual(copied, [
      'a beta gamma delta epsilon zeta eta theta iota kappa l',
    ]);
    ui.stdin.write(left('press', 5, 4));
    ui.stdin.write(left('drag', 8, 1));
    ui.stdin.write(left('release', 8, 1));
    await until('the highlight from the title', () =>
      ui.frame().includes('\u001b[7malpha'),
    );
    ui.stdin.write(CMD_C);
    await until('the second copy', () => copied.length > 1);
    assert.equal(
      copied[1],
      '\nalpha beta gamma delta epsilon zeta eta theta iota kappa lambd',
    );
    ui.stdin.write(left('press', 5, 9));
    ui.stdin.write(left('drag', 8, 3));
    ui.stdin.write(left('release', 8, 3));
    await delay(60);
    ui.stdin.write(CMD_C);
    await delay(60);
    assert.equal(copied.length, 2);
  } finally {
    ui.unmount();
  }
});

await test('a drag back along a row selects from the pointer to the press, one forward from mid-row draws from the press, and a typed c or Cmd+V copies nothing', async () => {
  const { app } = fake({
    items: [{ id: 'u', kind: 'user', text: 'alpha beta gamma', cwd: '/work' }],
  });
  const copied: string[] = [];
  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      copy: (text: string) => copied.push(text),
    }),
    60,
    20,
  );
  try {
    // the message is on row 3, from column 1
    await until('the message', () => ui.text().includes('alpha beta gamma'));
    ui.stdin.write(left('press', 11, 3));
    ui.stdin.write(left('drag', 1, 3));
    ui.stdin.write(left('release', 1, 3));
    await until('the highlight', () => ui.frame().includes('\u001b[7malpha'));
    // a typed c and Cmd+V leave the clipboard alone
    ui.stdin.write('c');
    ui.stdin.write('\u001b[118;9u');
    await delay(60);
    assert.deepEqual(copied, []);
    ui.stdin.write(CMD_C);
    await until('the copy', () => copied.length > 0);
    assert.deepEqual(copied, ['alpha beta']);
    ui.stdin.write(left('press', 7, 3));
    ui.stdin.write(left('drag', 10, 3));
    ui.stdin.write(left('release', 10, 3));
    await until('the highlight from the press', () =>
      ui.frame().includes('alpha \u001b[7mbeta\u001b[27m'),
    );
  } finally {
    ui.unmount();
  }
});

await test('a press or release anywhere ends a drag, so a drag report with no press of its own selects nothing', async () => {
  const { app } = fake({
    items: [{ id: 'u', kind: 'user', text: 'alpha beta gamma', cwd: '/work' }],
  });
  const copied: string[] = [];
  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      copy: (text: string) => copied.push(text),
    }),
    60,
    20,
  );
  try {
    // the message is on row 3, and the composer's text on row 15
    await until('the message', () => ui.text().includes('alpha beta gamma'));
    ui.stdin.write(left('press', 1, 3));
    ui.stdin.write(left('drag', 5, 3));
    await until('the highlight', () => ui.frame().includes('\u001b[7malpha'));
    ui.stdin.write('/help');
    await delay(30);
    ui.stdin.write('\r');
    await until('the help page', () => ui.text().includes('/new  New'));
    ui.stdin.write(left('release', 5, 3));
    ui.stdin.write('\u001b');
    await until('the transcript', () => ui.frame().includes('\u001b[7malpha'));
    // Ghostty keeps a Shift+press for itself but reports its motion once Shift lifts
    ui.stdin.write(left('drag', 16, 3));
    await delay(60);
    ui.stdin.write(CMD_C);
    await until('the copy', () => copied.length > 0);
    assert.deepEqual(copied, ['alpha']);
    ui.stdin.write(left('press', 1, 3));
    ui.stdin.write(left('drag', 5, 3));
    ui.stdin.write(left('press', 5, 15));
    ui.stdin.write(left('drag', 6, 15));
    ui.stdin.write(left('release', 6, 15));
    await delay(60);
    ui.stdin.write(CMD_C);
    await delay(60);
    assert.deepEqual(copied, ['alpha']);
  } finally {
    ui.unmount();
  }
});

await test('drag reports past the top in one read each scroll on from where the last one left the view', async () => {
  const transcript = Array.from({ length: 300 }, (_, n) => `row ${n + 1}`).join(
    '\n',
  );
  const { app } = fake({
    items: [{ id: 'long', kind: 'assistant', text: transcript, cwd: '/work' }],
  });
  const copied: string[] = [];
  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      copy: (text: string) => copied.push(text),
    }),
  );
  const first = () => Number(/row (\d+)/.exec(ui.text())?.[1]);
  try {
    await until('the transcript', () => first() > 0);
    const bottom = first();
    ui.stdin.write(left('press', 1, 2));
    ui.stdin.write(
      left('drag', 1, 0) + left('drag', 2, 0) + left('drag', 3, 0),
    );
    await until('three rows up', () => first() === bottom - 3);
    ui.stdin.write(left('release', 3, 0));
    await delay(60);
    ui.stdin.write(CMD_C);
    await until('the copy', () => copied.length > 0);
    assert.deepEqual(copied, [
      `w ${bottom - 3}\nrow ${bottom - 2}\nrow ${bottom - 1}\nr`,
    ]);
  } finally {
    ui.unmount();
  }
});

await test('Cmd+C copies nothing while a page covers the selection or from blank rows alone', async () => {
  const { app } = fake({
    items: [
      { id: 'u', kind: 'user', text: 'hello', cwd: '/work' },
      {
        id: 't',
        kind: 'tool',
        title: 'run',
        text: 'one\n',
        cwd: '/work',
        done: true,
      },
    ],
  });
  const copied: string[] = [];
  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      copy: (text: string) => copied.push(text),
    }),
    60,
    20,
  );
  try {
    // the message is on row 3, and the expanded tool's output on row 6 ends with a blank line on row 7 and the blank row under it
    await until('the message', () => ui.text().includes('hello'));
    ui.stdin.write(left('press', 1, 3));
    ui.stdin.write(left('drag', 5, 3));
    ui.stdin.write(left('release', 5, 3));
    await until('the highlight', () => ui.frame().includes('\u001b[7mhello'));
    ui.stdin.write('/help');
    await delay(30);
    ui.stdin.write('\r');
    await until('the help page', () => ui.text().includes('/new  New'));
    ui.stdin.write(CMD_C);
    await delay(60);
    assert.deepEqual(copied, []);
    ui.stdin.write('\u001b');
    await until('the transcript', () => ui.frame().includes('\u001b[7mhello'));
    ui.stdin.write(CMD_C);
    await until('the copy', () => copied.length > 0);
    assert.deepEqual(copied, ['hello']);
    ui.stdin.write(`\t${ENTER}`);
    await until('the expanded tool', () => ui.text().includes('one'));
    ui.stdin.write(left('press', 1, 7));
    ui.stdin.write(left('drag', 20, 8));
    ui.stdin.write(left('release', 20, 8));
    await until('the blank highlight', () =>
      ui.frame().includes('\u001b[7m        '),
    );
    ui.stdin.write(CMD_C);
    await delay(60);
    assert.deepEqual(copied, ['hello']);
  } finally {
    ui.unmount();
  }
});

await test('a click on a page leaves it open', async () => {
  const { app } = fake({});
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write('/help');
    await delay(30);
    ui.stdin.write('\r');
    await until('the help page', () => ui.text().includes('/new  New'));
    ui.stdin.write(left('press', 1, 3) + left('release', 1, 3));
    await delay(60);
    assert.ok(ui.text().includes('/new  New'));
  } finally {
    ui.unmount();
  }
});

await test('a click and a wheel step between keys leave the draft as typed', async () => {
  const { app } = fake({});
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write(`xq\u001b[<0;3;4M\u001b[<0;3;4m${wheelUp}zw`);
    await until('the draft', () => ui.text().includes('xqzw'));
  } finally {
    ui.unmount();
  }
});

await test('the pentacle shows only beside an 80-cell main column, turns while the agent works and returns to its rest angle when idle', async () => {
  const braille = (text: string) => text.match(/[⠁-⣿]/g)?.join('');
  // the working row's spinner is braille too, so only the sidebar's cells count
  const inSidebar = (text: string) =>
    braille(
      text
        .split('\n')
        .map((line) => line.slice(80))
        .join('\n'),
    );
  const narrow = show(
    createElement(App, { coordinator: fake({}).app, onExit: () => {} }),
    104,
  );
  try {
    await delay(60);
    assert.equal(braille(narrow.text()), undefined);
  } finally {
    narrow.unmount();
  }
  const { app, coordinator } = fake({});
  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    105,
  );
  try {
    await until('the pentacle', () => !!inSidebar(ui.text()));
    const rest = inSidebar(ui.text());
    coordinator.publish({ phase: 'running' });
    await until('a turn', () => inSidebar(ui.text()) !== rest);
    coordinator.publish({ phase: 'idle' });
    await until('the rest', () => inSidebar(ui.text()) === rest);
    await delay(200);
    assert.equal(inSidebar(ui.text()), rest);
  } finally {
    ui.unmount();
  }
});

/** the sidebar's text, right of its border and padding, row by row. */
const sidebarRows = (text: string) =>
  text.split('\n').map((line) => line.slice(82).trimEnd());

await test('the sidebar lists only running familiars, depth first under the familiar that started them, each with its time, tool count and latest tool call, one whose parent is not listed as a root, and no heading once none are running', async () => {
  const now = Date.now();
  const subagents: Snapshot['subagents'] = [
    {
      id: 'a',
      name: 'map code',
      kind: 'Explore',
      status: 'running',
      startedAt: now,
      rows: { start: 'row' },
      activity: 'Read  src/a.ts',
      tools: 2,
    },
    {
      id: 'b',
      name: 'fix bug',
      kind: '',
      status: 'failed',
      startedAt: 0,
      rows: { start: 'row' },
    },
    {
      id: 'c',
      parent: 'a',
      name: 'read tests',
      kind: '',
      status: 'running',
      startedAt: now,
      rows: { start: 'row' },
      activity: 'Bash  $ ls',
      tools: 1,
    },
    {
      id: 'd',
      parent: 'c',
      name: 'run ls',
      kind: '',
      status: 'stopped',
      startedAt: 0,
      rows: { start: 'row' },
    },
    {
      id: 'e',
      parent: 'b',
      name: 'orphan',
      kind: '',
      status: 'running',
      startedAt: now,
      rows: { start: 'row' },
    },
  ];
  const { app, coordinator } = fake({ subagents });
  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    105,
  );
  try {
    await until('the familiars', () => ui.text().includes('FAMILIARS'));
    const rows = sidebarRows(ui.text()).slice(0, 10);
    // a running familiar's time ticks, so its row is matched rather than compared
    assert.match(rows[2]!, /^ {2}\dS \| 2 TOOLS$/);
    assert.match(rows[5]!, /^ {4}\dS \| 1 TOOL$/);
    assert.match(rows[8]!, /^ {2}\dS \| 0 TOOLS$/);
    assert.deepEqual(rows, [
      'FAMILIARS',
      '● MAP CODE Explore',
      rows[2],
      '  Read src/a.ts',
      '  ● READ TESTS',
      rows[5],
      '    Bash $ ls',
      '● ORPHAN',
      rows[8],
      '',
    ]);
    coordinator.publish({
      subagents: subagents.map((subagent) => ({
        ...subagent,
        status: 'completed',
      })),
    });
    await until('no familiars', () => !ui.text().includes('FAMILIARS'));
  } finally {
    ui.unmount();
  }
});

await test("a running familiar's time ticks once a second, also when it starts after the sidebar shows", async () => {
  const { app, coordinator } = fake({});
  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    105,
  );
  const seconds = () =>
    Number(/^ {2}(\d+)S \|/.exec(sidebarRows(ui.text())[2] ?? '')?.[1]);
  try {
    await until('the pentacle', () => /[⠁-⣿]/.test(ui.text()));
    coordinator.publish({
      subagents: [
        {
          id: 'a',
          name: 'map code',
          kind: '',
          status: 'running',
          startedAt: Date.now() - 5000,
          rows: { start: 'row' },
        },
      ],
    });
    await until('the familiar', () => ui.text().includes('FAMILIARS'));
    const first = seconds();
    await until('a tick', () => seconds() > first);
  } finally {
    ui.unmount();
  }
});

await test('familiars that overflow the sidebar show the last whole familiars in tree order under a count of the rest, above the whole pentacle', async () => {
  const { app } = fake({
    // the newest, 6, started under the oldest, so tree order puts it second
    subagents: [1, 2, 3, 4, 5, 6].map((index) => ({
      id: `${index}`,
      parent: index === 6 ? '1' : undefined,
      name: `task ${index}`,
      kind: '',
      status: 'running' as const,
      startedAt: Date.now(),
      rows: { start: 'row' },
    })),
  });
  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    105,
    19,
  );
  try {
    await until('the familiars', () => ui.text().includes('FAMILIARS'));
    const rows = sidebarRows(ui.text());
    // eight rows above the pentacle: the heading, the count and two familiars of three rows each
    assert.deepEqual(
      [rows[0], rows[1], rows[2], rows[5]],
      ['FAMILIARS', '+4 MORE', '● TASK 4', '● TASK 5'],
    );
    assert.ok(
      rows.slice(8, 19).every((row) => /[⠁-⣿]/.test(row)),
      rows.join('\n'),
    );
  } finally {
    ui.unmount();
  }
});

await test("the status line shows the model's label, the effort the agent runs, its usage and the repository as it changes", async () => {
  const { app } = fake({
    native: {
      id: 's',
      agent: 'a',
      model: 'gpt-x-2026',
      permissionMode: 'default',
      hasHistory: true,
      nativeEffort: 'medium',
    },
    models: [{ id: 'gpt-x-2026', label: 'GPT-X', efforts: [] }],
    usage: { cost: 0.5, context: 30, lines: { added: 2, removed: 1 } },
    openedAt: Date.now(),
  });
  const listeners = new Set<() => void>();
  const repository = {
    snapshot: {
      branch: 'main',
      ahead: 1,
      behind: 0,
      staged: 0,
      modified: 0,
      conflicts: 0,
      untracked: 0,
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const ui = show(
    createElement(App, { coordinator: app, repository, onExit: () => {} }),
  );
  const status = () =>
    ui
      .text()
      .trimEnd()
      .split('\n')
      .slice(-2)
      .map((row) => row.trim());
  try {
    await until('the status line', () => status()[0]!.startsWith('GPT-X'));
    assert.deepEqual(status(), [
      'GPT-X | MEDIUM | $0.50 | 0M',
      'CTX 30% ███░░░░░░░ | work | main ↑1 | 2+/1-',
    ]);
    repository.snapshot = { ...repository.snapshot, branch: 'feat/y' };
    for (const listener of listeners) listener();
    await until('the new branch', () => status()[1]!.includes('feat/y ↑1'));
  } finally {
    ui.unmount();
  }
});

await test('while the agent works, a row above the composer names a verb and counts the seconds, and it leaves at idle', async () => {
  const { app, coordinator } = fake({ phase: 'running' });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  const row = () => {
    const lines = ui.text().split('\n');
    const composer = lines.findIndex((line) =>
      line.trimStart().startsWith('┏'),
    );
    return lines[composer - 1]?.trim() ?? '';
  };
  const activity =
    /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (CONJURING|SCRYING|BREWING|DIVINING|INCANTING|SUMMONING|HEXING|TRANSMUTING) \| (\d+)S \| ESC TO INTERRUPT$/;
  try {
    await until('the activity row', () => activity.exec(row())?.[2] === '0');
    await until('a second later', () => activity.exec(row())?.[2] === '1');
    coordinator.publish({ phase: 'idle' });
    await until('the row gone', () => !ui.text().includes('ESC TO INTERRUPT'));
  } finally {
    ui.unmount();
  }
});

await test('a typed /agent returns to live output', async () => {
  const transcript = Array.from({ length: 300 }, (_, n) => `row ${n + 1}`).join(
    '\n',
  );
  const { app, calls } = fake({
    items: [{ id: 'long', kind: 'assistant', text: transcript, cwd: '/work' }],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write('\u001b[5~');
    await until('earlier output', () =>
      ui.text().includes('READING EARLIER OUTPUT'),
    );
    ui.stdin.write('/agent b');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the switch', () => calls.length > 0);
    await until('live output', () => !ui.text().includes('READING EARLIER'));
    assert.deepEqual(calls, [['switchAgent', 'b']]);
  } finally {
    ui.unmount();
  }
});

await test('Down with tools focused and no tools keeps the reading position, and End returns to live output', async () => {
  const transcript = Array.from({ length: 300 }, (_, n) => `row ${n + 1}`).join(
    '\n',
  );
  const { app } = fake({
    items: [{ id: 'long', kind: 'assistant', text: transcript, cwd: '/work' }],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  const top = () => ui.text().split('\n')[2]?.trim();
  try {
    await delay(60);
    ui.stdin.write('\u001b[5~');
    await until('a page up', () => top() === 'row 238');
    ui.stdin.write(`\t${DOWN}`);
    await delay(60);
    assert.equal(top(), 'row 238');
    ui.stdin.write('\u001b[F');
    // the tools hint takes a transcript row
    await until('live output', () => top() === 'row 271');
  } finally {
    ui.unmount();
  }
});

await test('Escape while tools are focused during a turn leaves focus without interrupting', async () => {
  const { app, calls } = fake({ phase: 'running', items: tools('first') });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write('\t');
    await until('tool focus', () => ui.text().includes('ESC LEAVE TOOLS'));
    ui.stdin.write('\u001b');
    await until('the composer', () => !ui.text().includes('ESC LEAVE TOOLS'));
    assert.ok(!calls.some(([call]) => call === 'interrupt'));
  } finally {
    ui.unmount();
  }
});

await test('a new request ignores keys for its first 500 ms', async () => {
  const { app, coordinator, calls } = fake({
    phase: 'running',
    requests: [approval],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await until('the request', () => ui.text().includes('Approval required'));
    // a key in the instant the request appears beats even a 0 ms guard
    await delay(150);
    ui.stdin.write('y');
    await delay(100);
    assert.deepEqual(calls, []);
    await delay(500);
    ui.stdin.write('y');
    await until('the accept', () => calls.length > 0);
    coordinator.publish({
      requests: [{ ...approval, id: 'r2', title: 'rm -rf dist' }],
    });
    await until('the next request', () => ui.text().includes('rm -rf dist'));
    await delay(150);
    ui.stdin.write('y');
    await delay(100);
    assert.deepEqual(calls, [['respond', 'r1', { decision: 'accept' }]]);
  } finally {
    ui.unmount();
  }
  const question = fake({
    phase: 'running',
    requests: [
      {
        id: 'q',
        kind: 'question',
        title: 'Question',
        detail: '',
        questions: [{ id: 'one', title: 'Pick?', options: ['only'] }],
      },
    ],
  });
  const asked = show(
    createElement(App, { coordinator: question.app, onExit: () => {} }),
  );
  try {
    await until('the question', () => asked.text().includes('Pick?'));
    await delay(150);
    asked.stdin.write(ENTER);
    await delay(100);
    assert.deepEqual(question.calls, []);
  } finally {
    asked.unmount();
  }
});

await test('Escape declines a question and the turn continues', async () => {
  const { app, calls } = fake({
    phase: 'running',
    requests: [
      {
        id: 'q',
        kind: 'question',
        title: 'Question',
        detail: '',
        questions: [{ id: 'one', title: 'Pick?', options: ['only'] }],
      },
    ],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(600);
    ui.stdin.write('\u001b');
    await until('the decline', () => calls.length > 0);
    assert.deepEqual(calls, [['respond', 'q', { decision: 'decline' }]]);
  } finally {
    ui.unmount();
  }
});

// /ex runs from the list; a trailing space opens no list, so /quit resolves as an alias in submit
for (const typed of ['/ex', '/quit '])
  await test(`${typed.trim()} exits without sending a prompt`, async () => {
    const { app, calls } = fake({});
    let exits = 0;
    const ui = show(
      createElement(App, {
        coordinator: app,
        onExit: () => {
          exits++;
        },
      }),
    );
    try {
      await delay(60);
      ui.stdin.write(typed);
      await delay(30);
      ui.stdin.write('\r');
      await until('the exit', () => exits === 1);
      assert.deepEqual(calls, []);
    } finally {
      ui.unmount();
    }
  });

for (const [phase, outcome, exits, interrupts] of [
  ['idle', 'exits', 1, 0],
  ['running', 'interrupts', 0, 1],
] as const)
  await test(`Ctrl+C while ${phase} ${outcome}`, async () => {
    const { app, calls } = fake({ phase });
    let exited = 0;
    const ui = show(
      createElement(App, {
        coordinator: app,
        onExit: () => {
          exited++;
        },
      }),
    );
    try {
      await delay(60);
      ui.stdin.write('\u0003');
      await delay(60);
      assert.equal(exited, exits);
      assert.equal(
        calls.filter(([call]) => call === 'interrupt').length,
        interrupts,
      );
    } finally {
      ui.unmount();
    }
  });

await test('Ctrl+C while closing quits instead of interrupting again', async () => {
  const { app, coordinator, calls } = fake({});
  let exits = 0;
  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {
        exits++;
      },
    }),
  );
  try {
    await delay(60);
    coordinator.publish({ phase: 'closing' });
    await until('the closing frame', () => ui.text().includes('CLOSING'));
    ui.stdin.write('\u0003');
    await delay(60);
    assert.equal(exits, 1);
    assert.ok(!calls.some(([call]) => call === 'interrupt'));
  } finally {
    ui.unmount();
  }
});

const skills = [
  { name: 'x-one', description: 'First skill' },
  { name: 'x-two', description: 'Second skill' },
];

/** mounts while starting and then goes to `phase`, so App's key listener comes before the composer's as in the real app. */
async function launched(snapshot: Partial<Snapshot>, files?: string[]) {
  const context = fake({ ...snapshot, phase: 'starting' }, files);
  const ui = show(
    createElement(App, { coordinator: context.app, onExit: () => {} }),
  );
  await delay(60);
  context.coordinator.publish({ phase: snapshot.phase ?? 'idle' });
  await delay(60);
  return { ...context, ui };
}

await test('Down and Enter in one read run the second matching skill', async () => {
  const { ui, calls } = await launched({ skills });
  try {
    ui.stdin.write(`/x${DOWN}${ENTER}`);
    await until('the send', () => calls.length > 0);
    assert.deepEqual(calls, [['send', '/x-two']]);
  } finally {
    ui.unmount();
  }
});

await test('typing after Down in the same read resets the selection', async () => {
  const { ui, calls } = await launched({ skills });
  try {
    ui.stdin.write(`/${DOWN}x${ENTER}`);
    await until('the send', () => calls.length > 0);
    assert.deepEqual(calls, [['send', '/x-one']]);
  } finally {
    ui.unmount();
  }
});

await test('a slash command nothing matches is sent as typed', async () => {
  const { ui, calls } = await launched({ skills });
  try {
    ui.stdin.write(`/zzz${ENTER}`);
    await until('the send', () => calls.length > 0);
    assert.deepEqual(calls, [['send', '/zzz']]);
  } finally {
    ui.unmount();
  }
});

await test('Tab completes a skill and the arguments typed in the same read follow it', async () => {
  const { ui, calls } = await launched({ skills });
  try {
    ui.stdin.write(`/x-o${TAB}arg${ENTER}`);
    await until('the send', () => calls.length > 0);
    assert.deepEqual(calls, [['send', '/x-one arg']]);
  } finally {
    ui.unmount();
  }
});

await test('Escape closes the list during a turn, a new token reopens it, and Escape then interrupts', async () => {
  const { ui, calls } = await launched({ skills, phase: 'running' });
  const open = () => ui.text().includes('/x-one First skill');
  try {
    ui.stdin.write('/x');
    await until('the list', open);
    ui.stdin.write('\u001b');
    await until('the closed list', () => !open());
    ui.stdin.write('-');
    await until('the reopened list', open);
    // back on the dismissed token, the list stays open
    ui.stdin.write('\u007f');
    await until('the shorter token', () => ui.text().includes('┃ /x '));
    assert.ok(open());
    ui.stdin.write('\u001b');
    await until('the closed list', () => !open());
    assert.deepEqual(calls, []);
    ui.stdin.write('\u001b');
    await until('the interrupt', () => calls.length > 0);
    assert.deepEqual(calls, [['interrupt']]);
  } finally {
    ui.unmount();
  }
});

await test('Tab inserts a file into the middle of a draft', async () => {
  const { ui, calls } = await launched({}, ['src/app.ts', 'lib/x.ts']);
  try {
    ui.stdin.write(`see @sr now${LEFT.repeat(4)}`);
    await until('the file list', () => ui.text().includes('@src/app.ts'));
    ui.stdin.write(TAB);
    await until('the inserted path', () =>
      ui.text().includes('┃ see @src/app.ts now'),
    );
    assert.deepEqual(calls, []);
  } finally {
    ui.unmount();
  }
});

await test('Enter inserts a file without sending', async () => {
  const { ui, calls } = await launched({}, ['src/app.ts']);
  try {
    ui.stdin.write('see @sr');
    await until('the file list', () => ui.text().includes('@src/app.ts'));
    ui.stdin.write(ENTER);
    await until('the inserted path', () =>
      ui.text().includes('┃ see @src/app.ts'),
    );
    await delay(60);
    assert.deepEqual(calls, []);
  } finally {
    ui.unmount();
  }
});

await test('Up chooses in an open list without moving the cursor, and moves it once a space closes the list', async () => {
  const { ui } = await launched({}, ['src/app.ts', 'src/apx.ts']);
  try {
    ui.stdin.write('abc');
    await delay(30);
    ui.stdin.write(SHIFT_ENTER);
    await delay(30);
    ui.stdin.write('see @sr');
    await until('the file list', () => ui.text().includes('@src/apx.ts'));
    ui.stdin.write(DOWN);
    await delay(30);
    ui.stdin.write(UP);
    await delay(30);
    ui.stdin.write(TAB);
    await until('the first file at the token', () =>
      ui.text().includes('┃ see @src/app.ts'),
    );
    ui.stdin.write(` ${UP}Z`);
    await until('typing on the first line', () => ui.text().includes('┃ abcZ'));
  } finally {
    ui.unmount();
  }
});

await test('tool focus hides a remounted draft list, which shows once focus returns', async () => {
  const { ui, coordinator } = await launched({ skills });
  const conversation = coordinator.snapshot.conversation!;
  const open = (id: string) =>
    coordinator.publish({ conversation: { ...conversation, id } });
  try {
    open('d');
    await delay(60);
    ui.stdin.write('/x');
    await until('the list', () => ui.text().includes('/x-one'));
    open('c');
    await until('the empty draft', () => !ui.text().includes('/x-one'));
    ui.stdin.write(TAB);
    await until('tool focus', () => ui.text().includes('ESC LEAVE TOOLS'));
    open('d');
    await delay(100);
    assert.ok(!ui.text().includes('/x-one'));
    ui.stdin.write(TAB);
    await until('the list again', () => ui.text().includes('/x-one'));
  } finally {
    ui.unmount();
  }
});

await test('Ctrl+P over an open list gives the picker its keys', async () => {
  const { ui, calls } = await launched({ skills });
  try {
    ui.stdin.write('/x');
    await until('the list', () => ui.text().includes('/x-one'));
    await commands(ui);
    ui.stdin.write('\u001b');
    await until('the list again', () => ui.text().includes('/x-one'));
    await commands(ui);
    ui.stdin.write(`${DOWN}${ENTER}`);
    await until('the conversations picker', () =>
      ui.text().includes('Conversations'),
    );
    assert.deepEqual(calls, []);
  } finally {
    ui.unmount();
  }
});

await test('the composer grows with its text up to half the body and shrinks after a send', async () => {
  const { app, calls } = fake({});
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  const composerRows = () => {
    const lines = ui.text().split('\n');
    const top = lines.findIndex((line) => line.trimStart().startsWith('┏'));
    const bottom = lines.findIndex((line) => line.trimStart().startsWith('┗'));
    return bottom - top - 1;
  };
  try {
    await delay(60);
    assert.equal(composerRows(), 1);
    // 94 columns hold 200 characters and the cursor in 3 rows
    ui.stdin.write('x'.repeat(200));
    await until('a grown composer', () => composerRows() === 3);
    // 2200 would take 24 rows, and half of the 36-row body is 18
    ui.stdin.write('x'.repeat(2000));
    await until('a capped composer', () => composerRows() === 18);
    ui.stdin.write(ENTER);
    await until('the send', () => calls.length > 0);
    await until('an empty composer', () => composerRows() === 1);
  } finally {
    ui.unmount();
  }
});

await test('an open list of 8 or more keeps the newest transcript row and its own last row in view', async () => {
  const items = Array.from({ length: 60 }, (_, index) => ({
    id: `n${index}`,
    kind: 'notice' as const,
    text: `row ${index}`,
    cwd: '/work',
  }));
  const many = Array.from({ length: 10 }, (_, index) => ({
    name: `x-${index}`,
    description: `Skill ${index}`,
  }));
  const { ui } = await launched({ items, skills: many });
  try {
    ui.stdin.write('/x');
    await until('the list', () => ui.text().includes('/x-0'));
    const text = ui.text();
    assert.ok(text.includes('row 59'));
    assert.ok(text.includes('/x-7') && !text.includes('/x-8'));
    // above the row the body leaves free and the status line's two
    assert.match(text.trimEnd().split('\n').at(-4)!, /\/x-7 Skill 7$/);
  } finally {
    ui.unmount();
  }
});

await test('a skill named like a Witch command is left out, since the command runs instead', async () => {
  const { ui } = await launched({
    skills: [{ name: 'help', description: 'Native help' }],
  });
  try {
    ui.stdin.write('/he');
    await until('the list', () => ui.text().includes('/help Keyboard help'));
    assert.ok(!ui.text().includes('Native help'));
  } finally {
    ui.unmount();
  }
});

await test('list rows drop a link forged in a skill description or a file name', async () => {
  const forged = (text: string) => forgedLink('https://evil.example', text);
  const skill = await launched({
    skills: [{ name: 'x-evil', description: `see ${forged('docs')}` }],
  });
  const file = await launched({}, [`a${forged('b')}.txt`]);
  try {
    skill.ui.stdin.write('/x');
    await until('the skill list', () =>
      skill.ui.text().includes('/x-evil see docs'),
    );
    assert.ok(!skill.ui.frame().includes('\u001b]8;;https://evil.example'));
    file.ui.stdin.write('@a');
    await until('the file list', () => file.ui.text().includes('.txt'));
    assert.ok(!file.ui.frame().includes('\u001b]8;;https://evil.example'));
  } finally {
    skill.ui.unmount();
    file.ui.unmount();
  }
});
