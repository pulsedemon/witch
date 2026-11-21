import assert from 'node:assert/strict';

// qualification input only; never merge this fixture into main.
function add(left, right) {
  return left + right;
}

assert.equal(add(2, 3), 5);
