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
