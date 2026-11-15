import assert from 'node:assert/strict';
import { test } from 'vitest';
import { within } from '../../src/paths.js';

test('within holds for a path itself and the paths under it', () => {
  assert.equal(within('/a/b', '/a/b'), true);
  assert.equal(within('/a/b/c', '/a/b'), true);
  assert.equal(within('/a', '/a/b'), false);
});

test('within rejects a sibling that shares a name prefix', () => {
  assert.equal(within('/a/bc', '/a/b'), false);
});

test('within holds for every path under the filesystem root', () => {
  assert.equal(within('/a', '/'), true);
});
