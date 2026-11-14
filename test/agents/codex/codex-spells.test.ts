import assert from 'node:assert/strict';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  castIndex,
  castSkills,
} from '../../../src/agents/codex/codex-spells.js';
import type { AgentEvent, Cast, Subagent } from '../../../src/agents/types.js';
import { close, fixture } from '../../fixtures/codex-adapter.js';
import { scratch } from '../../fixtures/scratch.js';

async function spellTree() {
  const root = await scratch('witch-codex-spells-');
  const a = join(root, 'p', '.agents', 'skills', 'a', 'SKILL.md');
  const b = join(root, 'h', 'skills', 'b', 'SKILL.md');
  const c = join(root, 'sp ace', 'skills', 'c', 'SKILL.md');

  await mkdir(join(a, '..', 'scripts'), { recursive: true });

  await mkdir(join(b, '..'), { recursive: true });

  await mkdir(join(c, '..'), { recursive: true });

  for (const path of [a, b, c]) await writeFile(path, '---\n---\n');

  await writeFile(join(a, '..', 'scripts', 'run.py'), '');

  await symlink(join(root, 'p'), join(root, 'link'));

  const index = castIndex([
    { name: 'a', path: a },
    { name: 'b', path: b },
    { name: 'c', path: c },
  ]);

  return { root, a, b, c, index };
}

test('a selected spell and a command that reads a listed SKILL.md or runs one of its scripts cast that spell once each, and nothing else does', async () => {
  const { root, a, b, c, index } = await spellTree();
  const project = join(root, 'p');

  const command = (commandActions?: unknown[], fields = {}) => ({
    type: 'commandExecution',
    cwd: project,
    source: 'agent',
    ...(commandActions ? { commandActions } : {}),
    ...fields,
  });

  const unknown = (text: string) =>
    command([{ type: 'unknown', command: text }]);

  const cases: [string, unknown, string[]][] = [
    ['an absolute read', command([{ type: 'read', path: a }]), ['a']],
    [
      'a read relative to the cwd',
      command([{ type: 'read', path: '.agents/skills/a/SKILL.md' }]),
      ['a'],
    ],
    [
      'a read through a symlinked alias',
      command([
        { type: 'read', path: join(root, 'link', '.agents/skills/a/SKILL.md') },
      ]),
      ['a'],
    ],
    ['cat of two spells', unknown(`cat ${b} '${a}'`), ['b', 'a']],
    ['a quoted path with a space', unknown(`cat "${c}"`), ['c']],
    ['sed printing a range', unknown(`sed -n '1,200p' ${a}`), ['a']],
    [
      'a runner on a script',
      unknown('python3 .agents/skills/a/scripts/run.py --x'),
      ['a'],
    ],
    ['wc', unknown(`wc -l ${a}`), []],
    ['rg', unknown(`rg x ${a}`), []],
    ['grep', unknown(`grep x ${a}`), []],
    ['ls', unknown(`ls ${a}`), []],
    [
      'a search naming the path',
      command([{ type: 'search', query: 'x', path: a }]),
      [],
    ],
    [
      'a listing naming the path',
      command([{ type: 'listFiles', path: a }]),
      [],
    ],
    [
      "the user's own `!` command",
      command([{ type: 'read', path: a }], { source: 'userShell' }),
      [],
    ],
    [
      'two reads of one spell',
      command([
        { type: 'read', path: a },
        { type: 'unknown', command: `cat ${a}` },
      ]),
      ['a'],
    ],
    [
      'a selected spell',
      {
        type: 'userMessage',
        content: [
          { type: 'text', text: 'go' },
          { type: 'skill', name: 'a', path: a },
        ],
      },
      ['a'],
    ],
    ['a command without actions', command(), []],
  ];

  for (const [name, item, expected] of cases)
    assert.deepEqual(
      castSkills(item, index).map((cast) => cast.name),
      expected,
      name,
    );
});

const spellIds = (events: AgentEvent[]) =>
  events.flatMap((event) => (event.type === 'spell' ? [event.cast.id] : []));

test("a selected spell the agent also reads is one cast per turn, under the turn's id", async () => {
  const events: AgentEvent[] = [];

  const { session, cwd } = await fixture((event) => events.push(event), {
    mode: 'spell-reads',
  });

  try {
    const path = await realpath(join(cwd, '.agents/skills/a/SKILL.md'));

    assert.deepEqual(await session.skills(), [{ name: 'a', description: 'A' }]);

    const first = await session.send('cast', {
      skill: { name: 'a', args: '' },
    });

    assert.equal(first.status, 'completed');

    assert.deepEqual(
      [...new Set(spellIds(events))],
      [`native-thread/turn-1/${path}`],
    );

    assert.ok(
      events.every(
        (event) => event.type !== 'spell' || event.cast.name === 'a',
      ),
    );

    const before = spellIds(events).length;

    assert.equal((await session.send('again')).status, 'completed');

    assert.deepEqual(spellIds(events).slice(before), [
      `native-thread/turn-2/${path}`,
    ]);
  } finally {
    await close(session, cwd);
  }
});

test("a familiar's reads join its spells once, a late one from its previous turn included, and an unknown thread's read is announced as the agent's", async () => {
  const events: AgentEvent[] = [];

  const { session, cwd } = await fixture((event) => events.push(event), {
    mode: 'spell-reads',
  });

  try {
    const path = await realpath(join(cwd, '.agents/skills/a/SKILL.md'));

    await session.skills();

    assert.equal((await session.send('familiar')).status, 'completed');

    const cast: Cast = { id: `child-thread/child-turn-1/${path}`, name: 'a' };

    const child = events.flatMap((event): Subagent[] =>
      event.type === 'subagent' && event.subagent.id === 'child-thread'
        ? [event.subagent]
        : [],
    );

    for (const subagent of child)
      if (subagent.spells) assert.deepEqual(subagent.spells, [cast]);

    for (const run of ['child-turn-1', 'child-turn-2'])
      assert.ok(
        child.some((subagent) => subagent.run === run && subagent.spells),
        run,
      );

    assert.deepEqual(
      [...new Set(spellIds(events))],
      [`stray-thread/stray-turn/${path}`],
    );
  } finally {
    await close(session, cwd);
  }
});

test('a selected spell Codex is never sent is not announced', async () => {
  const events: AgentEvent[] = [];

  const { session, cwd } = await fixture((event) => events.push(event), {
    mode: 'context-error',
  });

  try {
    await session.skills();

    const result = await session.send('review this', {
      skill: { name: 'review', args: '' },
      context: 'context',
    });

    assert.equal(result.inputUnsent, true);

    assert.deepEqual(spellIds(events), []);
  } finally {
    await close(session, cwd);
  }
});
