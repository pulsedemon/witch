import { once } from 'node:events';
import { writeSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { identifyProcess } from '../../src/persistence/process.js';
import { ScratchSpace } from '../../src/persistence/scratch.js';

const [mode, parent, value] = process.argv.slice(2) as [string, string, string];
const deadline = setTimeout(() => process.exit(1), 15_000);
try {
  if (mode === 'hold') {
    const space = await ScratchSpace.open(parent, { boot: async () => value });
    try {
      await writeFile(join(space.directory, 'marker'), 'held');
      writeSync(1, `${space.directory}\n`);
      await once(process.stdin, 'data');
    } finally {
      await space.close();
    }
  } else {
    const space =
      mode === 'resumed'
        ? await ScratchSpace.open(parent, { resume: value })
        : mode === 'legacy'
          ? undefined
          : await ScratchSpace.open(parent);
    const directory = space?.directory ?? join(parent, String(process.pid));
    if (mode !== 'resumed') {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'marker'), 'before restart');
    }
    writeSync(
      1,
      `${JSON.stringify({
        directory,
        identity: await identifyProcess(process.pid),
        resumed: space?.resumed ?? false,
      })}\n`,
    );
    await space?.close();
    if (mode !== 'resumed')
      process.execve!(
        process.execPath,
        [
          process.execPath,
          ...process.execArgv,
          process.argv[1]!,
          'resumed',
          parent,
          directory,
        ],
        process.env,
      );
  }
} finally {
  clearTimeout(deadline);
  process.stdin.pause();
}
