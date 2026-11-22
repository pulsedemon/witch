export type CastPurpose = 'ship' | 'create';

export const spellTitle = '✦ Spell';

export interface CastAnimation {
  /** shared 50 ms ticks the cast stays live. */
  frames: number;
  purpose: CastPurpose;
  /** a live cast's heading row, and the row above it when `lift` allows one. neither changes the cached rows. */
  rows(
    frame: number,
    width: number,
    seed: string,
    lift: boolean,
  ): { heading: string; above?: string };
}

export type CastRows = CastAnimation['rows'];

/** numbers in [0, 1) that repeat for a seed, so every frame of one cast draws the same. */
export function picks(seed: string): () => number {
  let state = 2166136261;

  for (const char of seed)
    state = Math.imul(state ^ char.codePointAt(0)!, 16777619);

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** a color `share` of the way from one hex color to another. */
export function blend(from: string, to: string, share: number): string {
  const channel = (start: number) => {
    const low = parseInt(from.slice(start, start + 2), 16);
    const high = parseInt(to.slice(start, start + 2), 16);

    return Math.round(low + (high - low) * share)
      .toString(16)
      .padStart(2, '0');
  };

  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/** one of `variants` per seed, so every frame and every resize of one cast draws the same one. */
export function varied(variants: readonly CastRows[]): CastRows {
  return (frame, width, seed, lift) =>
    variants[Math.floor(picks(`${seed}/variant`)() * variants.length)]!(
      frame,
      width,
      seed,
      lift,
    );
}
