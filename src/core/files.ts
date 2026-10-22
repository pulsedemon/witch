import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runGit } from '../memory/memory.js';

const unreadable = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR']);

const paths = (output: Buffer) =>
  output.toString('utf8').split('\0').filter(Boolean);

/** paths relative to `cwd` for `@` completion: Git's tracked and untracked files, honoring ignores, or outside a work tree a walk that skips dot entries. */
export async function listFiles(
  cwd: string,
  limit = 10_000,
): Promise<string[]> {
  const listed = await runGit(
    ['ls-files', '-co', '--exclude-standard', '--deduplicate', '-z'],
    { cwd },
  );
  if (listed.code !== 0) return walk(cwd, limit);
  const deleted = new Set(
    paths((await runGit(['ls-files', '--deleted', '-z'], { cwd })).stdout),
  );
  return paths(listed.stdout)
    .filter((path) => !deleted.has(path))
    .slice(0, limit);
}

async function walk(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  const directories = [''];
  for (const directory of directories) {
    const entries = await readdir(join(root, directory), {
      withFileTypes: true,
    }).catch((error: NodeJS.ErrnoException) => {
      if (unreadable.has(error.code ?? '')) return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) directories.push(path);
      else files.push(path);
      if (files.length === limit) return files;
    }
  }
  return files;
}
