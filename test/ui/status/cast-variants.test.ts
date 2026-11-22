import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { test, vi } from 'vitest';
import type {
  CastAnimation,
  CastRows,
} from '../../../src/ui/status/cast-animation.js';
import {
  hellfireCast,
  hellfireVariants,
} from '../../../src/ui/status/cast-hellfire.js';
import { sigilCast, sigilVariants } from '../../../src/ui/status/cast-sigil.js';
import { brightest, isFinal } from '../../fixtures/cast.js';

interface Family {
  cast: CastAnimation;
  variants: Readonly<Record<string, CastRows>>;
  /** a fresh instance of the family's module, for checking that rows keep no state between calls. */
  load: () => Promise<Readonly<Record<string, CastRows>>>;
  /** the darkest color every cell has faded to by the last frame. */
  end: string;
  /** the variants that draw in the blank row above. */
  above: readonly string[];
}

const families: Family[] = [
  {
    cast: hellfireCast,
    variants: hellfireVariants,
    load: async () =>
      (await import('../../../src/ui/status/cast-hellfire.js'))
        .hellfireVariants,
    end: '#5a1a1a',
    above: ['blaze', 'firewall', 'brimstone'],
  },
  {
    cast: sigilCast,
    variants: sigilVariants,
    load: async () =>
      (await import('../../../src/ui/status/cast-sigil.js')).sigilVariants,
    end: '#120004',
    above: ['seal', 'collapse'],
  },
];

const variants = families.flatMap((family) =>
  Object.entries(family.variants).map(([name, rows]) => ({
    family,
    name,
    rows,
  })),
);

const seed = 'spell/variant';
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const frames = (family: Family) => [...Array(family.cast.frames).keys()];

const sum = (hex: string) =>
  [1, 3, 5].reduce(
    (total, start) => total + parseInt(hex.slice(start, start + 2), 16),
    0,
  );

const reach = (row: string) => stripAnsi(row).slice(8).trim();

test('every variant stays inside the width with the title anchored', () => {
  for (const { family, name, rows } of variants)
    for (const width of [7, 8, 9, 10, 28, 61, 100, 200])
      for (const frame of frames(family))
        for (const lift of [true, false]) {
          const { heading, above } = rows(frame, width, seed, lift);
          const where = `${name} ${width} ${frame} ${lift}`;
          assert.ok(stripAnsi(heading).startsWith('✦ Spell'), where);

          for (const row of [heading, above ?? '']) {
            assert.ok(stringWidth(row) <= width, where);

            for (const { segment } of graphemes.segment(stripAnsi(row)))
              assert.equal(stringWidth(segment), 1, `${where} ${segment}`);
          }

          if (!lift) assert.equal(above, undefined, where);

          if (above !== undefined)
            assert.ok(stripAnsi(above).startsWith(' '.repeat(8)), where);
        }
});

test('a narrow terminal shows the title alone', () => {
  for (const { name, rows } of variants)
    for (const width of [7, 8])
      for (const lift of [true, false]) {
        const { heading, above } = rows(20, width, seed, lift);
        assert.equal(stripAnsi(heading), '✦ Spell', name);
        assert.equal(above, undefined, name);
      }
});

test('every variant starts live and ends dark', () => {
  for (const { family, name, rows } of variants) {
    for (const lift of [true, false])
      assert.ok(!isFinal(rows(0, 100, seed, lift).heading), name);

    for (const width of [28, 200]) {
      const { heading, above } = rows(
        family.cast.frames - 1,
        width,
        seed,
        true,
      );

      for (const row of [heading, above ?? ''])
        assert.ok(
          brightest(row, 8) <= sum(family.end),
          `${name} ${width}: ${brightest(row, 8)}`,
        );
    }
  }
});

test('every variant animates the heading without a row above', () => {
  for (const { family, name, rows } of variants)
    assert.ok(
      frames(family).some((frame) =>
        reach(rows(frame, 100, seed, false).heading),
      ),
      name,
    );
});

test('variants listed as drawing above do so', () => {
  for (const { family, name, rows } of variants)
    if (family.above.includes(name))
      assert.ok(
        frames(family).some((frame) =>
          stripAnsi(rows(frame, 100, seed, true).above ?? '').trim(),
        ),
        name,
      );
});

test('rows depend only on their arguments', async () => {
  for (const family of families) {
    const drawn = new Map<string, ReturnType<CastRows>>();

    const key = (name: string, frame: number, width: number) =>
      `${name}/${frame}/${width}`;

    for (const [name, rows] of Object.entries(family.variants)) {
      drawn.set(key(name, -40, 100), rows(40, 100, seed, true));

      for (const frame of frames(family).reverse())
        for (const width of [100, 61])
          drawn.set(key(name, frame, width), rows(frame, width, seed, true));
    }

    vi.resetModules();
    const fresh = await family.load();

    for (const [name, rows] of Object.entries(fresh)) {
      for (const width of [100, 61])
        for (const frame of frames(family))
          assert.deepEqual(
            rows(frame, width, seed, true),
            drawn.get(key(name, frame, width)),
            `${name} ${frame} ${width}`,
          );

      assert.deepEqual(
        rows(40, 100, seed, true),
        drawn.get(key(name, -40, 100)),
      );
    }
  }
});

test('the blaze lights out of the title and burns across the row', () => {
  const blaze = (frame: number) =>
    stripAnsi(hellfireVariants.blaze(frame, 100, seed, false).heading);

  assert.ok(blaze(1).slice(8, 12).trim());

  for (let column = 8; column < 100; column++)
    assert.ok(
      [...Array(21).keys()].some((step) => blaze(20 + step)[column] !== ' '),
      String(column),
    );
});

test('a seal closes and flares at any width, with or without the row above', () => {
  for (const width of [28, 200])
    for (const lift of [true, false])
      for (let frame = 41; frame <= 45; frame++)
        assert.ok(
          stripAnsi(
            sigilVariants.seal(frame, width, seed, lift).heading,
          ).includes('═'),
          `${width} ${lift} ${frame}`,
        );
});
