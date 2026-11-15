import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { vi } from 'vitest';
import type { TestContext } from 'vitest';

/** makes `stat` of `path` alone fail as the OS refusing to look, until the test ends. chmod can't stand in for it, since root ignores modes. */
export function unreadable(
  t: Pick<TestContext, 'onTestFinished'>,
  path: string,
): void {
  const stat = fs.promises.stat;

  const spy = vi
    .spyOn(fs.promises, 'stat')
    .mockImplementation(((target, options) =>
      String(target) === path
        ? Promise.reject(
            Object.assign(
              new Error(`EACCES: permission denied, stat '${path}'`),
              { code: 'EACCES' },
            ),
          )
        : stat(target, options)) as typeof fs.promises.stat);

  syncBuiltinESMExports();

  t.onTestFinished(() => {
    spy.mockRestore();
    syncBuiltinESMExports();
  });
}
