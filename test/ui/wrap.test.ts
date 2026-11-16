import assert from 'node:assert/strict';
import { test } from 'vitest';
import { wrapSourceLines } from '../../src/ui/wrap.js';

test('page rows drop the space they broke at and anchor to their source offsets', () => {
  assert.deepEqual(wrapSourceLines('abcdefghij klm\n    code line', 10), [
    [
      { text: 'abcdefghij', offset: 0 },
      { text: 'klm', offset: 11 },
    ],
    [
      { text: '    code ', offset: 0 },
      { text: 'line', offset: 9 },
    ],
  ]);

  assert.deepEqual(wrapSourceLines('abc def', 3), [
    [
      { text: 'abc', offset: 0 },
      { text: 'def', offset: 4 },
    ],
  ]);
});
