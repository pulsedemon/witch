import assert from 'node:assert/strict';
import { test } from 'vitest';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
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
