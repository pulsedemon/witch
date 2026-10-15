import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} timed out`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function until(
  what: string,
  predicate: () => boolean | Promise<boolean>,
) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail(`timed out waiting for ${what}`);
}
