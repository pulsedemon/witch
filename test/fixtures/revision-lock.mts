import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { openLocked } from '../../src/persistence/lock.js';

const [directory, marker, git, failing, ...args] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  ...string[],
];

if (args.join(' ') === 'rev-parse --short HEAD') {
  let result = 'unlocked';
  try {
    const lock = await openLocked(
      directory,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    await lock.close();
  } catch (error) {
    result = (error as NodeJS.ErrnoException).code!;
  }
  await writeFile(marker, result);
  if (failing === 'true') {
    process.stderr.write('revision unavailable\n');
    process.exit(23);
  }
}
process.exit(spawnSync(git, args, { stdio: 'inherit' }).status ?? 1);
