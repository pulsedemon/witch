import assert from 'node:assert/strict';
import { test } from 'vitest';
import { castAnimation, castPurpose } from '../../../src/ui/status/cast.js';
import { varied } from '../../../src/ui/status/cast-animation.js';
import { fireCast } from '../../../src/ui/status/cast-fire.js';
import {
  hellfireCast,
  hellfireVariants,
} from '../../../src/ui/status/cast-hellfire.js';
import { kaomojiCast } from '../../../src/ui/status/cast-kaomoji.js';
import { sigilCast, sigilVariants } from '../../../src/ui/status/cast-sigil.js';

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

test('a spell with a purpose plays only that purpose’s animations', () => {
  const shipped = new Set(
    ids(40).map((id) => castAnimation({ id, spell: 'commit-message' })),
  );

  assert.deepEqual(shipped, new Set([fireCast, hellfireCast]));

  const created = new Set(
    ids(40).map((id) => castAnimation({ id, spell: 'brainstorming' })),
  );

  assert.deepEqual(created, new Set([kaomojiCast, sigilCast]));
});

test('varied keeps one variant per seed and reaches every variant', () => {
  const names = ['a', 'b', 'c', 'd'];
  const rows = varied(names.map((name) => () => ({ heading: name })));
  const reached = new Set<string>();

  for (const [id, other] of ids(40).map((id, index) => [id, `other/${index}`]))
    for (const frame of [0, 30, 63])
      for (const width of [9, 60, 120])
        for (const lift of [true, false]) {
          const { heading } = rows(frame, width, id!, lift);
          rows(frame, width, other!, lift);
          assert.equal(heading, rows(0, 9, id!, false).heading);
          reached.add(heading);
        }

  assert.deepEqual(reached, new Set(names));
});

test('every animation with variants reaches each of them across casts', () => {
  for (const [cast, variants] of [
    [hellfireCast, hellfireVariants],
    [sigilCast, sigilVariants],
  ] as const) {
    const reached = new Set(
      ids(40).map((id) => {
        const drawn = cast.rows(10, 100, id, true);

        return Object.entries(variants).find(
          ([, rows]) =>
            JSON.stringify(rows(10, 100, id, true)) === JSON.stringify(drawn),
        )?.[0];
      }),
    );

    assert.deepEqual(reached, new Set(Object.keys(variants)));
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
