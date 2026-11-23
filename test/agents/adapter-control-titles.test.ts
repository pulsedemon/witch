import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentEvent } from '../../src/agents/types.js';
import { quote } from '../../src/shell.js';
import { frameWriter, launcher } from '../fixtures/claude-adapter.js';
import { controlledFixture } from '../fixtures/codex-adapter.js';
import { until } from '../fixtures/within.js';
import { project } from '../fixtures/agent.js';

const prefixes = {
  control:
    "'/node' '/witch' '--control-dir' '/control' '--control-conversation' 'owner' '--control-activation' 'active'",
  familiar:
    "'/node' '/witch' '--control-dir' '/control/familiars' '--control-conversation' 'owner' '--control-activation' 'active'",
};

const claim = `${prefixes.control} --claim task:adapter-check --summary 'original summary'`;
const foreign = claim.replace("'active'", "'another-activation'");

test('Codex command lifecycle events preserve bound titles, original commands and output', async () => {
  const f = await controlledFixture('brews', prefixes);
  const familiar = `env TMPDIR='/task/tmp' ${prefixes.familiar} --familiar-claude review --report-file /report -- --model opus <<'PROMPT'\nReview this.\nPROMPT`;

  try {
    const calls = [
      {
        id: 'control',
        command: `/bin/zsh -lc ${quote(claim)}`,
        title: 'claim task:adapter-check',
      },
      {
        id: 'familiar',
        command: `/bin/zsh -lc ${quote(familiar)}`,
        title: 'Familiar Claude review',
      },
      { id: 'foreign', command: foreign, title: undefined },
      { id: 'ordinary', command: 'git status', title: undefined },
    ];

    for (const call of calls) {
      const params = { threadId: 'native-thread', turnId: 'command-turn' };

      const item = {
        id: call.id,
        type: 'commandExecution',
        command: call.command,
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
          method: 'item/commandExecution/outputDelta',
          params: { ...params, itemId: call.id, delta: 'partial' },
        },
        {
          method: 'item/completed',
          params: {
            ...params,
            item: {
              ...item,
              status: 'completed',
              aggregatedOutput: `finished ${call.id}`,
              exitCode: 0,
              durationMs: 1,
            },
          },
        },
      );

      const row = project(f.events).find((row) => row.id === call.id);

      // the start and the finish both say a shell command ran, bound to Witch or not
      assert.deepEqual(
        f.events.flatMap((event) =>
          event.type === 'tool' && event.id === call.id && !event.append
            ? [[event.done, event.command]]
            : [],
        ),
        [
          [false, true],
          [true, true],
        ],
      );

      assert.equal(row?.title, call.title ?? call.command);
      assert.equal(row?.expandedTitle, call.title ? call.command : undefined);
      assert.equal(row?.singleLine, call.title ? true : undefined);
      assert.equal(row?.text, `finished ${call.id}`);
      assert.equal(row?.done, true);
    }
  } finally {
    await f.session.close();
  }
});

test('Claude Bash results retain bound titles and multiline commands after replacing input', async () => {
  const events: AgentEvent[] = [];
  const f = await launcher('background');

  const session = await f.connect({
    commandPrefixes: prefixes,
    onEvent: (event) => events.push(event),
  });

  const emit = frameWriter(
    f.cwd,
    (name) =>
      events.some(
        (event) => event.type === 'skills' && event.skills[0]?.name === name,
      ),
    f.children[0]!,
  );

  const familiar = `${prefixes.familiar} --familiar-codex review --report-file /report -- -c model='gpt-6-astra' <<'PROMPT'\nReview this.\nPROMPT`;
  const isolated = `${prefixes.familiar} --familiar-codex review --report-file /report --lean -- -c model='gpt-6-astra'`;

  try {
    const turn = session.send('initial');

    await until('initial Claude result', () =>
      events.some(
        (event) =>
          event.type === 'skills' && event.skills[0]?.name === 'result-1',
      ),
    );

    const calls = [
      { id: 'control', command: claim, title: 'claim task:adapter-check' },
      { id: 'familiar', command: familiar, title: 'Familiar Codex review' },
      { id: 'isolated', command: isolated, title: 'Familiar Codex review' },
      { id: 'foreign', command: foreign, title: undefined },
      { id: 'ordinary', command: 'git status', title: undefined },
    ];

    for (const call of calls) {
      await emit(
        {
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            id: `message-${call.id}`,
            type: 'message',
            role: 'assistant',
            model: 'claude-a',
            content: [
              {
                type: 'tool_use',
                id: call.id,
                name: 'Bash',
                input: { command: call.command },
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
                tool_use_id: call.id,
                content: `finished ${call.id}`,
              },
            ],
          },
        },
      );

      const row = project(events).find((row) => row.id === call.id);

      // Claude's result names no tool, so only the start says a shell command ran
      assert.deepEqual(
        events.flatMap((event) =>
          event.type === 'tool' && event.id === call.id
            ? [[event.done, event.command]]
            : [],
        ),
        [
          [false, true],
          [true, undefined],
        ],
      );

      assert.equal(row?.title, call.title ?? `Bash  $ ${call.command}`);

      assert.equal(
        row?.expandedTitle,
        call.title ? `Bash  $ ${call.command}` : undefined,
      );

      assert.equal(row?.singleLine, call.title ? true : undefined);
      assert.equal(row?.text, `finished ${call.id}`);
      assert.equal(row?.done, true);
    }

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
