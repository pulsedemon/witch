import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { Text, useInput } from 'ink';
import type { Cell, Pointer } from '../src/ui/mouse.js';
import {
  MouseInput,
  captureMouse,
  releaseMouse,
  usePointer,
} from '../src/ui/mouse.js';
import { show } from './fixtures/ui.js';
import { until } from './fixtures/within.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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
  const hovers: Cell[] = [];
  let clicks = 0;
  const pointer: [Pointer, Cell][] = [];
  mouse.on('readable', () => {
    let text;
    while ((text = mouse.read()) !== null) read.push(text);
  });
  mouse.on('wheel', (rows: number) => wheel.push(rows));
  mouse.on('hover', (cell: Cell) => hovers.push(cell));
  mouse.on('click', () => clicks++);
  mouse.on('pointer', (kind: Pointer, cell: Cell) =>
    pointer.push([kind, cell]),
  );
  return { source, mouse, read, wheel, hovers, clicks: () => clicks, pointer };
}

function noMouse(found: ReturnType<typeof input>) {
  assert.deepEqual(found.pointer, []);
  assert.deepEqual(found.wheel, []);
  assert.deepEqual(found.hovers, []);
  assert.equal(found.clicks(), 0);
}

async function showInput() {
  const events: ([Pointer, Cell] | ['key', string, string[]])[] = [];
  function Probe() {
    usePointer((action, cell) => events.push([action, cell]));
    useInput((input, key) =>
      events.push([
        'key',
        input,
        Object.entries(key)
          .filter(([, value]) => value === true)
          .map(([name]) => name),
      ]),
    );
    return createElement(Text, {}, 'ready');
  }
  let ui!: ReturnType<typeof show>;
  await act(async () => {
    ui = show(createElement(Probe));
  });
  return { ...ui, events };
}

const press = '\u001b[<0;4;7M';
const release = '\u001b[<0;4;7m';
const pair = [
  ['press', { column: 3, row: 6 }],
  ['release', { column: 3, row: 6 }],
];

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

await test('a report split across reads waits for its end', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let split = 1; split < press.length; split++) {
    const { source, read, clicks, pointer } = input();
    source.emit('data', 'x' + press.slice(0, split));
    assert.deepEqual(read, ['x'], `press prefix ${split}`);
    source.emit('data', press.slice(split));
    source.emit('data', release.slice(0, split));
    source.emit('data', release.slice(split) + 'y');
    assert.deepEqual(read, ['x', 'y']);
    assert.equal(clicks(), 1);
    assert.deepEqual(pointer, pair);
  }
  const { source, read, clicks, pointer } = input();
  source.emit('data', 'x');
  for (const byte of press + release) source.emit('data', byte);
  source.emit('data', 'y');
  assert.deepEqual(read, ['x', 'y']);
  assert.equal(clicks(), 1);
  assert.deepEqual(pointer, pair);
});

await test('ambiguous prefixes expire once at 20 ms', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const prefix of ['\u001b', '\u001b[', '\u001b\u001b', '\u001b\u001b[']) {
    const found = input();
    found.source.emit('data', 'x' + prefix);
    t.mock.timers.tick(19);
    assert.deepEqual(found.read, ['x']);
    t.mock.timers.tick(1);
    assert.deepEqual(found.read, ['x', prefix]);
    t.mock.timers.tick(100);
    assert.deepEqual(found.read, ['x', prefix]);
    noMouse(found);
  }
});

await test('prefix progress cancels expiry and a recognized mouse body waits for completion', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const found = input();
  for (const [chunk, wait] of [
    ['\u001b', 19],
    ['[', 19],
    ['<0;4', 100],
  ] as const) {
    found.source.emit('data', chunk);
    assert.deepEqual(found.read, []);
    noMouse(found);
    t.mock.timers.tick(wait);
    assert.deepEqual(found.read, []);
    noMouse(found);
  }
  found.source.emit('data', ';7M' + release);
  assert.deepEqual(found.read, []);
  assert.deepEqual(found.pointer, pair);
  assert.equal(found.clicks(), 1);
});

await test('stalled prefix progress expires at its renewed deadline', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const found = input();
  found.source.emit('data', '\u001b');
  t.mock.timers.tick(19);
  found.source.emit('data', '[');
  t.mock.timers.tick(19);
  assert.deepEqual(found.read, []);
  t.mock.timers.tick(1);
  assert.deepEqual(found.read, ['\u001b[']);
  t.mock.timers.tick(100);
  assert.deepEqual(found.read, ['\u001b[']);
  noMouse(found);
});

await test('non-mouse escape sequences pass through unchanged', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const sequence of [
    '\u001bb',
    '\u001b[D',
    '\u001b[27u',
    '\u001b[99;9u',
    '\u001b[200~first\nsecond\u001b[201~',
  ]) {
    const found = input();
    for (const byte of sequence) found.source.emit('data', byte);
    assert.equal(found.read.join(''), sequence);
    t.mock.timers.tick(100);
    assert.equal(found.read.join(''), sequence);
    noMouse(found);
  }
});

await test('long Escape runs before a key keep input responsive', () => {
  const found = input();
  const sequence = '\u001b'.repeat(32_768) + 'b';
  const started = process.cpuUsage();
  found.source.emit('data', sequence);
  const { user, system } = process.cpuUsage(started);
  assert.ok(user + system < 100_000, `input used ${user + system} µs of CPU`);
  assert.deepEqual(found.read, [sequence]);
  noMouse(found);
});

await test('disabling raw mode cancels a pending prefix', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const prefix of ['\u001b', '\u001b[<0;4']) {
    const found = input();
    found.mouse.setRawMode(true);
    found.source.emit('data', prefix);
    found.mouse.setRawMode(false);
    t.mock.timers.tick(100);
    assert.deepEqual(found.read, []);
    noMouse(found);
    found.mouse.setRawMode(true);
    found.source.emit('data', 'z');
    assert.deepEqual(found.read, ['z']);
    noMouse(found);
    assert.deepEqual(found.source.raw, [true, false, true]);
  }
});

await test('a disabled raw-mode timer cannot flush a new activation', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const found = input();
  found.mouse.setRawMode(true);
  found.source.emit('data', '\u001b');
  found.mouse.setRawMode(false);
  t.mock.timers.tick(10);
  found.mouse.setRawMode(true);
  found.source.emit('data', '\u001b[<0;4');
  t.mock.timers.tick(10);
  assert.deepEqual(found.read, []);
  noMouse(found);
  found.source.emit('data', ';7M');
  assert.deepEqual(found.read, []);
  assert.deepEqual(found.pointer, [['press', { column: 3, row: 6 }]]);
  assert.deepEqual(found.wheel, []);
  assert.deepEqual(found.hovers, []);
  assert.equal(found.clicks(), 0);
  assert.deepEqual(found.source.raw, [true, false, true]);
});

await test('Ink receives keys once after fragmented mouse input', async () => {
  for (const split of [1, 2]) {
    const ui = await showInput();
    try {
      await act(async () => {
        for (const report of [press, release]) {
          ui.stdin.write(report.slice(0, split));
          ui.stdin.write(report.slice(split));
        }
      });
      assert.deepEqual(ui.events, pair);
      ui.events.length = 0;
      await act(async () => {
        for (const chunk of [
          '\u001b',
          '[',
          'D',
          '\u001b',
          'b',
          '\u001b[27u',
          '\u001b',
        ])
          ui.stdin.write(chunk);
      });
      await act(async () => {
        await until('legacy Escape', () => ui.events.length >= 4);
      });
      assert.deepEqual(ui.events, [
        ['key', '', ['leftArrow']],
        ['key', 'b', ['meta']],
        ['key', '', ['escape']],
        ['key', '', ['escape']],
      ]);
      ui.events.length = 0;
      await act(async () => {
        ui.stdin.write('\u001b\u001b');
      });
      await act(async () => {
        await until('double Escape', () => ui.events.length > 0);
      });
      assert.deepEqual(ui.events, [['key', '\u001b', ['escape', 'meta']]]);
    } finally {
      await act(async () => {
        ui.unmount();
      });
    }
  }
});

await test('Ink preserves Escape before a slow mouse body', async () => {
  const ui = await showInput();
  try {
    await act(async () => {
      ui.stdin.write('\u001b\u001b[<0;4');
    });
    await act(async () => {
      await until(
        'Escape before completing mouse body',
        () => ui.events.length > 0,
      );
    });
    assert.deepEqual(ui.events, [['key', '', ['escape']]]);
    await act(async () => {
      ui.stdin.write(';7M' + release + 'b');
    });
    assert.deepEqual(ui.events, [
      ['key', '', ['escape']],
      ...pair,
      ['key', 'b', []],
    ]);
  } finally {
    await act(async () => {
      ui.unmount();
    });
  }
});

await test('legacy Escape stays ambiguous through both input waits', async (t) => {
  const ui = await showInput();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await act(async () => {
      ui.stdin.write('\u001b');
      t.mock.timers.tick(20);
      t.mock.timers.tick(10);
    });
    assert.deepEqual(ui.events, []);
    await act(async () => {
      ui.stdin.write('b');
    });
    assert.deepEqual(ui.events, [['key', 'b', ['meta']]]);
    await act(async () => {
      t.mock.timers.tick(100);
    });
    assert.deepEqual(ui.events, [['key', 'b', ['meta']]]);
    ui.events.length = 0;
    await act(async () => {
      ui.stdin.write('\u001b');
      t.mock.timers.tick(20);
      t.mock.timers.tick(19);
    });
    assert.deepEqual(ui.events, []);
    await act(async () => {
      t.mock.timers.tick(1);
    });
    assert.deepEqual(ui.events, [['key', '', ['escape']]]);
    await act(async () => {
      ui.stdin.write('b');
    });
    assert.deepEqual(ui.events, [
      ['key', '', ['escape']],
      ['key', 'b', []],
    ]);
  } finally {
    await act(async () => {
      ui.unmount();
    });
  }
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

await test('motion with no button held and middle or right reports are hovers at their cell, and neither click nor reach the input', () => {
  const { source, read, clicks, pointer, hovers } = input();
  // a hover, then a middle and a right press, drag and release
  source.emit(
    'data',
    'a\u001b[<35;3;2Mb\u001b[<1;4;2M\u001b[<33;5;2M\u001b[<1;5;2m\u001b[<2;6;2M\u001b[<34;7;2M\u001b[<2;7;2m',
  );
  assert.deepEqual(read, ['a', 'b']);
  assert.deepEqual(hovers, [
    { column: 2, row: 1 },
    { column: 3, row: 1 },
    { column: 4, row: 1 },
    { column: 4, row: 1 },
    { column: 5, row: 1 },
    { column: 6, row: 1 },
    { column: 6, row: 1 },
  ]);
  assert.equal(clicks(), 0);
  assert.deepEqual(pointer, []);
});

await test('raw mode reaches the terminal', () => {
  const { source, mouse } = input();
  mouse.setRawMode(true);
  mouse.setRawMode(false);
  assert.deepEqual(source.raw, [true, false]);
});

await test('capturing the mouse asks for all motion, in SGR coordinates, and releasing it ends every mode capture began', () => {
  const modes = (sequence: string, end: 'h' | 'l') =>
    [...sequence.matchAll(/\?(\d+)([hl])/g)]
      .filter(([, , kind]) => kind === end)
      .map(([, mode]) => mode)
      .sort();
  assert.deepEqual(modes(captureMouse, 'h'), ['1003', '1006']);
  assert.deepEqual(modes(releaseMouse, 'l'), modes(captureMouse, 'h'));
});
