import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { errorMessage } from '../src/agents/stderr.js';
import { quote } from '../src/shell.js';

const marker = '#!/bin/sh\n# Witch launcher\n';

try {
  if (process.argv.length > 3)
    throw new Error('Usage: pnpm install:cli [destination]');
  const entry = await realpath(resolve('dist/cli.js'));
  await access(entry, constants.X_OK);
  const destination = resolve(
    process.argv[2] ?? join(homedir(), '.local', 'bin', 'witch'),
  );
  const existing = await lstat(destination).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  });
  if (
    existing &&
    !existing.isSymbolicLink() &&
    (!existing.isFile() ||
      !(await readFile(destination, 'utf8')).startsWith(marker))
  )
    throw new Error(
      `Refusing to replace a file not installed by Witch: ${destination}`,
    );
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o755);
  try {
    await file.writeFile(`${marker}entry=${quote(entry)}
if [ ! -f "$entry" ]; then
  printf '%s\\n' "witch: missing compiled entry: $entry" 'Run pnpm build and pnpm install:cli from the relocated Witch checkout.' >&2
  exit 1
fi
exec "$entry" "$@"
`);
    await file.sync();
    await rename(temporary, destination);
  } finally {
    await file.close();
    await rm(temporary, { force: true });
  }
  process.stdout.write(`Installed ${destination}\n`);
} catch (error) {
  process.stderr.write(`witch: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
