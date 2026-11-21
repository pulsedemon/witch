import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentEvent } from '../../src/agents/types.js';
import { frameWriter, launcher } from '../fixtures/claude-adapter.js';
import { controlledFixture } from '../fixtures/codex-adapter.js';
import { until } from '../fixtures/within.js';
import { project } from '../fixtures/agent.js';

test('a Codex command that exits non-zero, fails or is declined marks its row failed', async () => {
  const f = await controlledFixture('brews');

  try {
    const calls = [
      { id: 'nonzero', status: 'completed', exitCode: 1, failed: true },
      { id: 'failed', status: 'failed', exitCode: null, failed: true },
      { id: 'declined', status: 'declined', exitCode: null, failed: true },
      { id: 'ok', status: 'completed', exitCode: 0, failed: undefined },
    ];

    for (const call of calls) {
      const params = { threadId: 'native-thread', turnId: 'command-turn' };

      const item = {
        id: call.id,
        type: 'commandExecution',
        command: `run ${call.id}`,
        source: 'unifiedExecStartup',
        processId: null,
        cwd: '/work',
        commandActions: [],
        status: 'inProgress',
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      };

      await f.emit(
        { method: 'item/started', params: { ...params, item } },
        {
          method: 'item/completed',
          params: {
            ...params,
            item: {
              ...item,
              status: call.status,
              aggregatedOutput: '',
              exitCode: call.exitCode,
              durationMs: 1,
            },
          },
        },
      );

      const row = project(f.events).find((row) => row.id === call.id);
      assert.equal(row?.done, true, call.id);
      assert.equal(row?.failed, call.failed, call.id);
    }
  } finally {
    await f.session.close();
  }
});

test('a Claude tool result with is_error marks its row failed', async () => {
  const events: AgentEvent[] = [];
  const f = await launcher('background');
  const session = await f.connect({ onEvent: (event) => events.push(event) });

  const emit = frameWriter(
    f.cwd,
    (name) =>
      events.some(
        (event) => event.type === 'skills' && event.skills[0]?.name === name,
      ),
    f.children[0]!,
  );

  try {
    const turn = session.send('initial');

    await until('initial Claude result', () =>
      events.some(
        (event) =>
          event.type === 'skills' && event.skills[0]?.name === 'result-1',
      ),
    );

    for (const [id, isError] of [
      ['broken', true],
      ['fine', false],
    ] as const) {
      await emit(
        {
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            id: `message-${id}`,
            type: 'message',
            role: 'assistant',
            model: 'claude-a',
            content: [
              {
                type: 'tool_use',
                id,
                name: 'Bash',
                input: { command: `run ${id}` },
              },
            ],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        },
        {
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: id,
                content: `finished ${id}`,
                ...(isError ? { is_error: true } : {}),
              },
            ],
          },
        },
      );
    }

    const rows = project(events);
    assert.equal(rows.find((row) => row.id === 'broken')?.failed, true);
    assert.equal(rows.find((row) => row.id === 'fine')?.failed, undefined);

    await emit({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
    });

    assert.equal((await turn).status, 'completed');
  } finally {
    await session.close();
  }
});
