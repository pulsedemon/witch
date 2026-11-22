import { accent, colors } from '../theme.js';
import { blend, picks, spellTitle, varied } from './cast-animation.js';
import type { CastAnimation, CastRows } from './cast-animation.js';

const frames = 64;
/** pixel rows: two half blocks per terminal row, the line above first. */
const pixels = 4;

const doom = [
  '#1f0707',
  '#2f0f07',
  '#470f07',
  '#571707',
  '#671f07',
  '#771f07',
  '#8f2707',
  '#9f2f07',
  '#af3f07',
  '#bf4707',
  '#c74707',
  '#df4f07',
  '#df5707',
  '#d75f07',
  '#cf6f0f',
  '#c78717',
  '#bf9f1f',
  '#e6b84a',
  '#ffd166',
];

const crimson = [
  '#14040a',
  '#22060e',
  '#320812',
  '#460a14',
  '#5c0c16',
  '#740e18',
  '#8c101a',
  '#a4141a',
  '#bc1a18',
  '#d22416',
  '#e23414',
  '#ee4a14',
  '#f66418',
  '#fc8a2a',
  '#ffb04a',
];

const core = '#fff1c2';
const smoke = '#3a1a4a';

interface Fire {
  palette: readonly string[];
  /** flame height in pixels at full heat. */
  scale: number;
  /** columns a frame the tongues lean by. */
  wind: number;
  smoke: boolean;
  /** the frame a column catches and the frame it goes out, for `x` of `reach`. */
  span(x: number, reach: number): [number, number];
}

/** a fixed hash of a lattice point to [0, 1). */
function lattice(salt: number, i: number, j: number): number {
  let h = Math.imul(
    salt ^ Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1),
    0x9e3779b1,
  );

  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);

  return ((h ^ (h >>> 13)) >>> 0) / 2 ** 32;
}

/** value noise in [0, 1), smooth between lattice points. */
function smooth(salt: number, x: number, t: number): number {
  const [i, j] = [Math.floor(x), Math.floor(t)];

  const [u, v] = [x - i, t - j].map((d) => d * d * (3 - 2 * d)) as [
    number,
    number,
  ];

  const near = lattice(salt, i, j) * (1 - u) + lattice(salt, i + 1, j) * u;

  const far =
    lattice(salt, i, j + 1) * (1 - u) + lattice(salt, i + 1, j + 1) * u;

  return near * (1 - v) + far * v;
}

const pick = (palette: readonly string[], heat: number) =>
  palette[Math.min(palette.length - 1, Math.floor(heat * palette.length))]!;

/** the column's fuel: 0 before it catches and after it goes out, easing in and out between. */
function fuel(fire: Fire, x: number, reach: number, frame: number): number {
  const [on, off] = fire.span(x, reach);
  const length = off - on;

  if (frame < on || frame >= off) return 0;

  return Math.min(
    1,
    (frame - on + 1) / Math.min(4, length / 3),
    (off - frame) / Math.min(6, length / 2),
  );
}

/** an ember's glow after its column goes out, gone well before the cast settles. */
function ember(fire: Fire, x: number, reach: number, frame: number): number {
  const off = fire.span(x, reach)[1];

  return frame < off ? 0 : 0.9 * 0.88 ** (frame - off);
}

/** the flame's height in pixels: a travelling wave plus slow noise, so neighboring columns move together. */
function height(
  fire: Fire,
  salt: number,
  x: number,
  reach: number,
  frame: number,
) {
  const heat = fuel(fire, x, reach, frame);

  if (heat === 0) return 0;

  const lean = x - frame * fire.wind;

  const tongue =
    0.5 +
    0.5 *
      Math.sin(
        lean * 0.55 + frame * 0.9 + 2 * Math.sin(lean * 0.17 + frame * 0.11),
      );

  return (
    heat *
    fire.scale *
    (1.2 + 1.5 * tongue + 1.3 * smooth(salt, lean * 0.4, frame * 0.35))
  );
}

/** every pixel's color, or `undefined` where the terminal's own background shows. */
function canvas(fire: Fire, frame: number, reach: number, seed: string) {
  const salt = Math.floor(picks(`${seed}/fire`)() * 2 ** 32);

  const grid = Array.from({ length: pixels }, () =>
    Array<string | undefined>(reach).fill(undefined),
  );

  for (let x = 0; x < reach; x++) {
    const tall = height(fire, salt, x, reach, frame);
    const flicker = lattice(salt, x, frame);

    for (let y = 0; y < pixels; y++) {
      const base = pixels - 1 - y;
      const over = tall - base;

      if (over > 0) {
        const heat =
          (0.25 + 0.75 * (1 - base / Math.max(tall, 1))) *
          Math.min(1, over + 0.15) *
          (0.78 + 0.22 * smooth(salt + 1, x * 0.6, frame * 0.5));

        grid[y]![x] =
          heat > 0.93 && flicker > 0.82 ? core : pick(fire.palette, heat);
      } else if (
        fire.smoke &&
        y < 2 &&
        tall > 1.5 &&
        lattice(salt + 2, x * 3 + y, frame >> 1) > 0.55
      )
        grid[y]![x] = blend(smoke, '#140a1a', lattice(salt + 3, x, frame));
    }

    const glow = ember(fire, x, reach, frame);
    const twinkle = lattice(salt + 4, x, frame >> 2);

    if (!grid[3]![x] && glow > 0.08 && twinkle > 0.3)
      grid[3]![x] =
        glow > 0.3
          ? blend('#3a0a04', '#c43a08', glow * twinkle)
          : blend('#1e1818', '#4a4040', glow * 2);
  }

  sparks(fire, salt, frame, reach, grid);

  return grid;
}

/** sparks born over tall flames, recomputed from the seed on every call so rows stay pure. */
function sparks(
  fire: Fire,
  salt: number,
  frame: number,
  reach: number,
  grid: (string | undefined)[][],
) {
  const life = 6;

  for (let birth = Math.max(0, frame - life + 1); birth <= frame; birth++)
    for (let n = 0; n < Math.ceil(reach / 24); n++) {
      const x = Math.floor(lattice(salt + 5, birth, n) * reach);

      if (height(fire, salt, x, reach, birth) < 2.5) continue;

      const age = frame - birth;
      const drift = (lattice(salt + 6, birth, n) - 0.3) * 0.6;

      const [column, row] = [
        Math.floor(x + 0.5 + drift * age),
        Math.floor(1.5 - age * 0.5),
      ];

      if (row >= 0 && column >= 0 && column < reach && !grid[row]![column])
        grid[row]![column] = blend('#ffcf6a', '#7a1a05', age / life);
    }
}

/** two pixels stacked in one cell. */
function cell(top: string | undefined, bottom: string | undefined): string {
  if (top && bottom) return colors.hex(top).bgHex(bottom)('▀');

  if (top) return colors.hex(top)('▀');

  if (bottom) return colors.hex(bottom)('▄');

  return ' ';
}

function burn(fire: Fire): CastRows {
  return (frame, width, seed, lift) => {
    const out = Math.max(...[0, 0.5, 1].map((share) => fire.span(share, 1)[1]));

    const title =
      frame < out
        ? colors
            .hex(frame % 3 ? '#ffd166' : '#ff8c00')
            .bgHex('#4a0000')
            .bold(spellTitle)
        : colors
            .hex(
              blend(
                '#ff5a1a',
                accent,
                Math.min(1, (frame - out) / (frames - 1 - out)),
              ),
            )
            .bold(spellTitle);

    const reach = width - spellTitle.length - 1;

    if (reach <= 0) return { heading: title };

    const grid = canvas(fire, frame, reach, seed);

    const row = (top: number) =>
      grid[top]!.map((color, x) => cell(color, grid[top + 1]![x])).join('');

    return {
      heading: `${title} ${row(2)}`,
      above: lift ? `${' '.repeat(spellTitle.length + 1)}${row(0)}` : undefined,
    };
  };
}

/** a third of the reach wide, crossing it by frame 36. */
const wave = 1 / 3;

export const hellfireVariants = {
  /** lights out of the title, holds, then gutters right to left into embers. */
  blaze: burn({
    palette: doom,
    scale: 0.95,
    wind: 0,
    smoke: false,
    span: (x, reach) => [
      Math.floor((9 * x) / reach),
      30 + Math.floor(10 * (1 - x / reach)),
    ],
  }),
  /** a wave of fire runs out of the title and burns out behind itself. */
  firewall: burn({
    palette: doom,
    scale: 0.95,
    wind: 0.35,
    smoke: false,
    span: (x, reach) => [
      Math.floor((36 * (x / reach)) / (1 + wave)),
      Math.floor((36 * (x / reach + wave)) / (1 + wave)),
    ],
  }),
  /** low crimson brimstone with violet smoke off the tips. */
  brimstone: burn({
    palette: crimson,
    scale: 0.75,
    wind: -0.15,
    smoke: true,
    span: (x, reach) => [
      Math.floor((7 * x) / reach),
      34 + Math.floor(6 * (x / reach)),
    ],
  }),
} satisfies Record<string, CastRows>;

export const hellfireCast: CastAnimation = {
  frames,
  purpose: 'ship',
  rows: varied(Object.values(hellfireVariants)),
};
