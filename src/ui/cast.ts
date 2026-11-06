import { useEffect, useState } from 'react';
import type { DisplayItem } from '../core/state.js';
import { accent, accentDim, colors } from './theme.js';

const stepMs = 100;
export const castFrames = 20;
export const castMs = castFrames * stepMs;
const title = '✦ Spell';
const hot = '#fff1c2';
const fire = '#fb923c';
const ember = '#7c3a2b';

/** decoration stays on the heading's row; the cached title remains the copy and scroll anchor. */
export function castTitle(frame?: number, width = title.length): string {
  if (frame === undefined) return colors.hex(accent).bold(title);
  const ignition = frame >= 4 && frame < 6;
  const heading = ignition
    ? colors.hex(hot).bgHex('#9a3412').bold(title)
    : colors
        .hex(frame < 4 ? '#d8b4fe' : frame < 13 ? fire : accent)
        .bold(title);
  const reach = width - title.length - 1;
  if (reach <= 0) return heading;
  const progress = (frame - 6) / 6;
  const front = Math.round(
    (frame < 4 ? 1 - (frame / 3) ** 2 : 1 - (1 - progress) ** 2) * (reach - 1),
  );
  const sparks = Array.from({ length: reach }, (_, column) => {
    if (frame < 4) {
      const behind = column - front;
      if (behind === 0) return colors.hex('#e9d5ff').bold('*');
      if (behind === 3 || behind === 7) return colors.hex(accent)('+');
      return colors.hex(accentDim)(column % 5 === frame ? '.' : ' ');
    }
    if (ignition)
      return colors.hex(column < 5 ? hot : fire).bgHex('#261333')(
        column < 5 ? '*:+:*'[column]! : column % 4 === 0 ? '.' : ' ',
      );
    if (frame < 13) {
      const behind = front - column;
      if (behind === 0) return colors.hex(hot).bold('*');
      const glyph =
        behind > 0 && (column + frame) % 3 !== 0
          ? behind < 5
            ? '+'
            : ':'
          : ' ';
      return colors.hex(behind < 5 ? fire : ember).bgHex('#1c1028')(glyph);
    }
    const age = frame - 13;
    const glowing = (column * 7) % 11 >= (age * 10) / 6;
    return colors.hex(age < 3 ? ember : accentDim)(glowing ? '.' : ' ');
  });
  return `${heading} ${sparks.join('')}`;
}

function live(items: readonly DisplayItem[], now: number) {
  const casting = new Map<string, number>();
  for (const item of items) {
    if (!item.cast || !item.at) continue;
    const age = now - Date.parse(item.at);
    if (age >= 0 && age < castMs)
      casting.set(item.id, Math.floor(age / stepMs));
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
    }, stepMs);
    return () => clearInterval(timer);
  }, [items]);
  return casting;
}
