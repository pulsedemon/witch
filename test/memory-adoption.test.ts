import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/memory/memory.js';
import type { Workspace } from '../src/memory/workspace.js';
import { passThrough } from './fixtures/git.js';
import { fixture, save, git, repository } from './fixtures/memory.js';

await test('a subdirectory of a repository shares its project memory, and its notes move once the repository has an origin', async () => {
  const { memory, open, project } = await fixture();
  await git(project, 'init', '--quiet');
  const src = join(project, 'src');
  await mkdir(src);
  // notes saved before origins keyed projects live under this key
  assert.deepEqual(await memory.scopePaths(src), {
    global: 'global',
    project: `projects/project-${createHash('sha256').update(project).digest('hex').slice(0, 16)}`,
  });
  const { workspace } = await open('a');
  const begun = await workspace.begin(src);
  await save(workspace, { [`${begun.scope.project}/x.md`]: 'X.\n' });
  await workspace.publish();
  await git(project, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  const moved = await workspace.begin(src);
  assert.equal(await memory.read(main, `${moved.scope.project}/x.md`), 'X.\n');
});

await test('checkout adoption preserves unpublished notes until they are published', async () => {
  const { memory, open, project } = await fixture();
  await git(project, 'init', '--quiet');
  const { workspace } = await open('a');
  const before = await workspace.begin(project);
  const original = `${before.scope.project}/private.md`;
  await save(workspace, { [original]: 'Private note.\n' });
  const unpublished = await workspace.revision();
  const accepted = await memory.resolve(main);
  assert.notEqual(unpublished, accepted);
  assert.equal(await workspace.isDirty(), false);
  await git(project, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  const scope = await memory.scopePaths(project);
  const migrated = `${scope.project}/private.md`;
  assert.notEqual(original, migrated);

  await workspace.adoptCheckout(project);
  assert.equal(await memory.resolve(main), accepted);
  assert.equal(await workspace.revision(), unpublished);
  assert.equal(
    await readFile(join(workspace.root, original), 'utf8'),
    'Private note.\n',
  );
  await assert.rejects(readFile(join(workspace.root, migrated)), {
    code: 'ENOENT',
  });
  assert.equal(await workspace.isDirty(), false);

  await workspace.publish();
  await workspace.adoptCheckout(project);
  assert.equal(await memory.read(main, migrated), 'Private note.\n');
  await assert.rejects(readFile(join(workspace.root, original)), {
    code: 'ENOENT',
  });
  assert.equal(await workspace.revision(), await memory.resolve(main));
  assert.equal(await workspace.isDirty(), false);
});

await test("a turn merges the notes keyed by a checkout's path into its origin's project, keeping both versions of a note", async () => {
  const { memory, open, root, project } = await fixture();
  const begin = async (
    workspace: Workspace,
    cwd: string,
    notes: Record<string, string> = {},
  ) => {
    const begun = await workspace.begin(cwd);
    await save(
      workspace,
      Object.fromEntries(
        Object.entries(notes).map(([note, text]) => [
          `${begun.scope.project}/${note}`,
          text,
        ]),
      ),
    );
    await workspace.publish();
    return begun;
  };
  const first = (await open('a')).workspace;
  await git(project, 'init', '--quiet');
  // its copy's name passes the 255 UTF-16 units an APFS name holds
  const long = `${'n'.repeat(251)}.md`;
  const path = (
    await begin(first, project, {
      'MEMORY.md': '# Project\n- [deploy](deploy.md)\n- shared  \n',
      [long]: 'Long A.\n',
      'deploy.md': 'Deploy with A.\n',
      'notes/a.md': 'A note.\n',
      'same.md': 'Same.\n',
      'dot.md': 'A.\n',
      'angled.md': 'A.\n',
      'p(1).md': 'A.\n',
      'literal#part.md': 'Literal A.\n',
    })
  ).scope.project;
  const copy = await repository(root, 'copy');
  const second = (await open('b')).workspace;
  await begin(second, copy, {
    'MEMORY.md':
      '# Project\n- shared  \n- [deploy](deploy.md)\n- [two](two.md)\n- [two](two.md)\n- [dot](./dot.md)\n- [angled](<angled.md>)\n- [p](p(1).md)\n' +
      '- [fragment](deploy.md#section)\n- [query](<angled.md?raw=1>)\n- [both](deploy.md?next=../two#section)\n- [literal](literal#part.md)\n- [unmatched](missing.md?raw=1#section)\n' +
      '- [query path](./deploy.md?next=/../dot.md)\n- [fragment path](<deploy.md#section/../same.md>)\n' +
      '- [query directory](deploy.md?raw/missing)\n- [fragment directory](deploy.md#raw/missing)\n- [literal directory](deploy.md?raw/other.md)\n- [first suffix](deploy.md?raw/other.md#section)\n',
    [long]: 'Long B.\n',
    'deploy.md': 'Deploy with B.\n',
    notes: 'A file named notes.\n',
    'same.md': 'Same.\n',
    'two.md': 'Two.\n',
    'dot.md': 'B.\n',
    'angled.md': 'B.\n',
    'p(1).md': 'B.\n',
    'literal#part.md': 'Literal B.\n',
    'deploy.md?raw/other.md': 'Other query note.\n',
    'deploy.md#raw/other.md': 'Other fragment note.\n',
  });
  const origin = 'https://github.com/owner/repo.git';
  await git(project, 'remote', 'add', 'origin', origin);
  await git(copy, 'remote', 'add', 'origin', origin);
  assert.equal((await begin(first, project)).scope.checkout, path);
  const merged = await begin(second, copy);
  assert.equal(merged.revision, await memory.resolve(main));
  const target = merged.scope.project;
  assert.equal(
    (
      await memory.git(memory.root, [
        'ls-tree',
        '-r',
        '--name-only',
        merged.revision,
        '--',
        'projects',
      ])
    ).trim(),
    [
      `(copy)/${long}`,
      '(copy)/notes',
      'MEMORY.md',
      'angled (copy).md',
      'angled.md',
      'deploy (copy).md',
      'deploy.md',
      'deploy.md#raw/other.md',
      'deploy.md?raw/other.md',
      'dot (copy).md',
      'dot.md',
      'literal#part (copy).md',
      'literal#part.md',
      long,
      'notes/a.md',
      'p(1) (copy).md',
      'p(1).md',
      'same.md',
      'two.md',
    ]
      .map((note) => `${target}/${note}`)
      .join('\n'),
  );
  assert.equal(
    await memory.read(merged.revision, `${target}/MEMORY.md`),
    '# Project\n- [deploy](deploy.md)\n- shared  \n- [deploy](<deploy (copy).md>)\n- [two](two.md)\n- [dot](<dot (copy).md>)\n- [angled](<angled (copy).md>)\n- [p](<p(1) (copy).md>)\n' +
      '- [fragment](<deploy (copy).md#section>)\n- [query](<angled (copy).md?raw=1>)\n- [both](<deploy (copy).md?next=../two#section>)\n- [literal](<literal#part (copy).md>)\n- [unmatched](missing.md?raw=1#section)\n' +
      '- [query path](<deploy (copy).md?next=/../dot.md>)\n- [fragment path](<deploy (copy).md#section/../same.md>)\n' +
      '- [query directory](<deploy (copy).md?raw/missing>)\n- [fragment directory](<deploy (copy).md#raw/missing>)\n- [literal directory](deploy.md?raw/other.md)\n- [first suffix](<deploy (copy).md?raw/other.md#section>)\n',
  );
  assert.equal(
    await memory.read(merged.revision, `${target}/deploy.md`),
    'Deploy with A.\n',
  );
  assert.equal(
    await memory.read(merged.revision, `${target}/deploy (copy).md`),
    'Deploy with B.\n',
  );
  assert.equal(
    await memory.read(merged.revision, `${target}/literal#part.md`),
    'Literal A.\n',
  );
  assert.equal(
    await memory.read(merged.revision, `${target}/literal#part (copy).md`),
    'Literal B.\n',
  );
  assert.equal(
    await memory.read(merged.revision, `${target}/(copy)/notes`),
    'A file named notes.\n',
  );
  assert.equal(
    await memory.read(merged.revision, `${target}/(copy)/${long}`),
    'Long B.\n',
  );
});

await test('migration keeps links to literal filenames that retain their names', async () => {
  const { memory, open, root } = await fixture();
  const origin = 'https://example.org/team/project.git';
  const upstream = await repository(root, 'upstream', origin);
  const copy = await repository(root, 'copy');
  const { workspace } = await open('a');
  const target = (await workspace.begin(upstream)).scope.project;
  await save(workspace, {
    [`${target}/deploy.md`]: 'Upstream base.\n',
    [`${target}/deploy.md#same`]: 'Shared fragment.\n',
    [`${target}/deploy.md?raw=2`]: 'Shared query.\n',
  });
  const source = (await workspace.begin(copy)).scope.project;
  const index =
    '[new fragment](./deploy.md#new)\n[new query](<deploy.md?raw=1>)\n' +
    '[shared fragment](deploy.md#same)\n[shared query](<./deploy.md?raw=2>)\n';
  await save(workspace, {
    [`${source}/MEMORY.md`]: index,
    [`${source}/deploy.md`]: 'Checkout base.\n',
    [`${source}/deploy.md#new`]: 'New fragment.\n',
    [`${source}/deploy.md?raw=1`]: 'New query.\n',
    [`${source}/deploy.md#same`]: 'Shared fragment.\n',
    [`${source}/deploy.md?raw=2`]: 'Shared query.\n',
  });
  await workspace.publish();
  await git(copy, 'remote', 'add', 'origin', origin);
  await workspace.begin(copy);
  assert.equal(await memory.read(main, `${target}/MEMORY.md`), index);
  for (const [note, text] of [
    ['deploy.md', 'Upstream base.\n'],
    ['deploy (copy).md', 'Checkout base.\n'],
    ['deploy.md#new', 'New fragment.\n'],
    ['deploy.md?raw=1', 'New query.\n'],
    ['deploy.md#same', 'Shared fragment.\n'],
    ['deploy.md?raw=2', 'Shared query.\n'],
  ])
    assert.equal(await memory.read(main, `${target}/${note}`), text);
});

await test('migration normalizes literal note directories before preserving link suffixes', async () => {
  const { memory, open, root } = await fixture();
  const origin = 'https://example.org/team/project.git';
  const upstream = await repository(root, 'upstream', origin);
  const copy = await repository(root, 'copy');
  const { workspace } = await open('a');
  const target = (await workspace.begin(upstream)).scope.project;
  await save(workspace, {
    [`${target}/folder#tag/note.md`]: 'Upstream hash.\n',
    [`${target}/folder?tag/note.md`]: 'Upstream query.\n',
  });
  const source = (await workspace.begin(copy)).scope.project;
  const parent = 'folder#tag/../'.repeat(16_000);
  await save(workspace, {
    [`${source}/MEMORY.md`]:
      '[hash](folder#tag/./note.md)\n[query](folder?tag/./note.md)\n' +
      `[parent](${parent}folder#tag/note.md)\n` +
      '[suffix](<folder?tag/./note.md#section/../untouched>)\n',
    [`${source}/folder#tag/note.md`]: 'Checkout hash.\n',
    [`${source}/folder?tag/note.md`]: 'Checkout query.\n',
  });
  await workspace.publish();
  await git(copy, 'remote', 'add', 'origin', origin);
  const started = performance.now();
  await workspace.begin(copy);
  const elapsed = performance.now() - started;
  assert.equal(
    await memory.read(main, `${target}/MEMORY.md`),
    '[hash](<folder#tag/note (copy).md>)\n' +
      '[query](<folder?tag/note (copy).md>)\n' +
      '[parent](<folder#tag/note (copy).md>)\n' +
      '[suffix](<folder?tag/note (copy).md#section/../untouched>)\n',
  );
  for (const [note, text] of [
    ['folder#tag/note.md', 'Upstream hash.\n'],
    ['folder#tag/note (copy).md', 'Checkout hash.\n'],
    ['folder?tag/note.md', 'Upstream query.\n'],
    ['folder?tag/note (copy).md', 'Checkout query.\n'],
  ])
    assert.equal(await memory.read(main, `${target}/${note}`), text);
  assert.ok(elapsed < 3000, `migration took ${elapsed} ms`);
});

await test("a move that loses to another clone's move is made again on the newer main", async () => {
  const { memory, open, root, project, hook } = await fixture();
  const begin = async (workspace: Workspace, cwd: string, note?: string) => {
    const begun = await workspace.begin(cwd);
    if (note) await save(workspace, { [`${begun.scope.project}/x.md`]: note });
    await workspace.publish();
    return begun;
  };
  const first = (await open('a')).workspace;
  await git(project, 'init', '--quiet');
  await begin(first, project, 'A version.\n');
  const copy = await repository(root, 'copy');
  const second = (await open('b')).workspace;
  await begin(second, copy, 'B version.\n');
  for (const checkout of [project, copy])
    await git(
      checkout,
      'remote',
      'add',
      'origin',
      'https://github.com/o/r.git',
    );
  // the other clone's move lands after this one read main and before it publishes
  let raced = false;
  hook.current = async (command, run, options) => {
    if (
      !raced &&
      options.cwd === second.root &&
      command[0] === 'ls-files' &&
      command[1] === '-z'
    ) {
      raced = true;
      await first.begin(project);
    }
    return run();
  };
  const merged = await second.begin(copy);
  assert.ok(raced);
  assert.equal(merged.revision, await memory.resolve(main));
  const target = merged.scope.project;
  assert.equal(await memory.read(main, `${target}/x.md`), 'A version.\n');
  assert.equal(
    await memory.read(main, `${target}/x (copy).md`),
    'B version.\n',
  );
});

await test('a move that keeps losing to other clones gives up on main, so it never waits to publish', async () => {
  const { memory, open, root } = await fixture();
  const { workspace } = await open('a');
  const copy = await repository(root, 'copy');
  const key = (await workspace.begin(copy)).scope.project;
  await save(workspace, { [`${key}/x.md`]: 'X.\n' });
  await workspace.publish();
  await git(copy, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  const publish = workspace.publish.bind(workspace);
  let publishes = 0;
  // the leftover publish goes through, and every move after it loses
  workspace.publish = async () =>
    publishes++
      ? { paths: [`${key}/x.md`], diff: `+X. in ${key}/x.md` }
      : publish();
  await assert.rejects(workspace.begin(copy), /kept losing/);
  assert.equal(
    (await git(workspace.root, 'rev-parse', 'HEAD')).trim(),
    await memory.resolve(main),
  );
});

await test("a note with no free path in the project stays under the checkout's key", async () => {
  const { memory, open, root } = await fixture();
  const { workspace } = await open('a');
  const origin = 'https://github.com/o/r.git';
  const upstream = await repository(root, 'upstream', origin);
  const target = (await workspace.begin(upstream)).scope.project;
  await save(workspace, {
    [`${target}/x.md/note.md`]: 'A directory.\n',
    [`${target}/(app)`]: 'A file.\n',
  });
  await workspace.publish();
  const app = await repository(root, 'app');
  const key = (await workspace.begin(app)).scope.project;
  await save(workspace, { [`${key}/x.md`]: 'Stays.\n' });
  await workspace.publish();
  await git(app, 'remote', 'add', 'origin', origin);
  await workspace.begin(app);
  assert.equal(await memory.read(main, `${key}/x.md`), 'Stays.\n');
});

await test('a failed memory move preserves its error and reports a failed rollback', async (t) => {
  for (const rollbackFails of [false, true])
    await t.test(
      rollbackFails ? 'failed rollback' : 'successful rollback',
      async () => {
        const { memory, open, root, hook } = await fixture();
        const copy = await repository(root, 'copy');
        const { workspace } = await open('a');
        const source = (await workspace.begin(copy)).scope.project;
        await save(workspace, { [`${source}/note.md`]: 'Original.\n' });
        await workspace.publish();
        const accepted = await memory.resolve(main);
        await git(
          copy,
          'remote',
          'add',
          'origin',
          'https://example.org/team/project.git',
        );
        const target = (await memory.scopePaths(copy)).project;
        const adoption = new Error('adoption failed');
        const rollback = new Error('rollback failed');
        hook.current = async (command, run) => {
          if (command[0] === 'add') throw adoption;
          if (rollbackFails && command[0] === 'reset') throw rollback;
          return run();
        };
        try {
          await assert.rejects(workspace.begin(copy), (error: unknown) => {
            if (rollbackFails) {
              assert.ok(error instanceof Error);
              assert.equal(
                error.message,
                'adoption failed\n\nCould not discard the failed memory move: rollback failed',
              );
              assert.equal(error.cause, adoption);
            } else assert.equal(error, adoption);
            return true;
          });
        } finally {
          hook.current = passThrough;
        }
        assert.equal(await memory.resolve(main), accepted);
        assert.equal(
          await memory.read(main, `${source}/note.md`),
          'Original.\n',
        );
        await assert.rejects(memory.read(main, `${target}/note.md`));
        assert.equal(await workspace.isDirty(), rollbackFails);
        const present = rollbackFails ? target : source;
        const absent = rollbackFails ? source : target;
        assert.equal(
          await readFile(join(workspace.root, present, 'note.md'), 'utf8'),
          'Original.\n',
        );
        await assert.rejects(
          readFile(join(workspace.root, absent, 'note.md')),
          { code: 'ENOENT' },
        );
      },
    );
});

await test('a move that fails on an OS error fails the turn and leaves every note where it was', async () => {
  const { memory, open, root, hook } = await fixture();
  const first = (await open('a')).workspace;
  const target = (
    await first.begin(
      await repository(root, 'upstream', 'https://github.com/o/r.git'),
    )
  ).scope.project;
  await save(first, { [`${target}/d/y.md`]: 'Y.\n' });
  await first.publish();
  const copy = await repository(root, 'copy');
  const second = (await open('b')).workspace;
  const key = (await second.begin(copy)).scope.project;
  await save(second, { [`${key}/a.md`]: 'A.\n', [`${key}/d/x.md`]: 'X.\n' });
  await second.publish();
  await git(copy, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  const locked = join(second.root, target, 'd');
  // d is unreadable only while the move places notes, between its git commands
  hook.current = async (command, run, options) => {
    if (options.cwd === second.root)
      await chmod(
        locked,
        command[0] === 'ls-files' && command[1] === '-z' ? 0o000 : 0o755,
      );
    return run();
  };
  try {
    await assert.rejects(second.begin(copy), /EACCES/);
  } finally {
    await chmod(locked, 0o755);
  }
  assert.equal(await second.isDirty(), false);
  assert.equal(await memory.read(main, `${key}/a.md`), 'A.\n');
  assert.equal(await memory.read(main, `${key}/d/x.md`), 'X.\n');
});

await test(
  "a third version of a note from another checkout of the same name takes the next copy number, in the index's line endings",
  { timeout: 20_000 },
  async () => {
    const { memory, open, root } = await fixture();
    const { workspace } = await open('a');
    const begin = async (cwd: string, notes: Record<string, string> = {}) => {
      const { scope } = await workspace.begin(cwd);
      await save(
        workspace,
        Object.fromEntries(
          Object.entries(notes).map(([note, text]) => [
            `${scope.project}/${note}`,
            text,
          ]),
        ),
      );
      await workspace.publish();
      return scope.project;
    };
    const origin = 'https://github.com/o/r.git';
    const upstream = await repository(root, 'upstream', origin);
    const target = await begin(upstream, {
      'MEMORY.md': '# Project\r\n- [x](x.md)\r\n',
      'x.md': 'A.\n',
    });
    const checkouts = [
      await repository(root, 'first/app'),
      await repository(root, 'second/app'),
    ];
    for (const [index, checkout] of checkouts.entries())
      await begin(checkout, {
        'MEMORY.md': '# Project\n- [x](x.md)\n',
        'x.md': `${'BC'[index]}.\n`,
      });
    for (const checkout of checkouts) {
      await git(checkout, 'remote', 'add', 'origin', origin);
      await begin(checkout);
    }
    assert.equal(await memory.read(main, `${target}/x.md`), 'A.\n');
    assert.equal(await memory.read(main, `${target}/x (app).md`), 'B.\n');
    assert.equal(await memory.read(main, `${target}/x (app 2).md`), 'C.\n');
    assert.equal(
      await memory.read(main, `${target}/MEMORY.md`),
      '# Project\r\n- [x](x.md)\r\n- [x](<x (app).md>)\r\n- [x](<x (app 2).md>)\r\n',
    );
  },
);

await test('index migration preserves duplicate, empty and newline cases', async (t) => {
  const blankRun = '\n'.repeat(80_000);
  for (const [name, index, added, expected] of [
    ['already present', 'Keep\r\n\r\n\r\n', 'Keep\nKeep\n', 'Keep\r\n\r\n\r\n'],
    ['empty destination', '', 'Added\nAdded\n', 'Added\n'],
    ['bare CR', 'Keep\r', 'Added\n', 'Keep\r\nAdded\n'],
    ['CRLF', 'Keep\r\n\r\n', 'Added\n', 'Keep\r\nAdded\r\n'],
    [
      'long blank run',
      `Head\n${blankRun}Tail\n`,
      'Added\n',
      `Head\n${blankRun}Tail\nAdded\n`,
    ],
  ] as const) {
    await t.test(name, async () => {
      const { memory, root, open } = await fixture();
      const origin = 'https://example.org/team/project.git';
      const upstream = await repository(root, 'upstream', origin);
      const copy = await repository(root, 'copy');
      const { workspace } = await open('a');
      const target = (await workspace.begin(upstream)).scope.project;
      await save(workspace, { [`${target}/MEMORY.md`]: index });
      const source = (await workspace.begin(copy)).scope.project;
      await save(workspace, { [`${source}/MEMORY.md`]: added });
      await workspace.publish();
      await git(copy, 'remote', 'add', 'origin', origin);
      const started = performance.now();
      await workspace.begin(copy);
      const elapsed = performance.now() - started;
      assert.equal(await memory.read(main, `${target}/MEMORY.md`), expected);
      if (name === 'long blank run')
        assert.ok(elapsed < 3000, `migration took ${elapsed} ms`);
    });
  }
});
