import assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';

import {
  access,
  mkdir,
  readFile,
  rm,
  writeFile,
  unlink,
} from 'node:fs/promises';

import { join } from 'node:path';

import { setTimeout as delay } from 'node:timers/promises';

import { test } from 'vitest';

import { createElement } from 'react';

import { render } from 'ink-testing-library';

import stripAnsi from 'strip-ansi';

import { CodexAdapter } from '../src/agents/codex.js';

import { Coordinator } from '../src/core/coordinator.js';

import { StateStore } from '../src/persistence/store.js';

import { App } from '../src/ui/app.js';

import { FixtureAgent } from './fixtures/agent.js';

import { hookedGit, passThrough } from './fixtures/git.js';

import { scratch } from './fixtures/scratch.js';

import { seededMemory } from './fixtures/seeded-memory.js';

import { show, forgedLink, fake, ENTER, openCommand } from './fixtures/ui.js';

import { until } from './fixtures/within.js';

/** a stored conversation whose memory worktree is ready for notes, before it opens. */
async function conversation() {
  const root = await scratch('witch-ui-memory-');

  const cwd = join(root, 'project');

  await mkdir(cwd);

  const store = await StateStore.open(join(root, 'state'));

  const memory = await seededMemory(join(root, 'state', 'memory.git'));

  const coordinator = new Coordinator(store, memory, [
    { adapter: new CodexAdapter() },
  ]);

  await coordinator.initialize(cwd);

  const id = randomUUID();

  const files = await store.create({
    id,
    title: 'Notes',
    cwd,
    agent: 'codex',
    sessions: {},
    createdAt: new Date().toISOString(),
  });

  const workspace = memory.workspace(files.directory, id);

  await workspace.ensureWorktree();

  const scope = await workspace.scope(cwd);

  return { coordinator, id, files, workspace, scope };
}

test('a deleted note remains discoverable and can be restored through its history picker', async () => {
  const { coordinator, id, files, workspace, scope } = await conversation();

  const reference = join(workspace.root, scope.project, 'decisions.md');

  await writeFile(reference, 'Accepted project decision.');

  await workspace.commit('save reference');

  const originalRevision = await workspace.revision();

  await unlink(reference);

  await workspace.commit('delete reference');

  await files.close();

  // the conversation opens even though its agent can't connect
  await assert.rejects(
    coordinator.selectConversation(id),
    /Codex is not installed/,
  );

  const ui = render(createElement(App, { coordinator, onExit: () => {} }));

  try {
    await delay(40);

    ui.stdin.write('/memory');

    await delay(30);

    ui.stdin.write('\r');

    await until(
      'the deleted note',
      () => !!ui.lastFrame()?.includes('(deleted)'),
    );

    assert.match(stripAnsi(ui.lastFrame()!), /decisions.md \(deleted\)/);

    assert.ok(ui.lastFrame()!.includes(`vscode://file${reference}`));

    await delay(30);

    ui.stdin.write('decisions.md');

    await delay(30);

    ui.stdin.write('\r');

    await until(
      'the restore prompt',
      () => !!ui.lastFrame()?.includes('Restore a memory version'),
    );

    assert.ok(!ui.lastFrame()!.includes('delete reference'));

    await delay(30);

    ui.stdin.write('\r');

    await until(
      'the restored note',
      async () =>
        coordinator.snapshot.phase === 'idle' &&
        (await readFile(reference, 'utf8').catch(() => '')) ===
          'Accepted project decision.',
    );

    assert.notEqual(await workspace.revision(), originalRevision);

    assert.equal(await workspace.isDirty(), false);
  } finally {
    ui.unmount();

    await coordinator.close();
  }
});

test('the conflict view resolves with k and d, ignores a and Option+K, and links notes into the worktree', async () => {
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

    assert.match(ui.text(), /Commit that could not be published:/);

    assert.match(ui.text(), /\+mine in global\/one\.md/);

    assert.match(ui.text(), /Keep mine merges your current changes/);

    assert.ok(
      ui
        .frame()
        .includes('vscode://file/state/conversations/c/memory/global/one.md'),
    );

    assert.ok(!ui.frame().includes('memory.git'));

    // past the 500 ms recovery guard, so the view, not the guard, ignores a and Option+K
    await delay(600);

    for (const key of ['a', '\u001b[107;3u', 'k', 'd']) {
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

test('a conflicting note name carrying a link sequence shows as plain text', async () => {
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

test('an error naming a note drops a link forged in the name', async () => {
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

test('the pending view ignores k and letters typed with Ctrl, Option or Cmd', async () => {
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

    // Cmd+← as Ghostty sends it, Option+D and Cmd+D come between k and a
    for (const key of ['k', '\u0001', '\u001b[100;3u', '\u001b[100;9u', 'a']) {
      ui.stdin.write(key);

      await delay(30);
    }

    assert.deepEqual(calls, [['recoverMemory', 'accept']]);
  } finally {
    ui.unmount();
  }
});

test('a recovery that appears while typing ignores keys for its first 500 ms', async () => {
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

test('PageDown in the recovery view starts at the first row it hid', async () => {
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

test('entering a later recovery resets its page to the first row', async () => {
  const recovery = (label: string) => ({
    kind: 'pending' as const,
    paths: [],
    diff: Array.from({ length: 60 }, (_, n) => `+${label} ${n + 1}`).join('\n'),
    root: '/m',
  });

  const { app, coordinator } = fake({
    phase: 'recovery',
    recovery: recovery('old'),
  });

  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    100,
    24,
  );

  const shown = (label: string) =>
    [...ui.text().matchAll(new RegExp(`${label} (\\d+)`, 'g'))].map((match) =>
      Number(match[1]),
    );

  try {
    await until('the first recovery page', () => shown('old')[0] === 1);

    ui.stdin.write('\u001b[6~');

    await until('the scrolled recovery', () => (shown('old')[0] ?? 0) > 1);

    coordinator.publish({ phase: 'idle', recovery: undefined });

    await until('the composer', () => !ui.text().includes('d DISCARD'));

    coordinator.publish({ phase: 'recovery', recovery: recovery('new') });

    await until(
      'the new recovery starts at row one',
      () => shown('new')[0] === 1,
    );

    assert.equal(shown('new')[0], 1);
  } finally {
    ui.unmount();
  }
});

test('an error shows in the recovery view', async () => {
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

test('a launch report shows every line, and a taller message ends with a row count', async () => {
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
  const root = await scratch('witch-ui-memory-');

  const cwd = join(root, 'project');

  await mkdir(cwd);

  const hook = { current: passThrough };

  const store = await StateStore.open(join(root, 'state'));

  const memory = await seededMemory(
    join(root, 'state', 'memory.git'),
    hookedGit(hook),
  );

  const directory = join(root, 'state', 'conversations', 'seed');

  await mkdir(directory, { recursive: true });

  const seed = memory.workspace(directory, 'seed');

  await seed.ensureWorktree();

  await writeFile(join(seed.root, 'global', 'other.md'), 'Another note.');

  await seed.commit('chore(memory): save seed notes');

  await seed.publish();

  const coordinator = new Coordinator(
    store,
    memory,
    // uninstalled, so opening the conversation builds no worktree
    [{ adapter: new FixtureAgent('a') }],
    undefined,
    editFile,
  );

  await coordinator.initialize(cwd);

  return { root, hook, seed, coordinator };
}

test('/memory reads one commit even when main moves during the action', async () => {
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

    await openCommand(ui, '/memory', 'global/other.md');

    // only the launch's connect report, no error from reading memory
    assert.equal(
      coordinator.snapshot.error,
      'a is not installed. Install its native CLI and sign in before using it.',
    );
  } finally {
    ui.unmount();

    await coordinator.close();
  }
});

test('/memory shows a long note whose name holds a line break on one row, linked or not', async () => {
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

    await openCommand(ui, '/memory', row);

    ui.stdin.write('\u001b');

    await until('the chat', () => !ui.text().includes(row));

    // a worktree at main links the rows, so they render through linkify
    await coordinator.editMemory('global/other.md');

    await openCommand(ui, '/memory', row);

    assert.ok(ui.frame().includes('/memory/global/other.md\u0007'));
  } finally {
    ui.unmount();

    await coordinator.close();
  }
});

test('a note page shows a name that holds a line break on its title row', async () => {
  const { seed, coordinator } = await memoryApp();

  await writeFile(join(seed.root, 'global', 'first\nsecond.md'), 'A note.');

  await seed.commit('chore(memory): save a note');

  await seed.publish();

  const ui = show(createElement(App, { coordinator, onExit: () => {} }));

  try {
    await delay(60);

    await openCommand(ui, '/memory', 'global/first second.md');

    await delay(30);

    ui.stdin.write('second');

    await delay(30);

    ui.stdin.write(ENTER);

    await until('the note page', () => ui.text().includes('A note.'));

    const rows = ui.text().split('\n');

    assert.equal(
      rows[rows.findIndex((row) => row.includes('A note.')) - 1]!.trim(),
      'global/first second.md',
    );
  } finally {
    ui.unmount();

    await coordinator.close();
  }
});

test('memory without a worktree shows no links, builds no worktree, and keeps history', async () => {
  const { root, coordinator } = await memoryApp();

  const ui = show(createElement(App, { coordinator, onExit: () => {} }));

  const row = (text: string) =>
    ui
      .frame()
      .split('\n')
      .find((line) => stripAnsi(line).includes(text)) ?? '';

  try {
    await delay(60);

    await openCommand(ui, '/memory', 'global/MEMORY.md');

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

test('a note page scrolls by rows and full pages and stops at its last row', async () => {
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

    await openCommand(ui, '/memory', 'long.md');

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

test('e on a note page edits that note, letters typed with Ctrl, Option or Cmd leave it open, and the + entry edits project essentials', async () => {
  const edited: string[] = [];

  const { coordinator } = await memoryApp(async (file) => {
    edited.push(file);
  });

  const ui = show(createElement(App, { coordinator, onExit: () => {} }));

  try {
    await delay(60);

    await openCommand(ui, '/memory', 'other.md');

    await delay(30);

    ui.stdin.write('other.md');

    await delay(30);

    ui.stdin.write('\r');

    await until('the note page', () => ui.text().includes('e EDIT'));

    // Cmd+→ as Ghostty sends it, Option+E, Cmd+E and Option+H leave the page where it is
    for (const key of [
      '\u0005',
      '\u001b[101;3u',
      '\u001b[101;9u',
      '\u001b[104;3u',
    ]) {
      ui.stdin.write(key);

      await delay(60);

      assert.ok(ui.text().includes('e EDIT'), JSON.stringify(key));
    }

    ui.stdin.write('e');

    await until('the edit', () => edited.length === 1);

    assert.match(edited[0]!, /\/global\/other\.md$/);

    await until('idle', () => coordinator.snapshot.phase === 'idle');

    // the edit's notice already names other.md
    await openCommand(ui, '/memory', 'Edit project essentials');

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

test('a note page links its relative Markdown targets beside the note once its worktree holds the revision', async () => {
  const { root, seed, coordinator } = await memoryApp();

  await writeFile(join(seed.root, 'global', 'index.md'), '- [Other](other.md)');

  await seed.commit('chore(memory): add index');

  await seed.publish();

  const ui = show(createElement(App, { coordinator, onExit: () => {} }));

  const open = async () => {
    // the edit's notice already names index.md
    await openCommand(ui, '/memory', 'Edit project essentials');

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

test('a note file name carrying a link sequence shows as plain text in the picker, on its page and in its notices', async () => {
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

    await openCommand(ui, '/memory', 'global/forged');

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

    await openCommand(ui, '/memory', 'global/forged');

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

    await openCommand(ui, '/memory', 'global/forged');

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
