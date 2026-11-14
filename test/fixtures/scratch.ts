import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
let parent: Promise<string> | undefined;
let made: string | undefined;

process.once('exit', cleanScratch);

/** clean at file teardown because Vitest can stop workers without exit handlers. */
export function cleanScratch(): void {
  if (made) rmSync(made, { recursive: true, force: true });

  made = undefined;
  parent = undefined;
}

/** a real path under a shared parent retained through this file's tests, then removed at file teardown or process exit. */
export async function scratch(prefix: string): Promise<string> {
  parent ??= open();

  return mkdtemp(join(await parent, prefix));
}

/** makes this process's parent, `witch-tests/<pid>-XXXXXX`, after removing those whose process is gone. */
async function open(): Promise<string> {
  const base = join(await realpath(tmpdir()), 'witch-tests');

  await mkdir(base, { recursive: true });

  for (const name of await readdir(base)) {
    const pid = /^(\d+)-[0-9A-Za-z]{6}$/.exec(name)?.[1];

    if (pid === undefined || running(Number(pid))) continue;

    const dead = join(base, name);

    // a run killed between a test's chmod and its restore leaves directories rm can't enter.
    // another process may be removing the same tree, so chmod's errors are ignored; rm reports what's left
    await execute('/bin/chmod', ['-R', 'u+rwx', dead]).catch(() => {});

    await rm(dead, { recursive: true, force: true });
  }

  made = await mkdtemp(join(base, `${process.pid}-`));

  return made;
}

/** only ESRCH means gone: EPERM is another user's live process. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
