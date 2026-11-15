import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inject } from 'vitest';
import { openLocked } from '../../src/persistence/lock.js';
import { scratch } from './scratch.js';
import { exists } from './within.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const compiled = buildCli();

// keep the shared build outside each CLI behavior check's deadline
await compiled;

export function compiledCli(): Promise<string> {
  return compiled;
}

async function buildCli(): Promise<string> {
  const root = inject('cliBuild');
  const dist = join(root, 'dist');

  const lock = await openLocked(
    join(root, 'lock'),
    constants.O_CREAT | constants.O_RDWR,
  );

  try {
    // tsc writes cli.js even when typechecking fails, so only the renamed directory marks a finished build
    if (!(await exists(dist))) {
      const output = join(await scratch('witch-cli-build-'), 'dist');

      await promisify(execFile)(process.execPath, [
        join(repository, 'scripts/build.mjs'),
        output,
      ]);

      await rename(output, dist);
    }
  } finally {
    await lock.close();
  }

  return join(dist, 'cli.js');
}
