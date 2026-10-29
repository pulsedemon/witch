import { useEffect, useState } from 'react';
import type { DisplayItem } from '../core/state.js';
import { accent, colors, potion } from './theme.js';

export const castFrames = 12;
export const castMs = castFrames * 100;
const glyphs = ['✧', '✦', '✶', '✦'];
const word = 'Spell';

/** a frame keeps the final title's width, so the transcript never shifts under it. */
export function castTitle(frame?: number): string {
  const title = colors.hex(accent).bold;
  if (frame === undefined) return title(`✦ ${word}`);
  const lit = frame % word.length;
  const letters = [...word].map((letter, index) =>
    index === lit ? colors.hex(potion).bold(letter) : letter,
  );
  return title(`${glyphs[frame % glyphs.length]} ${letters.join('')}`);
}

function live(items: readonly DisplayItem[], now: number) {
  const casting = new Map<string, number>();
  for (const item of items) {
    if (!item.cast || !item.at) continue;
    const age = now - Date.parse(item.at);
    if (age >= 0 && age < castMs) casting.set(item.id, Math.floor(age / 100));
  }
  return casting;
}

/** each cast row's frame while new; history loads past its window, so only casts made now animate. */
export function useCasting(
  items: readonly DisplayItem[],
): ReadonlyMap<string, number> {
  const [casting, setCasting] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  useEffect(() => {
    const update = () => {
      const next = live(items, Date.now());
      // an unchanged empty map keeps its identity, so a transcript with no new cast doesn't render again
      setCasting((previous) => (previous.size || next.size ? next : previous));
      return next.size > 0;
    };
    if (!update()) return;
    const timer = setInterval(() => {
      if (!update()) clearInterval(timer);
    }, 100);
    return () => clearInterval(timer);
  }, [items]);
  return casting;
}
