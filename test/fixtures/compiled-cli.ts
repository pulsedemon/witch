import { execFile } from 'node:child_process';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { scratch } from './scratch.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
let compiled: Promise<string> | undefined;

export function compiledCli(): Promise<string> {
  return (compiled ??= buildCli());
}

async function buildCli(): Promise<string> {
  const root = await scratch('witch-cli-build-');
  const output = join(root, 'dist');
  await promisify(execFile)(process.execPath, [
    join(repository, 'scripts/build.mjs'),
    output,
  ]);
  await symlink(join(repository, 'node_modules'), join(root, 'node_modules'));
  await symlink(join(repository, 'package.json'), join(root, 'package.json'));
  return join(output, 'cli.js');
}
