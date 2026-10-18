import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editInput, initialInput } from '../src/ui/input-buffer.js';
import type { Step } from '../src/ui/input-buffer.js';

await test('an insert stores CRLF and lone CR line endings as newlines', () => {
  assert.deepEqual(
    editInput(
      { value: 'ab', cursor: 1 },
      { type: 'insert', text: 'first\r\nsecond\rthird' },
    ),
    { value: 'afirst\nsecond\nthirdb', cursor: 19 },
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
  const at = (cursor: number, type: Step) =>
    editInput({ value, cursor }, { type });
  assert.deepEqual(at(4, 'left'), { value, cursor: 3 });
  assert.deepEqual(at(4, 'backspace'), { value: 'e\u0301x👩‍💻y\nz', cursor: 3 });
  assert.deepEqual(at(3, 'right'), { value, cursor: 4 });
  assert.deepEqual(at(3, 'delete'), { value: 'e\u0301x👩‍💻y\nz', cursor: 3 });
  assert.deepEqual(at(2, 'left'), { value, cursor: 0 });
  assert.deepEqual(at(4, 'right'), { value, cursor: 9 });
  assert.deepEqual(at(9, 'backspace'), { value: 'e\u0301x\ny\nz', cursor: 4 });
  assert.deepEqual(at(9, 'up'), { value, cursor: 3 });
  assert.deepEqual(at(2, 'down'), { value, cursor: 4 });
  assert.deepEqual(at(9, 'home'), { value, cursor: 4 });
  assert.deepEqual(at(4, 'end'), { value, cursor: 10 });
  assert.deepEqual(at(2, 'up'), { value, cursor: 2 });
  assert.deepEqual(at(11, 'down'), { value, cursor: 11 });
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

await test('word moves stop at word edges, crossing punctuation, blank lines and combining marks', () => {
  // o0 n1 e2 ·3 t4 w5 o6 ,7 ·8 ·9 t10 … e14 \n15 \n16 ·17 ·18 f19 … r22 .23
  const value = 'one two,  three\n\n  four.';
  const at = (cursor: number, type: 'wordLeft' | 'wordRight', text = value) =>
    editInput({ value: text, cursor }, { type }).cursor;
  assert.deepEqual(
    [23, 19, 12, 10, 4, 0].map((cursor) => at(cursor, 'wordLeft')),
    [19, 10, 10, 4, 0, 0],
  );
  // with no word before it, the value's start
  assert.equal(at(2, 'wordLeft', '  four'), 0);
  assert.deepEqual(
    [0, 1, 3, 7, 15, 21, 23].map((cursor) => at(cursor, 'wordRight')),
    [3, 3, 7, 15, 23, 23, 24],
  );
  // ï and é as a letter plus a combining mark stay inside their words
  const marked = 'nai\u0308ve cafe\u0301';
  assert.deepEqual(
    [
      at(12, 'wordLeft', marked),
      at(7, 'wordLeft', marked),
      at(0, 'wordRight', marked),
      at(6, 'wordRight', marked),
    ],
    [7, 0, 6, 12],
  );
  // `foo_` and `_baz` are one word each only when their whole line is segmented
  const under = 'foo_ bar _baz';
  assert.deepEqual(
    [at(10, 'wordLeft', under), at(3, 'wordRight', under)],
    [9, 4],
  );
});

await test('word and line deletions remove only what the matching move passes over', () => {
  const run = (value: string, cursor: number, type: Step) =>
    editInput({ value, cursor }, { type });
  const value = 'one two,  three\n\n  four.';
  assert.deepEqual(run(value, 12, 'backspaceWord'), {
    value: 'one two,  ree\n\n  four.',
    cursor: 10,
  });
  assert.deepEqual(run(value, 19, 'backspaceWord'), {
    value: 'one two,  four.',
    cursor: 10,
  });
  assert.deepEqual(run(value, 7, 'deleteWord'), {
    value: 'one two\n\n  four.',
    cursor: 7,
  });
  assert.deepEqual(run(value, 15, 'deleteWord'), {
    value: 'one two,  three.',
    cursor: 15,
  });
  const row = (value: string, cursor: number, start: number) =>
    editInput({ value, cursor }, { type: 'backspaceRow', start });
  // `three` wrapped onto a row of its own
  assert.deepEqual(row('one two three', 13, 8), {
    value: 'one two ',
    cursor: 8,
  });
  const lines = 'one\ntwo three';
  assert.deepEqual(row(lines, 8, 4), { value: 'one\nthree', cursor: 4 });
  assert.deepEqual(row(lines, 4, 4), { value: 'onetwo three', cursor: 3 });
  assert.deepEqual(row(lines, 0, 0), { value: lines, cursor: 0 });
});

await test('a word move in a 200KB draft segments only the lines it crosses', () => {
  const value = 'word\n'.repeat(40000) + 'x y';
  const times: number[] = [];
  for (let run = 0; run < 5; run++) {
    const start = performance.now();
    editInput({ value, cursor: value.length }, { type: 'wordLeft' });
    editInput({ value, cursor: 0 }, { type: 'wordRight' });
    times.push(performance.now() - start);
  }
  assert.ok(
    Math.min(...times) < 1,
    `fastest pair of word moves took ${Math.min(...times)} ms`,
  );
});
