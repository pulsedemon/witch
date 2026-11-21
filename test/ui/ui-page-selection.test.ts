import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createElement } from 'react';
import stripAnsi from 'strip-ansi';
import { test, vi } from 'vitest';
import { App } from '../../src/ui/App.js';
import type { Snapshot } from '../../src/core/snapshot.js';
import { CMD_C } from '../fixtures/ui-transcript.js';
import { DOWN, ENTER, fake, left, openCommand, show } from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';

function mount(snapshot: Partial<Snapshot>, columns = 60, rows = 24) {
  const state = fake(snapshot);
  const copied: string[] = [];
  const confirmations: (() => void)[] = [];

  const ui = show(
    createElement(App, {
      coordinator: state.app,
      onExit() {},
      copy(text, confirmed) {
        copied.push(text);
        confirmations.push(confirmed);
      },
    }),
    columns,
    rows,
  );

  return { ...state, ui, copied, confirmations };
}

type Mounted = ReturnType<typeof mount>;

function cell(ui: Mounted['ui'], text: string): [number, number] {
  const rows = ui.text().split('\n');
  const row = rows.findIndex((line) => line.includes(text));
  assert.ok(row >= 0, `missing ${text}:\n${ui.text()}`);

  return [rows[row]!.indexOf(text), row];
}

const click = (column: number, row: number) =>
  left('press', column, row) + left('release', column, row);

async function drawn() {
  for (let turn = 0; turn < 5; turn++) await setImmediate();
}

async function copy(mounted: Mounted, reports: string, expected: string) {
  const count = mounted.copied.length;
  mounted.ui.stdin.write(reports + CMD_C);
  await until('selected text copied', () => mounted.copied.length > count);
  assert.equal(mounted.copied.at(-1), expected);
}

function dragText(ui: Mounted['ui'], text: string) {
  const [x, y] = cell(ui, text);

  return (
    left('press', x, y) +
    left('drag', x + text.length - 1, y) +
    left('release', x + text.length - 1, y)
  );
}

for (const surface of ['help', 'approval', 'pending', 'conflict'] as const) {
  test(`${surface} body supports same-read drag, word and line copy without acting on its controls`, async () => {
    const mounted = mount(
      surface === 'help'
        ? {}
        : surface === 'approval'
          ? {
              requests: [
                {
                  id: 'r',
                  kind: 'approval',
                  title: 'Approval probe',
                  detail: 'alpha beta gamma',
                },
              ],
            }
          : {
              phase: 'recovery',
              recovery: {
                kind: surface,
                paths: [],
                root: '/work',
                diff: 'alpha beta gamma',
              },
            },
    );

    const { ui, copied, confirmations, calls } = mounted;
    const word = surface === 'help' ? '/new' : 'beta';

    const line =
      surface === 'help' ? '/new  New conversation' : 'alpha beta gamma';

    try {
      if (surface === 'help') await openCommand(ui, '/help', '/new  New');
      else await until('the body', () => ui.text().includes(line));

      await copy(mounted, dragText(ui, word), word);
      assert.ok(!ui.text().split('\n')[0]!.includes('COPIED'));
      confirmations[0]!();

      await until('clipboard confirmation', () =>
        ui.text().split('\n')[0]!.includes('COPIED'),
      );

      const [x, y] = cell(ui, word);
      await copy(mounted, click(0, 0) + click(x, y).repeat(2), word);
      await copy(mounted, click(0, 0) + click(x, y).repeat(3), line);
      assert.ok(ui.frame().includes('\u001b[7m'));
      assert.deepEqual(calls, []);
      const count = copied.length;
      ui.stdin.write(click(0, 0) + CMD_C);
      await drawn();
      assert.equal(copied.length, count);

      ui.stdin.write(
        left('press', 0, y) +
          left('drag', x + 2, y) +
          left('release', x + 2, y) +
          CMD_C,
      );

      await drawn();
      assert.equal(copied.length, count);
      await copy(mounted, dragText(ui, word), word);
      ui.resize(80);

      await until(
        'selection invalidated by resize',
        () => !ui.frame().includes('\u001b[7m'),
      );

      ui.stdin.write(CMD_C);
      await drawn();
      assert.equal(copied.length, count + 1);
    } finally {
      ui.unmount();
    }
  });
}

test('a wrapped note copies source spaces across rows while recovery diff rows stay separate', async () => {
  const note = mount({}, 18, 40);

  Object.assign(note.coordinator, {
    memoryView: async () => ({
      revision: 'r',
      root: '/work',
      scope: 'project',
    }),
  });

  Object.assign(note.coordinator.memory, {
    catalog: async () => [{ path: 'note.md' }],
    read: async () =>
      'alpha beta gamma delta epsilon zeta\n[guide](https://example.com/docs)',
  });

  try {
    await openCommand(note.ui, '/memory', 'note.md');
    note.ui.stdin.write('note.md' + ENTER);
    await until('the note', () => note.ui.text().includes('alpha beta'));
    const [x, y] = cell(note.ui, 'alpha');
    const [end, last] = cell(note.ui, 'zeta');

    await copy(
      note,
      left('press', x, y) +
        left('drag', end + 3, last) +
        left('release', end + 3, last),
      'alpha beta gamma delta epsilon zeta',
    );

    await copy(
      note,
      click(0, 0) + click(x, y).repeat(3),
      'alpha beta gamma delta epsilon zeta',
    );

    const [linkX, linkY] = cell(note.ui, 'guide');

    await copy(
      note,
      click(0, 0) + click(linkX, linkY).repeat(2),
      'guide (https://example.com/docs)',
    );
  } finally {
    note.ui.unmount();
  }

  const diff = mount(
    {
      phase: 'recovery',
      recovery: { kind: 'pending', root: '/work', paths: [], diff: '+abcdef' },
    },
    7,
    40,
  );

  try {
    await until('wrapped recovery diff', () =>
      diff.ui.text().includes('+abcd'),
    );

    const [x, y] = cell(diff.ui, '+abcd');
    const [end, last] = cell(diff.ui, 'ef');

    await copy(
      diff,
      left('press', x, y) +
        left('drag', end + 1, last) +
        left('release', end + 1, last),
      '+abcd\nef',
    );

    await copy(diff, click(0, 0) + click(end, last).repeat(3), 'ef');
  } finally {
    diff.ui.unmount();
  }
});

for (const [presses, expected] of [
  [2, 'beta gamma\none two'],
  [3, 'alpha beta gamma\none two three'],
] as const) {
  test(`a page drag extends its ${presses === 2 ? 'word' : 'line'} selection by whole units`, async () => {
    const mounted = mount({
      requests: [
        {
          id: 'r',
          kind: 'approval',
          title: 'Read',
          detail: 'alpha beta gamma\none two three',
        },
      ],
    });

    try {
      await until('two body lines', () =>
        mounted.ui.text().includes('one two three'),
      );

      const [x, y] = cell(mounted.ui, 'beta');
      const [end, last] = cell(mounted.ui, 'two');

      await copy(
        mounted,
        click(x, y).repeat(presses - 1) +
          left('press', x, y) +
          left('drag', end, last) +
          left('release', end, last),
        expected,
      );

      assert.deepEqual(mounted.calls, []);
    } finally {
      mounted.ui.unmount();
    }
  });
}

test('Enter and copy in one read cannot copy the previous question or change the next answer', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const mounted = mount({
    requests: [
      {
        id: 'q',
        kind: 'question',
        title: 'Question',
        detail: '',
        questions: [
          { id: 'first', title: 'alpha beta gamma', options: ['one', 'two'] },
          {
            id: 'second',
            title: 'delta epsilon zeta',
            options: ['three', 'four'],
          },
        ],
      },
    ],
  });

  const { ui, calls, copied } = mounted;

  try {
    await until('first question', () => ui.text().includes('alpha beta gamma'));
    await vi.advanceTimersByTimeAsync(500);
    await drawn();
    await copy(mounted, dragText(ui, 'beta'), 'beta');
    ui.stdin.write(ENTER + CMD_C);

    await until('second question', () =>
      ui.text().includes('delta epsilon zeta'),
    );

    assert.deepEqual(copied, ['beta']);
    assert.deepEqual(calls, []);
    ui.stdin.write('custom');

    await until('the existing answer draft', () =>
      ui.text().includes('custom'),
    );

    await copy(mounted, dragText(ui, 'epsilon'), 'epsilon');
    ui.stdin.write(DOWN + ENTER);
    await until('question response', () => calls.length > 0);

    assert.deepEqual(calls, [
      [
        'respond',
        'q',
        { decision: 'accept', answers: { first: ['one'], second: ['custom'] } },
      ],
    ]);
  } finally {
    ui.unmount();
  }
});

test('request arrows and Escape retain their actions while request text is selected', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const mounted = mount({
    requests: [
      {
        id: 'r',
        kind: 'approval',
        title: 'Approve',
        detail: 'alpha beta gamma',
      },
    ],
  });

  try {
    await until('approval detail', () =>
      mounted.ui.text().includes('alpha beta gamma'),
    );

    await vi.advanceTimersByTimeAsync(500);
    await drawn();
    await copy(mounted, dragText(mounted.ui, 'beta'), 'beta');
    mounted.ui.stdin.write(DOWN);

    await until('decline selected', () =>
      mounted.ui.text().includes('› Decline'),
    );

    assert.deepEqual(mounted.calls, []);
    mounted.ui.stdin.write('\u001b[27u');
    await until('declined', () => mounted.calls.length > 0);

    assert.deepEqual(mounted.calls, [
      ['respond', 'r', { decision: 'decline' }],
    ]);
  } finally {
    mounted.ui.unmount();
  }
});

const long = Array.from({ length: 80 }, (_, row) => `row ${row + 1}`).join(
  '\n',
);

test('wheel, drag and copy in one read use the latest page scroll position', async () => {
  const mounted = mount({
    phase: 'recovery',
    recovery: { kind: 'pending', root: '/work', paths: [], diff: long },
  });

  try {
    await until('first page', () => mounted.ui.text().includes('row 1\n'));
    const [x, y] = cell(mounted.ui, 'row 1');

    await copy(
      mounted,
      left('press', x, y) +
        `\u001b[<65;${x + 1};${y + 2}M` +
        left('drag', x + 4, y + 1) +
        left('release', x + 4, y + 1),
      'row 1\nrow 2\nrow 3',
    );
  } finally {
    mounted.ui.unmount();
  }
});

test('a batched replacement recovery cannot retain a matching range, click run or edge drag', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const a = { kind: 'pending' as const, root: '/work', paths: [], diff: long };
  const mounted = mount({ phase: 'recovery', recovery: a });
  const { ui, coordinator, copied } = mounted;

  try {
    await until('recovery A', () => ui.text().includes('row 1\n'));
    const baseline = vi.getTimerCount();
    const visibleRows = [...ui.text().matchAll(/row \d+/g)].length;
    const [x, y] = cell(ui, 'row 1');
    ui.stdin.write(left('press', x, y) + left('drag', x + 8, 23));
    await until('held edge scroll', () => vi.getTimerCount() === baseline + 1);

    await copy(
      mounted,
      '',
      long
        .split('\n')
        .slice(0, visibleRows + 1)
        .join('\n'),
    );

    const before = copied.length;
    const firstFrame = ui.frames().length;
    const b = { ...a, diff: long.replace('row 3\n', 'middle B\n') };
    coordinator.publish({ phase: 'editing' });
    coordinator.publish({ phase: 'recovery', recovery: b });
    ui.stdin.write(CMD_C);
    await until('recovery B', () => ui.text().includes('middle B'));

    assert.ok(
      ui
        .frames()
        .slice(firstFrame)
        .every((frame) =>
          stripAnsi(frame).includes('Unfinished memory changes'),
        ),
    );

    assert.equal(copied.length, before);
    assert.equal(vi.getTimerCount(), baseline);
    assert.ok(!ui.frame().includes('\u001b[7m'));
    ui.stdin.write(left('drag', x + 4, y + 1) + CMD_C);
    vi.advanceTimersByTime(150);
    await drawn();
    assert.equal(copied.length, before);
    const [nextX, nextY] = cell(ui, 'middle B');
    ui.stdin.write(click(nextX, nextY) + CMD_C);
    await drawn();
    assert.equal(copied.length, before);
    await copy(mounted, click(nextX, nextY), 'middle');
  } finally {
    ui.unmount();
  }
});

for (const edge of ['top', 'bottom'] as const) {
  test(`a held page ${edge} scroll advances on ticks and ends on release, lost motion or unmount`, async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    const mounted = mount({
      phase: 'recovery',
      recovery: { kind: 'pending', root: '/work', paths: [], diff: long },
    });

    const { ui } = mounted;
    const first = () => Number(/row (\d+)/.exec(ui.text())?.[1]);
    const outside = edge === 'top' ? 0 : 23;

    try {
      await until('first page', () => first() === 1);

      if (edge === 'top') {
        ui.stdin.write('\u001b[<65;2;5M'.repeat(5));
        await until('five rows down', () => first() === 6);
      }

      const baseline = vi.getTimerCount();
      const [x, y] = cell(ui, `row ${first()}`);
      ui.stdin.write(left('press', x, y) + left('drag', x, outside));
      await until('one edge step', () => first() === (edge === 'top' ? 5 : 2));
      assert.equal(vi.getTimerCount(), baseline + 1);
      vi.advanceTimersByTime(150);
      await drawn();
      assert.equal(first(), edge === 'top' ? 2 : 5, ui.text());
      ui.stdin.write(left('release', x, outside));
      assert.equal(vi.getTimerCount(), baseline);
      const [nextX, nextY] = cell(ui, `row ${first()}`);

      ui.stdin.write(
        left('press', nextX, nextY) + left('drag', nextX, outside),
      );

      await until(
        'second edge timer',
        () => vi.getTimerCount() === baseline + 1,
      );

      ui.stdin.write('\u001b[<35;1;1M');
      assert.equal(vi.getTimerCount(), baseline);
      const stopped = first();
      vi.advanceTimersByTime(150);
      ui.stdin.write(left('drag', nextX, outside));
      await drawn();
      assert.equal(first(), stopped);
      assert.equal(vi.getTimerCount(), baseline);
      const [lastX, lastY] = cell(ui, `row ${first()}`);

      ui.stdin.write(
        left('press', lastX, lastY) + left('drag', lastX, outside),
      );

      await until(
        'timer before unmount',
        () => vi.getTimerCount() === baseline + 1,
      );
    } finally {
      ui.unmount();
      assert.equal(vi.getTimerCount(), 0);
    }
  });
}

test('narrow page selection keeps wide characters whole and an empty viewport starts no drag', async () => {
  const mounted = mount(
    {
      requests: [
        { id: 'r', kind: 'approval', title: 'Read', detail: '日本語 alpha' },
      ],
    },
    8,
    40,
  );

  try {
    await until('wide text', () => mounted.ui.text().includes('日本語'));
    const [x, y] = cell(mounted.ui, '日本語');
    await copy(mounted, click(x + 1, y).repeat(2), '日本語');
  } finally {
    mounted.ui.unmount();
  }

  const empty = mount(
    {
      requests: [
        { id: 'r', kind: 'approval', title: 'Read', detail: 'hidden text' },
      ],
    },
    1,
    1,
  );

  try {
    await drawn();
    empty.ui.stdin.write(left('press', 0, 0) + left('drag', 0, 2) + CMD_C);
    await drawn();
    assert.deepEqual(empty.copied, []);
    assert.deepEqual(empty.calls, []);
  } finally {
    empty.ui.unmount();
  }
});

test('page highlighting excludes rows outside the copied range', async () => {
  const mounted = mount({
    requests: [
      {
        id: 'r',
        kind: 'approval',
        title: 'Read',
        detail: 'alpha beta gamma\nuntouched text',
      },
    ],
  });

  try {
    await until('the body', () => mounted.ui.text().includes('untouched text'));
    await copy(mounted, dragText(mounted.ui, 'beta'), 'beta');

    await until('the selected word drawn', () =>
      mounted.ui.frame().includes('\u001b[7mbeta'),
    );

    const untouched = mounted.ui
      .frame()
      .split('\n')
      .find((row) => row.includes('untouched text'))!;

    assert.ok(!untouched.includes('\u001b[7m'), untouched);
    assert.deepEqual(mounted.copied, ['beta']);
  } finally {
    mounted.ui.unmount();
  }
});

test('wheel then Ctrl+O in one read copies the displayed approval title after the scroll reset', async () => {
  const mounted = mount({
    requests: [
      {
        id: 'r',
        kind: 'approval',
        title: 'Approval title',
        detail: 'reason',
        diff: [
          {
            path: '/work/a',
            kind: 'add',
            hunks: [
              {
                oldStart: 0,
                newStart: 1,
                lines: Array.from(
                  { length: 45 },
                  (_, row) => `+line ${row + 1}`,
                ),
              },
            ],
          },
        ],
      },
    ],
  });

  try {
    await until('the approval title', () =>
      mounted.ui.text().includes('Approval title'),
    );

    mounted.ui.stdin.write('\u001b[<65;3;4M\u001b[111;5u');

    await until('expanded approval', () =>
      mounted.ui.text().includes('CTRL+O SHOW PREVIEW'),
    );

    await copy(
      mounted,
      dragText(mounted.ui, 'Approval title'),
      'Approval title',
    );

    assert.deepEqual(mounted.calls, []);
  } finally {
    mounted.ui.unmount();
  }
});

test('rewriting a page selection endpoint ends its held drag until a fresh press', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const mounted = mount({
    requests: [
      {
        id: 'q',
        kind: 'question',
        title: 'Question',
        detail: '',
        questions: [
          { id: 'choice', title: 'Question title', options: ['alpha', 'beta'] },
        ],
      },
    ],
  });

  const { ui, copied } = mounted;

  try {
    await until('the question', () => ui.text().includes('Question title'));
    await vi.advanceTimersByTimeAsync(500);
    await drawn();
    const [x, y] = cell(ui, 'Question title');
    const [end, last] = cell(ui, '› 1. alpha');
    ui.stdin.write(left('press', x, y) + left('drag', end + 9, last));
    await until('the held selection', () => ui.frame().includes('\u001b[7m'));
    ui.stdin.write(DOWN);

    await until('the rewritten endpoint', () =>
      ui.text().includes('› 2. beta'),
    );

    ui.stdin.write(left('drag', x + 5, y) + CMD_C);
    await drawn();
    assert.deepEqual(copied, []);
    assert.ok(!ui.frame().includes('\u001b[7m'));
    await copy(mounted, dragText(ui, 'beta'), 'beta');
    assert.deepEqual(mounted.calls, []);
  } finally {
    ui.unmount();
  }
});

test('an MCP request covering a page owns copying before and after both view transitions', async () => {
  const mounted = mount({});
  const { ui, coordinator, copied } = mounted;

  try {
    await openCommand(ui, '/help', '/new  New');
    await copy(mounted, dragText(ui, '/new'), '/new');

    coordinator.publish({
      requests: [
        {
          id: 'mcp',
          kind: 'elicitation',
          title: 'MCP input',
          detail: 'MCP payload value',
          schema: { type: 'object', properties: { value: { type: 'string' } } },
        },
      ],
    });

    ui.stdin.write(CMD_C);

    await until('the covering request', () =>
      ui.text().includes('MCP payload value'),
    );

    assert.deepEqual(copied, ['/new']);
    await copy(mounted, dragText(ui, 'payload'), 'payload');
    coordinator.publish({ requests: [] });
    ui.stdin.write(CMD_C);
    await until('the restored page', () => ui.text().includes('Keyboard help'));
    ui.stdin.write(CMD_C);
    await drawn();
    assert.deepEqual(copied, ['/new', 'payload']);
    assert.deepEqual(mounted.calls, []);
  } finally {
    ui.unmount();
  }
});
