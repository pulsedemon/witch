import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { vi } from 'vitest';
import { runCommand } from '../../src/core/repository/command.js';
import type { Run } from '../../src/core/repository/repository.js';
import { scratch } from './scratch.js';
import { git } from './git.js';

/**
 * a checkout on `main` tracking a bare origin, in its own scratch root so its `<main>-<i>` slots are removed with it.
 * without `lockfile` it has no `pnpm-lock.yaml`, like a Godot project.
 */
export async function checkout(name = 'repo', lockfile = true) {
  const root = await scratch('witch-spawn-');
  const origin = join(root, 'origin.git');
  const main = join(root, name);

  await git(root, 'init', '--bare', '-b', 'main', origin);

  await git(root, 'init', '-b', 'main', main);

  if (lockfile)
    await writeFile(join(main, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  else await writeFile(join(main, 'project.godot'), '');

  await git(main, 'add', '.');

  await git(main, 'commit', '-m', 'first');

  await git(main, 'remote', 'add', 'origin', origin);

  await git(main, 'push', '-u', 'origin', 'main');

  return { root, origin, main, slot: (index: number) => `${main}-${index}` };
}

/**
 * runs git, cp and find for real and records `pnpm` and `osascript`. a call `fail` returns output for rejects as execFile does, with
 * the command line in its message; one it returns an error for rejects with that error.
 */
export function recording(
  fail: (
    command: string,
    cwd: string,
  ) => { stdout?: string; stderr?: string } | Error | undefined = () =>
    undefined,
) {
  const calls: { command: string; args: string[]; cwd: string }[] = [];

  const run: Run = async (command, args, options) => {
    // Linux ci's GNU cp has no -c, the clone flag on macOS
    if (command === 'cp' && process.platform !== 'darwin')
      return runCommand(
        command,
        args.filter((arg) => arg !== '-c'),
        options,
      );

    if (['git', 'cp', 'find'].includes(command))
      return runCommand(command, args, options);

    calls.push({ command, args, cwd: options.cwd });

    const failure = fail(command, options.cwd);

    if (failure instanceof Error) throw failure;

    if (failure)
      throw Object.assign(
        new Error(
          `Command failed: ${[command, ...args].join(' ')}\n${failure.stderr ?? ''}`,
        ),
        { stdout: '', stderr: '', ...failure },
      );

    return { stdout: '', stderr: '' };
  };

  return {
    run,
    installs: () =>
      calls.filter(({ command }) => command === 'pnpm').map(({ cwd }) => cwd),
    tabs: () =>
      calls
        .filter(({ command }) => command === 'osascript')
        .map(({ args }) => args.slice(2)),
    calls,
  };
}

export async function printed(work: () => Promise<number>) {
  const write = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true);

  try {
    const code = await work();

    return { code, output: write.mock.calls.map(([text]) => text).join('') };
  } finally {
    write.mockRestore();
  }
}
