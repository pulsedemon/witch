import { accent, colors } from '../theme.js';
import {
  blankLine,
  blend,
  castLines,
  picks,
  spellTitle,
  varied,
} from './cast-animation.js';
import type { CastAnimation, CastRows } from './cast-animation.js';

const frames = 64;
/** one cell each in Ghostty. no `⸸`: Ghostty draws it as `◆`. */
const glyphs = ['†', '☿', '♄', '♃', '♂', '♆', 'ᛟ', 'ᛉ', 'ᚦ', '⛧'];
const spacing = 8;
const scar = '#120004';

/** this cast's sigils, in order, and the columns they sit at: as many as fit, at most seven. */
function sigils(reach: number, seed: string) {
  const next = picks(`${seed}/glyphs`);
  const pool = [...glyphs];

  for (let index = pool.length - 1; index > 0; index--) {
    const swap = Math.floor(next() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap]!, pool[index]!];
  }

  const count = Math.max(0, Math.min(7, Math.floor((reach - 9) / spacing) + 1));

  return pool
    .slice(0, count)
    .map((glyph, index) => ({ glyph, at: 4 + index * spacing }));
}

/** a burning trace draws a seal around the row, lighting each sigil as it passes, then flares and fades. */
const seal: CastRows = (frame, width, seed, lift) => {
  const [closed, flared] = [40, 46];
  const flaring = frame > closed && frame < flared;
  const fade = Math.max(0, (frame - flared) / 16);

  const title = flaring
    ? colors.hex('#ffffff').bgHex('#7a0012').bold(spellTitle)
    : colors
        .hex(
          fade > 0
            ? blend('#8a0018', accent, Math.min(1, fade))
            : blend(
                accent,
                '#8a0018',
                (0.7 * Math.min(frame, closed)) / closed,
              ),
        )
        .bold(spellTitle);

  const reach = width - spellTitle.length - 1;

  if (reach <= 0) return { heading: title };

  const marks = sigils(reach, seed);
  const right = marks.length ? marks.at(-1)!.at + 4 : reach - 1;
  const heading = blankLine(reach);
  const above = lift ? blankLine(reach) : undefined;
  const path: [number, number][] = [];

  for (let x = 0; x <= right; x++) path.push([1, x]);

  if (lift) for (let x = right; x >= 0; x--) path.push([0, x]);

  const head = (Math.min(frame, closed) / closed) * path.length;

  const edge = (row: number, x: number) => {
    if (!lift) return flaring ? '═' : '─';

    if (x === 0) return row ? (flaring ? '╚' : '╰') : flaring ? '╔' : '╭';

    if (x === right) return row ? (flaring ? '╝' : '╯') : flaring ? '╗' : '╮';

    return flaring ? '═' : '─';
  };

  path.forEach(([row, x], index) => {
    if (index > head) return;

    const behind = head - index;
    const sigil = row === 1 ? marks.find((mark) => mark.at === x) : undefined;

    const color = flaring
      ? frame % 2
        ? '#ff3030'
        : '#ff7050'
      : fade > 0
        ? blend(sigil ? '#ff2a2a' : '#6a0012', scar, Math.min(1, fade))
        : behind < 1
          ? '#fff4d0'
          : behind < 10
            ? blend('#ffb040', '#c01020', behind / 10)
            : '#6a0012';

    (row ? heading : above!)[x] = sigil
      ? {
          glyph: sigil.glyph,
          color: flaring || (behind < 3 && fade === 0) ? '#ffffff' : color,
          bg: flaring ? '#6a0010' : undefined,
          bold: true,
        }
      : { glyph: edge(row, x), color, bold: behind < 1 || flaring };
  });

  return castLines(title, heading, above);
};

/** sigils are scratched in one by one, then pulled into a pentagram that pulses and burns out. */
const collapse: CastRows = (frame, width, seed, lift) => {
  const [pull, merged, fading] = [40, 50, 56];
  const fade = Math.max(0, (frame - fading) / 7);
  const pulse = (Math.sin((frame - merged) / 1.5) + 1) / 2;

  const title = colors
    .hex(
      frame >= merged && frame < fading
        ? frame % 2
          ? '#ff2020'
          : '#ffffff'
        : fade > 0
          ? blend('#8a0018', accent, Math.min(1, fade))
          : blend(accent, '#8a0018', Math.min(1, frame / pull)),
    )
    .bold(spellTitle);

  const reach = width - spellTitle.length - 1;

  if (reach <= 0) return { heading: title };

  const marks = sigils(reach, seed);
  const heading = blankLine(reach);
  const above = lift ? blankLine(reach) : undefined;
  const center = marks[Math.floor((marks.length - 1) / 2)]?.at ?? 0;

  if (frame < merged) {
    const pulled = Math.max(0, frame - pull) / (merged - pull);

    marks.forEach(({ glyph, at }, index) => {
      const scratched = frame - index * 5;

      if (scratched < 0) return;

      const next = marks[index + 1];

      if (pulled === 0 && next && frame >= (index + 1) * 5)
        for (let dot = at + 1; dot < next.at; dot++)
          heading[dot] = { glyph: '·', color: '#5a0010' };

      const x = Math.round(at + (center - at) * pulled ** 2);

      if (pulled > 0)
        for (let trail = Math.min(x, at); trail <= Math.max(x, at); trail++)
          heading[trail] = {
            glyph: '·',
            color: blend('#ff3030', '#2a0008', pulled),
          };

      heading[x] =
        scratched < 3
          ? {
              glyph: ['/', '×', '\\'][scratched]!,
              color: '#ffd0d0',
              bold: true,
            }
          : { glyph, color: pulled > 0 ? '#ff4040' : '#c0001c', bold: true };

      if (scratched < 3 && above) {
        if (x > 0) above[x - 1] = { glyph: '˙', color: '#ff6060' };

        if (x + 1 < reach) above[x + 1] = { glyph: '`', color: '#ff6060' };
      }
    });

    return castLines(title, heading, above);
  }

  if (fade >= 1) return castLines(title, heading, above);

  heading[center] = {
    glyph: '⛧',
    color:
      fade > 0
        ? blend('#ff2020', scar, fade)
        : blend('#ff2020', '#ffffff', pulse * 0.6),
    bg: fade > 0 ? undefined : '#5a0010',
    bold: true,
  };

  if (fade > 0) return castLines(title, heading, above);

  for (let ray = 1; ray <= Math.min(6, frame - merged + 1); ray++) {
    const color = blend('#ff4030', '#3a0008', ray / 6);

    for (const x of [center - ray - 1, center + ray + 1])
      if (x >= 0 && x < reach) heading[x] = { glyph: '─', color };
  }

  if (above) {
    above[center] = {
      glyph: '✶',
      color: pulse > 0.5 ? '#ff9a3a' : '#ff3030',
      bold: true,
    };

    for (const x of [center - 2, center + 2])
      if (x >= 0 && x < reach) above[x] = { glyph: '˙', color: '#c02020' };
  }

  return castLines(title, heading, above);
};

export const sigilVariants = { seal, collapse } satisfies Record<
  string,
  CastRows
>;

export const sigilCast: CastAnimation = {
  frames,
  purpose: 'create',
  rows: varied(Object.values(sigilVariants)),
};
