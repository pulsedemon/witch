import { accent, accentDim, colors } from '../theme.js';
import { spellTitle } from './cast-animation.js';
import type { CastAnimation } from './cast-animation.js';

const hot = '#fff1c2';
const fire = '#fb923c';
const ember = '#7c3a2b';

/** one of the sweep's 20 steps, which last 100 ms each. */
function sweep(step: number, width: number): string {
  const ignition = step >= 4 && step < 6;

  const heading = ignition
    ? colors.hex(hot).bgHex('#9a3412').bold(spellTitle)
    : colors
        .hex(step < 4 ? '#d8b4fe' : step < 13 ? fire : accent)
        .bold(spellTitle);

  const reach = width - spellTitle.length - 1;

  if (reach <= 0) return heading;

  const progress = (step - 6) / 6;

  const front = Math.round(
    (step < 4 ? 1 - (step / 3) ** 2 : 1 - (1 - progress) ** 2) * (reach - 1),
  );

  const sparks = Array.from({ length: reach }, (_, column) => {
    if (step < 4) {
      const behind = column - front;

      if (behind === 0) return colors.hex('#e9d5ff').bold('*');

      if (behind === 3 || behind === 7) return colors.hex(accent)('+');

      return colors.hex(accentDim)(column % 5 === step ? '.' : ' ');
    }

    if (ignition)
      return colors.hex(column < 5 ? hot : fire).bgHex('#261333')(
        column < 5 ? '*:+:*'[column]! : column % 4 === 0 ? '.' : ' ',
      );

    if (step < 13) {
      const behind = front - column;

      if (behind === 0) return colors.hex(hot).bold('*');

      const glyph =
        behind > 0 && (column + step) % 3 !== 0
          ? behind < 5
            ? '+'
            : ':'
          : ' ';

      return colors.hex(behind < 5 ? fire : ember).bgHex('#1c1028')(glyph);
    }

    const age = step - 13;
    const glowing = (column * 7) % 11 >= (age * 10) / 6;

    return colors.hex(age < 3 ? ember : accentDim)(glowing ? '.' : ' ');
  });

  return `${heading} ${sparks.join('')}`;
}

export const fireCast: CastAnimation = {
  frames: 40,
  purpose: 'ship',
  rows: (frame, width) => ({ heading: sweep(Math.floor(frame / 2), width) }),
};
