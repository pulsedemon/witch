export interface CastKick {
  at: number;
  center: number;
  strength: number;
}

export const eased = (share: number) => {
  const held = Math.min(1, Math.max(0, share));

  return held * held * (3 - 2 * held);
};

const falloff = 0.955;
const wave = 2;
const liftoff = 0.55;

/** the upper row's share of a moving body's light, and its highlight strength. */
export function castHop(
  frame: number,
  center: number,
  kicks: readonly CastKick[],
  lift: boolean,
): { rise: number; shine: number } {
  let rise = 0;
  let shine = 0;

  for (const kick of kicks) {
    const away = Math.abs(center - kick.center);
    const power = kick.strength * falloff ** away;
    const step = frame - kick.at - Math.round(away / wave);

    if (step < 0 || power < 0.15) continue;

    if (lift && power >= liftoff) {
      const air = 12 + Math.round(6 * Math.min(1, (power - liftoff) / 0.6));

      if (step < air) {
        const arc = Math.sin((Math.PI * (step + 0.5)) / air);
        rise = Math.max(rise, eased(arc * arc));
        shine = Math.max(shine, arc);
      } else if (step < air + 4) {
        shine = Math.max(shine, 0.4 * (1 - (step - air) / 4));
      }
    } else if (step < 6) {
      shine = Math.max(shine, power * Math.sin((Math.PI * (step + 0.5)) / 6));
    }
  }

  return { rise, shine: Math.min(1, shine) };
}
