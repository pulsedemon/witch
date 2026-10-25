import assert from 'node:assert/strict';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';

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
  attempts = 150,
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) {
      // a view shown after an await attaches its Ink input listeners in a later React task, so keys sent before it reach the previous view
      await setImmediate();
      return;
    }
    await delay(20);
  }
  assert.fail(`timed out waiting for ${what}`);
}
