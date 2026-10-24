import process from 'node:process';
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
if (
  process.cwd() === process.env.WITCH_CAPTURE_CWD &&
  process.argv[1]?.endsWith('/vitest.mjs') &&
  process.argv[2] === 'run'
) {
  process.argv.push(
    '--reporter=default',
    '--reporter=json',
    `--outputFile=${process.env.WITCH_CAPTURE_REPORT}`,
  );
  writeFileSync(
    process.env.WITCH_CAPTURE_RUNTIME,
    JSON.stringify(
      {
        pid: process.pid,
        node: process.version,
        executable: process.execPath,
        platform: process.platform,
        arch: process.arch,
        availableParallelism: availableParallelism(),
        started: Date.now(),
      },
      null,
      2,
    ) + '\n',
  );
}
