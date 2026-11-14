import assert from 'node:assert/strict';

import { access } from 'node:fs/promises';

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

export const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

export async function appears(path: string, what = path) {
  await until(what, () => exists(path));
}

/** whether the promise has settled yet, either way. */
export function settled(promise: Promise<unknown>) {
  let done = false;

  void promise.then(
    () => (done = true),
    () => (done = true),
  );

  return () => done;
}
