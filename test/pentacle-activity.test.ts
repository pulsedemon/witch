import assert from 'node:assert/strict';

import { test } from 'vitest';

import { PentacleActivity } from '../src/core/pentacle-activity.js';

test('pentacle activity belongs to its sources and publishes only aggregate changes', () => {
  const activity = new PentacleActivity();

  const other = new PentacleActivity();

  const a = Symbol('work');

  const b = Symbol('work');

  const changes: boolean[] = [];

  const subscribe = activity.subscribe;

  const unsubscribe = subscribe(() => changes.push(activity.active));

  const check = (active: boolean, expected: boolean[]) => {
    assert.equal(activity.active, active);

    assert.equal(other.active, false);

    assert.deepEqual(changes, expected);
  };

  check(false, []);

  activity.set(a, true);

  activity.set(a, true);

  check(true, [true]);

  activity.set(b, true);

  activity.set(a, false);

  activity.set(a, false);

  check(true, [true]);

  activity.set(b, false);

  activity.set(b, false);

  check(false, [true, false]);

  unsubscribe();

  activity.set(a, true);

  check(true, [true, false]);
});
