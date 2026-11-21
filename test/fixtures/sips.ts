import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { vi } from 'vitest';
import type { TestContext } from 'vitest';

export function hangingSips(t: TestContext): Promise<void> {
  t.onTestFinished(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  const started = Promise.withResolvers<void>();

  vi.spyOn(childProcess, 'execFile').mockImplementation((...call) => {
    const [, , { signal }, callback] = call as unknown as [
      string,
      string[],
      { signal: AbortSignal },
      (error: Error | null, stdout: string) => void,
    ];

    signal.addEventListener('abort', () => callback(new Error('aborted'), ''));
    started.resolve();

    return new childProcess.ChildProcess();
  });

  syncBuiltinESMExports();

  return started.promise;
}
