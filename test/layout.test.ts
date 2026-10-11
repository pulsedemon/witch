import assert from 'node:assert/strict';
import { test } from 'node:test';
import stripAnsi from 'strip-ansi';
import { TranscriptLayout } from '../src/ui/transcript-layout.js';
import type { DisplayItem } from '../src/core/state.js';

await test('expanding a tool shows its complete output without losing links', () => {
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
    stripAnsi(layout.render([item], 60, new Set()).lines.join('\n')),
    /Done/,
  );
  const expanded = layout.render([item], 60, new Set(['tool']));
  assert.match(stripAnsi(expanded.lines.join('\n')), /Done/);
  assert.ok(
    expanded.lines
      .join('\n')
      .includes('vscode://file/work/project/src/main.ts:9'),
  );
});

await test('completed output is cached when another message streams', () => {
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
  const first = layout.render(items, 80, new Set(['large']));
  const second = layout.render(
    [items[0]!, { ...items[1]!, text: 'First response' }],
    80,
    new Set(['large']),
  );
  assert.equal(first.blocks[0], second.blocks[0]);
  assert.match(stripAnsi(second.lines.at(-2) ?? ''), /First response/);
});

await test('a reading anchor follows its original log line when a narrower window wraps earlier lines', () => {
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
  const wide = layout.render([item], 100, new Set(['log']));
  const row = wide.lines.findIndex((line) =>
    stripAnsi(line).startsWith('Line 700:'),
  );
  const anchor = wide.anchorAt(row)!;
  const narrow = layout.render([item], 30, new Set(['log']));
  assert.match(stripAnsi(narrow.lines[narrow.rowOf(anchor)]!), /^Line 700:/);
  assert.doesNotMatch(stripAnsi(narrow.lines[row]!), /^Line 700:/);
});
