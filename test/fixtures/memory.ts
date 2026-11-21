import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Workspace } from '../../src/memory/workspace.js';
import { hookedGit, passThrough } from './git.js';
import { scratch } from './scratch.js';
import { seededMemory } from './seeded-memory.js';
import { configureGitEnvironment } from './merged-environment.js';

configureGitEnvironment();
const execute = promisify(execFile);

export async function fixture() {
  const root = await scratch('witch-memory-');
  const project = join(root, 'project');
  await mkdir(project);
  const hook = { current: passThrough };
  const memory = await seededMemory(join(root, 'memory.git'), hookedGit(hook));

  const open = async (id: string) => {
    const directory = join(root, 'conversations', id);
    await mkdir(directory, { recursive: true });
    const workspace = memory.workspace(directory, id);
    await workspace.ensureWorktree();
    const scope = await workspace.scope(project);

    return {
      workspace,
      scope: {
        global: join(workspace.root, scope.global),
        project: join(workspace.root, scope.project),
      },
    };
  };

  /** begins from `cwd`'s scope, as a turn does after reading it. */
  const begin = async (workspace: Workspace, cwd: string) => {
    const scope = await memory.scopePaths(cwd);

    return { revision: (await workspace.begin(scope)).revision, scope };
  };

  return { memory, root, project, hook, open, begin };
}

export async function save(
  workspace: Workspace,
  files: Record<string, string | null>,
  message = 'save',
) {
  for (const [path, text] of Object.entries(files)) {
    const file = join(workspace.root, path);

    if (text === null) await rm(file);
    else {
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, text);
    }
  }

  await workspace.commit(message);
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute('git', args, { cwd })).stdout;
}

export async function repository(
  root: string,
  name: string,
  origin?: string,
): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await git(path, 'init', '--quiet');

  if (origin) await git(path, 'remote', 'add', 'origin', origin);

  return path;
}
