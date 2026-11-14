import assert from 'node:assert/strict';
import { test } from 'vitest';
import { pentacle } from '../src/ui/pentacle.js';

const drawn = (angle: number) =>
  pentacle(angle, 22, 11).map((runs) => runs.map(({ text }) => text).join(''));

/** the columns that hold any dot. */
const span = (rows: string[]): [number, number] => {
  const used = rows.flatMap((row) =>
    [...row].flatMap((cell, column) => (cell === ' ' ? [] : [column])),
  );

  return [Math.min(...used), Math.max(...used)];
};

test('face on, the pentacle fills its cells, and a quarter turn about its upright axis narrows it to the middle', () => {
  assert.deepEqual(span(drawn(0)), [0, 21]);

  const [left, right] = span(drawn(Math.PI / 2));

  assert.ok(left >= 8 && right <= 13, `${left}..${right}`);
});
