import assert from 'node:assert/strict';
import { test } from 'vitest';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { selectedText } from '../../../src/ui/selection.js';
import { TranscriptLayout } from '../../../src/ui/transcript/transcript-layout.js';
import type { FileDiff } from '../../../src/agents/types.js';
import type { DisplayItem } from '../../../src/core/state.js';
import { applyDisplayUpdate } from '../../../src/core/state.js';

test('single-line tool titles fit the viewport while expansion retains the full command across resizes', () => {
  const title = `claim task:${'界review '.repeat(30)}`;
  const command = `'node' 'witch' --claim '${title.slice(6)}' --summary 'original command end'`;

  const item: DisplayItem = {
    id: 'control',
    kind: 'tool',
    title,
    expandedTitle: command,
    singleLine: true,
    text: 'CONTROL-OUTPUT',
    cwd: '/work',
    done: true,
  };

  const layout = new TranscriptLayout();

  for (const width of [83, 42, 120, 83]) {
    const collapsed = layout.render([item], width, new Map());
    const rows = collapsed.lines.slice().map(stripAnsi).filter(Boolean);
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.startsWith('+ ✓ claim task:界review '));
    assert.ok(rows[0]!.endsWith('…'));
    assert.ok(stringWidth(rows[0]!) <= width);
    const anchor = collapsed.anchorAt(0)!;
    assert.equal(collapsed.rowOf(anchor), 0);
    const expanded = layout.render([item], width, new Map([['control', true]]));
    const text = stripAnsi(expanded.lines.slice().join('\n'));
    assert.ok(text.includes("'node' 'witch' --claim"));
    assert.match(text, /'original\s+command\s+end'/);
    assert.ok(text.includes('CONTROL-OUTPUT'));
    assert.ok(!text.includes('…'));
    assert.equal(item.expandedTitle, command);
  }

  const ordinary = { ...item, singleLine: undefined };
  assert.ok(layout.render([ordinary], 83, new Map()).lines.length > 2);
});

test('an expanded title change invalidates an appended tool output cache', () => {
  let items = applyDisplayUpdate([], {
    id: 't',
    kind: 'tool',
    title: 'peers',
    expandedTitle: 'first original command',
    singleLine: true,
    text: 'first output\n',
    cwd: '/work',
    done: false,
  });

  const layout = new TranscriptLayout();
  const expanded = new Map([['t', true]]);
  layout.render(items, 83, expanded);

  items = applyDisplayUpdate(items, {
    id: 't',
    kind: 'tool',
    title: '',
    expandedTitle: 'second original command',
    text: 'second output',
    cwd: '/work',
    done: false,
  });

  const rows = layout.render(items, 83, expanded).lines.slice().map(stripAnsi);
  assert.ok(rows.includes('− … second original command'));
  assert.ok(!rows.some((row) => row.includes('first original command')));
  assert.ok(rows.includes('first output'));
  assert.ok(rows.includes('second output'));
});

test('full diff choices survive cached renders and resizes', () => {
  const item: DisplayItem = {
    id: 'full',
    kind: 'tool',
    title: 'Write',
    text: '',
    cwd: '/work',
    done: true,
    diff: [
      {
        path: '/work/a.txt',
        kind: 'add',
        hunks: [
          {
            oldStart: 0,
            newStart: 1,
            lines: [
              '+' + 'wide '.repeat(20),
              ...Array.from({ length: 11 }, (_, i) => `+line_${i + 2}`),
            ],
          },
        ],
      },
    ],
  };

  const following: DisplayItem = {
    id: 'after',
    kind: 'tool',
    title: 'Following tool',
    text: '',
    cwd: '/work',
    done: true,
  };

  const items = [item, following];
  const layout = new TranscriptLayout();

  for (const full of [false, true, false, true]) {
    const rendered = layout.render(
      items,
      40,
      new Map(),
      new Set(full ? ['full'] : []),
    );

    assert.equal(
      rendered.lines.slice().some((line) => line.includes('line_12')),
      full,
    );
  }

  const full = new Set(['full']);
  const initial = layout.render(items, 40, new Map(), full);

  const last = initial.anchorAt(
    initial.lines.slice().findIndex((line) => line.includes('line_12')),
  )!;

  const after = initial.anchorAt(initial.starts.get('after')!)!;

  for (const width of [100, 30]) {
    const resized = layout.render(items, width, new Map(), full);

    assert.equal(
      stripAnsi(resized.lines.at(resized.rowOf(last))!).trim(),
      '12 +line_12',
    );

    assert.equal(
      stripAnsi(resized.lines.at(resized.rowOf(after))!),
      '+ ✓ Following tool',
    );
  }

  const closed = layout.render(items, 30, new Map([['full', false]]), full);

  assert.equal(
    closed.lines.slice().some((line) => line.includes('line_12')),
    false,
  );
});

test('expanding a tool shows its complete output without losing links', () => {
  const item: DisplayItem = {
    id: 'tool',
    kind: 'tool',
    title: 'Build',
    text: 'https://example.com/log\nsrc/main.ts:9\nDone',
    cwd: '/work/project',
    done: true,
  };

  const layout = new TranscriptLayout();

  assert.doesNotMatch(
    stripAnsi(layout.render([item], 60, new Map()).lines.slice().join('\n')),
    /Done/,
  );

  const expanded = layout.render([item], 60, new Map([['tool', true]]));
  assert.match(stripAnsi(expanded.lines.slice().join('\n')), /Done/);

  assert.ok(
    expanded.lines
      .slice()
      .join('\n')
      .includes('vscode://file/work/project/src/main.ts:9'),
  );
});

test("a tool's title links the path its field gave whole, spaces and U+202F included", () => {
  const path = '/shots/Screenshot 2026-10-26 at 3.35.40\u202fPM.png';

  const lines = new TranscriptLayout()
    .render(
      [
        {
          id: 'read',
          kind: 'tool',
          title: `Read  ${path}`,
          path,
          text: '',
          cwd: '/work',
          done: true,
        },
      ],
      100,
      new Map(),
    )
    .lines.slice()
    .join('\n');

  assert.deepEqual(
    [
      // eslint-disable-next-line no-control-regex
      ...lines.matchAll(/\u001b\]8;;([^\u0007]+)\u0007(.*?)\u001b\]8;;\u0007/g),
    ].map(([, target, text]) => [target, stripAnsi(text!)]),
    [
      [
        'file:///shots/Screenshot%202026-10-26%20at%203.35.40%E2%80%AFPM.png',
        path,
      ],
    ],
  );
});

test("a tool's path links after its name, not where the name holds the same text", () => {
  const lines = new TranscriptLayout()
    .render(
      [
        {
          id: 'read',
          kind: 'tool',
          title: 'files.read  read',
          path: 'read',
          text: '',
          cwd: '/work',
          done: true,
        },
      ],
      100,
      new Map(),
    )
    .lines.slice()
    .join('\n');

  assert.ok(
    lines.includes('files.read  \u001b]8;;vscode://file/work/read\u0007'),
    JSON.stringify(lines),
  );
});

test("a tool's linked path reaches the terminal without the escape sequences in it", () => {
  const path = '/shots/a\u001b]0;title\u0007\u001b[2Jb.png';

  const lines = new TranscriptLayout()
    .render(
      [
        {
          id: 'read',
          kind: 'tool',
          title: `Read  ${path}`,
          path,
          text: '',
          cwd: '/work',
          done: true,
        },
      ],
      100,
      new Map(),
    )
    .lines.slice()
    .join('\n');

  assert.ok(!lines.includes('\u001b]0;'), JSON.stringify(lines));
  assert.ok(!lines.includes('\u001b[2J'), JSON.stringify(lines));
  assert.equal(stripAnsi(lines).trimEnd(), '+ ✓ Read  /shots/a[2Jb.png');
});

test('completed output is cached when another message streams', () => {
  const items: DisplayItem[] = [
    {
      id: 'large',
      kind: 'tool',
      title: 'Long output',
      text: 'log line\n'.repeat(10000),
      cwd: '/work',
      done: true,
    },
    { id: 'reply', kind: 'assistant', text: 'First', cwd: '/work' },
  ];

  const layout = new TranscriptLayout();
  const first = layout.render(items, 80, new Map([['large', true]]));

  const second = layout.render(
    [items[0]!, { ...items[1]!, text: 'First response' }],
    80,
    new Map([['large', true]]),
  );

  assert.equal(first.blocks[0], second.blocks[0]);
  assert.match(stripAnsi(second.lines.at(-2) ?? ''), /First response/);
});

test('a reading anchor follows its original log line when a narrower window wraps earlier lines', () => {
  const item: DisplayItem = {
    id: 'log',
    kind: 'tool',
    title: 'Build',
    cwd: '/work',
    done: true,
    text: Array.from(
      { length: 1000 },
      (_, index) =>
        `Line ${index + 1}: https://example.com/result/${index + 1}`,
    ).join('\n'),
  };

  const layout = new TranscriptLayout();
  const wide = layout.render([item], 100, new Map([['log', true]]));

  const row = wide.lines
    .slice()
    .findIndex((line) => stripAnsi(line).startsWith('Line 700:'));

  const anchor = wide.anchorAt(row)!;
  const narrow = layout.render([item], 30, new Map([['log', true]]));
  assert.match(stripAnsi(narrow.lines.at(narrow.rowOf(anchor))!), /^Line 700:/);
  assert.doesNotMatch(stripAnsi(narrow.lines.at(row)!), /^Line 700:/);
});

test('expanded logs exceed the argument limit with complete output and usable anchors', () => {
  const layout = new TranscriptLayout();

  for (const wrapped of [false, true]) {
    const item: DisplayItem = {
      id: 'large',
      kind: 'tool',
      title: 'Log',
      cwd: '/work',
      done: true,
      text: wrapped
        ? 'x'.repeat(400000)
        : Array<string>(200000).fill('line').join('\n'),
    };

    const output = layout.render(
      [item],
      wrapped ? 2 : 80,
      new Map([['large', true]]),
    );

    assert.equal(
      output.lines
        .slice()
        .filter((line) => stripAnsi(line) === (wrapped ? 'xx' : 'line')).length,
      200000,
    );

    assert.equal(stripAnsi(output.lines.at(-2)!), wrapped ? 'xx' : 'line');
    const anchor = output.anchorAt(150000)!;
    assert.equal(anchor.item, 'large');

    if (wrapped) assert.equal(anchor.line, 1);

    assert.equal(output.rowOf(anchor), 150000);
  }
});

test('a reading anchor keeps its position within a wrapped line after resize', () => {
  const item: DisplayItem = {
    id: 'log',
    kind: 'tool',
    title: 'Log',
    text: 'x'.repeat(10000),
    cwd: '/work',
    done: true,
  };

  const layout = new TranscriptLayout();
  const expanded = new Map([['log', true]]);
  const original = layout.render([item], 80, expanded);
  const anchor = original.anchorAt(90)!;
  assert.equal(original.rowOf(anchor), 90);
  assert.equal(layout.render([item], 40, expanded).rowOf(anchor), 179);
  assert.equal(layout.render([item], 160, expanded).rowOf(anchor), 45);
});

test('an anchor on a line that no longer renders falls back to its item start', () => {
  const item: DisplayItem = {
    id: 'log',
    kind: 'tool',
    title: 'Log',
    text: 'a\nb\nc',
    cwd: '/work',
    done: true,
  };

  const notice: DisplayItem = {
    id: 'notice',
    kind: 'notice',
    text: 'one\ntwo',
    cwd: '/work',
  };

  const layout = new TranscriptLayout();
  const expanded = layout.render([notice, item], 80, new Map([['log', true]]));
  const anchor = expanded.anchorAt(expanded.starts.get('log')! + 2)!;
  const collapsed = layout.render([notice, item], 80, new Map());
  assert.ok(collapsed.starts.get('log')! > 0);
  assert.equal(collapsed.rowOf(anchor), collapsed.starts.get('log'));
});

test('a reading anchor includes spaces trimmed while wrapping a title', () => {
  const item: DisplayItem = {
    id: 'log',
    kind: 'tool',
    title: Array.from(
      { length: 20 },
      (_, index) => `word${String(index).padStart(3, '0')}`,
    ).join(' '),
    text: 'body',
    cwd: '/work',
    done: true,
  };

  const layout = new TranscriptLayout();
  const narrow = layout.render([item], 40, new Map());
  const anchor = narrow.anchorAt(2)!;
  assert.match(stripAnsi(narrow.lines.at(2)!), /^word009/);
  const wide = layout.render([item], 80, new Map());
  assert.equal(wide.rowOf(anchor), 1);
  assert.match(stripAnsi(wide.lines.at(wide.rowOf(anchor))!), /^word009/);
});

test('a title row changed by wrapping does not take another row’s anchor', () => {
  const item: DisplayItem = {
    id: 'tool',
    kind: 'tool',
    title: `${'a'.repeat(53)} \u00a0\u200b ${'b'.repeat(55)} tail`,
    text: '',
    cwd: '/work',
    done: true,
  };

  const output = new TranscriptLayout().render([item], 58, new Map());

  assert.deepEqual(
    output.lines.slice().map((line) => stripAnsi(line)),
    [`+ ✓ ${'a'.repeat(53)}`, `\u200b${'b'.repeat(55)}`, 'tail', ''],
  );

  assert.deepEqual(
    [0, 1, 2, 3].map((row) => output.rowOf(output.anchorAt(row)!)),
    [0, 1, 2, 3],
  );
});

test('anchors keep item boundaries and wrapped offsets in their own render frame', () => {
  const items: DisplayItem[] = [
    { id: 'first', kind: 'notice', text: 'first', cwd: '/work' },
    {
      id: 'middle',
      kind: 'tool',
      title: 'Build',
      text: 'abcdefghijklmnop\nnext',
      cwd: '/work',
      done: true,
    },
    { id: 'last', kind: 'user', text: 'last', cwd: '/work' },
  ];

  const layout = new TranscriptLayout();
  const first = layout.render(items, 12, new Map([['middle', true]]));

  const expected = [
    ['first', 0, 0],
    ['first', 1, 0],
    ['middle', 0, 0],
    ['middle', 1, 0],
    ['middle', 1, 12],
    ['middle', 2, 0],
    ['middle', 3, 0],
    ['last', 0, 0],
    ['last', 1, 0],
    ['last', 2, 0],
  ].map(([item, line, offset]) => ({ item, line, offset }));

  assert.deepEqual(
    first.lines.slice().map((_, row) => first.anchorAt(row)),
    expected,
  );

  const second = layout.render(items.slice(1), 24, new Map());

  assert.deepEqual(
    second.lines.slice().map((_, row) => second.anchorAt(row)),
    [
      { item: 'middle', line: 0, offset: 0 },
      { item: 'middle', line: 1, offset: 0 },
      { item: 'last', line: 0, offset: 0 },
      { item: 'last', line: 1, offset: 0 },
      { item: 'last', line: 2, offset: 0 },
    ],
  );

  assert.deepEqual(
    first.lines.slice().map((_, row) => first.anchorAt(row)),
    expected,
  );

  assert.equal(first.anchorAt(-1), undefined);
  assert.equal(layout.render([], 12, new Map()).anchorAt(0), undefined);

  assert.deepEqual(first.anchorAt(first.lines.length), {
    item: 'last',
    line: 0,
    offset: 0,
  });
});

test('anchor lookups stay fast across ten thousand messages', () => {
  const items: DisplayItem[] = Array.from({ length: 10000 }, (_, index) => ({
    id: `message-${index}`,
    kind: 'user',
    text: `message ${index}`,
    cwd: '/work',
  }));

  const output = new TranscriptLayout().render(items, 58, new Map());
  assert.equal(output.lines.length, 30000);

  const expected = items.flatMap((item) =>
    [0, 1, 2].map((line) => ({ item: item.id, line, offset: 0 })),
  );

  const started = performance.now();
  const actual = output.lines.slice().map((_, row) => output.anchorAt(row));
  const elapsed = performance.now() - started;
  assert.deepEqual(actual, expected);
  assert.ok(elapsed < 500, `anchor lookups took ${elapsed} ms`);
});

test("a shell tool row shows expanded until toggled, and an agent's tool row collapsed until toggled", () => {
  const items: DisplayItem[] = [
    {
      id: 's',
      kind: 'tool',
      title: 'ls',
      text: 'shell-a\nshell-b',
      cwd: '/work',
      done: true,
      shell: true,
    },
    {
      id: 't',
      kind: 'tool',
      title: 'Read',
      text: 'agent-x',
      cwd: '/work',
      done: true,
    },
  ];

  const layout = new TranscriptLayout();

  const lines = (expanded: ReadonlyMap<string, boolean>) =>
    stripAnsi(
      layout.render(items, 60, expanded).lines.slice().join('\n'),
    ).split('\n');

  const untoggled = lines(new Map());
  assert.ok(untoggled.includes('− ✓ ls'), untoggled.join('\n'));
  assert.ok(untoggled.includes('shell-a') && untoggled.includes('shell-b'));
  assert.ok(untoggled.includes('+ ✓ Read'));
  assert.ok(!untoggled.includes('agent-x'));

  const toggled = lines(
    new Map([
      ['s', false],
      ['t', true],
    ]),
  );

  assert.ok(toggled.includes('+ ✓ ls'), toggled.join('\n'));
  assert.ok(!toggled.includes('shell-a'));
  assert.ok(toggled.includes('− ✓ Read'));
  assert.ok(toggled.includes('agent-x'));
});

test("a tool row under Witch's name shows the native name only while expanded", () => {
  const items: DisplayItem[] = [
    {
      id: 't',
      kind: 'tool',
      title: 'Spell  handoff',
      expandedTitle: 'Spell (Skill)  handoff',
      text: 'Launching skill: handoff',
      cwd: '/work',
      done: true,
    },
  ];

  const layout = new TranscriptLayout();

  const lines = (expanded: boolean) =>
    stripAnsi(
      layout
        .render(items, 60, new Map([['t', expanded]]))
        .lines.slice()
        .join('\n'),
    ).split('\n');

  assert.ok(
    lines(false).includes('+ ✓ Spell  handoff'),
    lines(false).join('\n'),
  );

  assert.ok(
    lines(true).includes('− ✓ Spell (Skill)  handoff'),
    lines(true).join('\n'),
  );
});

test('a tool that changed a file under its directory shows its diff until toggled, one elsewhere collapsed until toggled, and a diff that arrives under unchanged output still shows', () => {
  const diff = (path: string): FileDiff[] => [
    {
      path,
      kind: 'update',
      hunks: [{ oldStart: 1, newStart: 1, lines: [' a', '-b', '+B'] }],
    },
  ];

  const items: DisplayItem[] = [
    {
      id: 'in',
      kind: 'tool',
      title: 'Edit in',
      text: '',
      cwd: '/work',
      done: true,
      diff: diff('/work/a.txt'),
    },
    {
      id: 'out',
      kind: 'tool',
      title: 'Edit out',
      text: '',
      cwd: '/work',
      done: true,
      diff: diff('/elsewhere/a.txt'),
    },
  ];

  const layout = new TranscriptLayout();

  const lines = (
    shown: DisplayItem[],
    expanded: ReadonlyMap<string, boolean>,
  ) =>
    layout
      .render(shown, 60, expanded)
      .lines.slice()
      .map((line) => stripAnsi(line).trimEnd());

  const untoggled = lines(items, new Map());
  assert.ok(untoggled.includes('− ✓ Edit in'), untoggled.join('\n'));
  assert.ok(untoggled.includes('Update ./a.txt +1 -1'));
  assert.ok(untoggled.includes('2 +B'));
  assert.ok(untoggled.includes('+ ✓ Edit out'));
  assert.ok(!untoggled.includes('Update /elsewhere/a.txt +1 -1'));

  const toggled = lines(
    items,
    new Map([
      ['in', false],
      ['out', true],
    ]),
  );

  assert.ok(toggled.includes('+ ✓ Edit in'), toggled.join('\n'));
  assert.ok(toggled.includes('− ✓ Edit out'));
  assert.ok(toggled.includes('Update /elsewhere/a.txt +1 -1'));
  assert.ok(!toggled.includes('Update ./a.txt +1 -1'));

  const growing: DisplayItem = {
    id: 'g',
    kind: 'tool',
    title: 'Patch',
    text: 'out\n',
    cwd: '/work',
    done: false,
  };

  lines([growing], new Map([['g', true]]));

  const patched = lines(
    [{ ...growing, diff: diff('/elsewhere/a.txt') }],
    new Map([['g', true]]),
  );

  assert.ok(
    patched.includes('Update /elsewhere/a.txt +1 -1'),
    patched.join('\n'),
  );
});

test('a tool in a conversation at / shows the diff of a file anywhere until toggled', () => {
  const item: DisplayItem = {
    id: 'root',
    kind: 'tool',
    title: 'Edit root',
    text: '',
    cwd: '/',
    done: true,
    diff: [
      {
        path: '/Users/me/a.txt',
        kind: 'update',
        hunks: [{ oldStart: 1, newStart: 1, lines: [' a', '-b', '+B'] }],
      },
    ],
  };

  const layout = new TranscriptLayout();

  const lines = (expanded: ReadonlyMap<string, boolean>) =>
    layout
      .render([item], 60, expanded)
      .lines.slice()
      .map((line) => stripAnsi(line).trimEnd());

  const untoggled = lines(new Map());
  assert.ok(untoggled.includes('− ✓ Edit root'), untoggled.join('\n'));
  assert.ok(untoggled.includes('Update /Users/me/a.txt +1 -1'));
  assert.ok(lines(new Map([['root', false]])).includes('+ ✓ Edit root'));
});

test('explicit expansion choices survive a project diff arriving', () => {
  const pending: DisplayItem = {
    id: 'edit',
    kind: 'tool',
    title: 'Edit',
    cwd: '/work',
    text: JSON.stringify({
      file_path: '/work/a.txt',
      old_string: 'b',
      new_string: 'B',
    }),
    done: false,
  };

  const completed: DisplayItem = {
    ...pending,
    text: '',
    done: true,
    diff: [
      {
        path: '/work/a.txt',
        kind: 'update',
        hunks: [{ oldStart: 1, newStart: 1, lines: [' a', '-b', '+B'] }],
      },
    ],
  };

  for (const [choice, before, after] of [
    [undefined, false, true],
    [true, true, true],
    [false, false, false],
  ] as const) {
    const layout = new TranscriptLayout();
    const choices = new Map<string, boolean>();

    if (choice !== undefined) choices.set(pending.id, choice);

    const render = (item: DisplayItem) =>
      layout
        .render([item], 60, choices)
        .lines.slice()
        .map((line) => stripAnsi(line).trimEnd());

    const initial = render(pending);
    assert.equal(initial[0], `${before ? '−' : '+'} … Edit`);

    assert.equal(
      initial.some((line) => line.includes('old_string')),
      before,
    );

    const result = render(completed);
    assert.equal(result[0], `${after ? '−' : '+'} ✓ Edit`);
    assert.equal(result.includes('2 +B'), after);
  }
});

test('one-column diff rows keep copy breaks and widen prefix anchors onto their source line', () => {
  const item: DisplayItem = {
    id: 'diff',
    kind: 'tool',
    title: 'Edit',
    text: '',
    cwd: '/work',
    done: true,
    diff: [
      {
        path: '/work/a.ts',
        kind: 'add',
        hunks: [{ oldStart: 0, newStart: 1, lines: ['+abcdef'] }],
      },
    ],
  };

  const layout = new TranscriptLayout();
  const narrow = layout.render([item], 1, new Map());

  const changed = narrow.lines
    .slice()
    .flatMap((text, row) =>
      text.includes('\u001b[48;2;34;92;43m') ? [row] : [],
    );

  assert.ok(changed.length > 1);

  for (const row of changed.slice(1))
    assert.equal(narrow.joinBefore(row), '\n');

  const prefix = changed.find((row) => narrow.anchorAt(row)!.offset < 0);
  assert.notEqual(prefix, undefined);
  const wide = layout.render([item], 80, new Map());

  assert.match(
    stripAnsi(wide.lines.at(wide.rowOf(narrow.anchorAt(prefix!)!))!),
    /1 \+abcdef/,
  );
});

test('a scroll anchor on a diff line stays on that line when a resize rewraps the lines above it', () => {
  const item: DisplayItem = {
    id: 't',
    kind: 'tool',
    title: 'Edit',
    text: '',
    cwd: '/work',
    done: true,
    diff: [
      {
        path: '/work/a.md',
        kind: 'update',
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            lines: [' ' + 'long '.repeat(30), '-old', '+new', ' tail'],
          },
        ],
      },
    ],
  };

  const layout = new TranscriptLayout();

  const plainAt = (width: number, row: number) =>
    stripAnsi(layout.render([item], width, new Map()).lines.at(row)!).trimEnd();

  const narrow = layout.render([item], 40, new Map());

  const tail = narrow.lines
    .slice()
    .findIndex((line) => stripAnsi(line).includes('tail'));

  const continuation = narrow.anchorAt(3)!;
  const anchor = narrow.anchorAt(tail)!;
  const wide = layout.render([item], 200, new Map());

  assert.equal(
    stripAnsi(wide.lines.at(wide.rowOf(anchor))!).trimEnd(),
    '3  tail',
  );

  // the long line no longer wraps, so its continuation's anchor lands on the line itself
  assert.match(plainAt(200, wide.rowOf(continuation)), /^1 {2}long long/);

  assert.equal(
    plainAt(30, layout.render([item], 30, new Map()).rowOf(anchor)),
    '3  tail',
  );
});

test('wrapped body rows drop the space they broke at and keep indentation and copied text', () => {
  const text = '**abcdefghij klm**\n\n```\n      indented code\n```';
  const item: DisplayItem = { id: 'a', kind: 'assistant', text, cwd: '/work' };
  const narrow = new TranscriptLayout().render([item], 10, new Map());
  const rows = narrow.lines.slice();
  const plain = rows.map((row) => stripAnsi(row));

  assert.deepEqual(plain.slice(1, -1), [
    'abcdefghij',
    'klm',
    '',
    '      ',
    'indented ',
    'code',
  ]);

  assert.ok(rows[2]!.includes('\u001b[1m'));

  const copied = plain
    .map((row, index) => (index ? narrow.joinBefore(index) : '') + row)
    .join('');

  assert.equal(copied, 'Assistant\nabcdefghij klm\n\n      indented code\n');

  const tight = new TranscriptLayout().render(
    [{ ...item, text: 'abc def' }],
    3,
    new Map(),
  );

  assert.deepEqual(tight.lines.slice().map(stripAnsi).slice(3, -1), [
    'abc',
    'def',
  ]);
});

test("a line's rows are every row wrapped from it, and stop at the next line, the next item and each diff row", () => {
  const items: DisplayItem[] = [
    {
      id: 'a',
      kind: 'assistant',
      text: 'alpha beta gamma delta epsilon\nnext',
      cwd: '/work',
    },
    { id: 'n', kind: 'notice', text: 'notice words', cwd: '/work' },
    {
      id: 't',
      kind: 'tool',
      title: 'Edit',
      text: '',
      cwd: '/work',
      done: true,
      diff: [
        {
          path: '/work/a.txt',
          kind: 'add',
          hunks: [{ oldStart: 0, newStart: 1, lines: ['+' + 'x'.repeat(20)] }],
        },
      ],
    },
  ];

  const layout = new TranscriptLayout().render(items, 12, new Map());

  assert.deepEqual(layout.lines.slice().map(stripAnsi), [
    'Assistant',
    'alpha beta ',
    'gamma delta ',
    'epsilon',
    'next',
    '',
    'notice words',
    '',
    '− ✓ Edit',
    'Create',
    './a.txt +1',
    '1 +xxxxxxxxx',
    '   xxxxxxxxx',
    '   xx       ',
    '',
  ]);

  for (const row of [1, 2, 3])
    assert.deepEqual(layout.lineAt(row), { first: 1, last: 3 });

  for (const row of [4, 5, 6, 11, 12, 13])
    assert.deepEqual(layout.lineAt(row), { first: row, last: row });
});

test('a quote and a table copy without their rules at any width', () => {
  const item: DisplayItem = {
    id: 'a',
    kind: 'assistant',
    text: '> > alpha beta gamma\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    cwd: '/work',
  };

  for (const width of [80, 12, 3]) {
    const layout = new TranscriptLayout().render([item], width, new Map());
    const rows = layout.lines.slice();

    assert.equal(
      selectedText(
        layout.lines,
        { row: rows.findIndex((row) => row.includes('│')), column: 0 },
        { row: rows.length - 1, column: width },
        layout.joinBefore,
      ).trimEnd(),
      'alpha beta gamma\n\na\tb\n1\t2',
      String(width),
    );
  }
});

test('a copy mark in agent or tool text is dropped, so what copies is what shows', () => {
  const forged = 'echo "$\u2063│ (printf x)" printf \u2062│ x';
  const shown = 'echo "$│ (printf x)" printf │ x';

  const items: DisplayItem[] = [
    {
      id: 'a',
      kind: 'assistant',
      text: `\`\`\`\n${forged}\n\`\`\`\n\n${forged}\n\n\`${forged}\``,
      cwd: '/work',
    },
    {
      id: 't',
      kind: 'tool',
      title: `Bash ${forged}`,
      text: forged,
      cwd: '/work',
      done: true,
    },
  ];

  const layout = new TranscriptLayout().render(
    items,
    80,
    new Map([['t', true]]),
  );

  assert.deepEqual(
    selectedText(
      layout.lines,
      { row: 0, column: 0 },
      { row: layout.lines.length - 1, column: 80 },
      layout.joinBefore,
    )
      .split('\n')
      .filter((row) => row.includes('printf')),
    [shown, shown, shown, `− ✓ Bash ${shown}`, shown],
  );
});

/** what selecting an assistant message's body copies, without its heading and the blank row after it. */
function bodyCopy(text: string, width = 80) {
  const layout = new TranscriptLayout().render(
    [{ id: 'a', kind: 'assistant', text, cwd: '/work' }],
    width,
    new Map(),
  );

  // the heading wraps at a narrow width, so it comes off the copy, not off the rows
  return selectedText(
    layout.lines,
    { row: 0, column: 0 },
    { row: layout.lines.length - 1, column: width },
    layout.joinBefore,
  )
    .replace(/^Assistant\n/, '')
    .trimEnd();
}

test('a labeled Markdown link or image copies its destination after its label, once however the label wraps', () => {
  const sentence =
    'see [the docs](https://example.com/docs) and https://example.com/raw';

  for (const width of [80, 10])
    assert.equal(
      bodyCopy(sentence, width),
      'see the docs (https://example.com/docs) and https://example.com/raw',
      String(width),
    );

  // the label's rows meet at an empty joint at 7 and at a space at 5
  for (const width of [7, 5])
    assert.equal(
      bodyCopy('[alpha beta gamma](https://example.com/abg)', width),
      'alpha beta gamma (https://example.com/abg)',
      String(width),
    );

  for (const [text, copied] of [
    ['[docs](https://example.com/docs)', 'docs (https://example.com/docs)'],
    [
      '[guide](HTTPS://example.com/manual)',
      'guide (HTTPS://example.com/manual)',
    ],
    ['[ref][r]\n\n[r]: https://example.com/r', 'ref (https://example.com/r)'],
    ['[the notes](src/a.ts:3)', 'the notes (/work/src/a.ts:3)'],
    ['[open](src/👩‍💻.ts)', 'open (/work/src/👩‍💻.ts)'],
    [
      '![photo](https://example.com/image.png)',
      '[photo] (https://example.com/image.png)',
    ],
    [
      '[the\ndocs](https://example.com/docs)',
      'the (https://example.com/docs)\ndocs (https://example.com/docs)',
    ],
    [
      '[a](https://example.com/x) [b](https://example.com/x)',
      'a (https://example.com/x) b (https://example.com/x)',
    ],
    [
      '[a](https://example.com/one)[b](https://example.com/two)',
      'a (https://example.com/one)b (https://example.com/two)',
    ],
    [
      '| [a](https://example.com/x) | b |\n|---|---|',
      'a (https://example.com/x)\tb',
    ],
  ] as const)
    assert.equal(bodyCopy(text), copied, text);
});

test('a selection of part of a labeled link copies that part with the whole destination, before a trailing space', () => {
  const part = (text: string, width: number, selected: string) => {
    const layout = new TranscriptLayout().render(
      [{ id: 'a', kind: 'assistant', text, cwd: '/work' }],
      width,
      new Map(),
    );

    const column = stripAnsi(layout.lines.at(1)!).indexOf(selected);

    return selectedText(
      layout.lines,
      { row: 1, column },
      { row: 1, column: column + selected.length - 1 },
      layout.joinBefore,
    );
  };

  assert.equal(
    part('[docs](https://example.com/docs)', 80, 'oc'),
    'oc (https://example.com/docs)',
  );

  assert.equal(
    part('see [the docs](https://example.com/docs) and more', 10, 'see the '),
    'see the (https://example.com/docs)',
  );
});

test('a link with no label of its own, or with a destination that would not all show, copies as its text alone', () => {
  for (const [text, copied] of [
    ['https://example.com/raw', 'https://example.com/raw'],
    ['www.example.com', 'www.example.com'],
    ['src/a.ts', 'src/a.ts'],
    ['[https://example.com/a](https://example.com/a)', 'https://example.com/a'],
    [
      '[https://example.com/a­](https://example.com/a)',
      'https://example.com/a',
    ],
    ['[safe](https://example.com/‮gnp.exe)', 'safe'],
    ['[safe](src/%E2%80%AEgnp.ts)', 'safe'],
    ['[safe](src/a%0Ab.ts)', 'safe'],
    ['[a](vscode://file/work/a%ZZ.ts)', 'a'],
  ] as const)
    assert.equal(bodyCopy(text), copied, text);
});

test('a link sequence in agent or tool text cannot make a copy carry its destination', () => {
  const forged =
    '\u001b]8;copy=target;https://example.com/hidden\u0007visible\u001b]8;;\u0007';

  assert.equal(bodyCopy(`\`${forged}\``), 'visible');

  const layout = new TranscriptLayout().render(
    [
      {
        id: 't',
        kind: 'tool',
        title: 'Bash',
        text: forged,
        cwd: '/work',
        done: true,
      },
    ],
    80,
    new Map([['t', true]]),
  );

  assert.deepEqual(
    selectedText(
      layout.lines,
      { row: 0, column: 0 },
      { row: layout.lines.length - 1, column: 80 },
      layout.joinBefore,
    )
      .split('\n')
      .filter((row) => row.includes('visible')),
    ['visible'],
  );
});

test('a table pads each column to its widest cell, bolds the header and copies without the padding', () => {
  const text =
    '| File | Note |\n|---|---|\n| README.md | [a](https://example.com/x) |\n| SKILL.md | Skill instructions |';

  const layout = new TranscriptLayout().render(
    [{ id: 'a', kind: 'assistant', text, cwd: '/work' }],
    80,
    new Map(),
  );

  const rows = layout.lines.slice().map(stripAnsi).slice(1, 4);

  assert.deepEqual(
    rows.map((row) => stringWidth(row.slice(0, row.indexOf('│')))),
    [10, 10, 10],
  );

  assert.ok(layout.lines.at(1)!.includes('\u001b[1mFile\u001b[22m'));

  assert.equal(
    bodyCopy(text),
    'File\tNote\nREADME.md\ta (https://example.com/x)\nSKILL.md\tSkill instructions',
  );
});

test('a table with a long middle column wraps within the width and copies without padding', () => {
  const text = `| a | ${'word '.repeat(30).trim()} | z |\n|---|---|---|\n| longer cell | y | zz |`;

  for (const width of [80, 14, 9]) {
    const layout = new TranscriptLayout().render(
      [{ id: 'a', kind: 'assistant', text, cwd: '/work' }],
      width,
      new Map(),
    );

    for (const line of layout.lines.slice())
      assert.ok(stringWidth(stripAnsi(line)) <= width, `${width}: ${line}`);

    assert.ok(!bodyCopy(text, width).includes(' '), String(width));
  }

  assert.equal(
    bodyCopy(text),
    `a\t${'word '.repeat(30).trim()}\tz\nlonger cell\ty\tzz`,
  );
});

test('a header holding inline code, bold or a link still draws bold and aligned', () => {
  const text =
    '| `code` | **b** | [l](https://example.com/x) |\n|---|---|---|\n| 1 | 2 | 3 |';

  const layout = new TranscriptLayout().render(
    [{ id: 'a', kind: 'assistant', text, cwd: '/work' }],
    80,
    new Map(),
  );

  const [header, row] = layout.lines.slice().slice(1, 3).map(stripAnsi);
  assert.equal(header!.indexOf('│'), row!.indexOf('│'));
  assert.equal(header!.lastIndexOf('│'), row!.lastIndexOf('│'));
  assert.equal(bodyCopy(text), 'code\tb\tl (https://example.com/x)\n1\t2\t3');
});
