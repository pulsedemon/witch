import stringWidth from 'string-width';
import { accent, colors } from '../theme.js';
import { picks, spellTitle } from './cast-animation.js';
import type { CastAnimation } from './cast-animation.js';
import { kaomoji } from './kaomoji.js';
import { castHop, eased } from './cast-motion.js';
import type { CastKick } from './cast-motion.js';

/** the frame the chain is fully wiped in by, and the first of its fade. */
const [opened, closing] = [10, 54];
const frames = 72;
const lilac = '#c4a0ef';
const glow = '#eee5ff';
/** near a dark terminal's background, which the chain fades from and back into. */
const night = '#1e1630';
/** one cell each. no halfwidth `ﾞ` or `ﾟ`: after a two-cell glyph Ghostty gives it no cell of its own. */
const sparks = ['☆', '✧', '♪', '♡', '･', '*', '+', '｡'];
/** how bright a hopping face's print on the heading row stays. */
const impression = 0.14;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

interface Cluster {
  text: string;
  width: number;
}

/** the clusters a terminal draws, each with its cells, so the row's edge never cuts through one. */
const clusters = (text: string): Cluster[] =>
  [...graphemes.segment(text)].map(({ segment }) => ({
    text: segment,
    width: stringWidth(segment),
  }));

const faces = kaomoji.map((text) => ({
  // drawn from the leading edge back, so last cluster first
  clusters: clusters(text).reverse(),
  width: stringWidth(text),
}));

/** a color `share` of the way from one hex color to another. */
function blend(from: string, to: string, share: number): string {
  const channel = (start: number) => {
    const low = parseInt(from.slice(start, start + 2), 16);
    const high = parseInt(to.slice(start, start + 2), 16);

    return Math.round(low + (high - low) * share)
      .toString(16)
      .padStart(2, '0');
  };

  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/**
 * the cells right of the heading and of the row above. kaomoji chained with sparkles pour out of the title like a
 * ticker, one cell a frame. kicks travel through nearby faces and sparkles; blending between the two rows
 * softens each hop without changing the transcript's layout.
 */
function stage(frame: number, reach: number, seed: string, lift: boolean) {
  const next = picks(seed);
  const shift = next();
  const out = reach + frame;

  /** every face and sparkle the chain has by now, by how far its last cell is behind the leading edge. */
  const bodies: {
    drawn: readonly Cluster[];
    before: number;
    width: number;
    face: boolean;
  }[] = [];

  for (let before = 0; before < out;) {
    const face = faces[Math.floor(next() * faces.length)]!;
    const spark = sparks[Math.floor(next() * sparks.length)]!;

    bodies.push({
      drawn: face.clusters,
      before,
      width: face.width,
      face: true,
    });

    before += face.width + 1;

    bodies.push({
      drawn: [{ text: spark, width: 1 }],
      before,
      width: 1,
      face: false,
    });

    before += 2;
  }

  const chance = picks(`${seed}/kicks`);
  /** kicks rotate across the row so fresh faces launch the next ripple. */
  const kicks: CastKick[] = [];

  for (let at = opened + Math.floor(chance() * 3); at < closing - 3;) {
    const side = (kicks.length + Math.floor(shift * 3)) % 3;
    const spot = at + reach * (0.08 + side * 0.28 + chance() * 0.16);

    const nearest = bodies
      .filter(({ face }) => face)
      .reduce((best, body) =>
        Math.abs(body.before + body.width / 2 - spot) <
        Math.abs(best.before + best.width / 2 - spot)
          ? body
          : best,
      );

    kicks.push({
      at,
      center: nearest.before + nearest.width / 2,
      strength: 1.1 + chance() * 0.4,
    });

    at += 8 + Math.floor(chance() * 5);
  }

  const distortion = picks(`${seed}/glitch`);
  let glitch: { from: number; to: number } | undefined;

  for (let at = opened + 8 + Math.floor(distortion() * 4); at < closing - 3;) {
    const from = at + Math.floor(reach * (0.15 + distortion() * 0.65));
    const to = from + 8 + Math.floor(distortion() * 7);

    if (frame >= at && frame < at + 3) glitch = { from, to };

    kicks.push({ at: at - 2, center: (from + to) / 2, strength: 1.65 });
    at += 23 + Math.floor(distortion() * 6);
  }

  const front =
    (reach + 12) * (1 - (1 - Math.min(1, (frame + 1) / opened)) ** 3);

  const lit = eased((frames - frame) / (frames - closing));
  const ground: string[] = Array.from({ length: reach }, () => ' ');
  const sky: string[] = Array.from({ length: reach }, () => ' ');

  for (const [
    index,
    { drawn, before: start, width: span, face },
  ] of bodies.entries()) {
    const { rise, shine } = castHop(frame, start + span / 2, kicks, lift);

    const twinkle = face
      ? 1
      : 0.72 + 0.28 * Math.sin(frame * 0.45 + index * 1.9);

    let before = start;

    for (const { text, width } of drawn) {
      const column = out - before - width;
      before += width;

      if (column < 0 || column + width > reach) continue;

      // soft at the title, at the row's end and at the wipe's front
      const shown =
        lit *
        twinkle *
        Math.min(1, (column + 1) / 4, (reach - column) / 10) *
        Math.min(1, Math.max(0, (front - column) / 12));

      const color = blend(
        accent,
        lilac,
        0.65 + 0.15 * Math.sin(shift * Math.PI * 2 + start / 24 - frame / 14),
      );

      const broken =
        glitch &&
        before >= glitch.from &&
        before < glitch.to &&
        (before + frame) % 3 !== 0;

      const glyph = broken
        ? ['░', '▒', '_', '/', '\\', '|'][(before + frame) % 6]!.repeat(width)
        : text;

      const tone = blend(
        color,
        glow,
        broken ? 0.9 : (face ? 0.55 : 0.65) * shine + (face ? 0 : 0.3),
      );

      for (const [cells, share] of [
        [ground, face && rise > 0 ? Math.max(impression, 1 - rise) : 1 - rise],
        [sky, rise],
      ] as const) {
        if (share * shown < 0.06) continue;

        cells[column] = colors.hex(blend(night, tone, share * shown))(glyph);
        cells.fill('', column + 1, column + width);
      }
    }
  }

  return { ground: ground.join(''), sky: sky.join('') };
}

export const kaomojiCast: CastAnimation = {
  frames,
  purpose: 'create',
  rows(frame, width, seed, lift) {
    const reach = width - spellTitle.length - 1;
    const lit = eased((frames - frame) / (frames - closing));

    const heading = colors
      .hex(blend(blend(accent, lilac, lit), glow, 1 - eased((frame + 1) / 8)))
      .bold(spellTitle);

    if (reach <= 0) return { heading };

    const { ground, sky } = stage(frame, reach, seed, lift);

    return {
      heading: `${heading} ${ground}`,
      above: lift ? `${' '.repeat(spellTitle.length + 1)}${sky}` : undefined,
    };
  },
};
