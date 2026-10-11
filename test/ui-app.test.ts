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
    send: async (text: string) => {
      calls.push(['send', text]);
      return true;
    },
    interrupt: record('interrupt'),
    respond: record('respond'),
    recoverMemory: record('recoverMemory'),
    newConversation: record('newConversation'),
    selectConversation: record('selectConversation'),
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
const DOWN = '\u001b[B';
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
    ui.stdin.write('/help');
    await delay(30);
    ui.stdin.write(`\t${DOWN}${ENTER}`);
    await until('the expanded tool', () =>
      ui.text().includes('first output 2'),
    );
    assert.ok(!ui.text().includes('first output 1'));
    assert.ok(!ui.text().includes('Keyboard help'));
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

await test('/exit quits without sending a prompt', async () => {
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
    ui.stdin.write('/exit');
    await delay(30);
    ui.stdin.write('\r');
    await until('the exit', () => exits === 1);
    assert.deepEqual(calls, []);
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
