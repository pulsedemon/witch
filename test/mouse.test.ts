import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Click, Pointer } from '../src/ui/mouse.js';
import { MouseInput } from '../src/ui/mouse.js';

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
  const clicks: Click[] = [];
  const pointer: [Pointer, Click][] = [];
  mouse.on('readable', () => {
    let text;
    while ((text = mouse.read()) !== null) read.push(text);
  });
  mouse.on('wheel', (rows: number) => wheel.push(rows));
  mouse.on('click', (click: Click) => clicks.push(click));
  mouse.on('pointer', (kind: Pointer, cell: Click) =>
    pointer.push([kind, cell]),
  );
  return { source, mouse, read, wheel, clicks, pointer };
}

await test('mouse reports leave the input as wheel steps and left clicks, and the keys around them read through', () => {
  const { source, read, wheel, clicks } = input();
  // a wheel up, a left click, a right press, Alt+wheel down and a Ctrl+left click
  source.emit(
    'data',
    'a\u001b[<64;5;6Mb\u001b[<0;12;3M\u001b[<0;12;3m\u001b[<2;1;1Mc\u001b[<73;1;1M\u001b[<16;2;9M\u001b[<16;2;9m',
  );
  assert.deepEqual(read, ['abc']);
  assert.deepEqual(wheel, [-1, 1]);
  assert.deepEqual(clicks, [
    { column: 11, row: 2 },
    { column: 1, row: 8 },
  ]);
});

await test('a report split across reads waits for its end', () => {
  const { source, read, clicks } = input();
  source.emit('data', 'x\u001b[<0;4');
  assert.deepEqual(read, ['x']);
  source.emit('data', ';7M\u001b[<0;4;7m');
  assert.deepEqual(read, ['x']);
  assert.deepEqual(clicks, [{ column: 3, row: 6 }]);
});

await test('a press dragged off its cell is a drag, not a click, even released where it began', () => {
  const { source, clicks, pointer } = input();
  source.emit(
    'data',
    '\u001b[<0;5;5M\u001b[<32;6;5M\u001b[<32;5;5M\u001b[<0;5;5m',
  );
  assert.deepEqual(clicks, []);
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
  assert.deepEqual(clicks, []);
});

await test('raw mode reaches the terminal', () => {
  const { source, mouse } = input();
  mouse.setRawMode(true);
  mouse.setRawMode(false);
  assert.deepEqual(source.raw, [true, false]);
});
