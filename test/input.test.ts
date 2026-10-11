import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editInput } from '../src/ui/input-buffer.js';

await test('pasting multiline content inserts text without an implicit submission', () => {
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
