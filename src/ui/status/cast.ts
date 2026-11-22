import { useEffect, useMemo, useState } from 'react';
import type { DisplayItem } from '../../core/state.js';
import { accent, colors } from '../theme.js';
import { tickMs, useTick } from '../useTick.js';
import { picks, spellTitle } from './cast-animation.js';
import type { CastAnimation, CastPurpose } from './cast-animation.js';
import { chantCast } from './cast-chant.js';
import { fireCast } from './cast-fire.js';
import { hellfireCast } from './cast-hellfire.js';
import { kaomojiCast } from './cast-kaomoji.js';
import { sigilCast } from './cast-sigil.js';

const castAnimations: readonly CastAnimation[] = [
  kaomojiCast,
  fireCast,
  hellfireCast,
  sigilCast,
  chantCast,
];

/** in priority order, so a name with words from both takes the first. */
const purposeWords: [CastPurpose, string[]][] = [
  [
    'ship',
    [
      'commit',
      'pr',
      'merge',
      'release',
      'deploy',
      'finish',
      'push',
      'publish',
      'ship',
    ],
  ],
  [
    'create',
    [
      'brainstorm',
      'plan',
      'design',
      'writ',
      'draft',
      'init',
      'scaffold',
      'feature',
      'creat',
    ],
  ],
];

/** the settled heading, which the transcript caches as the copy and scroll anchor. */
export function castTitle(): string {
  return colors.hex(accent).bold(spellTitle);
}

/** read from the name alone, since native descriptions are trigger text that crosses purposes. */
export function castPurpose(spell: string): CastPurpose | undefined {
  // a plugin prefix names its package, not the spell
  const words = spell
    .slice(spell.lastIndexOf(':') + 1)
    .toLowerCase()
    .split(/[_/\s-]+/);

  return purposeWords.find(([, stems]) =>
    stems.some((stem) =>
      // `pr` would otherwise catch `prompt` and `project`
      words.some((word) =>
        stem === 'pr' ? word === stem : word.startsWith(stem),
      ),
    ),
  )?.[0];
}

/** a seeded pick among the purpose's animations, else among all, the same for every frame of one cast. */
export function castAnimation(
  item: Pick<DisplayItem, 'id' | 'spell'>,
): CastAnimation {
  const purpose =
    item.spell === undefined ? undefined : castPurpose(item.spell);

  const candidates = purpose
    ? castAnimations.filter((animation) => animation.purpose === purpose)
    : castAnimations;

  // salted, because the kaomoji ticker takes the bare seed's first draw as its phase
  return candidates[
    Math.floor(picks(`${item.id}/animation`)() * candidates.length)
  ]!;
}

interface LiveCast {
  frame: number;
  animation: CastAnimation;
}

export type Casting = ReadonlyMap<string, LiveCast>;

const none: Casting = new Map();

function live(items: readonly DisplayItem[], now: number): Casting {
  const casting = new Map<string, LiveCast>();

  for (const item of items) {
    if (!item.cast || !item.at) continue;

    const frame = Math.floor((now - Date.parse(item.at)) / tickMs);
    const animation = castAnimation(item);

    if (frame >= 0 && frame < animation.frames)
      casting.set(item.id, { frame, animation });
  }

  return casting.size ? casting : none;
}

/** casts animate only within their timestamp window, including recently restored rows. */
export function useCasting(items: readonly DisplayItem[]): Casting {
  const [watching, setWatching] = useState(false);
  const tick = useTick(1, watching);
  const casting = useMemo(() => live(items, tick * tickMs), [items, tick]);

  // a cast can arrive while the clock sleeps, so this reads the time itself
  useEffect(() => {
    setWatching(casting.size > 0 || live(items, Date.now()).size > 0);
  }, [items, casting]);

  return casting;
}
