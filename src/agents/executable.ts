import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';

export function findExecutable(
  name: string,
  search = process.env.PATH ?? '',
): string | undefined {
  const paths =
    isAbsolute(name) || name.includes('/')
      ? [resolve(name)]
      : search.split(delimiter).map((directory) => join(directory, name));
  for (const path of paths) {
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** versioned artifact paths map to the same installation across native upgrades. */
export function nativeInstallationRoot(executable: string): string | undefined {
  const file = realpathSync(executable);
  const directory = dirname(file);
  if (
    basename(directory) === 'versions' &&
    basename(dirname(directory)) === 'claude'
  )
    return dirname(directory);
  const releases = dirname(dirname(directory));
  if (
    basename(file) === 'codex' &&
    basename(directory) === 'bin' &&
    basename(releases) === 'releases' &&
    basename(dirname(releases)) === 'standalone'
  )
    return dirname(releases);
  return undefined;
}
