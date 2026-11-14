import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import type { Snapshot } from '../../src/core/snapshot.js';
import { SidebarView } from '../fixtures/ui.js';
import { App } from '../../src/ui/App.js';
import { show, forgedLink, fake } from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';
import { unitFixture as coordinatorFixture } from '../fixtures/coordinator.js';
import { TurnGate } from '../fixtures/agent.js';
import { ENTER } from '../fixtures/ui.js';

test('the status line waits for a live model and uses its runtime label, and the phase row shows its permission mode', async () => {
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
    await until('the status line', () => /^ \? \|/m.test(ui.text()));

    coordinator.publish({
      models: [
        { agent: 'b', id: 'live-model', label: 'Wrong runtime', efforts: [] },
        { agent: 'a', id: 'live-model', label: 'Live label', efforts: [] },
      ],
    });

    coordinator.publish({
      native: {
        id: 's',
        agent: 'a',
        model: 'live-model',
        permissionMode: 'on-request',
        hasHistory: true,
      },
    });

    await until('the live label', () => /^ LIVE LABEL \|/m.test(ui.text()));

    assert.match(row(0), /^IDLE \| ON-REQUEST/);
  } finally {
    ui.unmount();
  }
});

test('the phase row of an idle session reads background while a brew runs and running while the native agent runs on its own', async () => {
  const { app, coordinator } = fake({});
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  const phase = () => ui.text().split('\n')[0] ?? '';

  try {
    await until('the idle row', () => /^IDLE\b/.test(phase()));

    coordinator.publish({
      backgroundCommands: [
        { id: 'serve', description: 'Serve', status: 'running' },
      ],
    });

    await until('the background row', () => /^BACKGROUND\b/.test(phase()));

    coordinator.publish({ nativeRunning: true });

    await until('the running row', () => /^RUNNING\b/.test(phase()));

    coordinator.publish({ nativeRunning: false, backgroundCommands: [] });

    await until('the idle row again', () => /^IDLE\b/.test(phase()));
  } finally {
    ui.unmount();
  }
});

test('a failed reconnect clears the displayed model and usage while preserving resume settings', async () => {
  const { coordinator, a, store } = await coordinatorFixture(undefined, (a) => {
    a.connectUsage = { context: 42 };
  });

  const ui = show(createElement(App, { coordinator, store, onExit: () => {} }));

  try {
    await coordinator.selectModel({ agent: 'a', id: 'a-big', effort: 'high' });

    await until(
      'the connected model and usage',
      () => /^ A-BIG \| HIGH/m.test(ui.text()) && ui.text().includes('CTX 42%'),
    );

    const saved = structuredClone(
      coordinator.snapshot.conversation!.sessions.a,
    );

    await a.sessions[0]!.session.close();

    a.failConnect = true;

    await coordinator.send('Reconnect');

    await until('the reconnect failure', () =>
      ui.text().includes('Destination unavailable'),
    );

    assert.equal(coordinator.snapshot.native, undefined);

    assert.deepEqual(coordinator.snapshot.usage, {});

    assert.doesNotMatch(ui.text(), /A-BIG|CTX 42%/);

    assert.deepEqual(coordinator.snapshot.conversation!.sessions.a, saved);

    a.failConnect = false;

    await coordinator.send('Resume');

    await until('the resumed model', () => /^ A-BIG \| HIGH/m.test(ui.text()));

    assert.equal(a.sessions.at(-1)!.options.resume, saved!.id);

    assert.equal(a.sessions.at(-1)!.options.model, 'a-big');

    assert.equal(a.sessions.at(-1)!.options.effort, 'high');
  } finally {
    ui.unmount();

    a.failConnect = false;

    await coordinator.close();
  }
});

test('a session that closes during reconnect discovery does not restore its displayed status', async () => {
  const { coordinator, a, store } = await coordinatorFixture(undefined, (a) => {
    a.connectUsage = { context: 42 };
  });

  const ui = show(createElement(App, { coordinator, store, onExit: () => {} }));
  let closedStatus: Pick<Snapshot, 'native' | 'usage'> | undefined;

  try {
    await until(
      'the connected status',
      () => /^ A-MODEL \|/m.test(ui.text()) && ui.text().includes('CTX 42%'),
    );

    await a.sessions[0]!.session.close();

    const connect = a.connect.bind(a);

    a.connect = async (options) => {
      const session = await connect(options);

      session.models = async () => {
        options.onEvent({ type: 'usage', usage: { context: 63 } });

        await session.close();

        options.onEvent({ type: 'closed' });

        closedStatus = {
          native: coordinator.snapshot.native,
          usage: coordinator.snapshot.usage,
        };

        throw new Error('Process exited during model/list');
      };

      return session;
    };

    await coordinator.send('Reconnect');

    await until('the closed session status', () =>
      ui.text().includes('Process exited during model/list'),
    );

    assert.deepEqual(closedStatus, { native: undefined, usage: {} });

    assert.equal(a.sessions.at(-1)!.session.closed, true);

    assert.equal(coordinator.snapshot.native, undefined);

    assert.deepEqual(coordinator.snapshot.usage, {});

    assert.doesNotMatch(ui.text(), /A-MODEL|CTX (42|63)%/);
  } finally {
    ui.unmount();

    await coordinator.close();
  }
});

test('a project name, model and permission mode carrying a link sequence show as plain text', async () => {
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
    await until('the status line', () => ui.text().includes('MODEL'));

    assert.match(ui.text(), / \| project\]8;;x-evil:payloadproject\]8;; \|/);

    assert.ok(
      !ui.frame().includes('\u001b]8;;x-evil'),
      JSON.stringify(ui.frame()),
    );
  } finally {
    ui.unmount();
  }
});

test('the pentacle follows independent activity across sidebar visibility changes and returns to rest', async () => {
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
    114,
  );

  try {
    await delay(60);

    assert.equal(braille(narrow.text()), undefined);
  } finally {
    narrow.unmount();
  }

  const { app, coordinator } = fake({});
  const source = Symbol('ui activity');

  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    115,
  );

  try {
    await until('the pentacle', () => !!inSidebar(ui.text()));

    const rest = inSidebar(ui.text());

    coordinator.pentacle.set(source, true);

    await until('a turn', () => inSidebar(ui.text()) !== rest);

    assert.equal(coordinator.snapshot.phase, 'idle');

    coordinator.pentacle.set(source, false);

    await until('the rest', () => inSidebar(ui.text()) === rest);

    await delay(200);

    assert.equal(inSidebar(ui.text()), rest);

    coordinator.pentacle.set(source, true);

    await until('another turn', () => inSidebar(ui.text()) !== rest);

    ui.resize(114);

    await until('the hidden sidebar', () => !braille(ui.text()));

    coordinator.pentacle.set(source, false);

    ui.resize(115);

    await until('the restored rest', () => inSidebar(ui.text()) === rest);

    await delay(200);

    assert.equal(inSidebar(ui.text()), rest);

    ui.resize(114);

    await until('the hidden sidebar again', () => !braille(ui.text()));

    coordinator.pentacle.set(source, true);

    ui.resize(115);

    await until(
      'activity started while hidden',
      () => !!inSidebar(ui.text()) && inSidebar(ui.text()) !== rest,
    );
  } finally {
    coordinator.pentacle.set(source, false);

    ui.unmount();
  }
});

/** the sidebar's text, right of its border and padding, row by row. */
const sidebarRows = (text: string) =>
  text.split('\n').map((line) => line.slice(82).trimEnd());

for (const height of [20, 19, 15])
  test(`mixed familiar identity rows fit whole entries at height ${height}`, async () => {
    const { app } = fake({
      subagents: [
        {
          id: 'astra',
          name: 'astra review',
          kind: '',
          runtime: 'codex',
          model: 'gpt-6-astra',
          status: 'running',
          startedAt: Date.now(),
          rows: { start: 'a' },
          tools: 3,
          activity: 'Read plan',
        },
        {
          id: 'claude',
          name: 'opus review',
          kind: '',
          runtime: 'claude',
          model: 'claude-opus-5-5',
          status: 'running',
          startedAt: Date.now(),
          rows: { start: 'b' },
          tools: 2,
          activity: 'Read source',
        },
      ],
    });

    const ui = show(
      createElement(SidebarView, { coordinator: app, height }),
      115,
      height,
    );

    try {
      await until('mixed familiars', () => ui.text().includes('FAMILIARS'));

      const rows = sidebarRows(ui.text());

      if (height === 20)
        assert.deepEqual(
          [rows[0], rows[1], rows[2], rows[5], rows[6], rows[8]],
          [
            'FAMILIARS',
            '● astra review',
            '  codex · gpt-6-astra',
            '● opus review',
            '  claude · claude-opus-5-5',
            '  Read source',
          ],
        );
      else if (height === 19)
        assert.deepEqual(
          [rows[0], rows[1], rows[2], rows[3], rows[5]],
          [
            'FAMILIARS',
            '+1 MORE',
            '● opus review',
            '  claude · claude-opus-5-5',
            '  Read source',
          ],
        );
      else assert.deepEqual(rows.slice(0, 4), ['FAMILIARS', '+2 MORE', '', '']);

      assert.equal(
        rows.slice(-11).filter((row) => /[⠁-⣿]/.test(row)).length,
        11,
      );
    } finally {
      ui.unmount();
    }
  });

for (const height of [21, 20, 16])
  test(`nested model wrapping preserves complete entries at height ${height}`, async () => {
    const subagents: Snapshot['subagents'] = [
      {
        id: 'codex',
        name: 'inspect source',
        kind: '',
        runtime: 'codex',
        model: 'gpt-6-astra',
        status: 'running',
        startedAt: Date.now(),
        rows: { start: 'a' },
        tools: 2,
        activity: 'Read source',
      },
      {
        id: 'claude',
        parent: 'codex',
        name: 'inspect tests',
        kind: '',
        runtime: 'claude',
        model: 'claude-haiku-4-5-20251001',
        status: 'running',
        startedAt: Date.now(),
        rows: { start: 'b' },
        tools: 3,
        activity: 'Read tests',
      },
    ];

    const { app, coordinator } = fake({ subagents });

    const ui = show(
      createElement(SidebarView, { coordinator: app, height }),
      115,
      height,
    );

    try {
      await until('nested identity', () => ui.text().includes('FAMILIARS'));

      const rows = sidebarRows(ui.text());

      if (height === 16) {
        assert.deepEqual(rows.slice(0, 2), ['FAMILIARS', '+2 MORE']);

        assert.equal(
          rows.some((row) => row.includes('●')),
          false,
        );
      } else {
        const index = rows.indexOf('  ● inspect tests');

        assert.ok(index > 0);

        assert.deepEqual(rows.slice(index + 1, index + 3), [
          '    claude ·',
          '    claude-haiku-4-5-20251001',
        ]);

        assert.match(rows[index + 3]!, /^ {4}\d+S \| 3 TOOLS$/);

        assert.equal(rows[index + 4], '    Read tests');

        assert.equal(rows.includes('● inspect source'), height === 21);

        if (height === 20) {
          assert.equal(rows[1], '+1 MORE');

          coordinator.publish({
            subagents: subagents.map((subagent) =>
              subagent.id === 'claude'
                ? { ...subagent, model: 'claude-opus-5-5' }
                : subagent,
            ),
          });

          await until('shorter identity', () =>
            ui.text().includes('claude-opus-5-5'),
          );

          const updated = sidebarRows(ui.text());

          assert.equal(updated.includes('+1 MORE'), false);

          assert.ok(updated.includes('● inspect source'));

          assert.equal(updated.filter((row) => row.includes('●')).length, 2);
        }
      }

      assert.equal(
        rows.slice(-11).filter((row) => /[⠁-⣿]/.test(row)).length,
        11,
      );
    } finally {
      ui.unmount();
    }
  });

test('a long task name does not consume the observed model row and late model identity replaces it', async () => {
  const subagent = {
    id: 'reported',
    name: 'a review task with a name longer than its available row',
    kind: '',
    runtime: 'claude',
    status: 'running' as const,
    startedAt: Date.now(),
    rows: { start: 'a' },
  };

  const { app, coordinator } = fake({ subagents: [subagent] });

  const ui = show(
    createElement(SidebarView, { coordinator: app, height: 20 }),
    115,
    20,
  );

  try {
    await until('runtime', () => sidebarRows(ui.text()).includes('  claude'));

    coordinator.publish({
      subagents: [{ ...subagent, model: 'claude-opus-5-5' }],
    });

    await until('model', () =>
      sidebarRows(ui.text()).includes('  claude · claude-opus-5-5'),
    );

    assert.equal(
      sidebarRows(ui.text()).filter((row) => row.includes('●')).length,
      1,
    );
  } finally {
    ui.unmount();
  }
});

test('the sidebar lists only running familiars, depth first under the familiar that started them, each with its time, tool count and latest tool call, one whose parent is not listed as a root, and no heading once none are running', async () => {
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
    115,
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
      '● map code Explore',
      rows[2],
      '  Read src/a.ts',
      '  ● read tests',
      rows[5],
      '    Bash $ ls',
      '● orphan',
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

test("a familiar's name and kind with line breaks stay on its sidebar row", async () => {
  const { app } = fake({
    subagents: [
      {
        id: 'a',
        name: 'map\nall',
        kind: 'Explore\nfast',
        status: 'running',
        startedAt: Date.now(),
        rows: { start: 'row' },
      },
    ],
  });

  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    115,
  );

  try {
    await until('the familiars', () => ui.text().includes('FAMILIARS'));

    assert.ok(
      sidebarRows(ui.text()).some((row) =>
        row.includes('map all Explore fast'),
      ),
      ui.text(),
    );
  } finally {
    ui.unmount();
  }
});

test("a running familiar's time ticks once a second, also when it starts after the sidebar shows", async () => {
  const { app, coordinator } = fake({});

  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    115,
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

test('a terminal too narrow for the sidebar counts running familiars and brews in the phase row', async () => {
  const familiar = (id: string, status: 'running' | 'completed') => ({
    id,
    name: `task ${id}`,
    kind: '',
    status,
    startedAt: Date.now(),
    rows: { start: `row ${id}` },
  });

  const brew = (id: string) => ({
    id,
    description: `brew ${id}`,
    status: 'running' as const,
  });

  for (const columns of [90, 140]) {
    const { app } = fake({
      subagents: [familiar('1', 'running'), familiar('2', 'completed')],
      backgroundCommands: [brew('a'), brew('b')],
    });

    const ui = show(
      createElement(App, { coordinator: app, onExit: () => {} }),
      columns,
      24,
    );

    try {
      await until('the phase row', () => ui.text().includes('BACKGROUND'));

      // the sidebar shares the first row at 140 columns
      const phase = ui.text().split('\n')[0]!.split('┃')[0]!;

      if (columns === 90)
        assert.match(phase, /BACKGROUND \| 1 FAMILIAR \| 2 BREWS/);
      else assert.doesNotMatch(phase, /FAMILIAR|BREW/);
    } finally {
      ui.unmount();
    }
  }
});

test('familiars that overflow the sidebar show the last whole familiars in tree order under a count of the rest, above the whole pentacle', async () => {
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
    createElement(SidebarView, { coordinator: app, height: 19 }),
    115,
    19,
  );

  try {
    await until('the familiars', () => ui.text().includes('FAMILIARS'));

    const rows = sidebarRows(ui.text());

    // eight rows above the pentacle: the heading, the count and two familiars of three rows each
    assert.deepEqual(
      [rows[0], rows[1], rows[2], rows[5]],
      ['FAMILIARS', '+4 MORE', '● task 4', '● task 5'],
    );

    assert.ok(
      rows.slice(8, 19).every((row) => /[⠁-⣿]/.test(row)),
      rows.join('\n'),
    );
  } finally {
    ui.unmount();
  }
});

const familiar = (id: string, name: string): Snapshot['subagents'][number] => ({
  id,
  name,
  kind: '',
  status: 'running',
  startedAt: Date.now(),
  rows: { start: 'row' },
});

const brew = (index: number): Snapshot['backgroundCommands'][number] => ({
  id: `${index}`,
  description: `brew ${index}`,
  status: 'running',
});

test('the sidebar lists running brews above the familiars, each with what it is for on one row, and no heading once none run', async () => {
  const { app, coordinator } = fake({
    backgroundCommands: [
      {
        id: 's',
        description: 'start\nthe documentation development server',
        status: 'running',
      },
    ],
    subagents: [familiar('a', 'map code')],
  });

  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    115,
  );

  try {
    await until('the brews', () => ui.text().includes('BREWS'));

    // a description that wrapped would push FAMILIARS down
    assert.deepEqual(sidebarRows(ui.text()).slice(0, 4), [
      'BREWS',
      '● start the documentation devel…',
      'FAMILIARS',
      '● map code',
    ]);

    coordinator.publish({ backgroundCommands: [] });

    await until('no brews', () => !ui.text().includes('BREWS'));
  } finally {
    ui.unmount();
  }
});

test('brews take the sidebar rows first and show their last whole brews under a count when they overflow, leave a running familiar its heading and count, and familiars take the rows they leave', async () => {
  const { app, coordinator } = fake({
    backgroundCommands: [1, 2, 3, 4, 5, 6, 7, 8].map(brew),
  });

  const ui = show(
    createElement(SidebarView, { coordinator: app, height: 19 }),
    115,
    19,
  );

  // eight rows above the pentacle
  const above = () => {
    const rows = sidebarRows(ui.text());

    assert.ok(
      rows.slice(8, 19).every((row) => /[⠁-⣿]/.test(row)),
      rows.join('\n'),
    );

    return rows.slice(0, 8);
  };

  try {
    await until('the brews', () => ui.text().includes('BREWS'));

    assert.deepEqual(above(), [
      'BREWS',
      '+2 MORE',
      '● brew 3',
      '● brew 4',
      '● brew 5',
      '● brew 6',
      '● brew 7',
      '● brew 8',
    ]);

    coordinator.publish({ subagents: [familiar('1', 'task 1')] });

    await until('the familiars', () => ui.text().includes('FAMILIARS'));

    assert.deepEqual(above(), [
      'BREWS',
      '+4 MORE',
      '● brew 5',
      '● brew 6',
      '● brew 7',
      '● brew 8',
      'FAMILIARS',
      '+1 MORE',
    ]);

    coordinator.publish({
      backgroundCommands: [1, 2].map(brew),
      subagents: [familiar('1', 'task 1'), familiar('2', 'task 2')],
    });

    await until('the second familiar', () => ui.text().includes('● task 2'));

    const rows = above();

    assert.match(rows[6]!, /^ {2}\dS \| 0 TOOLS$/);

    assert.deepEqual(rows, [
      'BREWS',
      '● brew 1',
      '● brew 2',
      'FAMILIARS',
      '+1 MORE',
      '● task 2',
      rows[6],
      '',
    ]);
  } finally {
    ui.unmount();
  }
});

test("the status line shows the model's label, the effort the agent runs, its usage and the repository as it changes", async () => {
  const { app } = fake({
    native: {
      id: 's',
      agent: 'a',
      model: 'gpt-x-2026',
      permissionMode: 'default',
      hasHistory: true,
      nativeEffort: 'medium',
    },
    models: [
      { agent: 'b', id: 'gpt-x-2026', label: 'Wrong runtime', efforts: [] },
      { agent: 'a', id: 'gpt-x-2026', label: 'GPT-X', efforts: [] },
    ],
    usage: {
      context: 30,
      contextWindow: 1000000,
      lines: { added: 2, removed: 1 },
    },
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
      'GPT-X | MEDIUM | 0M',
      'CTX 30% (1M) ███░░░░░░░ | work | main ↑1 | 2+/1-',
    ]);

    repository.snapshot = { ...repository.snapshot, branch: 'feat/y' };

    for (const listener of listeners) listener();

    await until('the new branch', () => status()[1]!.includes('feat/y ↑1'));
  } finally {
    ui.unmount();
  }
});

test('while the agent works, activity sits below a separator against the composer, counts seconds, and leaves at idle', async () => {
  const { app, coordinator } = fake({ phase: 'running' });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  const row = (above = 1) => {
    const lines = ui.text().split('\n');

    const composer = lines.findIndex((line) =>
      line.trimStart().startsWith('┏'),
    );

    return lines[composer - above]?.trim() ?? '';
  };

  const activity =
    /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (CONJURING|SCRYING|BREWING|DIVINING|INCANTING|SUMMONING|HEXING|TRANSMUTING) \| (\d+)S \| ESC TO INTERRUPT$/;

  try {
    await until('the activity row', () => activity.exec(row())?.[2] === '0');

    assert.equal(row(2), '');

    await until('a second later', () => activity.exec(row())?.[2] === '1');

    coordinator.publish({ phase: 'idle' });

    await until('the row gone', () => !ui.text().includes('ESC TO INTERRUPT'));
  } finally {
    ui.unmount();
  }
});

for (const [key, label] of [
  ['\u001b', 'Escape'],
  ['\u0003', 'Ctrl+C'],
] as const) {
  test(`compacting stays visible without a sidebar and ${label} restores queued input for editing`, async () => {
    const f = await coordinatorFixture();

    await f.coordinator.send('existing transcript');

    const gate = new TurnGate();
    f.a.gate = gate;
    let exited = false;

    const ui = show(
      createElement(App, {
        coordinator: f.coordinator,
        onExit: () => {
          exited = true;
        },
      }),
      80,
      30,
    );

    try {
      await delay(60);

      ui.stdin.write('/compact');

      await delay(30);

      ui.stdin.write(ENTER);

      await until('compacting phase', () => ui.text().startsWith('COMPACTING'));

      assert.ok(ui.text().includes('existing transcript'));

      ui.resize(130);

      await until(
        'compacting after resize',
        () => ui.text().startsWith('COMPACTING') && ui.text().includes('┃'),
      );

      ui.stdin.write('distinct queued input' + ENTER);

      await until(
        'queued prompt',
        () => f.coordinator.snapshot.queue.length === 1,
      );

      ui.stdin.write(key);

      await until(
        'editable input',
        () =>
          f.coordinator.snapshot.phase === 'idle' &&
          f.coordinator.snapshot.queue.length === 0 &&
          ui.text().includes('distinct queued input'),
      );

      assert.equal(exited, false);

      assert.equal(f.a.inputs.length, 1);

      f.a.gate = undefined;

      ui.stdin.write(ENTER);

      await until(
        'explicit resubmission',
        () =>
          f.a.inputs.length === 2 && f.coordinator.snapshot.phase === 'idle',
      );

      assert.match(f.a.inputs[1]!.prompt, /^distinct queued input$/);
    } finally {
      ui.unmount();

      gate.open();

      await f.coordinator.close();
    }
  });
}

test("the sidebar lists every runtime's usage under the pentacle, and the status line leaves it out", async () => {
  const now = Date.now();

  const { app } = fake({
    accounts: {
      a: {
        limits: [
          {
            window: '5H',
            percent: 20,
            resetsAt: now / 1000 + 2 * 3600 + 18 * 60 + 30,
            observedAt: now,
          },
        ],
      },
    },
  });

  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    115,
    40,
  );

  try {
    await until('the usage block', () =>
      sidebarRows(ui.text()).includes('USAGE'),
    );

    const rows = sidebarRows(ui.text());

    assert.deepEqual(rows.slice(rows.indexOf('USAGE')).filter(Boolean), [
      'USAGE',
      'A       5H 20% 2h18m',
      'B       ?',
    ]);

    assert.ok(/[⠁-⣿]/.test(rows[rows.indexOf('USAGE') - 1]!));

    const statusRow = ui
      .text()
      .split('\n')
      .find((line) => line.startsWith(' ? | '))!;

    assert.doesNotMatch(statusRow.slice(0, 80), /5H/);
  } finally {
    ui.unmount();
  }
});

test('a terminal too short for the usage block leaves usage to the status line', async () => {
  const now = Date.now();

  const window = (name: string, percent: number) => ({
    window: name,
    percent,
    observedAt: now,
  });

  const { app } = fake({
    accounts: {
      a: { limits: [window('5H', 20), window('7D', 75)] },
      b: {
        limits: [
          window('5H', 12),
          window('7D', 40),
          ...Array.from({ length: 10 }, (_, index) =>
            window(`model ${index}`, index),
          ),
        ],
      },
    },
  });

  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    115,
    24,
  );

  try {
    await until('the status line', () => ui.text().includes('B 5H 12% 7D 40%'));

    assert.ok(!sidebarRows(ui.text()).includes('USAGE'));

    assert.match(ui.text(), /0M \| 5H 20% 7D 75% \| B 5H 12% 7D 40%/);
  } finally {
    ui.unmount();
  }
});

test('a usage window turns dim with its age once it stops being current, without a new reading', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

  const now = Date.now();

  const { app } = fake({
    accounts: {
      a: {
        limits: [
          { window: '7D', percent: 40, observedAt: now - 10 * 60_000 + 2000 },
        ],
      },
    },
  });

  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    115,
    40,
  );

  try {
    await until('the usage block', () =>
      sidebarRows(ui.text()).includes('A       7D 40%'),
    );

    vi.advanceTimersByTime(5000);

    await until('the stale window', () =>
      sidebarRows(ui.text()).includes('A       7D 40%  10M OLD'),
    );
  } finally {
    ui.unmount();
  }
});
