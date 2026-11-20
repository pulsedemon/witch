import assert from 'node:assert/strict';
import type * as childProcess from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { test, vi } from 'vitest';
import type * as vitest from 'vitest';
import { scratch } from '../fixtures/scratch.js';

const provided = vi.hoisted(() => ({ root: '' }));

vi.mock('vitest', async (original) => ({
  ...(await original<typeof vitest>()),
  inject: () => provided.root,
}));

vi.mock('node:child_process', async (original) => {
  const child = await original<typeof childProcess>();
  const execute = promisify(child.execFile);

  return {
    ...child,
    execFile: Object.assign(child.execFile.bind(child), {
      [promisify.custom]: (file: string, args: string[]) =>
        args[0]?.endsWith('/scripts/build.mjs')
          ? execute(process.execPath, [`${provided.root}/build.mjs`])
          : execute(file, args),
    }),
  };
});

test('a failed compiled CLI build reports compiler stdout with stderr and its exit code', async () => {
  provided.root = await scratch('witch-build-failure-');

  await writeFile(
    `${provided.root}/build.mjs`,
    "process.stdout.write('src/probe.ts(1,1): error TS9999: build diagnostic\\n'); process.stderr.write('build failed\\n'); process.exit(2)",
  );

  await assert.rejects(
    import('../fixtures/compiled-cli.js'),
    (error: Error) => {
      assert.match(error.message, /error TS9999: build diagnostic/);
      assert.match(error.message, /build failed/);
      assert.equal((error as Error & { code: number }).code, 2);

      return true;
    },
  );
});
