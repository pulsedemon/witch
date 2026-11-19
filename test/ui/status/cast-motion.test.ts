import assert from 'node:assert/strict';
import { test } from 'vitest';
import { castHop } from '../../../src/ui/status/cast-motion.js';

const kick = [{ at: 0, center: 0, strength: 1.2 }];

test('a hop rises through intermediate levels and lands without leaving light behind', () => {
  assert.deepEqual(castHop(-1, 0, kick, true), { rise: 0, shine: 0 });
  const rising = castHop(3, 0, kick, true);
  assert.ok(rising.rise > 0.1 && rising.rise < 0.5);
  assert.ok(castHop(8, 0, kick, true).rise > 0.98);
  const falling = castHop(14, 0, kick, true);
  assert.ok(falling.rise > 0.1 && falling.rise < 0.5);
  assert.deepEqual(castHop(30, 0, kick, true), { rise: 0, shine: 0 });
});

test('an impulse reaches neighbors later and weakens to a highlight at a distance', () => {
  assert.deepEqual(castHop(7, 16, kick, true), { rise: 0, shine: 0 });
  assert.ok(castHop(8, 16, kick, true).rise > 0);
  assert.deepEqual(castHop(15, 32, kick, true), { rise: 0, shine: 0 });
  const distant = castHop(18, 32, kick, true);
  assert.equal(distant.rise, 0);
  assert.ok(distant.shine > 0 && distant.shine < 0.3);
});

test('a strong glitch stays within the color range when the upper row is unavailable', () => {
  const glitch = [{ at: 0, center: 0, strength: 1.65 }];
  assert.deepEqual(castHop(2, 0, glitch, false), { rise: 0, shine: 1 });
});
