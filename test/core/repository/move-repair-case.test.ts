import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { test } from 'vitest';
import { setup } from '../../fixtures/move-repair.js';
import { git } from '../../fixtures/git.js';
import { identify, readLedger } from '../../../src/persistence/directories.js';

test('a child renamed in case with its parent is repaired on the first pass', async (t) => {
  const f = await setup();

  await mkdir(f.at('w/main/src'));

  await f.save('nested', 'w/main/src');

  await f.store.addPrompt(f.at('w/main/src'), 'nested prompt');

  await f.repair('w/main');

  await rename(f.at('w/main'), f.at('w/Main'));

  await rename(f.at('w/Main/src'), f.at('w/Main/Src'));

  if (!(await identify(f.at('w/main'))))
    t.skip('requires case-insensitive paths');

  assert.deepEqual((await f.repair('w/Main/Src')).blocked, []);

  assert.deepEqual(
    (await f.store.conversations(f.at('w/Main/Src'))).map(({ id }) => id),
    ['nested'],
  );

  assert.deepEqual(await f.store.prompts(f.at('w/Main/Src')), [
    'nested prompt',
  ]);

  const ledger = await readLedger(f.at('state'));

  assert.deepEqual(
    ledger.entries.map(({ path }) => path).sort(),
    [f.at('w/Main'), f.at('w/Main/Src'), f.at('w/main-1')].sort(),
  );

  const saved = await f.saved('nested');

  assert.equal(saved.raw.cwd, f.at('w/Main/Src'));

  assert.ok(saved.history!.includes(JSON.stringify(f.at('w/Main/Src'))));
});

for (const [shape, from, to, main, worktree] of [
  ['main', 'w/main', 'w/Main', 'w/Main', 'w/main-1'],
  ['parent', 'w', 'W', 'W/main', 'W/main-1'],
  ['worktree', 'w/main-1', 'w/Main-1', 'w/main', 'w/Main-1'],
] as const)
  for (const start of ['main', 'worktree'])
    for (const relative of [false, true])
      test(`a case-only ${shape} rename repairs from ${start}, relative=${relative}`, async (t) => {
        const f = await setup();

        await f.save('saved-main', 'w/main');

        await f.save('saved-worktree', 'w/main-1');

        await f.store.addPrompt(f.at('w/main'), 'main prompt');

        await f.store.addPrompt(f.at('w/main-1'), 'worktree prompt');

        if (relative) {
          await writeFile(
            f.at('w/main-1/.git'),
            'gitdir: ../main/.git/worktrees/main-1\n',
          );

          await writeFile(
            f.at('w/main/.git/worktrees/main-1/gitdir'),
            '../../../../main-1/.git\n',
          );
        }

        await rename(f.at(from), f.at(to));

        if (!(await identify(f.at(from))))
          t.skip('requires case-insensitive paths');

        f.runs.length = 0;
        const report = await f.repair(start === 'main' ? main : worktree);

        assert.deepEqual(report.blocked, [], JSON.stringify(report));

        assert.deepEqual(report.unresolved, []);

        assert.equal(
          f.runs.filter(
            (args) =>
              args.join(' ') ===
              'git rev-parse --path-format=absolute --git-common-dir',
          ).length,
          1,
        );

        assert.deepEqual(
          (await f.store.conversations(f.at(main))).map(({ id }) => id),
          ['saved-main'],
        );

        assert.deepEqual(
          (await f.store.conversations(f.at(worktree))).map(({ id }) => id),
          ['saved-worktree'],
        );

        assert.deepEqual(await f.store.prompts(f.at(main)), ['main prompt']);

        assert.deepEqual(await f.store.prompts(f.at(worktree)), [
          'worktree prompt',
        ]);

        const dotgit = f.at(`${worktree}/.git`),
          reverse = f.at(`${main}/.git/worktrees/main-1/gitdir`);

        const expectedDotgit = relative
          ? `gitdir: ../${shape === 'main' ? 'Main' : 'main'}/.git/worktrees/main-1\n`
          : `gitdir: ${f.at(`${main}/.git/worktrees/main-1`)}\n`;

        const expectedReverse = `${dotgit}\n`;

        assert.equal(await readFile(dotgit, 'utf8'), expectedDotgit);

        assert.equal(await readFile(reverse, 'utf8'), expectedReverse);

        assert.equal(await git(f.at(worktree), 'status', '--porcelain'), '');

        assert.ok(
          (await git(f.at(main), 'worktree', 'list', '--porcelain')).includes(
            `worktree ${f.at(worktree)}\n`,
          ),
        );

        const ledger = await readLedger(f.at('state'));

        assert.deepEqual(
          ledger.entries.map(({ path }) => path).sort(),
          [f.at(main), f.at(worktree)].sort(),
        );

        assert.equal(
          ledger.entries.find(({ path }) => path === f.at(worktree))?.slot,
          1,
        );

        const before = await Promise.all(
          [dotgit, reverse].map(async (file) => {
            const { ino, mtimeMs } = await stat(file);

            return [ino, mtimeMs];
          }),
        );

        await f.repair(main);

        assert.deepEqual((await readLedger(f.at('state'))).moves, ledger.moves);

        assert.deepEqual(
          await Promise.all(
            [dotgit, reverse].map(async (file) => {
              const { ino, mtimeMs } = await stat(file);

              return [ino, mtimeMs];
            }),
          ),
          before,
        );
      });

test('case repair previews write nothing and an interrupted link update resumes', async (t) => {
  const f = await setup();

  await f.save('saved', 'w/main');

  await rename(f.at('w'), f.at('W'));

  if (!(await identify(f.at('w')))) t.skip('requires case-insensitive paths');

  const files = [
    'W/main-1/.git',
    'W/main/.git/worktrees/main-1/gitdir',
    'state/directories.json',
    'state/conversations/saved/state.json',
  ] as const;

  const snapshot = () =>
    Promise.all(files.map((file) => readFile(f.at(file), 'utf8')));

  const before = await snapshot();

  assert.deepEqual((await f.repair('W/main', { preview: true })).blocked, []);

  assert.deepEqual(await snapshot(), before);

  const mode = (await stat(f.at('W/main-1'))).mode;

  await chmod(f.at('W/main-1'), 0o500);

  try {
    const failed = await f.repair('W/main');

    assert.ok(failed.blocked.length > 0);

    assert.equal(
      await readFile(f.at(files[1]), 'utf8'),
      `${f.at('W/main-1/.git')}\n`,
    );

    assert.equal(await readFile(f.at(files[0]), 'utf8'), before[0]);
  } finally {
    await chmod(f.at('W/main-1'), mode);
  }

  assert.deepEqual((await f.repair('W/main')).blocked, []);

  assert.equal(
    await readFile(f.at(files[0]), 'utf8'),
    `gitdir: ${f.at('W/main/.git/worktrees/main-1')}\n`,
  );
});

test('a foreign registration prevents every case-link write in its repository', async (t) => {
  const g = await setup();

  await git(
    g.at('w/main'),
    'worktree',
    'add',
    '-q',
    '--detach',
    g.at('w/main-2'),
  );

  await mkdir(g.at('other'));

  await git(g.at('other'), 'init', '-q', '-b', 'main');

  await git(g.at('other'), 'commit', '-q', '--allow-empty', '-m', 'other');

  await rename(g.at('w/main-2'), g.at('away'));

  await git(
    g.at('other'),
    'worktree',
    'add',
    '-q',
    '--detach',
    g.at('w/main-2'),
  );

  await rename(g.at('w/main'), g.at('w/Main'));

  if (!(await identify(g.at('w/main'))))
    t.skip('requires case-insensitive paths');

  const links = [
    'w/main-1/.git',
    'w/main-2/.git',
    'w/Main/.git/worktrees/main-1/gitdir',
  ];

  const original = await Promise.all(
    links.map((file) => readFile(g.at(file), 'utf8')),
  );

  assert.ok((await g.repair('w/Main')).blocked.length > 0);

  assert.deepEqual(
    await Promise.all(links.map((file) => readFile(g.at(file), 'utf8'))),
    original,
  );
});
