import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { test } from 'vitest';
import type { Snapshot } from '../../src/core/snapshot.js';
import { applyDisplayUpdate } from '../../src/core/state.js';
import type { DisplayUpdate } from '../../src/core/state.js';
import { App } from '../../src/ui/App.js';
import {
  approval,
  ENTER,
  fake,
  left,
  openCommand,
  SHIFT_ENTER,
  show,
  TAB,
} from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';

const label = '↓ New messages';
const wheelUp = '\u001b[<64;10;10M';
const wheelDown = '\u001b[<65;10;10M';
const pageUp = '\u001b[5~';
const pageDown = '\u001b[6~';

const long = {
  id: 'long',
  kind: 'assistant' as const,
  cwd: '/work',
  text: Array.from({ length: 150 }, (_, i) => `row ${i + 1}`).join('\n'),
};

type UI = ReturnType<typeof show>;

const first = (ui: UI) => Number(/row (\d+)/.exec(ui.text())?.[1]);

const rowOf = (ui: UI, text: string) =>
  ui
    .text()
    .split('\n')
    .findIndex((line) => line.includes(text));

function button(ui: UI): [number, number] {
  const row = rowOf(ui, label);
  assert.ok(row >= 0, ui.text());

  return [ui.text().split('\n')[row]!.indexOf(label), row];
}

function click(ui: UI, cell = button(ui)) {
  ui.stdin.write(left('press', ...cell) + left('release', ...cell));
}

function mount(snapshot: Partial<Snapshot> = {}, columns = 80, rows = 25) {
  const { app, coordinator, calls } = fake({ items: [long], ...snapshot });
  const copied: string[] = [];

  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit() {},
      copy: (text) => copied.push(text),
    }),
    columns,
    rows,
  );

  const update = (item: DisplayUpdate) =>
    coordinator.publish({
      items: applyDisplayUpdate(coordinator.snapshot.items, item),
    });

  return { ui, coordinator, calls, copied, update };
}

async function readEarlier(ui: UI) {
  await until('the transcript', () => first(ui) > 0);
  const before = first(ui);
  ui.stdin.write(pageUp);
  await until('earlier rows', () => first(ui) < before);
}

for (const phase of ['idle', 'running'] as const) {
  test(`new output while reading shows a jump button and clicking resumes following while ${phase}`, async () => {
    const { ui, update, calls } = mount({ phase });

    try {
      await until('latest row', () => ui.text().includes('row 150'));
      update({ ...long, text: '\nalready followed' });
      await until('live arrival', () => ui.text().includes('already followed'));
      ui.stdin.write('retained draft');
      await readEarlier(ui);
      assert.ok(!ui.text().includes(label));
      const reading = first(ui);
      const prompt = rowOf(ui, 'retained draft');
      update({ id: 'new', kind: 'notice', cwd: '/work', text: 'new arrival' });
      await until('new messages button', () => ui.text().includes(label));
      assert.equal(first(ui), reading);
      assert.equal(rowOf(ui, 'retained draft'), prompt);
      assert.equal(rowOf(ui, label), prompt - (phase === 'running' ? 3 : 2));

      if (phase === 'running')
        assert.equal(rowOf(ui, 'ESC TO INTERRUPT'), prompt - 2);

      click(ui);

      await until(
        'latest output',
        () => ui.text().includes('new arrival') && !ui.text().includes(label),
      );

      assert.ok(!ui.text().includes('READING EARLIER OUTPUT'));
      assert.equal(rowOf(ui, 'retained draft'), prompt);

      update({
        id: 'later',
        kind: 'notice',
        cwd: '/work',
        text: 'following arrival',
      });

      await until('following output', () =>
        ui.text().includes('following arrival'),
      );

      assert.ok(ui.text().includes('retained draft'));
      assert.deepEqual(calls, []);
    } finally {
      ui.unmount();
    }
  });
}

test('pending compaction and new messages preserve the reading line and composer together', async () => {
  const { ui, update, coordinator } = mount({ phase: 'running' });

  try {
    await readEarlier(ui);
    ui.stdin.write('retained draft');
    await until('draft', () => ui.text().includes('retained draft'));
    const reading = first(ui);
    const prompt = rowOf(ui, 'retained draft');
    coordinator.publish({ pendingCompaction: true });

    await until('pending compaction', () =>
      ui.text().includes('Pending: /compact'),
    );

    assert.equal(first(ui), reading);
    assert.equal(rowOf(ui, 'retained draft'), prompt);
    assert.ok(!ui.text().includes(label));
    update({ ...long, text: '\narrival during pending compact' });
    await until('new messages', () => ui.text().includes(label));
    assert.equal(first(ui), reading);
    assert.equal(rowOf(ui, 'retained draft'), prompt);
    assert.ok(ui.text().includes('Pending: /compact'));
    click(ui);

    await until(
      'latest arrival',
      () =>
        ui.text().includes('arrival during pending compact') &&
        !ui.text().includes(label),
    );

    assert.equal(rowOf(ui, 'retained draft'), prompt);
    assert.ok(ui.text().includes('Pending: /compact'));
    coordinator.publish({ pendingCompaction: false });

    await until(
      'compaction cleared',
      () => !ui.text().includes('Pending: /compact'),
    );

    assert.equal(rowOf(ui, 'retained draft'), prompt);
    assert.ok(ui.text().includes('arrival during pending compact'));
  } finally {
    ui.unmount();
  }
});

test('updates to existing items notify without adding rows', async () => {
  const tool = {
    id: 'tool',
    kind: 'tool' as const,
    title: 'command',
    cwd: '/work',
    text: 'tool output',
    shell: true,
    done: false,
  };

  const { ui, update, coordinator } = mount({
    items: [
      long,
      tool,
      {
        id: 'tail',
        kind: 'notice',
        cwd: '/work',
        text: 'tail marker',
      },
    ],
  });

  try {
    for (const change of [
      { ...long, text: ' streamed suffix' },
      { ...tool, text: ' appended output' },
      { ...tool, text: '', done: true },
    ]) {
      await readEarlier(ui);
      const reading = first(ui);
      const count = coordinator.snapshot.items.length;
      update(change);
      await until('updated item indication', () => ui.text().includes(label));
      assert.equal(first(ui), reading);
      assert.equal(coordinator.snapshot.items.length, count);
      click(ui);

      await until(
        'updated content',
        () => ui.text().includes('tail marker') && !ui.text().includes(label),
      );
    }

    assert.match(ui.text(), /row 150 streamed suffix/);
    assert.match(ui.text(), /tool output appended output/);
    assert.match(ui.text(), /✓ command/);
  } finally {
    ui.unmount();
  }
});

test('returning to live output clears the indication, including bottom then up in one read', async () => {
  const { ui, update } = mount({
    items: [
      long,
      {
        id: 'tool',
        kind: 'tool',
        title: 'command',
        cwd: '/work',
        text: '',
        done: true,
      },
    ],
  });

  try {
    for (const [index, action] of [
      wheelDown.repeat(250),
      pageDown.repeat(20),
      `${TAB}\u001b[F`,
    ].entries()) {
      await readEarlier(ui);
      update({ ...long, text: '\nan arrival' });
      await until('pending output', () => ui.text().includes(label));
      ui.stdin.write(action);

      await until(
        'live output',
        () => !ui.text().includes('READING EARLIER OUTPUT'),
      );

      assert.ok(!ui.text().includes(label));

      if (action.includes(TAB)) ui.stdin.write(TAB);

      update({ ...long, text: `\ncontinued output ${index}` });

      await until('continued output', () =>
        ui.text().includes(`continued output ${index}`),
      );

      const bottom = first(ui);
      ui.stdin.write(wheelUp);
      await until('one row up', () => first(ui) === bottom - 1);
      assert.ok(!ui.text().includes(label));
      update({ ...long, text: '\nanother arrival' });
      await until('another indication', () => ui.text().includes(label));
      ui.stdin.write(wheelDown.repeat(250) + wheelUp);

      await until(
        'read after visiting bottom',
        () =>
          ui.text().includes('READING EARLIER OUTPUT') &&
          !ui.text().includes(label),
      );

      const reading = first(ui);
      ui.stdin.write(wheelDown);

      await until(
        'one step to bottom',
        () => !ui.text().includes('READING EARLIER OUTPUT'),
      );

      assert.equal(first(ui), reading + 1);
    }
  } finally {
    ui.unmount();
  }
});

test('only a click on the shown button jumps and transcript selection still copies', async () => {
  const { ui, update, copied } = mount();

  try {
    await readEarlier(ui);
    update({ ...long, text: '\narrival for clicking' });
    await until('button', () => ui.text().includes(label));
    const reading = first(ui);
    const [column, row] = button(ui);
    click(ui, [column - 2, row]);

    ui.stdin.write(
      left('press', column, row) +
        left('drag', column + 3, row) +
        left('release', column + 3, row),
    );

    await delay(80);
    assert.equal(first(ui), reading);
    assert.ok(ui.text().includes(label));

    ui.stdin.write(
      left('press', column, row) + wheelUp + left('release', column, row),
    );

    await until('wheel only', () => first(ui) === reading - 1);
    assert.ok(ui.text().includes(label));

    ui.stdin.write(
      left('press', 1, 1) +
        left('drag', 3, 1) +
        left('release', 3, 1) +
        '\u001b[99;9u',
    );

    await until('copied transcript', () => copied.length > 0);
    assert.deepEqual(copied, ['row']);
    click(ui);

    await until(
      'clicked latest',
      () =>
        ui.text().includes('arrival for clicking') &&
        !ui.text().includes(label),
    );
  } finally {
    ui.unmount();
  }
});

test('indications belong to their conversation and survive covered chat', async () => {
  const { ui, update, coordinator } = mount();

  try {
    await readEarlier(ui);
    const reading = first(ui);
    await openCommand(ui, '/help', '/new  New');
    update({ ...long, text: '\narrival behind help' });
    await delay(100);
    assert.ok(!ui.text().includes(label));
    click(ui, [40, 20]);
    ui.stdin.write('\u001b');
    await until('returned to chat', () => ui.text().includes(label));
    assert.equal(first(ui), reading);
    const cell = button(ui);
    coordinator.publish({ phase: 'running', requests: [approval] });
    await until('approval', () => ui.text().includes('Approval required'));
    assert.ok(!ui.text().includes(label));
    update({ ...long, text: '\narrival behind approval' });
    click(ui, cell);
    coordinator.publish({ requests: [] });
    await until('returned from approval', () => ui.text().includes(label));
    assert.equal(first(ui), reading);
    const original = coordinator.snapshot.conversation!;

    coordinator.publish({
      conversation: { ...original, id: 'second' },
      items: [
        {
          ...long,
          id: 'second-output',
          text: long.text + '\nsecond conversation',
        },
      ],
    });

    await until(
      'second conversation',
      () =>
        ui.text().includes('second conversation') &&
        !ui.text().includes('READING EARLIER OUTPUT'),
    );

    assert.ok(!ui.text().includes(label));
    await readEarlier(ui);
    assert.ok(!ui.text().includes(label));
    coordinator.publish({ conversation: original, items: [long] });

    await until(
      'original conversation',
      () =>
        ui.text().includes('row 150') &&
        !ui.text().includes('READING EARLIER OUTPUT'),
    );

    assert.ok(!ui.text().includes(label));
  } finally {
    ui.unmount();
  }
});

test('layout and status changes do not announce messages', async () => {
  const { ui, coordinator } = mount({
    phase: 'running',
    items: [
      {
        id: 'tool',
        kind: 'tool',
        title: 'expandable command',
        cwd: '/work',
        text: 'expanded output',
        done: true,
      },
      long,
    ],
  });

  try {
    await readEarlier(ui);
    ui.stdin.write('retained');
    ui.stdin.write(SHIFT_ENTER);
    ui.stdin.write('second line');
    await until('draft', () => ui.text().includes('second line'));
    ui.resize(45);
    coordinator.publish({ phase: 'compacting', usage: { context: 37 } });

    await until(
      'status change',
      () => ui.text().includes('COMPACTING') && ui.text().includes('CTX 37%'),
    );

    assert.ok(!ui.text().includes(label));
    ui.stdin.write(TAB + ENTER);
    await delay(80);
    assert.ok(!ui.text().includes(label));
    ui.stdin.write(TAB);
    assert.ok(ui.text().includes('second line'));
  } finally {
    ui.unmount();
  }
});

test('cast animation frames do not announce new messages', async () => {
  const { ui } = mount({
    items: [
      {
        id: 'cast',
        kind: 'notice',
        cwd: '/work',
        text: 'Cast spell',
        cast: true,
        at: new Date().toISOString(),
      },
      long,
    ],
  });

  try {
    await until('transcript', () => first(ui) > 0);
    ui.stdin.write(wheelUp.repeat(200));
    await until('spell shown', () => ui.text().includes('Cast spell'));
    const frame = ui.frame();
    await until('next animation frame', () => ui.frame() !== frame);
    assert.ok(!ui.text().includes(label));
    assert.ok(ui.text().includes('READING EARLIER OUTPUT'));
  } finally {
    ui.unmount();
  }
});

test('a completion list keeps the prompt and reading line fixed when new messages arrive', async () => {
  const { ui, update } = mount({ phase: 'running' }, 30, 24);

  try {
    await readEarlier(ui);
    ui.stdin.write('/');
    await until('completions', () => ui.text().includes('/sessions'));
    const reading = first(ui);
    const prompt = rowOf(ui, '┃ /');
    update({ ...long, text: ' newest suffix' });

    await until('button beside a cramped composer', () =>
      ui.text().includes(label),
    );

    assert.equal(first(ui), reading);
    assert.equal(rowOf(ui, '┃ /'), prompt);
    assert.ok(ui.text().includes('/sessions'));
    assert.equal(ui.text().split('\n').length, 24);
    click(ui);

    await until(
      'latest output with completions retained',
      () => ui.text().includes('newest suffix') && !ui.text().includes(label),
    );

    assert.equal(rowOf(ui, '┃ /'), prompt);
    assert.ok(ui.text().includes('/sessions'));
  } finally {
    ui.unmount();
  }
});

for (const [columns, rows] of [
  [120, 30],
  [30, 24],
]) {
  test(`the button preserves the composer and reading line at ${columns} by ${rows}`, async () => {
    const { ui, update } = mount(
      {
        phase: 'running',
        queue: ['queued prompt'],
        items: [
          long,
          {
            id: 'clear',
            kind: 'notice',
            cwd: '/work',
            text: 'Context cleared.',
            contextCleared: true,
          },
          {
            id: 'latest',
            kind: 'assistant',
            cwd: '/work',
            text: 'latest output',
          },
        ],
      },
      columns,
      rows,
    );

    try {
      await until('latest output', () => ui.text().includes('latest output'));
      ui.stdin.write(wheelUp.repeat(20));
      await until('earlier numbered rows', () => first(ui) > 0);
      ui.stdin.write('draft');

      if (rows! > 12) {
        ui.stdin.write(SHIFT_ENTER);
        ui.stdin.write('second draft line');
      }

      await until('draft', () => ui.text().includes('draft'));
      const reading = first(ui);
      const prompt = rowOf(ui, '┃ draft');
      assert.match(ui.text(), /Earlier messages/);

      update({
        id: 'latest',
        kind: 'assistant',
        cwd: '/work',
        text: '\nnewest output',
      });

      await until('button with context reminder', () =>
        ui.text().includes(label),
      );

      assert.equal(first(ui), reading);
      assert.equal(rowOf(ui, '┃ draft'), prompt);
      assert.equal(ui.text().split('\n').length, rows);

      if (columns! > 30) {
        for (const width of [114, 115, 45]) {
          const before = ui.frame();
          ui.resize(width);
          await until('resized frame', () => ui.frame() !== before);
          assert.equal(first(ui), reading);
          assert.ok(ui.text().includes(label));
          assert.ok(ui.text().includes('second draft line'));
        }
      }

      click(ui);

      await until(
        'latest after resize',
        () => ui.text().includes('newest output') && !ui.text().includes(label),
      );

      assert.ok(ui.text().includes('draft'));
    } finally {
      ui.unmount();
    }
  });
}
