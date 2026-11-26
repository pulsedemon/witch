import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentEvent,
  Skill,
  SkillCall,
} from '../../../src/agents/types.js';
import {
  fixture,
  frameWriter,
  jsonLines,
  launcher,
} from '../../fixtures/claude-adapter.js';
import { until, within } from '../../fixtures/within.js';
import { lifecycle } from '../../fixtures/claude-background.js';
import { running } from '../../../src/agents/shutdown.js';

const probe: SkillCall = { name: 'probe', args: 'later' };

const spells = (events: AgentEvent[]) =>
  events.flatMap((event) => (event.type === 'spell' ? [event.cast] : []));

const skill = (id: string, name: string) => ({
  type: 'tool_use',
  id,
  name: 'Skill',
  input: { skill: name },
});

const assistant = (
  content: object[],
  parent: string | null = null,
  agent?: string,
) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  ...(agent ? { agent_id: agent } : {}),
  message: {
    id: randomUUID(),
    type: 'message',
    role: 'assistant',
    model: 'claude-a',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {},
  },
});

/** a `background` session whose first turn has replied and stays open, with lifecycle acknowledgements on. */
async function background(initial = 'initial', initialSkill?: SkillCall) {
  const events: AgentEvent[] = [];
  const f = await launcher('background');
  const session = await f.connect({ onEvent: (event) => events.push(event) });

  const received = (name: string) =>
    events.some((e) => e.type === 'skills' && e.skills[0]?.name === name);

  const emit = frameWriter(f.cwd, received, f.children[0]!);
  const turn = session.send(initial, { skill: initialSkill });
  await until('initial reply', () => received('result-1'));

  const inputs = async () =>
    (await jsonLines(join(f.cwd, 'inputs.jsonl'))) as SDKUserMessage[];

  /** the uuid of the `count`th input, once Claude Code has it. */
  const pushed = async (count: number) => {
    await until('pushed input', async () => (await inputs()).length >= count);

    return (await inputs())[count - 1]!.uuid!;
  };

  return { ...f, session, events, emit, turn, inputs, pushed };
}

test('a sent spell is announced once with its input uuid when Claude Code starts it, ahead of init, and a native command is not', async () => {
  const events: AgentEvent[] = [];

  const { session, cwd } = await fixture(
    (event) => events.push(event),
    'spell-user',
  );

  try {
    assert.equal(
      (
        await session.send('/probe now', {
          skill: { name: 'probe', args: 'now' },
        })
      ).status,
      'completed',
    );

    const [input] = (await jsonLines(
      join(cwd, 'inputs.jsonl'),
    )) as SDKUserMessage[];

    assert.deepEqual(spells(events), [{ id: input!.uuid, name: 'probe' }]);

    assert.equal(
      (
        await session.send('/probe now', {
          skill: { name: 'probe', args: 'now', builtin: true },
        })
      ).status,
      'completed',
    );

    assert.equal(spells(events).length, 1);
  } finally {
    await session.close();
  }
});

test('a sent spell is announced when a frame lists its input uuid, without lifecycle frames', async () => {
  const f = await background('/probe now', { name: 'probe', args: 'now' });

  try {
    assert.deepEqual(spells(f.events), [
      { id: await f.pushed(1), name: 'probe' },
    ]);
  } finally {
    await f.session.close();
  }
});

test('a steered spell is announced once Claude Code starts it, not while it is queued', async () => {
  const f = await background();

  try {
    assert.equal(await f.session.steer('/probe later', { skill: probe }), true);
    const uuid = await f.pushed(2);
    await f.emit(lifecycle(uuid, 'queued'));
    assert.deepEqual(spells(f.events), []);

    await f.emit(lifecycle(uuid, 'started'), {
      type: 'result',
      result: 'Probed.',
      user_message_uuids: [uuid],
    });

    assert.deepEqual(spells(f.events), [{ id: uuid, name: 'probe' }]);
  } finally {
    await f.session.close();
  }
});

test('a steered spell Claude Code cancels is not announced, and sending it again announces the new input once it starts', async () => {
  const f = await background();

  try {
    assert.equal(await f.session.steer('/probe later', { skill: probe }), true);
    const cancelled = await f.pushed(2);

    await f.emit(lifecycle(cancelled, 'cancelled'), {
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
    });

    assert.equal(
      (await within(f.turn, 2000, 'cancelled turn')).status,
      'failed',
    );

    assert.deepEqual(spells(f.events), []);
    void f.session.send('/probe later', { skill: probe });
    const resent = await f.pushed(3);
    await f.emit(lifecycle(resent, 'started'));
    assert.deepEqual(spells(f.events), [{ id: resent, name: 'probe' }]);
  } finally {
    await f.session.close();
  }
});

test('a steered spell an interrupt reports still queued comes back unread unannounced, and its rerun after reconnecting is announced', async () => {
  const f = await background();

  try {
    assert.equal(await f.session.steer('/probe later', { skill: probe }), true);
    await f.pushed(2);
    await within(f.session.interrupt(), 2000, 'interrupt receipt');
    const outcome = await f.turn;
    assert.equal(outcome.status, 'interrupted');
    assert.deepEqual(outcome.unread, ['/probe later']);
    assert.deepEqual(spells(f.events), []);
  } finally {
    await f.session.close();
  }

  const rerun: AgentEvent[] = [];
  const session = await f.connect({ onEvent: (event) => rerun.push(event) });

  try {
    void session.send('/probe later', { skill: probe });

    await until('rerun reply', () =>
      rerun.some(
        (e) => e.type === 'skills' && e.skills[0]?.name === 'result-1',
      ),
    );

    assert.deepEqual(spells(rerun), [{ id: await f.pushed(3), name: 'probe' }]);
    assert.deepEqual(spells(f.events), []);
  } finally {
    await session.close();
  }
});

test("the agent's Skill call is announced with its tool id", async () => {
  const events: AgentEvent[] = [];
  const { session } = await fixture((event) => events.push(event));

  try {
    assert.equal((await session.send('tools')).status, 'completed');

    assert.deepEqual(
      events.filter((event) => event.type === 'spell'),
      [{ type: 'spell', cast: { id: 'tool-s', name: 'handoff' } }],
    );
  } finally {
    await session.close();
  }
});

test('two Skill calls naming one spell are two casts', async () => {
  const f = await background();

  try {
    await f.emit(
      assistant([skill('s-1', 'tdd')]),
      assistant([skill('s-2', 'tdd'), skill('s-3', 'review')]),
    );

    assert.deepEqual(spells(f.events), [
      { id: 's-1', name: 'tdd' },
      { id: 's-2', name: 'tdd' },
      { id: 's-3', name: 'review' },
    ]);
  } finally {
    await f.session.close();
  }
});

test("a listed familiar's Skill call joins its spells, while an ambient worker's and an unattributed nested call are announced as the agent's", async () => {
  const f = await background();

  try {
    await f.emit(
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'helper',
        task_type: 'local_agent',
        description: 'Helper',
        tool_use_id: 'helper-tool',
      },
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'worker',
        task_type: 'local_agent',
        description: '/spell',
        subagent_type: 'general-purpose',
        skip_transcript: true,
        ambient: true,
      },
      assistant([skill('h-1', 'tdd')], 'helper-tool', 'helper'),
      assistant([skill('w-1', 'review')], 'worker-tool', 'worker'),
      assistant([skill('n-1', 'handoff')], 'nested-tool'),
    );

    assert.deepEqual(spells(f.events), [
      { id: 'w-1', name: 'review' },
      { id: 'n-1', name: 'handoff' },
    ]);

    assert.deepEqual(
      f.events.flatMap((event) =>
        event.type === 'subagent' && event.subagent.spells
          ? [[event.subagent.id, event.subagent.spells]]
          : [],
      ),
      [['helper', [{ id: 'h-1', name: 'tdd' }]]],
    );
  } finally {
    await f.session.close();
  }
});

const named = (skills: Skill[], name: string) =>
  skills.find((skill) => skill.name === name);

const listed = (events: AgentEvent[]) =>
  events.flatMap((event) => (event.type === 'skills' ? [event.skills] : []));

const held = (children: { cwd: string }[]) =>
  !!children[0] && existsSync(join(children[0].cwd, 'reload-held'));

test("a built-in the session's skill reload lists is marked bundled before the first turn", async () => {
  const events: AgentEvent[] = [];
  const f = await launcher('reload-skills', 'reload-skills');
  const session = await f.connect({ onEvent: (event) => events.push(event) });

  try {
    await until('the reloaded skills', () => listed(events).length > 0);
    const [skills] = listed(events);

    assert.deepEqual(named(skills!, 'simplify'), {
      name: 'simplify',
      description: 'Review the changed code',
      builtin: true,
      bundled: true,
    });

    // the reload's same-named user skill must not mark the built-in bundled
    assert.deepEqual(named(skills!, 'compact'), {
      name: 'compact',
      description: 'Compact the conversation',
      builtin: true,
      aliases: ['squash'],
    });

    // the first turn's init names no bundled skills, so it replaces the reload's set
    assert.equal((await session.send('hello')).status, 'completed');

    await until('the init catalog', () =>
      listed(events).some((list) => named(list, 'simplify')?.bundled !== true),
    );

    const replaced = listed(events).find(
      (list) => named(list, 'simplify')?.bundled !== true,
    )!;

    assert.equal(named(replaced, 'simplify')?.builtin, true);
  } finally {
    await session.close();
  }
});

test("a resumed session's skill reload marks a built-in bundled before the first turn", async () => {
  const events: AgentEvent[] = [];
  const f = await launcher('reload-skills', 'reload-skills');

  const session = await f.connect({
    resume: randomUUID(),
    onEvent: (event) => events.push(event),
  });

  try {
    await until('the reloaded skills', () =>
      listed(events).some((list) => named(list, 'simplify')?.bundled),
    );
  } finally {
    await session.close();
  }
});

test("a turn's init stops a skill reload Claude Code has not answered", async () => {
  const f = await launcher('reload-late', 'reload-late');
  const session = await f.connect();

  try {
    await until('the held reload', () => held(f.sideChildren));
    assert.equal((await session.send('hello')).status, 'completed');
    await until('reload stop', () => !running(f.sideChildren[0]!.child));
    const skills = await session.skills();
    assert.equal(named(skills, 'autocompact')?.bundled, true);
    assert.equal(named(skills, 'simplify')?.bundled, undefined);
  } finally {
    await session.close();
  }
});

test("a skill reload that finishes after an empty turn init leaves that init's set", async () => {
  const events: AgentEvent[] = [];
  const f = await launcher('reload-skills', 'reload-linger');
  const session = await f.connect({ onEvent: (event) => events.push(event) });

  try {
    // an answered reload whose input then closed has settled its read, so its answer predates the init
    await until('the answered reload', () =>
      ['reload-answered', 'reload-closing'].every((marker) =>
        existsSync(join(f.sideChildren[0]?.cwd ?? '', marker)),
      ),
    );

    const reload = f.sideChildren[0]!;

    // listening before the turn, since the SDK kills the lingering process a few seconds after the init's abort
    const reloadClosed = new Promise((resolve) =>
      reload.child.once('close', resolve),
    );

    assert.equal((await session.send('hello')).status, 'completed');
    await writeFile(join(reload.cwd, 'release-reload'), '');
    await reloadClosed;
    // a second turn leaves the settled reload time to publish a set it must not
    assert.equal((await session.send('again')).status, 'completed');
    assert.ok(!listed(events).some((list) => named(list, 'simplify')?.bundled));
  } finally {
    await session.close();
  }
});

test("a refused skill reload leaves the first turn's init to name the bundled skills", async () => {
  const events: AgentEvent[] = [];
  const f = await launcher('reload-refused', 'reload-refused');
  const session = await f.connect({ onEvent: (event) => events.push(event) });

  try {
    // the side process ends once its refusal has been answered
    await until(
      'the refused reload',
      () => !!f.sideChildren[0] && !running(f.sideChildren[0].child),
    );

    assert.ok(!listed(events).some((list) => list.some((s) => s.bundled)));
    assert.equal((await session.send('hello')).status, 'completed');

    await until('the init catalog', () =>
      listed(events).some((list) => named(list, 'autocompact')?.bundled),
    );
  } finally {
    await session.close();
  }
});

test('closing a session stops a skill reload Claude Code has not answered', async () => {
  const f = await launcher('', 'reload-late');
  const session = await f.connect();

  try {
    await until('the held reload', () => held(f.sideChildren));
  } finally {
    await session.close();
  }

  assert.ok(!running(f.sideChildren[0]!.child));
});

test('a skill reload Claude Code leaves unanswered stops at its deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = await launcher('', 'reload-late');
  const session = await f.connect();

  try {
    await until('the held reload', () => held(f.sideChildren));
    const reload = f.sideChildren[0]!.child;
    // the SDK ends the reload's input as soon as it aborts
    vi.advanceTimersByTime(59_999);
    assert.equal(reload.stdin.writableEnded, false);
    vi.advanceTimersByTime(1);
    assert.equal(reload.stdin.writableEnded, true);

    await until('the reload deadline', () => {
      vi.advanceTimersByTime(100);

      return !running(reload);
    });

    assert.equal(session.closed, false);
  } finally {
    vi.useRealTimers();
    await session.close();
  }
});

test('a skill reload Claude Code has not answered stops when Claude Code exits cleanly', async () => {
  const closed = Promise.withResolvers<void>();
  const f = await launcher('', 'reload-late');

  const session = await f.connect({
    onEvent: (event) => {
      if (event.type === 'closed') closed.resolve();
    },
  });

  try {
    await until('the held reload', () => held(f.sideChildren));
    // ending its input exits Claude Code with status 0 before any turn's init can stop the reload
    f.children[0]!.stdin.end();
    await within(closed.promise, 5000, 'session exit');
    await until('the clean exit', () => f.children[0]!.exitCode === 0);
    await until('reload stop', () => !running(f.sideChildren[0]!.child));
  } finally {
    await session.close();
  }
});
