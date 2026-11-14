import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';

import { join } from 'node:path';

import { runCommand } from '../../src/core/command.js';

import { repairMoves } from '../../src/core/move-repair.js';

import type { Run } from '../../src/core/repository.js';

import type { ConversationRecord } from '../../src/core/state.js';

import { StateStore } from '../../src/persistence/store.js';

import { record } from './coordinator.js';

import { git } from './git.js';

import { scratch } from './scratch.js';

import { seededMemory } from './seeded-memory.js';

/** a main checkout `w/main` with a worktree `w/main-1`, a state directory, and one repair already run there. */
export async function setup({ origin = true }: { origin?: boolean } = {}) {
  const root = await scratch('witch-move-');

  const at = (path: string) => join(root, path);

  await mkdir(at('w/main'), { recursive: true });

  await git(at('w/main'), 'init', '-q', '-b', 'main');

  await git(at('w/main'), 'commit', '-q', '--allow-empty', '-m', 'first');

  if (origin)
    await git(
      at('w/main'),
      'remote',
      'add',
      'origin',
      'https://example.invalid/move.git',
    );

  await git(at('w/main'), 'worktree', 'add', '-q', '--detach', at('w/main-1'));

  const store = await StateStore.open(at('state'));

  const memory = await seededMemory(at('state/memory.git'));

  const runs: string[][] = [];

  const recording: Run = (command, args, options) => {
    runs.push([command, ...args]);

    return runCommand(command, args, options);
  };

  const repair = (
    cwd: string,
    options: Parameters<typeof repairMoves>[3] = {},
  ) => repairMoves(store, memory, at(cwd), { run: recording, ...options });

  let day = 1;

  const save = async (
    id: string,
    cwd: string,
    extra: Partial<ConversationRecord> & Record<string, unknown> = {},
    history = true,
  ) => {
    const files = await store.create({ ...record(id, at(cwd)), ...extra });

    if (history)
      await files.append({
        id: `${id}-line`,
        kind: 'assistant',
        cwd: at(cwd),
        text: `in ${id}`,
      });

    await files.close();

    const directory = at(`state/conversations/${id}`);

    const raw = JSON.parse(
      await readFile(join(directory, 'state.json'), 'utf8'),
    );

    await writeFile(
      join(directory, 'state.json'),
      JSON.stringify({ ...raw, ...extra }, null, 2),
    );

    const date = new Date(`2020-01-${String(day++).padStart(2, '0')}`);

    for (const file of ['state.json', 'history.jsonl'])
      await utimes(join(directory, file), date, date).catch(() => {});
  };

  const saved = async (id: string) => {
    const directory = at(`state/conversations/${id}`);

    return {
      raw: JSON.parse(
        await readFile(join(directory, 'state.json'), 'utf8'),
      ) as Record<string, unknown>,
      history: await readFile(join(directory, 'history.jsonl'), 'utf8').catch(
        () => undefined,
      ),
      mtimes: await Promise.all(
        ['state.json', 'history.jsonl'].map(
          async (file) =>
            (await stat(join(directory, file)).catch(() => undefined))?.mtimeMs,
        ),
      ),
    };
  };

  await repair('w/main');

  return { root, at, store, memory, repair, runs, save, saved };
}

export const darwin = process.platform === 'darwin';
