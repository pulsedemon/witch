import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runGit } from '../memory/memory.js';

const unreadable = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR']);

/** paths relative to `cwd` for `@` completion: Git's tracked and untracked files, honoring ignores, or outside a work tree a walk that skips dot entries. */
export async function listFiles(
  cwd: string,
  limit = 10_000,
): Promise<string[]> {
  // each entry is a status tag, a space and the path; a deleted tracked file also gets an `R` entry
  const listed = await runGit(
    ['ls-files', '-c', '-d', '-o', '--exclude-standard', '-t', '-z'],
    { cwd },
  );
  if (listed.code !== 0) return walk(cwd, limit);
  const entries = listed.stdout.toString('utf8').split('\0').filter(Boolean);
  const deleted = new Set(
    entries.filter((entry) => entry[0] === 'R').map((entry) => entry.slice(2)),
  );
  // a conflicted path has an entry per stage
  const present = new Set(
    entries.map((entry) => entry.slice(2)).filter((path) => !deleted.has(path)),
  );
  return [...present].slice(0, limit);
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
