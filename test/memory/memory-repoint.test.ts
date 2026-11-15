import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { main } from '../../src/memory/memory.js';
import { repointText } from '../../src/memory/workspace.js';
import { identify, mapper } from '../../src/persistence/directories.js';
import type { Ledger, LedgerMove } from '../../src/persistence/directories.js';
import { fixture, save } from '../fixtures/memory.js';
import { scratch } from '../fixtures/scratch.js';

async function moves(...pairs: Array<[string, string]>): Promise<Ledger> {
  const ledger: Ledger = { entries: [], moves: [] };

  for (const [from, to] of pairs) {
    await mkdir(to, { recursive: true });

    ledger.moves.push({
      from,
      to,
      ...(await identify(to))!,
      prompts: 0,
      at: 0,
    });
  }

  return ledger;
}

/** a move under the home directory whose `from` never existed, for the `~/` form. */
const homeMove = (to: string): LedgerMove => ({
  from: join(homedir(), `witch-test-${randomUUID()}`),
  to,
  device: '0',
  inode: '0',
  prompts: 0,
  at: 0,
});

test('repointText maps references at path boundaries and leaves look-alikes alone', async () => {
  const s = await scratch('witch-repoint-');
  const ledger = await moves([join(s, 'w/main'), join(s, 'c/main')]);
  const home = await scratch('witch-repoint-home-');
  const tilde = { ...homeMove(join(home, 'moved')), from: join(home, 'old') };
  ledger.moves.push(tilde);
  await mkdir(tilde.to);
  Object.assign(tilde, await identify(tilde.to));
  const { map } = await mapper(ledger);
  const w = join(s, 'w/main');
  const c = join(s, 'c/main');
  const forms = [w, tilde.from, '~/old'];
  const repoint = (text: string) => repointText(text, forms, map, home);

  for (const [before, after] of [
    [w, c],
    [`${w}/README.md`, `${c}/README.md`],
    [`\`${w}\`.`, `\`${c}\`.`],
    [`(${w})`, `(${c})`],
    [`[x](${w}/a.md#setup)`, `[x](${c}/a.md#setup)`],
    [`${w}?raw=1`, `${c}?raw=1`],
    [`see ${w}, then`, `see ${c}, then`],
    [`~/old/notes.md`, `~/moved/notes.md`],
    [`\`${w}/\``, `\`${c}/\``],
    [`${w}//src/a.md`, `${c}//src/a.md`],
  ])
    assert.equal(repoint(before!), after, before);

  for (const unchanged of [
    `${w}-1`,
    `${w}.git`,
    `\`${w} copy\``,
    `\`${w} copy/x\``,
    `<${w} copy/x>`,
    `see ${w} copy/x`,
    `${w}é`,
    `/backup${w}`,
  ])
    assert.equal(repoint(unchanged), unchanged);
});

test('a destination with a space gets angle brackets', async () => {
  const s = await scratch('witch-repoint-');
  const w = join(s, 'w/main');
  const to = join(s, 'new checkout');
  const { map } = await mapper(await moves([w, to]));

  assert.equal(
    repointText(`[x](${w}/README.md)`, [w], map, homedir()),
    `[x](<${to}/README.md>)`,
  );
});

test('repointing follows a chain and never maps into a reused directory', async () => {
  const s = await scratch('witch-repoint-');

  const [a, b, c] = ['a', 'b', 'c'].map((name) => join(s, name)) as [
    string,
    string,
    string,
  ];

  const ledger = await moves([a, c], [join(b, 'x'), c]);
  ledger.moves[0] = { ...ledger.moves[0]!, to: b };
  const note = `${a}/x/f`;

  assert.equal(
    repointText(note, [a, join(b, 'x')], (await mapper(ledger)).map, homedir()),
    `${c}/f`,
  );

  await mkdir(join(s, 'spare'));
  await mkdir(b, { recursive: true });
  await rename(join(s, 'spare'), join(b, 'x'));

  assert.equal(
    repointText(note, [a, join(b, 'x')], (await mapper(ledger)).map, homedir()),
    note,
  );

  for (const text of [
    `\`${note} ${note}#x ${note}?y\``,
    `${note}!${note}!${note}!`,
  ])
    assert.equal(
      repointText(
        text,
        [a, join(b, 'x')],
        (await mapper(ledger)).map,
        homedir(),
      ),
      text,
    );
});

test('repointing a suspended chain stays linear in the number of references', async () => {
  const s = await scratch('witch-repoint-');

  const [a, b, c] = ['a', 'b', 'c'].map((name) => join(s, name)) as [
    string,
    string,
    string,
  ];

  const ledger = await moves([a, c], [join(b, 'x'), c]);
  ledger.moves[0] = { ...ledger.moves[0]!, to: b };
  await mkdir(join(s, 'spare'));
  await mkdir(b, { recursive: true });
  await rename(join(s, 'spare'), join(b, 'x'));
  const { map } = await mapper(ledger);
  const note = `${a}/x/f`;

  // linear work takes milliseconds here, so a second fails only a scan that rereads the line for each reference
  for (const text of [
    `\`${`${note} `.repeat(20_000)}\``,
    `${note}!`.repeat(20_000),
  ]) {
    const started = performance.now();
    assert.equal(repointText(text, [a, join(b, 'x')], map, homedir()), text);
    assert.ok(performance.now() - started < 1000);
  }
});

test('a reference longer than any path is left alone', async () => {
  const s = await scratch('witch-repoint-');
  const w = join(s, 'w/main');
  const { map } = await mapper(await moves([w, join(s, 'c/main')]));

  for (const tail of ['x'.repeat(1100), 'é/'.repeat(350)]) {
    const text = `\`${w}/${tail}\``;
    assert.equal(repointText(text, [w], map, homedir()), text, tail);
  }
});

test('begin repoints moved paths in every scope as one published commit', async () => {
  const { memory, open, begin } = await fixture();
  const s = await scratch('witch-repoint-');
  const w = join(s, 'w/main');
  const c = join(s, 'c/main');
  const ledger = await moves([w, c]);
  const { workspace } = await open('a');
  const { scope } = await begin(workspace, s);
  const other = 'projects/other-0000/d.md';

  await save(workspace, {
    [`${scope.global}/a.md`]: `See ${w}/README.md.\n`,
    [`${scope.project}/b.md`]: `Use \`${w}\` and ${w}-1.\n`,
    [`${scope.project}/c.md`]: 'Nothing moved here.\n',
    [other]: `${w}\n`,
  });

  await workspace.publish();
  const begun = await workspace.begin(scope, ledger);
  assert.equal(begun.repointed, 3);
  assert.equal(await memory.read(main, other), `${c}\n`);
  assert.equal(begun.notice, undefined);
  assert.equal(begun.revision, await memory.resolve(main));

  assert.equal(
    await memory.read(main, `${scope.global}/a.md`),
    `See ${c}/README.md.\n`,
  );

  assert.equal(
    await memory.read(main, `${scope.project}/b.md`),
    `Use \`${c}\` and ${w}-1.\n`,
  );

  const message = (
    await memory.run(memory.root, ['log', '-1', '--format=%B', main])
  ).stdout.toString();

  assert.match(message, /^chore\(memory\): repoint moved directories/);
  assert.ok(message.includes(`${w} -> ${c}`));
  assert.match(message, /conversation: a/);
  const again = await workspace.begin(scope, ledger);
  assert.equal(again.repointed, 0);
  assert.equal(again.revision, begun.revision);
});

test('notes published later by another conversation get repointed at the next begin', async () => {
  const { memory, open, begin } = await fixture();
  const s = await scratch('witch-repoint-');
  const w = join(s, 'w/main');
  const c = join(s, 'c/main');
  const ledger = await moves([w, c]);
  const first = (await open('a')).workspace;
  const second = (await open('b')).workspace;
  const { scope } = await begin(first, s);
  await workspace(second, s, begin, { [`${scope.global}/late.md`]: `${w}\n` });
  await first.begin(scope, ledger);
  assert.equal(await memory.read(main, `${scope.global}/late.md`), `${c}\n`);
});

async function workspace(
  target: Awaited<
    ReturnType<Awaited<ReturnType<typeof fixture>>['open']>
  >['workspace'],
  cwd: string,
  begin: Awaited<ReturnType<typeof fixture>>['begin'],
  notes: Record<string, string>,
) {
  await begin(target, cwd);
  await save(target, notes);
  await target.publish();
}

/** a MEMORY.md whose concurrent union merge brings an old link back after the first repoint publishes. */
async function unionRace() {
  const f = await fixture();
  const s = await scratch('witch-repoint-');
  const w = join(s, 'w/main');
  const c = join(s, 'c/main');
  const ledger = await moves([w, c]);
  const first = (await f.open('a')).workspace;
  const second = (await f.open('b')).workspace;
  const { scope } = await f.begin(first, s);
  const index = `${scope.global}/MEMORY.md`;
  await save(first, { [index]: `- one ${w}\n` });
  await first.publish();
  await f.begin(second, s);
  await save(second, { [index]: `- one ${w}\n- two ${w}/x\n` });
  let raced = false;

  f.hook.current = async (command, run) => {
    if (!raced && command[0] === 'update-ref' && command.includes(main)) {
      raced = true;
      await second.publish();
    }

    return run();
  };

  return { ...f, w, c, ledger, first, scope, index, raced: () => raced };
}

test('a repoint survives a concurrent union merge of MEMORY.md', async () => {
  const f = await unionRace();
  await f.first.begin(f.scope, f.ledger);
  assert.ok(f.raced());
  const merged = await f.memory.read(main, f.index);
  assert.ok(!merged.includes(f.w), merged);
  assert.ok(merged.includes(`${f.c}/x`), merged);
});

test('a failed repoint after the first publish is still reported', async () => {
  const f = await unionRace();
  const hook = f.hook.current;

  f.hook.current = async (command, run, options) => {
    if (f.raced() && command[0] === 'commit') throw new Error('disk full');

    return hook(command, run, options);
  };

  const begun = await f.first.begin(f.scope, f.ledger);
  assert.match(begun.notice ?? '', /Could not repoint.*disk full/);
  assert.equal(begun.repointed, 1);
  assert.equal(begun.revision, await f.memory.resolve(main));
  assert.equal(await f.first.isDirty(), false);
});

test('a follow-up repoint that loses to another conversation starts the turn from main', async () => {
  const f = await unionRace();
  const publish = f.first.publish.bind(f.first);

  const spy = vi
    .spyOn(f.first, 'publish')
    .mockImplementationOnce(publish)
    .mockResolvedValueOnce({ paths: [f.index], diff: '' });

  const begun = await f.first.begin(f.scope, f.ledger);
  assert.equal(spy.mock.calls.length, 2);
  spy.mockRestore();
  assert.equal(begun.revision, await f.memory.resolve(main));
  assert.equal(await f.first.revision(), begun.revision);
  assert.ok((await f.memory.read(main, f.index)).includes(`${f.w}/x`));
  assert.equal((await f.first.begin(f.scope, f.ledger)).repointed, 1);
  assert.ok(!(await f.memory.read(main, f.index)).includes(f.w));
});

test('begin without matches makes no commit', async () => {
  const { memory, open, begin } = await fixture();
  const s = await scratch('witch-repoint-');
  const ledger = await moves([join(s, 'w/main'), join(s, 'c/main')]);
  const { workspace } = await open('a');
  const { scope } = await begin(workspace, s);
  const before = await memory.resolve(main);
  const begun = await workspace.begin(scope, ledger);
  assert.equal(begun.repointed, 0);
  assert.equal(await memory.resolve(main), before);
});

test('a failed note write rolls back and the turn still begins', async () => {
  const { memory, open, begin } = await fixture();
  const s = await scratch('witch-repoint-');
  const w = join(s, 'w/main');
  const ledger = await moves([w, join(s, 'c/main')]);
  const { workspace } = await open('a');
  const { scope } = await begin(workspace, s);
  const note = `${scope.global}/z-locked.md`;

  await save(workspace, {
    [note]: `${w}\n`,
    [`${scope.global}/a-open.md`]: `${w}\n`,
  });

  await workspace.publish();
  const before = await memory.resolve(main);
  await chmod(join(workspace.root, note), 0o444);

  try {
    const begun = await workspace.begin(scope, ledger);
    assert.match(begun.notice ?? '', /Could not repoint/);
    assert.equal(begun.repointed, 0);
    assert.equal(await workspace.isDirty(), false);
    assert.equal(await memory.resolve(main), before);
    assert.equal(await readFile(join(workspace.root, note), 'utf8'), `${w}\n`);
  } finally {
    await chmod(join(workspace.root, note), 0o644);
  }
});
