import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
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

test("a built-in the session's skill reload lists is marked bundled before the first turn", async () => {
  const events: AgentEvent[] = [];

  const { session } = await fixture(
    (event) => events.push(event),
    'reload-skills',
  );

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

test("a skill reload answered after a turn's init leaves the init's set", async () => {
  const events: AgentEvent[] = [];

  const { session } = await fixture(
    (event) => events.push(event),
    'reload-late',
  );

  try {
    assert.equal((await session.send('hello')).status, 'completed');

    await until('the marker catalog', () =>
      listed(events).some((skills) => named(skills, 'marker')),
    );

    const skills = listed(events).find((list) => named(list, 'marker'))!;
    assert.equal(named(skills, 'autocompact')?.bundled, true);
    assert.ok(named(skills, 'simplify'));
    assert.equal(named(skills, 'simplify')?.bundled, undefined);
  } finally {
    await session.close();
  }
});

test("a refused skill reload leaves the first turn's init to name the bundled skills", async () => {
  const events: AgentEvent[] = [];

  const { session, cwd } = await fixture(
    (event) => events.push(event),
    'reload-refused',
  );

  try {
    await until('the refused reload', () =>
      existsSync(join(cwd, 'reload-refused.json')),
    );

    assert.equal((await session.send('hello')).status, 'completed');

    await until('the init catalog', () =>
      listed(events).some((list) => named(list, 'autocompact')?.bundled),
    );
  } finally {
    await session.close();
  }
});
