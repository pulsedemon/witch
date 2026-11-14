import assert from 'node:assert/strict';

import { test } from 'vitest';

import { setImmediate } from 'node:timers/promises';

import { InputQueue } from '../src/agents/input-queue.js';

import { within } from './fixtures/within.js';

test('flush waits for queued inputs to finish consumer processing', async () => {
  const queue = new InputQueue<number>();

  const entered = [1, 2, 3].map(() => Promise.withResolvers<void>());

  const release = [1, 2, 3].map(() => Promise.withResolvers<void>());

  const processed: number[] = [];

  const reader = (async () => {
    for await (const value of queue) {
      entered[value - 1]!.resolve();

      await release[value - 1]!.promise;

      processed.push(value);
    }
  })();

  try {
    await within(queue.flush(), 1000, 'empty flush');

    queue.push(1);

    queue.push(2);

    let flushed = false;

    const drained = queue.flush().then(() => {
      flushed = true;
    });

    await entered[0]!.promise;

    await setImmediate();

    assert.equal(flushed, false);

    release[0]!.resolve();

    await entered[1]!.promise;

    await setImmediate();

    assert.equal(flushed, false, 'flush waits for the second consumer gate');

    assert.deepEqual(processed, [1]);

    release[1]!.resolve();

    await within(drained, 1000, 'processed inputs');

    assert.deepEqual(processed, [1, 2]);

    queue.push(3);

    let laterFlushed = false;

    const later = queue.flush().then(() => {
      laterFlushed = true;
    });

    await entered[2]!.promise;

    await setImmediate();

    assert.equal(flushed, true);

    assert.equal(laterFlushed, false);

    release[2]!.resolve();

    await within(later, 1000, 'later input');

    assert.deepEqual(processed, [1, 2, 3]);
  } finally {
    release.forEach((gate) => gate.resolve());

    queue.close();

    await reader;
  }
});
