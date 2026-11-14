import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement, Profiler } from 'react';
import { Lexer } from 'marked';
import type { Coordinator } from '../../src/core/coordinator.js';
import type { CoordinationSnapshot } from '../../src/core/coordination/coordination-state.js';
import type { Memory } from '../../src/memory/memory.js';
import { App } from '../../src/ui/App.js';
import { fake, show, openCommand, ENTER } from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';

function peerUpdates(coordinator: ReturnType<typeof fake>['coordinator']) {
  const listeners = new Set<() => void>();

  const coordination = {
    snapshot: {
      peers: [],
      reservations: [],
      unregistered: [],
    } as CoordinationSnapshot,
    subscribe(notify: () => void) {
      listeners.add(notify);

      return () => listeners.delete(notify);
    },
  };

  Object.assign(coordinator, { coordination });

  return (error: string) => {
    coordination.snapshot = { ...coordination.snapshot, error };

    for (const notify of listeners) notify();
  };
}

test('snapshot updates reuse composer wrapping while edits and resize update it', async () => {
  const value = `compiler-input\t${'abc '.repeat(30)}\nlast row`;
  const normalize = String.prototype.normalize;
  let wraps = 0;

  vi.spyOn(String.prototype, 'normalize').mockImplementation(function (
    this: string,
    form?: string,
  ) {
    if (this === value || this === `${value}X`) wraps++;

    return normalize.call(this, form);
  });

  const { app, coordinator } = fake({ error: 'snapshot initial' });
  const ui = show(createElement(App, { coordinator: app, onExit() {} }));

  try {
    await until('composer', () => ui.text().includes('Ask the agent'));

    ui.stdin.write(`\u001b[200~${value}\u001b[201~`);

    await until('pasted composer', () => ui.text().includes('last row'));

    assert.ok(wraps > 0);

    const before = wraps;

    coordinator.publish({ error: 'snapshot changed' });

    await until('snapshot render', () =>
      ui.text().includes('snapshot changed'),
    );

    assert.equal(wraps, before);

    assert.ok(ui.text().includes('last row'));

    ui.stdin.write('X');

    await until('edited composer', () => ui.text().includes('last rowX'));

    assert.ok(wraps > before);

    const beforeResize = wraps;

    ui.resize(45);

    await until('resized composer', () => wraps > beforeResize);

    assert.ok(ui.text().includes('last rowX'));
  } finally {
    ui.unmount();
  }
});

test('recovery snapshots and scrolling reuse wrapping while changed diffs and width update it', async () => {
  const diff = Array.from({ length: 80 }, (_, i) => `recovery-line ${i}`).join(
    '\n',
  );

  const changed = diff.replaceAll('recovery-line', 'updated-line');
  const normalize = String.prototype.normalize;
  let wraps = 0;

  vi.spyOn(String.prototype, 'normalize').mockImplementation(function (
    this: string,
    form?: string,
  ) {
    if (this === diff || this === changed) wraps++;

    return normalize.call(this, form);
  });

  const recovery = {
    kind: 'pending' as const,
    paths: [],
    diff,
    root: '/memory',
  };

  const { app, coordinator } = fake({
    phase: 'recovery',
    recovery,
    error: 'snapshot initial',
  });

  const updatePeers = peerUpdates(coordinator);
  let commits = 0;

  const ui = show(
    createElement(
      Profiler,
      {
        id: 'recovery',
        onRender() {
          commits++;
        },
      },
      createElement(App, { coordinator: app, onExit() {} }),
    ),
    100,
    24,
  );

  try {
    await until('recovery page', () => ui.text().includes('recovery-line 0'));

    assert.ok(wraps > 0);

    const before = wraps;

    coordinator.publish({ error: 'snapshot changed' });

    await until('snapshot render', () =>
      ui.text().includes('snapshot changed'),
    );

    assert.equal(wraps, before);

    const beforePeer = commits;

    updatePeers('peer update');

    await until('peer render', () => commits > beforePeer);

    assert.equal(wraps, before);

    ui.stdin.write('\u001b[6~');

    await until('scrolled page', () => !ui.text().includes('recovery-line 0'));

    assert.equal(wraps, before);

    assert.ok(ui.text().includes('recovery-line 15'));

    coordinator.publish({ recovery: { ...recovery, diff: changed } });

    await until('updated page', () => ui.text().includes('updated-line 15'));

    assert.ok(wraps > before);

    const beforeResize = wraps;

    ui.resize(60);

    await until('resized page', () => wraps > beforeResize);

    assert.ok(ui.text().includes('updated-line 15'));
  } finally {
    ui.unmount();
  }
});

test('page movement starts from the visible top after content shrinks', async () => {
  const recovery = (label: string, count: number) => ({
    kind: 'pending' as const,
    paths: [],
    root: '/memory',
    diff: Array.from({ length: count }, (_, i) => `+${label} ${i + 1}`).join(
      '\n',
    ),
  });

  const { app, coordinator, calls } = fake({
    phase: 'recovery',
    recovery: recovery('long', 60),
  });

  const ui = show(
    createElement(App, { coordinator: app, onExit() {} }),
    100,
    24,
  );

  const first = (label: string) =>
    Number(new RegExp(`${label} (\\d+)`).exec(ui.text())?.[1]);

  try {
    await until('initial recovery', () => first('long') === 1);

    ui.stdin.write('\u001b[6~'.repeat(4));

    await until('last page', () => first('long') === 45);

    coordinator.publish({ recovery: recovery('short', 25) });

    await until('clamped short page', () => first('short') === 10);

    ui.stdin.write('\u001b[<64;10;10M'.repeat(2));

    await until('two rows up', () => first('short') === 8);

    ui.stdin.write('\u001b[A');

    await until('one row up', () => first('short') === 7);

    assert.deepEqual(calls, []);
  } finally {
    ui.unmount();
  }
});

test('page key releases do not scroll', async () => {
  const { app } = fake({
    phase: 'recovery',
    recovery: {
      kind: 'pending',
      paths: [],
      root: '/memory',
      diff: Array.from({ length: 60 }, (_, i) => `+row ${i + 1}`).join('\n'),
    },
  });

  const ui = show(
    createElement(App, { coordinator: app, onExit() {} }),
    100,
    24,
  );

  const first = () => Number(/row (\d+)/.exec(ui.text())?.[1]);

  try {
    await until('initial page', () => first() === 1);

    ui.stdin.write('\u001b[6;1:1~\u001b[6;1:3~');

    await until('page press', () => first() !== 1);

    await delay(60);

    assert.equal(first(), 17);

    ui.stdin.write('\u001b[1;1:3A');

    await delay(60);

    assert.equal(first(), 17);
  } finally {
    ui.unmount();
  }
});

const notes = {
  'global/first.md':
    '# COMPILER-NOTE\n\n' + 'needle page content\n\n'.repeat(40),
  'global/second.md': '# Different note\n\nOther content.',
};

function memoryPicker() {
  const context = fake({ error: 'snapshot initial' });

  const view: Awaited<ReturnType<Coordinator['memoryView']>> = {
    revision: 'a'.repeat(40),
    scope: { global: 'global', project: 'projects/test' },
    root: '/memory',
  };

  const memory: Pick<Memory, 'catalog' | 'read'> = {
    async catalog(revision, scope) {
      assert.equal(revision, view.revision);

      assert.deepEqual(scope, view.scope);

      return Object.keys(notes).map((path) => ({ path, deleted: false }));
    },
    async read(revision, path) {
      assert.equal(revision, view.revision);

      assert.ok(Object.hasOwn(notes, path));

      return notes[path as keyof typeof notes];
    },
  };

  Object.assign(context.coordinator, { memoryView: async () => view });

  Object.assign(context.coordinator.memory, memory);

  return context;
}

test('memory picker snapshots reuse searchable text while a changed query updates results', async () => {
  const lower = String.prototype.toLowerCase;
  let searches = 0;

  vi.spyOn(String.prototype, 'toLowerCase').mockImplementation(function (
    this: string,
  ) {
    if (this.includes('COMPILER-NOTE') && this.includes('global/first.md'))
      searches++;

    return lower.call(this);
  });

  const { app, coordinator } = memoryPicker();
  const ui = show(createElement(App, { coordinator: app, onExit() {} }));

  try {
    await until('composer', () => ui.text().includes('Ask the agent'));

    await openCommand(ui, '/memory', 'global/first.md');

    assert.ok(ui.text().includes('global/second.md'));

    assert.ok(searches > 0);

    const before = searches;

    coordinator.publish({ error: 'snapshot changed' });

    await until('snapshot render', () =>
      ui.text().includes('snapshot changed'),
    );

    assert.equal(searches, before);

    ui.stdin.write('needle');

    await until(
      'matching note',
      () =>
        ui.text().includes('global/first.md') &&
        !ui.text().includes('global/second.md'),
    );

    assert.ok(searches > before);

    ui.stdin.write(ENTER);

    await until('selected note', () => ui.text().includes('COMPILER-NOTE'));
  } finally {
    ui.unmount();
  }
});

test('note snapshots and scrolling reuse Markdown while opening another note updates it', async () => {
  const lex = Lexer.prototype.lex;
  let renders = 0;

  vi.spyOn(Lexer.prototype, 'lex').mockImplementation(function (
    this: Lexer,
    text: string,
  ) {
    if (Object.values(notes).includes(text)) renders++;

    return lex.call(this, text);
  });

  const { app, coordinator } = memoryPicker();
  const updatePeers = peerUpdates(coordinator);
  let commits = 0;

  const ui = show(
    createElement(
      Profiler,
      {
        id: 'note',
        onRender() {
          commits++;
        },
      },
      createElement(App, { coordinator: app, onExit() {} }),
    ),
    100,
    24,
  );

  try {
    await until('composer', () => ui.text().includes('Ask the agent'));

    await openCommand(ui, '/memory', 'global/first.md');

    ui.stdin.write(`first${ENTER}`);

    await until('first note', () => ui.text().includes('COMPILER-NOTE'));

    assert.ok(renders > 0);

    const before = renders;

    coordinator.publish({ error: 'snapshot changed' });

    await until('snapshot render', () =>
      ui.text().includes('snapshot changed'),
    );

    assert.equal(renders, before);

    const beforePeer = commits;

    updatePeers('peer update');

    await until('peer render', () => commits > beforePeer);

    assert.equal(renders, before);

    coordinator.publish({ phase: 'running', error: 'phase changed' });

    await until('phase render', () => ui.text().includes('phase changed'));

    assert.equal(renders, before);

    coordinator.publish({ phase: 'idle', error: 'snapshot changed' });

    await until('idle render', () => ui.text().includes('snapshot changed'));

    assert.equal(renders, before);

    ui.stdin.write('\u001b[6~');

    await until('scrolled note', () => !ui.text().includes('COMPILER-NOTE'));

    assert.ok(ui.text().includes('needle page content'));

    assert.equal(renders, before);

    ui.stdin.write('\u001b');

    await until('composer', () => ui.text().includes('Ask the agent'));

    await openCommand(ui, '/memory', 'global/second.md');

    ui.stdin.write(`second${ENTER}`);

    await until('second note', () => ui.text().includes('Other content.'));

    assert.ok(renders > before);

    assert.ok(!ui.text().includes('needle page content'));
  } finally {
    ui.unmount();
  }
});
