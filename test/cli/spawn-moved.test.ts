import assert from 'node:assert/strict';
import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test, vi } from 'vitest';
import type { Run } from '../../src/core/repository/repository.js';
import { readLedger } from '../../src/persistence/directories.js';
import { StateStore } from '../../src/persistence/store.js';
import { runSpawn, sessionsIn } from '../../src/cli/spawn.js';
import { scratch } from '../fixtures/scratch.js';
import { git } from '../fixtures/git.js';
import { exists } from '../fixtures/within.js';
import { checkout, printed, recording } from '../fixtures/spawn.js';

describe('moved checkouts', () => {
  const darwin = process.platform === 'darwin';

  /** a checkout at `<root>/w/main` with its bare origin outside `w`, and `count` slots spawned there. */
  async function spawned(count: number) {
    const repository = await checkout('w/main');
    const state = join(repository.root, 'state');
    const first = recording();
    await printed(() => runSpawn(repository.main, count, state, first.run));
    const at = (path: string) => join(repository.root, path);

    return { ...repository, state, at };
  }

  test('spawn from a moved main reuses the worktrees left beside the old location', async () => {
    const f = await spawned(2);
    await mkdir(f.at('c'));
    await rename(f.main, f.at('c/main'));
    const { run } = recording();

    const { code, output } = await printed(() =>
      runSpawn(f.at('c/main'), 2, f.state, run),
    );

    assert.equal(code, 0, output);
    assert.match(output, /Repaired the move of .*w\/main to .*c\/main/);
    assert.ok(output.includes(`${f.slot(1)}: exists`), output);
    assert.ok(output.includes(`${f.slot(2)}: exists`), output);
    assert.equal(await exists(f.at('c/main-1')), false);

    for (const path of [f.at('c/main'), f.slot(1), f.slot(2)])
      await git(path, 'status');
  });

  test('spawn from a worktree whose main moved too repairs first', async () => {
    const f = await spawned(1);
    await rename(f.at('w'), f.at('c'));
    const { run } = recording();

    const { code, output } = await printed(() =>
      runSpawn(f.at('c/main-1'), 1, f.state, run),
    );

    assert.equal(code, 0, output);
    assert.ok(output.includes(`${f.at('c/main-1')}: exists`), output);
  });

  test("spawn creates only the slots it can't find", async () => {
    const f = await spawned(2);
    await git(f.main, 'worktree', 'remove', f.slot(2));
    await mkdir(f.at('c'));
    await rename(f.main, f.at('c/main'));
    const { run } = recording();

    const { output } = await printed(() =>
      runSpawn(f.at('c/main'), 2, f.state, run),
    );

    assert.ok(output.includes(`${f.slot(1)}: exists`), output);
    assert.ok(output.includes(`${f.at('c/main-2')}: created`), output);
  });

  test('spawn stops when another repository holds a registered path', async () => {
    const f = await spawned(1);
    await mkdir(f.at('c'));
    await rename(f.main, f.at('c/main'));
    await rename(f.slot(1), f.at('away'));
    const other = f.at('other');
    await git(f.root, 'init', '-b', 'main', other);
    await git(other, 'commit', '--allow-empty', '-m', 'other');
    await git(other, 'worktree', 'add', '--detach', f.slot(1));
    const { run, calls } = recording();

    const { code } = await printed(() =>
      runSpawn(f.at('c/main'), 1, f.state, run),
    );

    assert.equal(code, 1);
    assert.deepEqual(calls, []);
  });

  test('spawn checks registrations even when nothing moved', async () => {
    const f = await spawned(1);
    const other = f.at('other');
    await git(f.root, 'init', '-b', 'main', other);

    await writeFile(
      join(f.slot(1), '.git'),
      `gitdir: ${join(other, '.git/worktrees/main-1')}\n`,
    );

    const { run, calls } = recording();
    const { code } = await printed(() => runSpawn(f.main, 1, f.state, run));
    assert.equal(code, 1);
    assert.deepEqual(calls, []);
  });

  test('an unreadable ledger stops spawn before anything is installed or opened', async () => {
    const f = await spawned(1);
    await writeFile(join(f.state, 'directories.json'), '{');
    const { run, calls } = recording();
    const { code } = await printed(() => runSpawn(f.main, 1, f.state, run));
    assert.equal(code, 1);
    assert.deepEqual(calls, []);
    await assert.rejects(sessionsIn(f.state)(f.slot(1)), /directories\.json/);
  });

  test('outside a repository, a ledger spawn cannot read is named instead of only Git', async () => {
    const root = await scratch('witch-spawn-');
    const state = join(root, 'state');
    await mkdir(join(root, 'plain'));
    await mkdir(state);
    await writeFile(join(state, 'directories.json'), '{');

    const errors = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      assert.equal(await runSpawn(join(root, 'plain'), 1, state), 1);

      assert.match(
        errors.mock.calls.map(([text]) => text).join(''),
        /^witch: .*directories\.json: /,
      );
    } finally {
      errors.mockRestore();
    }
  });

  test('spawn fails when it cannot record the worktrees it opened', async () => {
    const f = await spawned(1);
    const { run: recorded } = recording();

    // breaks the ledger after repair read it, so only recording the slot fails
    const run: Run = async (command, args, options) => {
      if (command === 'osascript')
        await writeFile(join(f.state, 'directories.json'), '{');

      return recorded(command, args, options);
    };

    const { code, output } = await printed(() =>
      runSpawn(f.main, 1, f.state, run),
    );

    assert.ok(output.includes('Could not record the worktrees'), output);
    assert.ok(output.includes(`${f.slot(1)}: exists, opened`), output);
    assert.equal(code, 1);
  });

  test('a live session with a stale cwd still occupies its moved slot', async () => {
    const f = await spawned(1);
    const store = await StateStore.open(f.state);

    const held = await store.create({
      id: 'live',
      title: 'live',
      cwd: f.slot(1),
      agent: 'codex',
      sessions: {},
      createdAt: new Date().toISOString(),
    });

    try {
      await rename(f.at('w'), f.at('c'));
      const { run, tabs } = recording();

      const { code, output } = await printed(() =>
        runSpawn(f.at('c/main'), 1, f.state, run),
      );

      assert.equal(code, 0, output);
      assert.equal(await sessionsIn(f.state)(f.at('c/main-1')), true);

      assert.ok(
        output.includes(`${f.at('c/main-1')}: exists, already open`),
        output,
      );

      assert.deepEqual(tabs(), []);
    } finally {
      await held.close();
    }
  });

  test('a deleted slot does not stop the others', async () => {
    const f = await spawned(2);
    await rm(f.slot(2), { recursive: true });
    const { run, installs, tabs } = recording();
    const { output } = await printed(() => runSpawn(f.main, 2, f.state, run));
    assert.ok(output.includes(`${f.slot(1)}: exists`), output);

    assert.ok(
      output.includes(
        `${f.slot(2)}: registered but missing; start Witch where it moved`,
      ),
      output,
    );

    assert.deepEqual(installs(), [f.slot(1)]);
    assert.deepEqual(tabs(), [[f.slot(1)]]);
  });

  test.skipIf(!darwin)(
    'spawn after a worktree moved alone reuses it',
    async () => {
      const f = await spawned(1);
      await rename(f.slot(1), f.at('w/elsewhere'));
      const { run } = recording();
      const { output } = await printed(() => runSpawn(f.main, 1, f.state, run));
      assert.ok(output.includes(`${f.at('w/elsewhere')}: exists`), output);
      await git(f.at('w/elsewhere'), 'status');
    },
  );

  test.skipIf(!darwin)(
    'a stand-in put at a slot while spawn opens it never takes the slot',
    async () => {
      const f = await spawned(1);

      const before = (await readLedger(f.state)).entries.find(
        ({ path }) => path === f.slot(1),
      )!;

      const { run: recorded } = recording();

      // replaces the slot as its tab opens, between repair and recording it
      const run: Run = async (command, args, options) => {
        if (command === 'osascript') {
          await rename(f.slot(1), f.at('w/away'));
          await cp(f.at('w/away'), f.slot(1), { recursive: true });
        }

        return recorded(command, args, options);
      };

      await printed(() => runSpawn(f.main, 1, f.state, run));

      const after = (await readLedger(f.state)).entries.find(
        ({ path }) => path === f.slot(1),
      )!;

      assert.deepEqual(
        [after.device, after.inode, after.slot],
        [before.device, before.inode, 1],
      );
    },
  );

  test.skipIf(!darwin)(
    "a moved slot keeps its number and its default name isn't taken twice",
    async () => {
      const f = await spawned(1);
      await rename(f.slot(1), f.slot(2));
      const once = recording();
      const kept = await printed(() => runSpawn(f.main, 1, f.state, once.run));
      assert.ok(kept.output.includes(`${f.slot(2)}: exists`), kept.output);
      assert.ok(!kept.output.includes('created'), kept.output);
      const twice = recording();
      const both = await printed(() => runSpawn(f.main, 2, f.state, twice.run));
      assert.ok(both.output.includes(`${f.slot(2)}: exists`), both.output);
      assert.ok(both.output.includes(`${f.main}-2-2: created`), both.output);

      assert.equal(
        new Set(twice.tabs().flat()).size,
        twice.tabs().flat().length,
      );
    },
  );
});
