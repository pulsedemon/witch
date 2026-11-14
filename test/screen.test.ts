import assert from 'node:assert/strict';

import { EventEmitter } from 'node:events';

import { test, vi } from 'vitest';

import { Box, Text, render } from 'ink';

import { createElement } from 'react';

import { hyperlink } from '../src/ui/links.js';

import { Screen, recorded } from '../src/ui/screen.js';

import { until } from './fixtures/within.js';

/** a terminal Ink treats as interactive, so it draws with cursor movement and erasing. */
class Tty extends EventEmitter {
  readonly isTTY = true;
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super();
  }
  write(_data: string, callback?: () => void) {
    callback?.();

    return true;
  }
}

class Keys extends EventEmitter {
  readonly isTTY = true;
  read = () => null;
  setEncoding() {}
  setRawMode() {}
  ref() {}
  unref() {}
}

const docs = 'https://example.com/docs';

const link = (text: string, target: string) =>
  `\u001b]8;;${target}\u0007${text}\u001b]8;;\u0007`;

test('a link Ink draws is found at its cells, and a redraw that moves it leaves no link behind', async () => {
  const tty = new Tty(40, 6);

  const screen = new Screen(tty);

  const frame = (row: number) =>
    createElement(
      Box,
      { flexDirection: 'column', height: 6 },
      createElement(Text, null, 'header'),
      ...Array.from({ length: row }, (_, index) =>
        createElement(Text, { key: index }, '-'),
      ),
      createElement(
        Box,
        { paddingLeft: 4 },
        createElement(Text, null, `see ${hyperlink('docs', docs, '/')} here`),
      ),
    );

  const instance = render(frame(1), {
    stdout: recorded(tty as unknown as NodeJS.WriteStream, screen),
    stdin: new Keys() as unknown as NodeJS.ReadStream,
    interactive: true,
    alternateScreen: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  try {
    await until('the first link', () => screen.linkAt(8, 2) === docs);

    // `see ` starts at column 4, so the link fills columns 8 to 11
    assert.equal(screen.linkAt(7, 2), undefined);

    assert.equal(screen.linkAt(8, 2), docs);

    assert.equal(screen.linkAt(11, 2), docs);

    assert.equal(screen.linkAt(12, 2), undefined);

    instance.rerender(frame(3));

    await until('the moved link', () => screen.linkAt(8, 4) === docs);

    assert.equal(screen.linkAt(8, 4), docs);

    assert.equal(screen.linkAt(8, 2), undefined);
  } finally {
    instance.unmount();
  }
});

test('wide characters before a link move it right, and a line that fills the width wraps', () => {
  const screen = new Screen({ columns: 10, rows: 3 });

  screen.write(`漢字${link('ab', docs)}`);

  assert.equal(screen.linkAt(3, 0), undefined);

  assert.equal(screen.linkAt(4, 0), docs);

  assert.equal(screen.linkAt(5, 0), docs);

  screen.write(`\u001b[2;9H${link('xyz', docs)}`);

  assert.equal(screen.linkAt(8, 1), docs);

  assert.equal(screen.linkAt(9, 1), docs);

  assert.equal(screen.linkAt(0, 2), docs);

  assert.equal(screen.linkAt(1, 2), undefined);
});

test('repeated graphemes reuse their widths across writes and resize', () => {
  const segmentation = vi.spyOn(Intl.Segmenter.prototype, 'segment');

  const size = { columns: 40, rows: 2 };

  const screen = new Screen(size);

  const graphemes = ['─', '漢', '👩‍💻', '\u200B'];

  const text = graphemes.join('').repeat(2);

  for (const [columns, label, target] of [
    [40, 'A', docs],
    [50, 'B', `${docs}/resized`],
  ] as const) {
    size.columns = columns;

    screen.write(`\u001b[H${text}${link(label, target)}`);

    assert.equal(screen.linkAt(9, 0), undefined);

    assert.equal(screen.linkAt(10, 0), target);

    assert.equal(screen.linkAt(11, 0), undefined);
  }

  // string-width segments each grapheme; Screen's own calls receive the whole run.
  for (const grapheme of graphemes)
    assert.equal(
      segmentation.mock.calls.filter((call) => call[0] === grapheme).length,
      1,
      JSON.stringify(grapheme),
    );
});

test('ASCII links need no grapheme measurements', () => {
  const segmentation = vi.spyOn(Intl.Segmenter.prototype, 'segment');

  const screen = new Screen({ columns: 20, rows: 1 });

  screen.write(`plain ${link('AB', docs)}`);

  assert.equal(segmentation.mock.calls.length, 0);

  assert.equal(screen.linkAt(5, 0), undefined);

  assert.equal(screen.linkAt(6, 0), docs);

  assert.equal(screen.linkAt(7, 0), docs);

  assert.equal(screen.linkAt(8, 0), undefined);
});

test('keycaps keep both cells before a link, including at the right margin', () => {
  for (const keycap of ['1️⃣', '#⃣', '*️⃣']) {
    for (const [columns, lastColumn, lastRow] of [
      [12, 5, 0],
      [5, 0, 1],
    ] as const) {
      const screen = new Screen({ columns, rows: 2 });

      screen.write(`ab${keycap}${link('XY', docs)}`);

      assert.equal(screen.linkAt(3, 0), undefined, keycap);

      assert.equal(screen.linkAt(4, 0), docs, keycap);

      assert.equal(screen.linkAt(lastColumn, lastRow), docs, keycap);

      assert.equal(screen.linkAt(lastColumn + 1, lastRow), undefined, keycap);
    }
  }
});

test('a resize starts a new grid of the new size, and a terminal that reports no size gets 80 by 24', () => {
  const size = { columns: 4, rows: 2 };

  const screen = new Screen(size);

  screen.write(link('ab', docs));

  size.columns = 10;

  size.rows = 4;

  screen.write(`\u001b[4;8H${link('c', docs)}`);

  assert.equal(screen.linkAt(7, 3), docs);

  assert.equal(screen.linkAt(0, 0), undefined);

  const sizeless = new Screen({ columns: 0, rows: 0 });

  // a cursor move past the grid stops at its last cell
  sizeless.write(`\u001b[99;99H${link('d', docs)}`);

  assert.equal(sizeless.linkAt(79, 23), docs);
});

test('a link sequence split across writes still opens', () => {
  const screen = new Screen({ columns: 10, rows: 2 });

  screen.write(`ab\u001b]8;;${docs.slice(0, 10)}`);

  screen.write(`${docs.slice(10)}\u0007cd\u001b]8;;\u0007e`);

  assert.equal(screen.linkAt(2, 0), docs);

  assert.equal(screen.linkAt(3, 0), docs);

  assert.equal(screen.linkAt(4, 0), undefined);
});

test('erasing a line and the screen below removes their links', () => {
  const screen = new Screen({ columns: 6, rows: 3 });

  screen.write(
    `${link('abcdef', docs)}\n${link('ghi', docs)}\n${link('jk', docs)}`,
  );

  screen.write('\u001b[2;3H\u001b[K');

  assert.equal(screen.linkAt(1, 1), docs);

  assert.equal(screen.linkAt(2, 1), undefined);

  screen.write('\u001b[1;4H\u001b[J');

  assert.equal(screen.linkAt(2, 0), docs);

  assert.equal(screen.linkAt(3, 0), undefined);

  assert.equal(screen.linkAt(0, 2), undefined);
});

test('cursor moves place what follows them', () => {
  const screen = new Screen({ columns: 10, rows: 5 });

  // to row 4 column 6, up 2, back 3, forward 1, down 1, then to column 2 of that row
  screen.write(`\u001b[4;6H\u001b[2A${link('a', docs)}`);

  assert.equal(screen.linkAt(5, 1), docs);

  screen.write(`\u001b[3D${link('b', docs)}`);

  assert.equal(screen.linkAt(3, 1), docs);

  screen.write(`\u001b[C\u001b[B${link('c', docs)}`);

  assert.equal(screen.linkAt(5, 2), docs);

  screen.write(`\u001b[2G${link('d', docs)}`);

  assert.equal(screen.linkAt(1, 2), docs);

  assert.equal(screen.linkAt(0, 2), undefined);
});

test('only http, https, vscode and image file links open, since open would launch a file for any other target', () => {
  const screen = new Screen({ columns: 20, rows: 1 });

  screen.write(
    `${link('a', 'file:///bin/sh')}${link('b', '/Applications/Calculator.app')}${link('c', 'smb://host/x')}${link('d', 'vscode://file/a.ts')}${link('e', 'HTTP://example.com')}${link('f', 'file:///tmp/a%20b.PNG')}${link('g', 'file:///bin/sh#.png')}${link('h', 'file:///bin/sh?.png')}`,
  );

  assert.equal(screen.linkAt(0, 0), undefined);

  assert.equal(screen.linkAt(1, 0), undefined);

  assert.equal(screen.linkAt(2, 0), undefined);

  assert.equal(screen.linkAt(3, 0), 'vscode://file/a.ts');

  assert.equal(screen.linkAt(4, 0), 'HTTP://example.com');

  assert.equal(screen.linkAt(5, 0), 'file:///tmp/a%20b.PNG');

  // the fragment or query would hide the file's real extension
  assert.equal(screen.linkAt(6, 0), undefined);

  assert.equal(screen.linkAt(7, 0), undefined);
});

const hand = '\u001b]22;pointer\u0007';

const arrow = '\u001b]22;default\u0007';

test('styles preserve link cells and pointer positions', () => {
  const screen = new Screen({ columns: 20, rows: 2 });

  screen.write(`\u001b[38;2;17;34;51m${link('AB', docs)}\u001b[0m`);

  assert.equal(screen.linkAt(0, 0), docs);

  assert.equal(screen.linkAt(1, 0), docs);

  assert.equal(screen.linkAt(2, 0), undefined);

  assert.equal(screen.point(0, 0), hand);

  assert.equal(screen.point(1, 0), '');

  assert.equal(screen.point(2, 0), arrow);
});

test('the pointer turns into a hand over a link and back to the arrow off it, once per change', () => {
  const screen = new Screen({ columns: 20, rows: 2 });

  assert.equal(screen.write(`ab${link('cd', docs)}e`), '');

  assert.equal(screen.point(2, 0), hand);

  assert.equal(screen.point(3, 0), '');

  assert.equal(screen.point(4, 0), arrow);

  assert.equal(screen.point(1, 0), '');
});

test('a frame that draws a link under a still pointer or covers it changes the shape', () => {
  const screen = new Screen({ columns: 20, rows: 2 });

  assert.equal(screen.point(2, 0), '');

  assert.equal(screen.write(`ab${link('cd', docs)}`), hand);

  assert.equal(screen.write('\u001b[1;1Habcd'), arrow);
});

test('the recorded stream follows a frame with the shape change it makes', () => {
  const chunks: string[] = [];

  const stub = {
    write: (chunk: string) => chunks.push(chunk) > 0,
  } as unknown as NodeJS.WriteStream;

  const screen = new Screen({ columns: 20, rows: 2 });

  screen.point(2, 0);

  const stream = recorded(stub, screen);

  const frame = `ab${link('cd', docs)}`;

  stream.write(frame);

  stream.write('\u001b[1;1Hab');

  assert.deepEqual(chunks, [frame + hand, '\u001b[1;1Hab']);
});

test('a shape change waits for the write that ends a split sequence, so it never lands inside one', () => {
  const chunks: string[] = [];

  const stub = {
    write: (chunk: string) => chunks.push(chunk) > 0,
  } as unknown as NodeJS.WriteStream;

  const screen = new Screen({ columns: 20, rows: 2 });

  screen.point(2, 0);

  const stream = recorded(stub, screen);

  const start = `ab\u001b]8;;${docs}\u0007cd\u001b]8;;`;

  stream.write(start);

  assert.equal(screen.point(3, 0), '');

  stream.write('\u0007e');

  assert.deepEqual(chunks, [start, `\u0007e${hand}`]);
});

test('a shape change waits for a split style sequence to finish', () => {
  const chunks: string[] = [];

  const stub = {
    write: (chunk: string) => chunks.push(chunk) > 0,
  } as unknown as NodeJS.WriteStream;

  const screen = new Screen({ columns: 20, rows: 2 });

  screen.point(2, 0);

  const stream = recorded(stub, screen);

  const start = `ab${link('cd', docs)}\u001b[3`;

  stream.write(start);

  assert.equal(screen.linkAt(2, 0), docs);

  assert.deepEqual(chunks, [start]);

  stream.write('1m');

  assert.deepEqual(chunks, [start, `1m${hand}`]);
});
