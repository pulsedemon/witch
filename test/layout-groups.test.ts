import assert from 'node:assert/strict';
import { test } from 'vitest';
import stripAnsi from 'strip-ansi';
import { TranscriptLayout, toggleGroup } from '../src/ui/transcript-layout.js';
import type { DisplayItem } from '../src/core/state.js';

/** an agent tool row, whose id has the `<activity>/<agent>/<native id>` shape grouping relies on. */
const tool = (
  name: string,
  fields: Partial<DisplayItem> = {},
): DisplayItem => ({
  id: `turn/claude/${name}`,
  kind: 'tool',
  title: `Read  ${name}.ts`,
  text: `${name} output`,
  cwd: '/work',
  done: true,
  ...fields,
});
const said: DisplayItem = {
  id: 'said',
  kind: 'assistant',
  text: 'looking',
  cwd: '/work',
};
const rows = (output: { lines: { slice(): string[] } }) =>
  output.lines.slice().map(stripAnsi);

test('consecutive finished tools render as one group row until opened', () => {
  const items = [tool('a'), tool('b'), tool('c')];
  const layout = new TranscriptLayout();
  const closed = layout.render(items, 80, new Map());
  assert.deepEqual(rows(closed), ['+ ✓ 3 tools', '']);
  const open = layout.render(items, 80, toggleGroup(items, new Map()));
  assert.deepEqual(rows(open), [
    '− ✓ 3 tools',
    '',
    '+ ✓ Read  a.ts',
    '',
    '+ ✓ Read  b.ts',
    '',
    '+ ✓ Read  c.ts',
    '',
  ]);
  const reclosed = layout.render(
    items,
    80,
    toggleGroup(items, toggleGroup(items, new Map())),
  );
  assert.deepEqual(rows(reclosed), ['+ ✓ 3 tools', '']);
});

test('familiar rows, failures, running tools, shell commands and changed files split a run', () => {
  const items = [
    tool('a'),
    tool('b'),
    {
      id: '1c0d7e4a-familiar',
      kind: 'tool' as const,
      title: 'Familiar completed  reviewer',
      text: '',
      cwd: '/work',
      done: true,
    },
    tool('c'),
    tool('failed', { title: 'Bash  $ false', failed: true }),
    tool('d'),
    tool('running', { done: false }),
    tool('e'),
    tool('shell', { title: 'ls', shell: true, text: '' }),
    tool('f'),
    tool('edit', {
      title: 'Edit  src/f.ts',
      text: '',
      diff: [{ path: '/work/src/f.ts', kind: 'update', hunks: [] }],
    }),
    tool('g'),
    tool('h'),
  ];
  const output = rows(new TranscriptLayout().render(items, 80, new Map()));
  assert.deepEqual(
    output.filter((row) => row && !row.startsWith('Update')),
    [
      '+ ✓ 2 tools',
      '+ ✓ Familiar completed  reviewer',
      '+ ✓ Read  c.ts',
      '+ ✗ Bash  $ false',
      '+ ✓ Read  d.ts',
      '+ … Read  running.ts',
      '+ ✓ Read  e.ts',
      '− ✓ ls',
      '+ ✓ Read  f.ts',
      '− ✓ Edit  src/f.ts',
      '+ ✓ 2 tools',
    ],
  );
});

test('a group stays open as it grows backward and when it merges with another', () => {
  const [a, b, c, d, e, f] = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) =>
    tool(name),
  );
  const running = (item: DisplayItem) => ({ ...item, done: false });
  const layout = new TranscriptLayout();
  const choices = toggleGroup([b!, c!], new Map());
  const groupRows = (items: DisplayItem[]) =>
    rows(layout.render(items, 80, choices)).filter((row) =>
      row.includes(' tools'),
    );
  const before = [said, running(a!), b!, c!, running(d!), e!, f!];
  assert.deepEqual(groupRows(before), ['− ✓ 2 tools', '+ ✓ 2 tools']);
  const grown = [said, a!, b!, c!, running(d!), e!, f!];
  const afterGrowth = layout.render(grown, 80, choices);
  assert.ok(afterGrowth.items.some((item) => item.id === `tools:${a!.id}`));
  assert.deepEqual(groupRows(grown), ['− ✓ 3 tools', '+ ✓ 2 tools']);
  const merged = [said, a!, b!, c!, d!, e!, f!];
  assert.deepEqual(groupRows(merged), ['− ✓ 6 tools']);
  assert.equal(layout.render(merged, 80, choices).items.length, 8);
});

test('an anchor on a tool that joins a group resolves to the group row', () => {
  const b = tool('b', { text: 'first\nsecond' });
  const layout = new TranscriptLayout();
  const alone = layout.render([said, b], 80, new Map([[b.id, true]]));
  const anchor = alone.anchorAt(alone.starts.get(b.id)! + 1)!;
  assert.equal(anchor.item, b.id);
  const grouped = layout.render([said, b, tool('c')], 80, new Map());
  const start = grouped.starts.get(`tools:${b.id}`)!;
  assert.notEqual(start, 0);
  assert.equal(grouped.rowOf(anchor), start);
});

test('an anchor on a group that grows backward resolves to the grown group', () => {
  const [a, b, c] = ['a', 'b', 'c'].map((name) => tool(name));
  const layout = new TranscriptLayout();
  const before = layout.render(
    [said, { ...a!, done: false }, b!, c!],
    80,
    new Map(),
  );
  const anchor = before.anchorAt(before.starts.get(`tools:${b!.id}`)!)!;
  assert.equal(anchor.item, `tools:${b!.id}`);
  const after = layout.render([said, a!, b!, c!], 80, new Map());
  const start = after.starts.get(`tools:${a!.id}`)!;
  assert.notEqual(start, 0);
  assert.equal(after.rowOf(anchor), start);
  assert.equal(after.shownAs(`tools:${b!.id}`), `tools:${a!.id}`);
});

test('a one-line notice renders without a heading, a multi-line one keeps it', () => {
  const notice = (id: string, text: string): DisplayItem => ({
    id,
    kind: 'notice',
    text,
    cwd: '/work',
  });
  const output = new TranscriptLayout().render(
    [notice('one', 'Saved the note.'), notice('two', 'First.\nSecond.')],
    80,
    new Map(),
  );
  assert.deepEqual(rows(output), [
    'Saved the note.',
    '',
    'Notice',
    'First.',
    'Second.',
    '',
  ]);
});

test("a failed tool's ✗ stays full red in its dim row", () => {
  const output = new TranscriptLayout().render(
    [tool('broken', { failed: true })],
    80,
    new Map(),
  );
  const title = output.lines.at(0)!;
  assert.equal(stripAnsi(title), '+ ✗ Read  broken.ts');
  // the dim before it closes, so the mark isn't dimmed with the row
  assert.ok(title.includes('\u001b[22m\u001b[31m✗'));
});
