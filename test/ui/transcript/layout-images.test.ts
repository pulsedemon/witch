import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import stripAnsi from 'strip-ansi';
import { Graphics, placeholder } from '../../../src/ui/transcript/images.js';
import { TranscriptLayout } from '../../../src/ui/transcript/transcript-layout.js';
import type { DisplayItem } from '../../../src/core/state.js';
import { applyDisplayUpdate } from '../../../src/core/state.js';
import { loaded } from '../../fixtures/graphics.js';
import { png } from '../../fixtures/png.js';
import { scratch } from '../../fixtures/scratch.js';

const tool = (text: string, done = false): DisplayItem => ({
  id: 'tool',
  kind: 'tool',
  title: 'npm test',
  text,
  cwd: '/work',
  done,
});

test('an image arriving with an append replaces the text-only cached block', async () => {
  const directory = await scratch('witch-layout-');

  await writeFile(join(directory, 'shot.png'), png(160, 80));

  const graphics = new Graphics(() => {});
  const layout = new TranscriptLayout(graphics);
  const expanded = new Map([['tool', true]]);
  let items = applyDisplayUpdate([], { ...tool('read\n'), cwd: directory });
  const before = layout.render(items, 100, expanded);

  assert.ok(!before.lines.slice().some((line) => line.includes(placeholder)));

  items = applyDisplayUpdate(items, {
    ...tool('finished'),
    cwd: directory,
    images: ['shot.png'],
  });

  const loading = layout.render(items, 100, expanded);

  assert.ok(!loading.lines.slice().some((line) => line.includes(placeholder)));

  await loaded(graphics);

  const frame = layout.render(items, 100, expanded);
  const rows = frame.lines.slice();
  const first = rows.findIndex((line) => line.includes(placeholder));

  assert.equal(rows.filter((line) => line.includes(placeholder)).length, 5);

  assert.deepEqual(frame.anchorAt(first), { item: 'tool', line: 3, offset: 0 });

  assert.equal(frame.rowOf({ item: 'tool', line: 3, offset: 4 }), first + 4);

  assert.ok(!before.lines.slice().some((line) => line.includes(placeholder)));
});

test('an append after the retry delay retries a named image that was unavailable during the first render', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });

  for (const [initial, imageLine] of [
    ['', 2],
    ['waiting\n', 3],
  ] as const) {
    const directory = await scratch('witch-layout-');
    const graphics = new Graphics(() => {});
    const layout = new TranscriptLayout(graphics);
    const expanded = new Map([['tool', true]]);

    let items = applyDisplayUpdate([], {
      ...tool(initial),
      cwd: directory,
      images: ['shot.png'],
    });

    const before = layout.render(items, 100, expanded);

    assert.ok(!before.lines.slice().some((line) => line.includes(placeholder)));

    await loaded(graphics);

    const images = items[0]!.images;

    await writeFile(join(directory, 'shot.png'), png(160, 80));

    vi.setSystemTime(Date.now() + 2_000);

    items = applyDisplayUpdate(items, { ...tool('ready'), cwd: directory });

    assert.equal(items[0]!.images, images);

    layout.render(items, 100, expanded);

    await loaded(graphics);

    const frame = layout.render(items, 100, expanded);
    const rows = frame.lines.slice();
    const first = rows.findIndex((line) => line.includes(placeholder));

    assert.equal(rows.filter((line) => line.includes(placeholder)).length, 5);

    assert.deepEqual(frame.anchorAt(first), {
      item: 'tool',
      line: imageLine,
      offset: 0,
    });

    assert.equal(
      frame.rowOf({ item: 'tool', line: imageLine, offset: 4 }),
      first + 4,
    );

    assert.ok(!before.lines.slice().some((line) => line.includes(placeholder)));
  }
});

test('a message shows its images below its text, and a tool shows its images only while expanded, keeping them as its output grows', async () => {
  const directory = await scratch('witch-layout-');

  await writeFile(join(directory, 'shot.png'), png(160, 80));

  const writes: string[] = [];
  const graphics = new Graphics((data) => writes.push(data));
  const layout = new TranscriptLayout(graphics);

  const message: DisplayItem = {
    id: 'message',
    kind: 'user',
    text: 'look at [Image #1]',
    cwd: directory,
    images: ['shot.png'],
  };

  const tool: DisplayItem = {
    id: 'tool',
    kind: 'tool',
    title: 'Read',
    text: 'Read it',
    cwd: directory,
    done: true,
    images: ['shot.png'],
  };

  const imageRows = (lines: string[]) =>
    lines.filter((line) => line.includes(placeholder)).length;

  const expanded = new Map([['tool', true]]);

  layout.render([message, tool], 100, expanded);

  await loaded(graphics);

  graphics.rows('missing.png', directory, 100);

  // loads finish in order, so a second load of shot.png would have finished by now
  await loaded(graphics);

  assert.equal(
    writes.filter((write) => write.startsWith('\u001b_Ga=t,')).length,
    1,
  );

  assert.deepEqual(
    layout
      .render([message, tool], 100, expanded)
      .blocks.map((block) => imageRows(block.slice())),
    [5, 5],
  );

  const collapsed = layout.render([message, tool], 100, new Map());
  const [shown] = collapsed.blocks;

  assert.equal(imageRows(shown!.slice()), 5);

  assert.ok(
    shown!
      .slice()
      .findIndex((line) => stripAnsi(line).includes('look at [Image #1]')) <
      shown!.slice().findIndex((line) => line.includes(placeholder)),
  );

  assert.equal(imageRows(collapsed.blocks[1]!.slice()), 0);

  assert.equal(
    imageRows(layout.render([message, tool], 100, expanded).blocks[1]!.slice()),
    5,
  );

  const grown = layout
    .render([message, { ...tool, text: 'Read it\nand more' }], 100, expanded)
    .blocks[1]!.slice();

  assert.equal(imageRows(grown), 5);

  assert.ok(grown.some((line) => stripAnsi(line).includes('and more')));
});

test('a message draws no image for a path typed into its text, even one already loaded', async () => {
  const directory = await scratch('witch-layout-');
  const shot = join(directory, 'shot.png');

  await writeFile(shot, png(160, 80));

  const graphics = new Graphics(() => {});

  assert.deepEqual(graphics.rows(shot, directory, 100), []);

  await loaded(graphics);

  assert.notDeepEqual(graphics.rows(shot, directory, 100), []);

  const layout = new TranscriptLayout(graphics);

  const item: DisplayItem = {
    id: 'message',
    kind: 'user',
    text: `look at ${shot}`,
    cwd: directory,
  };

  const frame = layout.render([item], 100, new Map());

  assert.ok(stripAnsi(frame.lines.slice().join('\n')).includes('look at'));

  assert.ok(!frame.lines.slice().some((line) => line.includes(placeholder)));
});

for (const kind of ['tool', 'user'] as const) {
  test(`a ${kind}'s image anchors keep their image and closing blank across resizes`, async () => {
    const directory = await scratch('witch-layout-');

    await writeFile(join(directory, 'a.png'), png(800, 200));

    await writeFile(join(directory, 'b.png'), png(800, 160));

    const item: DisplayItem = {
      id: 'images',
      kind,
      text: 'a.png b.png',
      cwd: directory,
      images: ['a.png', 'b.png'],
      ...(kind === 'tool' ? { title: 'Read', done: true } : {}),
    };

    const graphics = new Graphics(() => {});
    const layout = new TranscriptLayout(graphics);
    const expanded = new Map([['images', true]]);

    layout.render([item], 40, expanded);

    layout.render([item], 100, expanded);

    await loaded(graphics);

    // one image shown and one still loading leaves the block missing an image
    layout.render([item], 100, expanded);

    await loaded(graphics);

    // the width is unchanged since the last render, so only the missing images rebuild it
    const wide = layout.render([item], 100, expanded);
    const narrow = layout.render([item], 40, expanded);

    assert.equal(narrow.lines.length, 12);

    assert.equal(wide.lines.length, 26);

    assert.equal(narrow.lines.at(11), '');

    assert.equal(wide.lines.at(25), '');

    assert.equal(wide.rowOf(narrow.anchorAt(11)!), 25);

    assert.equal(narrow.rowOf(wide.anchorAt(25)!), 11);

    assert.equal(wide.rowOf(narrow.anchorAt(4)!), 4);

    assert.equal(wide.rowOf(narrow.anchorAt(9)!), 17);

    assert.equal(narrow.rowOf(wide.anchorAt(14)!), 6);

    assert.equal(narrow.rowOf(wide.anchorAt(24)!), 10);
  });
}

test('a block whose image failed is reused across renders, not rewrapped each time', async () => {
  const directory = await scratch('witch-layout-');
  const graphics = new Graphics(() => {});
  const layout = new TranscriptLayout(graphics);

  const item: DisplayItem = {
    id: 'message',
    kind: 'user',
    text: 'look at [Image #1]',
    cwd: directory,
    images: ['missing.png'],
  };

  layout.render([item], 100, new Map());

  await loaded(graphics);

  const first = layout.render([item], 100, new Map());

  assert.equal(
    layout.render([item], 100, new Map()).blocks[0],
    first.blocks[0],
  );
});

test('a shown image and the closing blank keep their anchors while an image before them loads', async () => {
  const directory = await scratch('witch-layout-');

  await writeFile(join(directory, 'a.png'), png(160, 80));

  await writeFile(join(directory, 'b.png'), png(320, 80));

  const graphics = new Graphics(() => {});

  graphics.rows('b.png', directory, 100);

  await loaded(graphics);

  const layout = new TranscriptLayout(graphics);

  const item: DisplayItem = {
    id: 'message',
    kind: 'user',
    text: 'a.png b.png',
    cwd: directory,
    images: ['a.png', 'b.png'],
  };

  const before = layout.render([item], 100, new Map());

  const row = before.lines
    .slice()
    .findIndex((line) => line.includes(placeholder));

  const image = before.anchorAt(row)!;
  const blank = before.anchorAt(before.lines.length - 1)!;

  await loaded(graphics);

  const after = layout.render([item], 100, new Map());

  assert.ok(after.lines.length > before.lines.length);

  assert.equal(after.lines.at(after.rowOf(image)), before.lines.at(row));

  assert.equal(after.rowOf(blank), after.lines.length - 1);
});

test('an image anchor follows wrapped diff output', async () => {
  const directory = await scratch('witch-layout-');

  await writeFile(join(directory, 'a.png'), png(800, 200));

  const item: DisplayItem = {
    id: 'mixed',
    kind: 'tool',
    title: 'Read',
    text: 'Image',
    cwd: directory,
    done: true,
    images: ['a.png'],
    diff: [
      {
        path: '/elsewhere/a.txt',
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

  const graphics = new Graphics(() => {});
  const layout = new TranscriptLayout(graphics);
  const expanded = new Map([['mixed', true]]);

  layout.render([item], 40, expanded);

  await loaded(graphics);

  const narrow = layout.render([item], 40, expanded);
  const wide = layout.render([item], 100, expanded);

  const narrowImage = narrow.lines
    .slice()
    .findIndex((line) => line.includes(placeholder));

  const wideImage = wide.lines
    .slice()
    .findIndex((line) => line.includes(placeholder));

  assert.equal(narrowImage, 11);

  assert.equal(wideImage, 8);

  assert.equal(wide.rowOf(narrow.anchorAt(narrowImage + 2)!), wideImage + 2);
});
