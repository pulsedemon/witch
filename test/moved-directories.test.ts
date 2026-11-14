import assert from 'node:assert/strict';
import { mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { runCommand } from '../src/core/command.js';
import { Coordinator } from '../src/core/coordinator.js';
import type { Run } from '../src/core/repository.js';
import { main as accepted } from '../src/memory/memory.js';
import { StateStore } from '../src/persistence/store.js';
import { identify } from '../src/persistence/directories.js';
import { quote } from '../src/shell.js';
import { runSpawn } from '../src/spawn.js';
import { FixtureAgent } from './fixtures/agent.js';
import { notices, record } from './fixtures/coordinator.js';
import { scratch } from './fixtures/scratch.js';
import { seededMemory } from './fixtures/seeded-memory.js';
import { until } from './fixtures/within.js';
import { git } from './fixtures/git.js';

/** runs git for real and stands in for `pnpm` and `osascript`. */
const run: Run = (command, args, options) =>
  ['pnpm', 'osascript'].includes(command)
    ? Promise.resolve({ stdout: '', stderr: '' })
    : runCommand(command, args, options);

async function quietly<T>(work: () => Promise<T>): Promise<string> {
  const write = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true);

  try {
    await work();

    return write.mock.calls.map(([text]) => String(text)).join('');
  } finally {
    write.mockRestore();
  }
}

for (const caseOnly of [false, true])
  test(`a main checkout ${caseOnly ? 'renamed only in case' : 'moved'} keeps conversations, prompts, worktree, memory links and spawn slots`, async (t) => {
    const main = caseOnly ? 'w/Main' : 'c/main';
    const worktree = caseOnly ? 'w/main-1' : 'c/main-1';
    const root = await scratch('witch-moved-');
    const at = (path: string) => join(root, path);
    const origin = at('origin.git');

    await git(root, 'init', '--bare', '-q', '-b', 'main', origin);

    await git(root, 'init', '-q', '-b', 'main', at('w/main'));

    await git(at('w/main'), 'commit', '-q', '--allow-empty', '-m', 'first');

    await git(at('w/main'), 'remote', 'add', 'origin', origin);

    await git(at('w/main'), 'push', '-q', '-u', 'origin', 'main');

    const state = at('state');
    const store = await StateStore.open(state);
    const memory = await seededMemory(join(state, 'memory.git'));

    await quietly(() => runSpawn(at('w/main'), 1, state, run));

    for (const [id, date] of [
      ['older', '2020-01-01'],
      ['newer', '2020-01-02'],
    ] as const) {
      const files = await store.create(record(id, at('w/main')));

      await files.append({
        id: `${id}-line`,
        kind: 'assistant',
        cwd: at('w/main'),
        text: `from ${id}`,
      });

      await files.close();

      for (const file of ['state.json', 'history.jsonl'])
        await utimes(
          join(state, 'conversations', id, file),
          new Date(date),
          new Date(date),
        );
    }

    await mkdir(at('w/gone'));

    await (await store.create(record('lost', at('w/gone')))).close();

    await store.addPrompt(at('w/main'), 'first prompt');

    const scope = await memory.scopePaths(at('w/main'));
    const helper = memory.workspace(at('helper'), 'helper');

    await helper.ensureWorktree();

    await helper.begin(scope);

    const notes = [`${scope.global}/links.md`, `${scope.project}/links.md`];

    for (const note of notes)
      await writeFile(
        join(helper.root, note),
        `See ${at('w/main')}/README.md.\n`,
      );

    await helper.commit('save');

    await helper.publish();

    const agent = new FixtureAgent('a');

    const first = new Coordinator(store, memory, [
      { adapter: agent, executable: 'a' },
    ]);

    await first.initialize(at('w/main'));

    await first.close();

    const head = await memory.resolve(accepted);

    await rm(at('w/gone'), { recursive: true });

    await rename(at(caseOnly ? 'w/main' : 'w'), at(caseOnly ? 'w/Main' : 'c'));

    if (caseOnly && !(await identify(at('w/main'))))
      t.skip('requires case-insensitive paths');

    const coordinator = new Coordinator(store, memory, [
      { adapter: agent, executable: 'a' },
    ]);

    try {
      await coordinator.initialize(at(main), { continue: true });

      assert.equal(coordinator.snapshot.conversation!.id, 'newer');

      assert.deepEqual(
        (await coordinator.conversations()).map(({ id }) => id),
        ['newer', 'older'],
      );

      const notice = notices(coordinator).join('\n');

      assert.ok(
        notice.includes(`Repaired the move of ${at('w/main')} to ${at(main)}:`),
        notice,
      );

      assert.ok(
        notice.includes(`--recover-directory ${quote(at('w/gone'))}`),
        notice,
      );

      assert.deepEqual(await store.prompts(at(main)), ['first prompt']);

      await git(at(main), 'status');

      await git(at(worktree), 'status');

      await coordinator.send('after the move');

      await until(
        'the first turn after the move',
        () =>
          agent.inputs.length === 1 && coordinator.snapshot.phase === 'idle',
      );

      for (const note of notes)
        assert.equal(
          await memory.read(accepted, note),
          `See ${at(main)}/README.md.\n`,
        );

      assert.ok(
        coordinator.snapshot.items.some(
          ({ kind, text }) =>
            kind === 'notice' && /Repointed 2 memory note/.test(text),
        ),
      );

      const subjects = (
        await git(
          join(state, 'memory.git'),
          'log',
          '--format=%s',
          `${head}..${accepted}`,
        )
      ).split('\n');

      assert.ok(
        subjects.every((subject) => /^chore\(memory\): /.test(subject)),
        subjects.join('\n'),
      );
    } finally {
      await coordinator.close();
    }

    const refs = await git(join(state, 'memory.git'), 'for-each-ref');
    const output = await quietly(() => runSpawn(at(main), 1, state, run));

    assert.ok(output.includes(`${at(worktree)}: exists`), output);

    assert.equal(await git(join(state, 'memory.git'), 'for-each-ref'), refs);
  });
