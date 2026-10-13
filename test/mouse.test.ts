import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Click } from '../src/ui/mouse.js';
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
  mouse.on('readable', () => {
    let text;
    while ((text = mouse.read()) !== null) read.push(text);
  });
  mouse.on('wheel', (rows: number) => wheel.push(rows));
  mouse.on('click', (click: Click) => clicks.push(click));
  return { source, mouse, read, wheel, clicks };
}

await test('mouse reports leave the input as wheel steps and left presses, and the keys around them read through', () => {
  const { source, read, wheel, clicks } = input();
  // a wheel up, a left press and its release, a right press, Alt+wheel down and Ctrl+left press
  source.emit(
    'data',
    'a\u001b[<64;5;6Mb\u001b[<0;12;3M\u001b[<0;12;3m\u001b[<2;1;1Mc\u001b[<73;1;1M\u001b[<16;2;9M',
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
  source.emit('data', ';7M');
  assert.deepEqual(read, ['x']);
  assert.deepEqual(clicks, [{ column: 3, row: 6 }]);
});

await test('raw mode reaches the terminal', () => {
  const { source, mouse } = input();
  mouse.setRawMode(true);
  mouse.setRawMode(false);
  assert.deepEqual(source.raw, [true, false]);
});
