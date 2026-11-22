import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { test, vi } from 'vitest';
import type {
  CastAnimation,
  CastRows,
} from '../../../src/ui/status/cast-animation.js';
import {
  chantCast,
  chantStyles,
  chantTexts,
  chantVariants,
} from '../../../src/ui/status/cast-chant.js';
import { short } from '../../../src/ui/status/chants.js';
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
  /** the brightest color any cell may still show on the last frame. */
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
  {
    cast: chantCast,
    variants: chantVariants,
    load: async () =>
      (await import('../../../src/ui/status/cast-chant.js')).chantVariants,
    end: '#4a0010',
    above: ['ticker', 'crescendo', 'toll'],
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

    for (const width of [28, 200])
      for (const lift of [true, false]) {
        const { heading, above } = rows(
          family.cast.frames - 1,
          width,
          seed,
          lift,
        );

        for (const row of [heading, above ?? ''])
          assert.ok(
            brightest(row, 8) <= sum(family.end),
            `${name} ${width} ${lift}: ${brightest(row, 8)}`,
          );
      }
  }
});

test('every variant animates the heading without a row above', () => {
  for (const { family, name, rows } of variants) {
    const drawn = new Set(
      frames(family)
        .map((frame) => reach(rows(frame, 100, seed, false).heading))
        .filter(Boolean),
    );

    assert.ok(drawn.size > 1, `${name}: ${drawn.size}`);
  }
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
      [...Array(21).keys()].some((step) => blaze(20 + step)[column]?.trim()),
      String(column),
    );
});

test('a seal closes and flares at any width, with or without the row above', () => {
  for (const width of [28, 200]) {
    const seal = (frame: number, lift: boolean) => {
      const { heading, above } = sigilVariants.seal(frame, width, seed, lift);

      return { heading: stripAnsi(heading), above: stripAnsi(above ?? '') };
    };

    // the trace ends on the top-left corner, so it closes only when that is drawn
    assert.ok(!seal(20, true).above.includes('╭'), String(width));
    assert.ok(seal(40, true).above.includes('╭'), String(width));

    assert.ok(
      reach(seal(10, false).heading).length <
        reach(seal(40, false).heading).length,
      String(width),
    );

    for (const lift of [true, false])
      for (let frame = 41; frame <= 45; frame++)
        assert.ok(
          seal(frame, lift).heading.includes('═'),
          `${width} ${lift} ${frame}`,
        );
  }
});

const styles = Object.keys(chantStyles) as (keyof typeof chantStyles)[];

test('every approved text draws in single cells and fades out in every style it fits', () => {
  for (const style of styles)
    for (const text of chantTexts(style)) {
      const rows = chantStyles[style](text);

      for (const width of [30, 120])
        for (let frame = 0; frame < chantCast.frames; frame++)
          for (const lift of [true, false]) {
            const { heading, above } = rows(frame, width, seed, lift);

            for (const row of [heading, above ?? ''])
              for (const { segment } of graphemes.segment(stripAnsi(row)))
                assert.equal(
                  stringWidth(segment),
                  1,
                  `${style} ${text} ${segment}`,
                );
          }

      for (const width of [30, 200]) {
        const { heading, above } = rows(
          chantCast.frames - 1,
          width,
          seed,
          true,
        );

        for (const row of [heading, above ?? ''])
          assert.ok(
            brightest(row, 8) <= sum('#4a0010'),
            `${style} ${text} ${width}`,
          );
      }
    }
});

test('a chant keeps its text across a resize', () => {
  const runes = new Set(['ᚱ', 'ᛉ', 'ᚦ', '†', 'ᛟ', 'ᚾ']);
  const moment = { ticker: 30, crescendo: 10, toll: 14, whisper: 30 };

  for (const style of styles)
    for (const id of [...Array(20).keys()].map((index) => `spell/${index}`))
      for (const lift of [true, false]) {
        const drawn = [20, 200].map((width) =>
          chantVariants[style](moment[style], width, id, lift),
        );

        // the ticker's row above runs backward, so only its heading is compared
        const rows = (['heading', 'above'] as const).filter(
          (row) => row === 'heading' || (lift && style !== 'ticker'),
        );

        let compared = 0;

        for (const row of rows) {
          const [narrow, wide] = drawn.map((rows) => {
            const cells = [...stripAnsi(rows[row] ?? '').slice(8)].join('');

            // crescendo and toll keep the start that fits, ticker and whisper the end
            return style === 'ticker' || style === 'whisper'
              ? [...cells.trimEnd()].reverse()
              : [...cells.trimStart()];
          });

          narrow!.forEach((cell, index) => {
            const other = wide![index];

            if (
              cell === ' ' ||
              !other ||
              other === ' ' ||
              runes.has(cell) ||
              runes.has(other)
            )
              return;

            assert.equal(cell, other, `${style} ${id} ${lift} ${row}`);
            compared++;
          });
        }

        assert.ok(compared >= 3, `${style} ${id} ${lift}: ${compared}`);
      }
});

test('each crescendo round says the whole chant before the next starts', () => {
  for (const text of short) {
    const letters = [...text].filter((char) => char !== ' ').length;

    for (const round of [0, 1, 2])
      assert.ok(
        [...Array(22).keys()].some(
          (said) =>
            stripAnsi(
              chantStyles.crescendo(text)(round * 22 + said, 120, seed, false)
                .heading,
            )
              .slice(8)
              .replaceAll(' ', '').length >= letters,
        ),
        `${text} ${round}`,
      );
  }
});

test('crescendo and toll say only the short texts', () => {
  assert.equal(chantTexts('crescendo'), short);
  assert.equal(chantTexts('toll'), short);
  assert.equal(short.length, 13);

  for (const long of [
    'In nomine Dei nostri Satanas Luciferi excelsi',
    'Ad maiorem Satanae gloriam',
    'Flectere si nequeo superos, Acheronta movebo',
  ])
    assert.ok(!short.includes(long));
});
