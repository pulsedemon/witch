import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editInput, initialInput } from '../src/ui/input-buffer.js';

await test('an insert stores CRLF line endings as newlines', () => {
  assert.deepEqual(
    editInput(
      { value: 'ab', cursor: 1 },
      { type: 'insert', text: 'first\r\nsecond' },
    ),
    { value: 'afirst\nsecondb', cursor: 13 },
  );
});

await test('backspace removes a whole grapheme without damaging adjacent text', () => {
  assert.deepEqual(
    editInput({ value: 'a👩‍💻b', cursor: 6 }, { type: 'backspace' }),
    { value: 'ab', cursor: 1 },
  );
});

await test('line navigation and insertion retain the intended text order', () => {
  const up = editInput({ value: 'one\ntwo', cursor: 6 }, { type: 'up' });
  assert.deepEqual(up, { value: 'one\ntwo', cursor: 2 });
  assert.deepEqual(editInput(up, { type: 'insert', text: 'X' }), {
    value: 'onXe\ntwo',
    cursor: 3,
  });
});

await test('Home and Down navigate an empty first line', () => {
  const state = { value: '\nabc', cursor: 0 };
  assert.deepEqual(editInput(state, { type: 'home' }), state);
  assert.deepEqual(editInput(state, { type: 'down' }), {
    value: '\nabc',
    cursor: 1,
  });
});

await test('cursor moves and deletions land on grapheme boundaries across lines', () => {
  // é as e plus a combining accent, then an emoji of five UTF-16 units
  const value = 'e\u0301x\n👩‍💻y\nz';
  const at = (
    cursor: number,
    type: 'left' | 'right' | 'up' | 'down' | 'backspace' | 'delete',
  ) => editInput({ value, cursor }, { type });
  assert.deepEqual(at(4, 'left'), { value, cursor: 3 });
  assert.deepEqual(at(4, 'backspace'), { value: 'e\u0301x👩‍💻y\nz', cursor: 3 });
  assert.deepEqual(at(3, 'right'), { value, cursor: 4 });
  assert.deepEqual(at(3, 'delete'), { value: 'e\u0301x👩‍💻y\nz', cursor: 3 });
  assert.deepEqual(at(2, 'left'), { value, cursor: 0 });
  assert.deepEqual(at(4, 'right'), { value, cursor: 9 });
  assert.deepEqual(at(9, 'backspace'), { value: 'e\u0301x\ny\nz', cursor: 4 });
  assert.deepEqual(at(9, 'up'), { value, cursor: 3 });
  assert.deepEqual(at(2, 'down'), { value, cursor: 4 });
  assert.deepEqual(initialInput('a\r\nb'), { value: 'a\nb', cursor: 3 });
});

await test('an insert into a 200KB draft segments nothing', () => {
  const value = 'word '.repeat(40000);
  const times: number[] = [];
  for (let run = 0; run < 5; run++) {
    const start = performance.now();
    editInput({ value, cursor: value.length }, { type: 'insert', text: 'x' });
    times.push(performance.now() - start);
  }
  assert.ok(
    Math.min(...times) < 1,
    `fastest insert took ${Math.min(...times)} ms`,
  );
});
