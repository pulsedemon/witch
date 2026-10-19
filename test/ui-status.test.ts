import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import type { Snapshot } from '../src/core/coordinator.js';
import { App } from '../src/ui/app.js';
import { show, forgedLink, fake } from './fixtures/ui.js';
import { until } from './fixtures/within.js';

await test('the status line shows the stored model until the session reports one, and the phase row its permission mode', async () => {
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
    await until('the stored model', () => /^ STORED-MODEL \|/m.test(ui.text()));
    coordinator.publish({
      native: {
        id: 's',
        agent: 'a',
        model: 'live-model',
        permissionMode: 'on-request',
        hasHistory: true,
      },
    });
    await until('the live model', () => /^ LIVE-MODEL \|/m.test(ui.text()));
    assert.match(row(0), /^IDLE \| ON-REQUEST/);
  } finally {
    ui.unmount();
  }
});

await test('a project name, model and permission mode carrying a link sequence show as plain text', async () => {
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
    114,
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
    115,
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

await test("a familiar's name and kind with line breaks stay on its sidebar row", async () => {
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
        row.includes('MAP ALL Explore fast'),
      ),
      ui.text(),
    );
  } finally {
    ui.unmount();
  }
});

await test("a running familiar's time ticks once a second, also when it starts after the sidebar shows", async () => {
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
    115,
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

await test('the sidebar lists running brews above the familiars, each with what it is for on one row, and no heading once none run', async () => {
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
      '● START THE DOCUMENTATION DEVEL…',
      'FAMILIARS',
      '● MAP CODE',
    ]);
    coordinator.publish({ backgroundCommands: [] });
    await until('no brews', () => !ui.text().includes('BREWS'));
  } finally {
    ui.unmount();
  }
});

await test('brews take the sidebar rows first and show their last whole brews under a count when they overflow, leave a running familiar its heading and count, and familiars take the rows they leave', async () => {
  const { app, coordinator } = fake({
    backgroundCommands: [1, 2, 3, 4, 5, 6, 7, 8].map(brew),
  });
  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
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
      '● BREW 3',
      '● BREW 4',
      '● BREW 5',
      '● BREW 6',
      '● BREW 7',
      '● BREW 8',
    ]);

    coordinator.publish({ subagents: [familiar('1', 'task 1')] });
    await until('the familiars', () => ui.text().includes('FAMILIARS'));
    assert.deepEqual(above(), [
      'BREWS',
      '+4 MORE',
      '● BREW 5',
      '● BREW 6',
      '● BREW 7',
      '● BREW 8',
      'FAMILIARS',
      '+1 MORE',
    ]);

    coordinator.publish({
      backgroundCommands: [1, 2].map(brew),
      subagents: [familiar('1', 'task 1'), familiar('2', 'task 2')],
    });
    await until('the second familiar', () => ui.text().includes('● TASK 2'));
    const rows = above();
    assert.match(rows[6]!, /^ {2}\dS \| 0 TOOLS$/);
    assert.deepEqual(rows, [
      'BREWS',
      '● BREW 1',
      '● BREW 2',
      'FAMILIARS',
      '+1 MORE',
      '● TASK 2',
      rows[6],
      '',
    ]);
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
