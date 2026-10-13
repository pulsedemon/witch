import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Box, Text, render } from 'ink';
import { createElement } from 'react';
import { hyperlink } from '../src/ui/links.js';
import { Screen, recorded } from '../src/ui/screen.js';

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

await test('a link Ink draws is found at its cells, and a redraw that moves it leaves no link behind', async () => {
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
    for (let attempt = 0; attempt < 50 && !screen.linkAt(8, 2); attempt++)
      await delay(20);
    // `see ` starts at column 4, so the link fills columns 8 to 11
    assert.equal(screen.linkAt(7, 2), undefined);
    assert.equal(screen.linkAt(8, 2), docs);
    assert.equal(screen.linkAt(11, 2), docs);
    assert.equal(screen.linkAt(12, 2), undefined);
    instance.rerender(frame(3));
    for (let attempt = 0; attempt < 50 && !screen.linkAt(8, 4); attempt++)
      await delay(20);
    assert.equal(screen.linkAt(8, 4), docs);
    assert.equal(screen.linkAt(8, 2), undefined);
  } finally {
    instance.unmount();
  }
});

await test('wide characters before a link move it right, and a line that fills the width wraps', () => {
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

await test('a link sequence split across writes still opens', () => {
  const screen = new Screen({ columns: 10, rows: 2 });
  screen.write(`ab\u001b]8;;${docs.slice(0, 10)}`);
  screen.write(`${docs.slice(10)}\u0007cd\u001b]8;;\u0007e`);
  assert.equal(screen.linkAt(2, 0), docs);
  assert.equal(screen.linkAt(3, 0), docs);
  assert.equal(screen.linkAt(4, 0), undefined);
});

await test('erasing a line and the screen below removes their links', () => {
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

await test('cursor moves place what follows them', () => {
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
