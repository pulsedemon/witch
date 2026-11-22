import assert from 'node:assert/strict';
import { test } from 'vitest';
import { castAnimation, castPurpose } from '../../../src/ui/status/cast.js';
import { fireCast } from '../../../src/ui/status/cast-fire.js';
import { kaomojiCast } from '../../../src/ui/status/cast-kaomoji.js';

const ids = (count: number) =>
  Array.from({ length: count }, (_, index) => `spell/${index}`);

test('a spell name reads as the purpose its own words name first', () => {
  assert.equal(castPurpose('commit-message'), 'ship');
  assert.equal(castPurpose('finishing-a-development-branch'), 'ship');
  assert.equal(castPurpose('writing-pr'), 'ship');
  assert.equal(castPurpose('superpowers:brainstorming'), 'create');
  assert.equal(castPurpose('prompt-tuning'), undefined);
  assert.equal(castPurpose('feature-dev:code-reviewer'), undefined);
});

test('a spell with a purpose always plays that purpose’s animation', () => {
  for (const id of ids(20)) {
    assert.equal(castAnimation({ id, spell: 'commit-message' }), fireCast);
    assert.equal(castAnimation({ id, spell: 'brainstorming' }), kaomojiCast);
  }
});

test('a spell without a purpose, or a row without a name, picks any animation the same way each time', () => {
  for (const spell of [undefined, 'simplify-changes']) {
    const picked = ids(40).map((id) => castAnimation({ id, spell }));
    assert.ok(picked.includes(fireCast));
    assert.ok(picked.includes(kaomojiCast));

    assert.deepEqual(
      ids(40).map((id) => castAnimation({ id, spell })),
      picked,
    );
  }
});
