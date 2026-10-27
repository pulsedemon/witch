import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import type { Profiler } from 'node:inspector';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { Lexer } from 'marked';
import stripAnsi from 'strip-ansi';
import type { FileDiff } from '../src/agents/types.js';
import type { DisplayItem } from '../src/core/state.js';
import { applyDisplayUpdate } from '../src/core/state.js';
import { Graphics, placeholder } from '../src/ui/images.js';
import { TranscriptLayout } from '../src/ui/transcript-layout.js';
import { loaded } from './fixtures/graphics.js';
import { png } from './fixtures/png.js';
import { scratch } from './fixtures/scratch.js';

test('unchanged resizes reuse text and diff preparation', async () => {
  const watched = new Map([
    [
      new URL('../src/ui/markdown.ts', import.meta.url).href,
      ['markdown', 'markdownAppend'],
    ],
    [
      new URL('../src/ui/links.ts', import.meta.url).href,
      ['linkify', 'linkifyAppend'],
    ],
    [new URL('../src/ui/diff.ts', import.meta.url).href, ['changedWords']],
    [new URL('../src/ui/syntax.ts', import.meta.url).href, ['syntaxSpans']],
  ]);
  const names = [...watched.values()].flat();
  const counts = ({ result }: Profiler.TakePreciseCoverageReturnType) => {
    const found: Record<string, number> = Object.fromEntries(
      names.map((name) => [name, 0]),
    );
    for (const script of result) {
      const functions = watched.get(script.url);
      if (!functions) continue;
      for (const fn of script.functions)
        if (functions.includes(fn.functionName))
          found[fn.functionName] =
            found[fn.functionName]! + fn.ranges[0]!.count;
    }
    return found;
  };
  const items: DisplayItem[] = [
    {
      id: 'user',
      kind: 'user',
      cwd: '/work',
      text: 'See **src/user.ts:3** and https://example.com/user.',
    },
    {
      id: 'assistant',
      kind: 'assistant',
      cwd: '/work',
      text: 'First.\n\nSecond.\n\nA [source](src/answer.ts:7).',
    },
    {
      id: 'reference',
      kind: 'assistant',
      cwd: '/work',
      text: '[guide][g]\n\n[g]: src/guide.ts',
    },
    {
      id: 'tool',
      kind: 'tool',
      cwd: '/work',
      title: 'Read src/main.ts',
      text: 'https://example.com/log\nFinished',
    },
    {
      id: 'diff',
      kind: 'tool',
      cwd: '/work',
      title: 'Edit',
      text: 'Updated src/changed.ts:2',
      diff: [
        {
          path: '/work/src/changed.ts',
          kind: 'update',
          hunks: [
            {
              oldStart: 1,
              newStart: 1,
              lines: ['-const before = 1;', '+const after = 2;'],
            },
          ],
        },
      ],
    },
  ];
  const layout = new TranscriptLayout();
  const inspector = new Session();
  inspector.connect();
  try {
    await inspector.post('Profiler.enable');
    await inspector.post('Profiler.startPreciseCoverage', {
      callCount: true,
      detailed: false,
    });
    const expanded = new Map([
      ['tool', true],
      ['diff', true],
    ]);
    layout.render(items, 80, expanded);
    const warm = counts(await inspector.post('Profiler.takePreciseCoverage'));
    for (const name of names) assert.ok(warm[name]! > 0, `warm ${name}`);
    for (const expansion of ['closed', 'preview', 'full']) {
      const choices = new Map([
        ['tool', expansion !== 'closed'],
        ['diff', expansion !== 'closed'],
      ]);
      const full = new Set(expansion === 'full' ? ['diff'] : []);
      layout.render(items, 80, choices, full);
      for (const width of [40, 120, 80]) {
        await inspector.post('Profiler.takePreciseCoverage');
        const frame = layout.render(items, width, choices, full);
        const calls = counts(
          await inspector.post('Profiler.takePreciseCoverage'),
        );
        for (const name of names)
          assert.equal(calls[name], 0, `${expansion} ${width}: ${name}`);
        const fresh = new TranscriptLayout().render(
          items,
          width,
          choices,
          full,
        );
        assert.deepEqual(frame.lines.slice(), fresh.lines.slice());
        assert.deepEqual([...frame.starts], [...fresh.starts]);
        for (let row = 0; row < frame.lines.length; row++) {
          const anchor = frame.anchorAt(row)!;
          assert.deepEqual(anchor, fresh.anchorAt(row));
          assert.equal(frame.rowOf(anchor), fresh.rowOf(anchor));
        }
        const text = frame.lines.slice().join('\n');
        for (const target of [
          'vscode://file/work/src/user.ts:3',
          'https://example.com/user',
          'vscode://file/work/src/answer.ts:7',
          'vscode://file/work/src/guide.ts',
        ])
          assert.ok(text.includes(`\u001b]8;;${target}\u0007`), target);
        assert.ok(text.includes('\u001b[4m'));
        assert.match(stripAnsi(text), /First\./);
        assert.equal(
          text.includes('\u001b[48;2;34;92;43m'),
          expansion !== 'closed',
        );
        assert.equal(
          text.includes('\u001b[48;2;122;41;54m'),
          expansion !== 'closed',
        );
        if (expansion !== 'closed') {
          assert.match(stripAnsi(text), /Finished/);
          assert.match(stripAnsi(text), /1 -const before = 1;/);
          assert.match(stripAnsi(text), /1 \+const after = 2;/);
        }
      }
    }
    await inspector.post('Profiler.takePreciseCoverage');
    new TranscriptLayout().render(items, 40, expanded);
    const control = counts(
      await inspector.post('Profiler.takePreciseCoverage'),
    );
    for (const name of names) assert.ok(control[name]! > 0, `cold ${name}`);
  } finally {
    await inspector.post('Profiler.stopPreciseCoverage');
    await inspector.post('Profiler.disable');
    inspector.disconnect();
  }
});

test('a cached image variant restores its placement after intervening widths', async (t) => {
  const placements: string[] = [];
  const graphics = new Graphics((data) => {
    if (data.includes('a=p,')) placements.push(data);
  });
  t.onTestFinished(() => graphics.release());
  const layout = new TranscriptLayout(graphics);
  const item: DisplayItem = {
    id: 'tool',
    kind: 'tool',
    cwd: '/work',
    text: 'image',
    images: [`data:image/png;base64,${png(800, 200).toString('base64')}`],
    diff: [
      {
        path: '/work/image.txt',
        kind: 'add',
        hunks: [
          {
            oldStart: 0,
            newStart: 1,
            lines: Array.from({ length: 12 }, (_, i) => `+line_${i + 1}`),
          },
        ],
      },
    ],
  };
  layout.render([item], 80, new Map([['tool', true]]), new Set(['tool']));
  await loaded(graphics);
  for (const [width, mode] of [
    [80, 'full'],
    [80, 'preview'],
    [40, 'preview'],
    [40, 'closed'],
    [80, 'closed'],
  ] as const)
    layout.render(
      [item],
      width,
      new Map([['tool', mode !== 'closed']]),
      new Set(mode === 'full' ? ['tool'] : []),
    );
  assert.match(placements.at(-1)!, /c=40,r=5/);
  const placed = placements.length;
  const frame = layout.render(
    [item],
    80,
    new Map([['tool', true]]),
    new Set(['tool']),
  );
  const rows = frame.lines.slice().filter((row) => row.includes(placeholder));
  assert.equal(rows.length, 10);
  assert.ok(rows.every((row) => row.split(placeholder).length - 1 === 80));
  assert.match(placements.at(-1)!, /c=80,r=10/);
  assert.equal(placements.length, placed + 1);
  assert.ok(stripAnsi(frame.lines.slice().join('\n')).includes('12 +line_12'));
});

test('cached expansion variants use the current width and item', () => {
  const diff = (label: string): FileDiff[] => [
    {
      path: `/work/${label}.ts`,
      kind: 'add',
      hunks: [
        {
          oldStart: 0,
          newStart: 1,
          lines: Array.from(
            { length: 12 },
            (_, i) => `+${label}_${i + 1} ${'wide '.repeat(20)}`,
          ),
        },
      ],
    },
  ];
  let items = applyDisplayUpdate([], {
    id: 'tool',
    kind: 'tool',
    cwd: '/work',
    text: 'original',
    diff: diff('line'),
  });
  const layout = new TranscriptLayout();
  for (const [width, expansion] of [
    [80, 'full'],
    [40, 'preview'],
    [120, 'closed'],
    [40, 'full'],
    [80, 'preview'],
  ] as const) {
    const choices = new Map([['tool', expansion !== 'closed']]);
    const full = new Set(expansion === 'full' ? ['tool'] : []);
    const frame = layout.render(items, width, choices, full);
    const fresh = new TranscriptLayout().render(items, width, choices, full);
    assert.deepEqual(frame.lines.slice(), fresh.lines.slice());
    assert.equal(
      stripAnsi(frame.lines.slice().join('\n')).includes('line_12'),
      expansion === 'full',
    );
  }
  layout.render(items, 120, new Map([['tool', false]]));
  items = applyDisplayUpdate(items, {
    id: 'tool',
    kind: 'tool',
    cwd: '/work',
    text: 'replacement',
    replace: true,
    diff: diff('new'),
  });
  layout.render(items, 40, new Map([['tool', false]]));
  for (const full of [new Set(['tool']), new Set<string>()]) {
    const frame = layout.render(items, 80, new Map(), full);
    const text = frame.lines.slice().join('\n');
    assert.match(stripAnsi(text), /replacement/);
    assert.doesNotMatch(stripAnsi(text), /original|line_12/);
    assert.equal(stripAnsi(text).includes('new_12'), full.has('tool'));
    assert.ok(text.includes('vscode://file/work/new.ts'));
    assert.deepEqual(
      frame.lines.slice(),
      new TranscriptLayout().render(items, 80, new Map(), full).lines.slice(),
    );
  }
});

test('a resize after the retry delay retries a missing image without reparsing its text', async (t) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const directory = await scratch('witch-resize-image-');
  const graphics = new Graphics(() => {});
  t.onTestFinished(() => graphics.release());
  const layout = new TranscriptLayout(graphics);
  const item: DisplayItem = {
    id: 'image',
    kind: 'user',
    cwd: directory,
    text: 'shot.png',
  };
  const lex = Lexer.prototype.lex;
  let parsed = 0;
  vi.spyOn(Lexer.prototype, 'lex').mockImplementation(function (
    this: Lexer,
    source: string,
  ) {
    parsed++;
    return lex.call(this, source);
  });
  const before = layout.render([item], 80, new Map());
  assert.ok(!before.lines.slice().some((line) => line.includes(placeholder)));
  assert.ok(parsed > 0);
  const warm = parsed;
  await loaded(graphics);
  await writeFile(join(directory, 'shot.png'), png(800, 200));
  vi.setSystemTime(Date.now() + 2_000);
  layout.render([item], 40, new Map());
  await loaded(graphics);
  const after = layout.render([item], 40, new Map());
  assert.equal(parsed, warm);
  assert.equal(
    after.lines.slice().filter((line) => line.includes(placeholder)).length,
    5,
  );
  assert.deepEqual(after.anchorAt(2), { item: 'image', line: 2, offset: 0 });
  assert.deepEqual(after.anchorAt(7), { item: 'image', line: 3, offset: 0 });
  assert.equal(after.lines.at(7), '');
  assert.ok(!before.lines.slice().some((line) => line.includes(placeholder)));
});
