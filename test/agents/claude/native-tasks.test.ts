import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import type { AgentEvent } from '../../../src/agents/types.js';
import { fixture, frameWriter } from '../../fixtures/claude-adapter.js';

test('native familiar model-only frames preserve task state', async () => {
  const events: AgentEvent[] = [];
  const f = await fixture((event) => events.push(event), 'background');

  const emit = frameWriter(
    f.cwd,
    (name) =>
      events.some(
        (event) =>
          event.type === 'skills' &&
          event.skills.some((skill) => skill.name === name),
      ),
    f.child,
  );

  const current = () =>
    events
      .flatMap((event) =>
        event.type === 'subagent' && event.subagent.id === 'reader'
          ? [event.subagent]
          : [],
      )
      .at(-1)!;

  let sequence = 0;

  const assistant = (model: string, content: object[], agent = 'reader') => ({
    type: 'assistant',
    parent_tool_use_id: 'spawn-tool',
    agent_id: agent,
    message: {
      id: `message-${++sequence}`,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

  const thinking = [
    { type: 'thinking', thinking: 'Inspecting', signature: 'signature' },
  ];

  try {
    await emit({
      type: 'system',
      subtype: 'init',
      model: 'parent-model',
      permissionMode: 'default',
    });

    await emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'reader',
      run_id: 'one',
      task_type: 'local_agent',
      description: 'Inspect source',
    });

    assert.equal(current().runtime, 'claude');
    assert.equal(current().model, undefined);
    await emit(assistant('child-observed', thinking));
    assert.equal(current().model, 'child-observed');

    await emit(
      assistant('child-observed', [
        {
          type: 'tool_use',
          id: 'read-1',
          name: 'Read',
          input: { file_path: join(f.cwd, 'source.ts') },
        },
      ]),
      assistant('child-observed', [{ type: 'text', text: 'Read complete.' }]),
      assistant('changed-model', thinking),
      assistant('<synthetic>', thinking),
      assistant('unlisted-model', thinking, 'unlisted'),
    );

    assert.equal(current().model, 'changed-model');
    assert.equal(current().tools, 1);
    assert.equal(current().activity, 'Read  ./source.ts');
    assert.equal(current().report, 'Read complete.');

    await emit(
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'reader',
        run_id: 'one',
        status: 'completed',
      },
      assistant('late-model', thinking),
    );

    assert.equal(current().model, 'late-model');
    assert.equal(current().status, 'completed');
    assert.equal(current().report, 'Read complete.');
    assert.equal(f.session.info.model, 'parent-model');

    await emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'reader',
      run_id: 'two',
      task_type: 'local_agent',
      description: 'Inspect source again',
    });

    assert.equal(current().model, undefined);
    await emit(assistant('resumed-model', thinking));
    assert.equal(current().model, 'resumed-model');
    assert.equal(current().tools, 0);
    assert.equal(current().report, undefined);
  } finally {
    await f.session.close();
  }
});

test("a Claude familiar's tool calls give its latest activity, with a path under the session's directory shown relative and a spell under Witch's name, and its count, its last message's text is its report, and an unlisted agent's frames are ignored", async () => {
  const events: AgentEvent[] = [];
  const { session, cwd } = await fixture((event) => events.push(event));

  try {
    // without it Claude Code sends a familiar's tool calls but not its text
    assert.equal(
      JSON.parse(await readFile(join(cwd, 'initialize.json'), 'utf8'))
        .forwardSubagentText,
      true,
    );

    assert.equal((await session.send('familiar-work')).status, 'completed');

    const reader = {
      id: 'reader',
      parent: undefined,
      name: 'Read tests',
      kind: '',
      runtime: 'claude',
      status: 'running',
      run: undefined,
    };

    const observed = { ...reader, model: 'claude-a' };

    assert.deepEqual(
      events.flatMap((event) =>
        event.type === 'subagent' ? [event.subagent] : [],
      ),
      [
        reader,
        {
          ...observed,
          activity: undefined,
          tools: 0,
          report: 'Reading the tests.',
        },
        {
          ...observed,
          activity: 'Read  ./a.test.ts',
          tools: 1,
          report: 'Reading the tests.',
        },
        {
          ...observed,
          activity: 'Bash  Run tests  $ pnpm test',
          tools: 2,
          report: 'Reading the tests.',
        },
        {
          ...observed,
          activity: 'Spell  tdd',
          spells: [{ id: 'r-3', name: 'tdd' }],
          tools: 3,
          report: 'Reading the tests.',
        },
        // a later message's text replaces the report
        {
          ...observed,
          activity: 'Spell  tdd',
          spells: [{ id: 'r-3', name: 'tdd' }],
          tools: 3,
          report: 'All tests pass.',
        },
        // the report's second block arrives as its own frame of the same message
        {
          ...observed,
          activity: 'Spell  tdd',
          spells: [{ id: 'r-3', name: 'tdd' }],
          tools: 3,
          report: 'All tests pass.\nSee a.test.ts.',
        },
        {
          ...observed,
          activity: 'Spell  tdd',
          spells: [{ id: 'r-3', name: 'tdd' }],
          tools: 3,
          report: 'All tests pass.\nSee a.test.ts.',
          status: 'completed',
        },
      ],
    );
  } finally {
    await session.close();
  }
});

test("Claude's subagent tasks report their parent, run and how they finished, its shell and ambient tasks are not subagents, and an earlier run's late start and notification are ignored", async () => {
  const events: AgentEvent[] = [];
  const { session } = await fixture((event) => events.push(event));

  try {
    assert.equal((await session.send('familiars')).status, 'completed');

    const resumed = {
      id: 'resumed',
      parent: undefined,
      name: 'Fix lint',
      kind: '',
      runtime: 'claude',
      status: 'running',
      run: '2',
    };

    assert.deepEqual(
      events.flatMap((event) =>
        event.type === 'subagent' ? [event.subagent] : [],
      ),
      [
        {
          id: 'outer',
          parent: undefined,
          name: 'Map the code',
          kind: 'Explore',
          runtime: 'claude',
          status: 'running',
          run: undefined,
        },
        {
          id: 'inner',
          parent: 'outer',
          name: 'Read tests',
          kind: '',
          runtime: 'claude',
          status: 'running',
          run: undefined,
        },
        // one per run
        { ...resumed, run: '1' },
        resumed,
        { ...resumed, status: 'completed' },
        {
          id: 'inner',
          parent: 'outer',
          name: 'Read tests',
          kind: '',
          runtime: 'claude',
          status: 'completed',
          run: undefined,
        },
        {
          id: 'outer',
          parent: undefined,
          name: 'Map the code',
          kind: 'Explore',
          runtime: 'claude',
          status: 'failed',
          run: undefined,
        },
      ],
    );
  } finally {
    await session.close();
  }
});

test("Claude's background shells are commands from when the live set lists them, whether started there or moved there, until their notification, and neither foreground shells nor agents are", async () => {
  const events: AgentEvent[] = [];
  const { session } = await fixture((event) => events.push(event));

  try {
    assert.equal((await session.send('brews')).status, 'completed');

    assert.deepEqual(
      events.flatMap((event) =>
        event.type === 'command' ? [event.command] : [],
      ),
      [
        { id: 'serve', description: 'Start the server', status: 'running' },
        { id: 'moved', description: 'Run tests', status: 'running' },
        { id: 'serve', description: 'Start the server', status: 'failed' },
        { id: 'moved', description: 'Run tests', status: 'stopped' },
      ],
    );

    const outer = {
      id: 'outer',
      parent: undefined,
      name: 'Map the code',
      kind: '',
      runtime: 'claude',
      run: undefined,
    };

    // the live set's agent entries don't start a familiar, and one it drops after its notification has already ended
    assert.deepEqual(
      events.flatMap((event) =>
        event.type === 'subagent' ? [event.subagent] : [],
      ),
      [
        { ...outer, status: 'running' },
        { ...outer, status: 'completed' },
      ],
    );
  } finally {
    await session.close();
  }
});
