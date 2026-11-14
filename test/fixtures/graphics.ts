import type { Graphics } from '../../src/ui/images.js';
import { within } from './within.js';

/** resolves once `count` more loads finish. loads run on one chain, so a call right after the `rows` or `render` that queued them can't miss one. */
export async function loaded(graphics: Graphics, count = 1): Promise<void> {
  let left = count;

  let finish = () => {};

  const finished = new Promise<void>((resolve) => (finish = resolve));

  const unsubscribe = graphics.subscribe(() => {
    if (--left === 0) finish();
  });

  try {
    await within(finished, 5_000, `${count} image loads`);
  } finally {
    unsubscribe();
  }
}
