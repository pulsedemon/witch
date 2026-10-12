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
      requests: [],
      models: [],
      skills: [],
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
    send: async (text: string) => {
      calls.push(['send', text]);
      return true;
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
    conversations: async () => [],
    projectFiles: async () => files,
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
    // uninstalled, so opening the conversation builds no worktree
    [{ adapter: new FixtureAgent('a') }],
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
    // only the launch's connect report, no error from reading memory
    assert.match(coordinator.snapshot.error ?? '', /^a is not installed\./);
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

await test('a note page scrolls one full page at a time and stops at its last row', async () => {
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
    ui.stdin.write('/memory');
    await delay(30);
    ui.stdin.write('\r');
    await until('the memory picker', () => ui.text().includes('long.md'));
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

for (const [name, update] of [
  [
    'recovery',
    {
      phase: 'recovery',
      recovery: { kind: 'pending', paths: [], diff: 'x', root: '/m' },
    },
  ],
  [
    'a launch report',
    { phase: 'idle', error: 'These conversations need attention.' },
  ],
  [
    'a failed open',
    { phase: 'error', error: 'Open failed.', conversation: undefined },
  ],
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
      coordinator.publish(update as Partial<Snapshot>);
      if (update.phase === 'recovery') {
        await delay(60);
        coordinator.publish({ phase: 'idle', recovery: undefined });
      }
      await until('the seeded composer', () =>
        ui.text().includes('│ say hello'),
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

await test('a prompt the agent never got comes back into an empty composer and leaves a new draft alone', async () => {
  for (const retyped of [false, true]) {
    const { app, coordinator, calls } = fake({});
    const delivery = Promise.withResolvers<boolean>();
    Object.assign(coordinator, {
      send: (text: string) => {
        calls.push(['send', text]);
        return delivery.promise;
      },
    });
    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
    try {
      await delay(60);
      ui.stdin.write('hello');
      await delay(30);
      ui.stdin.write('\r');
      await until('the send', () => calls.length === 1);
      if (retyped) {
        await delay(30);
        ui.stdin.write('newer');
        await until('the new draft', () => ui.text().includes('│ newer'));
      }
      delivery.resolve(false);
      await delay(60);
      if (retyped) {
        assert.ok(ui.text().includes('│ newer'));
        assert.ok(!ui.text().includes('│ hello'));
      } else
        await until('the restored prompt', () => ui.text().includes('│ hello'));
    } finally {
      ui.unmount();
    }
  }
});

const ENTER = '\u001b[13u';
const SHIFT_ENTER = '\u001b[13;2u';
const DOWN = '\u001b[B';
const UP = '\u001b[A';
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

await test('Down and Enter in one read decline an approval', async () => {
  const { app, calls } = fake({ phase: 'running', requests: [approval] });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(600);
    ui.stdin.write(DOWN + ENTER);
    await until('the response', () => calls.length > 0);
    assert.deepEqual(calls, [['respond', 'r1', { decision: 'decline' }]]);
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
    ui.stdin.write(`1${ENTER}2${ENTER}`);
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

await test('/model with Keep current effort selects the model without an effort', async () => {
  const { app, calls } = fake({
    models: [
      { id: 'm', label: 'Model M', description: '', efforts: ['low', 'high'] },
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
      ui.text().includes('Keep current effort'),
    );
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the selection', () => calls.length === 2);
    assert.deepEqual(calls, [
      ['refreshModels'],
      ['selectModel', 'm', undefined],
    ]);
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
        description: '',
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
      description: '',
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
    // 24 rows less the header, status, title, filter, hint, footer and the row every view leaves free
    assert.equal(shown.length, 17);
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
        ui.text().includes('Conversations'),
      );
      assert.ok(!calls.some(([call]) => call === 'newConversation'));
    } finally {
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

await test('Tab, Down and Enter in one read expand a tool instead of submitting the draft', async () => {
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
    assert.deepEqual(calls, []);
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

await test('two page keys in one read scroll two pages', async () => {
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
    // 302 lines in a 30-row transcript start at row 272; two pages up is 212
    await until('two pages up', () => rows()[2] === 'row 212');
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
    // the detail starts on line 4, and two 30-row pages down show line 61
    await until('two pages down', () => {
      const all = rows();
      return all[all.indexOf('Approval required') + 1] === 'd58';
    });
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
      ui.text().includes('Reading earlier output'),
    );
    ui.stdin.write('/agent b');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the switch', () => calls.length > 0);
    await until('live output', () => !ui.text().includes('Reading earlier'));
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
    await until('a page up', () => top() === 'row 242');
    ui.stdin.write(`\t${DOWN}`);
    await delay(60);
    assert.equal(top(), 'row 242');
    ui.stdin.write('\u001b[F');
    await until('live output', () => top() === 'row 272');
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
    await until('tool focus', () => ui.text().includes('Esc leave tools'));
    ui.stdin.write('\u001b');
    await until('the composer', () => ui.text().includes('Esc interrupt'));
    assert.ok(!calls.some(([call]) => call === 'interrupt'));
  } finally {
    ui.unmount();
  }
});

await test('a new request ignores keys for its first 500 ms', async () => {
  const { app, calls } = fake({ phase: 'running', requests: [approval] });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await until('the request', () => ui.text().includes('Approval required'));
    ui.stdin.write('y');
    await delay(100);
    assert.deepEqual(calls, []);
    await delay(500);
    ui.stdin.write('y');
    await until('the accept', () => calls.length > 0);
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
    await until('the closing frame', () => ui.text().includes('closing'));
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
  const footer = () => ui.text().trimEnd().split('\n').at(-1) ?? '';
  try {
    ui.stdin.write('/x');
    await until('the list', () => footer().includes('Esc close list'));
    ui.stdin.write('\u001b');
    await until('the closed list', () => footer().includes('Esc interrupt'));
    ui.stdin.write('-');
    await until('the reopened list', () => footer().includes('Esc close list'));
    // back on the dismissed token, the list stays open
    ui.stdin.write('\u007f');
    await until('the shorter token', () => ui.text().includes('│ /x '));
    assert.match(footer(), /Esc close list/);
    ui.stdin.write('\u001b');
    await until('the closed list', () => footer().includes('Esc interrupt'));
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
    ui.stdin.write('see @sr');
    await until('the file list', () => ui.text().includes('@src/app.ts'));
    ui.stdin.write(TAB);
    await until('the inserted path', () =>
      ui.text().includes('│ see @src/app.ts'),
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
      ui.text().includes('│ see @src/app.ts'),
    );
    await delay(60);
    assert.deepEqual(calls, []);
  } finally {
    ui.unmount();
  }
});

await test('Up chooses in an open list without moving the cursor, and moves it once a space closes the list', async () => {
  const { ui } = await launched({}, ['src/app.ts']);
  try {
    ui.stdin.write('abc');
    await delay(30);
    ui.stdin.write(SHIFT_ENTER);
    await delay(30);
    ui.stdin.write('see @sr');
    await until('the file list', () => ui.text().includes('@src/app.ts'));
    ui.stdin.write(UP);
    await delay(30);
    ui.stdin.write('c');
    await until('typing at the token', () => ui.text().includes('│ see @src'));
    assert.ok(!ui.text().includes('abcc'));
    ui.stdin.write(` ${UP}Z`);
    await until('typing on the first line', () => ui.text().includes('│ abcZ'));
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
    await until('tool focus', () => ui.text().includes('Esc leave tools'));
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

await test('an open list of 8 or more keeps the newest transcript row and the footer in view', async () => {
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
    assert.match(text.trimEnd(), /Esc close list$/);
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
  const forged = (text: string) =>
    `\u001b]8;;https://evil.example\u0007${text}\u001b]8;;\u0007`;
  const skill = await launched({
    skills: [{ name: 'x-evil', description: `see ${forged('docs')}` }],
  });
  const file = await launched({}, [`a${forged('b')}.txt`]);
  try {
    skill.ui.stdin.write('/x');
    await until('the skill list', () =>
      skill.ui.text().includes('/x-evil see docs'),
    );
    assert.ok(!skill.ui.frame().includes('evil.example'));
    file.ui.stdin.write('@a');
    await until('the file list', () => file.ui.text().includes('@ab.txt'));
    assert.ok(!file.ui.frame().includes('evil.example'));
  } finally {
    skill.ui.unmount();
    file.ui.unmount();
  }
});
