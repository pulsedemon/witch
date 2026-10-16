import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Cell, Pointer } from '../src/ui/mouse.js';
import { MouseInput, captureMouse, releaseMouse } from '../src/ui/mouse.js';

class Source extends EventEmitter {
  raw: boolean[] = [];
  setEncoding() {}
  setRawMode(mode: boolean) {
    this.raw.push(mode);
  }
  ref() {}
  unref() {}
}

function input() {
  const source = new Source();
  const mouse = new MouseInput(source);
  const read: string[] = [];
  const wheel: number[] = [];
  let clicks = 0;
  const pointer: [Pointer, Cell][] = [];
  mouse.on('readable', () => {
    let text;
    while ((text = mouse.read()) !== null) read.push(text);
  });
  mouse.on('wheel', (rows: number) => wheel.push(rows));
  mouse.on('click', () => clicks++);
  mouse.on('pointer', (kind: Pointer, cell: Cell) =>
    pointer.push([kind, cell]),
  );
  return { source, mouse, read, wheel, clicks: () => clicks, pointer };
}

await test('mouse reports leave the input as wheel steps and left clicks, and the keys around them read through', () => {
  const { source, read, wheel, clicks, pointer } = input();
  // a wheel up, a left click around a right drag, Alt+wheel down and a Ctrl+left click
  source.emit(
    'data',
    'a\u001b[<64;5;6Mb\u001b[<0;12;3M\u001b[<2;1;1M\u001b[<34;2;1M\u001b[<2;2;1m\u001b[<0;12;3mc\u001b[<73;1;1M\u001b[<16;2;9M\u001b[<16;2;9m',
  );
  assert.deepEqual(read, ['a', 'b', 'c']);
  assert.deepEqual(wheel, [-1, 1]);
  assert.equal(clicks(), 2);
  assert.deepEqual(pointer, [
    ['press', { column: 11, row: 2 }],
    ['release', { column: 11, row: 2 }],
    ['press', { column: 1, row: 8 }],
    ['release', { column: 1, row: 8 }],
  ]);
});

await test('only the release of a left press on its own cell clicks, and only once', () => {
  const { source, clicks } = input();
  source.emit('data', '\u001b[<0;5;5M\u001b[<2;5;5m');
  assert.equal(clicks(), 0);
  source.emit('data', '\u001b[<0;5;5m\u001b[<0;5;5m');
  assert.equal(clicks(), 1);
  // a release Ghostty withheld, as it does one with Shift held, leaves the next release on another cell
  source.emit('data', '\u001b[<0;5;5M\u001b[<0;5;9m');
  source.emit('data', '\u001b[<0;5;5M\u001b[<0;9;5m');
  assert.equal(clicks(), 1);
  // or the next press while the last is held, and that press's own release still clicks
  source.emit('data', '\u001b[<0;5;5M\u001b[<0;9;9M\u001b[<0;9;9m');
  assert.equal(clicks(), 2);
});

await test('the keys and reports in one read arrive in the order they were sent', () => {
  const { source, mouse, read } = input();
  const seen: string[] = [];
  mouse.on('pointer', (kind: Pointer) =>
    seen.push(`${kind} after ${read.join('')}`),
  );
  source.emit('data', 'a\u001b[<0;5;5Mb\u001b[<0;5;5mc');
  assert.deepEqual(seen, ['press after a', 'release after ab']);
  assert.deepEqual(read, ['a', 'b', 'c']);
});

await test('a report split across reads waits for its end', () => {
  const { source, read, clicks } = input();
  source.emit('data', 'x\u001b[<0;4');
  assert.deepEqual(read, ['x']);
  source.emit('data', ';7M\u001b[<0;4;7m');
  assert.deepEqual(read, ['x']);
  assert.equal(clicks(), 1);
});

await test('a press dragged off its cell is a drag, not a click, even released where it began', () => {
  const { source, clicks, pointer } = input();
  source.emit(
    'data',
    '\u001b[<0;5;5M\u001b[<32;6;5M\u001b[<32;5;5M\u001b[<0;5;5m',
  );
  assert.equal(clicks(), 0);
  assert.deepEqual(pointer, [
    ['press', { column: 4, row: 4 }],
    ['drag', { column: 5, row: 4 }],
    ['drag', { column: 4, row: 4 }],
    ['release', { column: 4, row: 4 }],
  ]);
});

await test('a wheel step while the button is down keeps its release from clicking', () => {
  const { source, wheel, clicks } = input();
  source.emit('data', '\u001b[<0;5;5M\u001b[<65;5;5M\u001b[<0;5;5m');
  assert.deepEqual(wheel, [1]);
  assert.equal(clicks(), 0);
});

await test('raw mode reaches the terminal', () => {
  const { source, mouse } = input();
  mouse.setRawMode(true);
  mouse.setRawMode(false);
  assert.deepEqual(source.raw, [true, false]);
});

await test('capturing the mouse asks for motion while a button is held, in SGR coordinates, and releasing it ends every mode capture began', () => {
  const modes = (sequence: string, end: 'h' | 'l') =>
    [...sequence.matchAll(/\?(\d+)([hl])/g)]
      .filter(([, , kind]) => kind === end)
      .map(([, mode]) => mode)
      .sort();
  assert.deepEqual(modes(captureMouse, 'h'), ['1002', '1006']);
  assert.deepEqual(modes(releaseMouse, 'l'), modes(captureMouse, 'h'));
});
