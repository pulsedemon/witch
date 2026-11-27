import assert from 'node:assert/strict';
import { test } from 'vitest';
import { chatLayout } from '../../src/ui/chat-layout.js';

const working = {
  working: true,
  pending: false,
  message: true,
  list: 0,
  hints: 0,
};

test('the message row takes a row only when the composer’s limit leaves one', () => {
  // a 24-row terminal, less the phase row and a two-row footer, leaves the chat 21 rows
  assert.deepEqual(
    [20, 21].map((height) => {
      const { message, composer } = chatLayout(height, 80, working);

      return { message, composer };
    }),
    [
      { message: 0, composer: 10 },
      { message: 1, composer: 10 },
    ],
  );

  // a working phase that is not the agent's own run, such as compacting
  assert.equal(chatLayout(40, 80, { ...working, message: false }).message, 0);
});

test('a composer at its limit leaves the transcript its rows at every height', () => {
  for (let height = 1; height <= 80; height++)
    for (const controls of [working, { ...working, list: 5 }]) {
      const { content, composer, transcript } = chatLayout(
        height,
        80,
        controls,
      );

      assert.ok(content - composer >= transcript, `height ${height}`);
    }
});

test('rows the footer took come out of the gap and then the tool window', () => {
  const idle = { ...working, working: false, message: false };
  const before = chatLayout(11, 80, idle);
  const after = chatLayout(9, 80, { ...idle, yielded: 2 });
  assert.deepEqual([before.commands, before.gap], [4, 1]);
  assert.deepEqual([after.commands, after.gap], [3, 0]);
  assert.equal(after.transcript, before.transcript);
  assert.equal(after.composer, before.composer);
});
