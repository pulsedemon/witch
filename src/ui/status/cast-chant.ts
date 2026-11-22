import { accent, colors } from '../theme.js';
import {
  blankLine,
  blend,
  castLines,
  lattice,
  picks,
  spellTitle,
  varied,
} from './cast-animation.js';
import type { CastAnimation, CastLine, CastRows } from './cast-animation.js';
import { chants, short } from './chants.js';

const frames = 76;
/** what a fresh letter flickers through before it settles. no `⸸`: Ghostty draws it as `◆`. */
const runes = ['ᚱ', 'ᛉ', 'ᚦ', '†', 'ᛟ', 'ᚾ'];
const ember = '#1a0004';

const rune = (salt: number, at: number, frame: number) =>
  runes[Math.floor(lattice(salt, at, frame) * runes.length)]!;

const frakturCapitals: Readonly<Record<string, string>> = {
  C: 'ℭ',
  H: 'ℌ',
  I: 'ℑ',
  R: 'ℜ',
  Z: 'ℨ',
};

/** Mathematical Fraktur, whose C, H, I, R and Z sit in the Letterlike Symbols block. */
const fraktur = (text: string) =>
  [...text]
    .map((char) => {
      const code = char.charCodeAt(0);

      if (char >= 'a' && char <= 'z')
        return String.fromCodePoint(0x1d51e + code - 97);

      if (char >= 'A' && char <= 'Z')
        return (
          frakturCapitals[char] ?? String.fromCodePoint(0x1d504 + code - 65)
        );

      return char;
    })
    .join('');

/** the title darkens toward blood while the chant runs, then sinks at the end. */
function title(frame: number) {
  const color =
    frame < 66
      ? blend(accent, '#b00020', Math.min(1, frame / 30))
      : blend('#b00020', '#4a0010', (frame - 66) / 9);

  return colors.hex(color).bold(spellTitle);
}

type Style = (text: string) => CastRows;

/** wraps a style's lines in the title and the row above's indent. */
function chant(
  paint: (
    text: string,
    frame: number,
    reach: number,
    salt: number,
    lift: boolean,
  ) => [CastLine, CastLine?],
): Style {
  return (text) => (frame, width, seed, lift) => {
    const reach = width - spellTitle.length - 1;

    if (reach <= 0) return { heading: title(frame) };

    const salt = Math.floor(picks(`${seed}/runes`)() * 2 ** 32);
    const [heading, above] = paint(text, frame, reach, salt, lift);

    return castLines(
      title(frame),
      heading,
      lift ? (above ?? blankLine(reach)) : undefined,
    );
  };
}

/** pours out of the title a letter a frame, the words running backward above, cut off mid-word. */
const ticker = chant((text, frame, reach, salt, lift) => {
  const cut = 64;
  const stream = [...`${text} · ${text} · ${text} · `];
  const after = frame - cut;
  const heading = blankLine(reach);
  const above = blankLine(reach);

  if (after >= 8) return [heading];

  const shown = stream.slice(0, Math.min(frame + 1, cut));
  const line = shown.slice(-reach);
  // after the cut, only the word being said smolders on
  const word = line.length - 1 - line.lastIndexOf(' ');

  line.forEach((char, at) => {
    const age = line.length - 1 - at;

    if (after > 0 && age >= word) return;

    let color =
      age === 0 ? '#ff4040' : blend('#d0102a', '#3a0008', age / reach);

    if (lattice(salt, at, frame) > 0.92) color = '#ff7060';

    if (after === 0) color = '#ffffff';

    if (after > 0) color = blend('#a0001a', ember, after / 8);

    heading[at] = {
      glyph: age < 2 && after < 0 ? rune(salt, at, frame) : char,
      color,
      bold: age < 2 || after === 0,
    };
  });

  if (lift && after < 0)
    [...line].reverse().forEach((char, at) => {
      above[at] = {
        glyph: char,
        color: lattice(salt + 1, at, frame) > 0.82 ? '#5a0016' : '#2a0008',
      };
    });

  return [heading, above];
});

/** spaced capitals said three times, each louder, the last echo fading above. */
const crescendo = chant((text, frame, reach, salt, lift) => {
  const per = 22;
  const letters = [...[...text.toUpperCase()].join(' ')].slice(0, reach);
  const round = Math.min(2, Math.floor(frame / per));
  const said = frame - round * per;
  const done = frame >= per * 3;
  const loud = round / 2;
  const offset = Math.max(0, Math.floor((reach - letters.length) / 2));

  const shown = done
    ? letters.length
    : Math.min(letters.length, Math.floor(said * 1.6) + 1);

  const heading = blankLine(reach);
  const above = blankLine(reach);

  for (let at = 0; at < shown; at++) {
    const fresh = !done && shown - at < 3;

    const color = done
      ? blend('#ff3030', ember, (frame - per * 3) / 9)
      : fresh
        ? '#ffffff'
        : blend(
            blend('#5a0010', '#ff2a2a', loud),
            '#ffffff',
            lattice(salt, at, frame) > 0.95 ? 0.6 : 0,
          );

    heading[offset + at] = {
      glyph:
        fresh && letters[at] !== ' ' ? rune(salt, at, frame) : letters[at]!,
      color,
      bg: round === 2 && !done ? '#2a0006' : undefined,
      bold: round > 0,
    };

    if (lift && round > 0 && !done)
      above[offset + at] = {
        glyph: letters[at]!,
        color: blend('#3a0010', '#120004', said / per),
      };
  }

  return [heading, above];
});

/** one Fraktur word tolled every 11 frames, each rising into the row above as it fades. */
const toll = chant((text, frame, reach, _salt, lift) => {
  const [every, shown, settle] = [11, 20, 6];
  const heading = blankLine(reach);
  const above = blankLine(reach);
  let start = 0;

  fraktur(text)
    .split(' ')
    .forEach((word, index) => {
      const letters = [...word];
      const at = start;
      const said = frame - index * every;
      start += letters.length + 2;

      if (said < 0 || said >= shown) return;

      const risen = lift && said >= settle;

      const color =
        said === 0
          ? '#ffffff'
          : said < settle
            ? blend('#ff3030', '#a0001a', said / settle)
            : blend('#5a0014', '#0e0002', (said - settle) / (shown - settle));

      letters.forEach((glyph, offset) => {
        if (at + offset < reach)
          (risen ? above : heading)[at + offset] = {
            glyph,
            color,
            bold: said < 3,
          };
      });
    });

  return [heading, above];
});

/** a whisper: letters resolve out of runes while the tail dissolves, until it all dissolves. */
const whisper = chant((text, frame, reach, salt) => {
  const stream = [...`${text} … ${text} … `];
  const whole = 26;
  const span = Math.min(whole, reach - 1);
  const front = Math.min(stream.length, Math.floor(frame * 0.9) + 1);
  const gone = Math.max(0, (frame - 60) / 12);
  const heading = blankLine(reach);
  const first = Math.max(0, front - span);

  for (let index = first; index < front; index++) {
    const age = front - 1 - index;
    // measured against the full whisper, so a narrow row shows its newest part dissolving the same way
    const fade = age / whole;

    // the newest letters hold until the whole whisper goes
    if (
      (age > 0 || gone > 0) &&
      lattice(salt, index, frame >> 1) < fade * 0.7 + gone
    )
      continue;

    heading[1 + index - first] = {
      glyph: age > 1 ? stream[index]! : rune(salt, index, frame),
      color: age > 1 ? blend('#d04060', '#2a0812', fade) : '#ffb0c0',
    };
  }

  return [heading];
});

export const chantStyles = {
  ticker,
  crescendo,
  toll,
  whisper,
} satisfies Record<string, Style>;

/** the texts a style may draw: crescendo spaces letters out and toll says one word at a time. */
export const chantTexts = (style: keyof typeof chantStyles) =>
  style === 'crescendo' || style === 'toll' ? short : chants;

export const chantVariants = Object.fromEntries(
  Object.entries(chantStyles).map(([style, paint]) => {
    const texts = chantTexts(style as keyof typeof chantStyles);

    const rows: CastRows = (frame, width, seed, lift) =>
      paint(texts[Math.floor(picks(`${seed}/chant`)() * texts.length)]!)(
        frame,
        width,
        seed,
        lift,
      );

    return [style, rows];
  }),
) as Record<keyof typeof chantStyles, CastRows>;

export const chantCast: CastAnimation = {
  frames,
  rows: varied(Object.values(chantVariants)),
};
