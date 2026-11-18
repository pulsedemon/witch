import assert from 'node:assert/strict';
import { test } from 'vitest';
import { phaseSchema } from '../../../src/core/state.js';
import type { DisplayItem } from '../../../src/core/state.js';
import { agentActivity } from '../../../src/ui/status/agent-activity.js';

const at = (milliseconds: number) => new Date(milliseconds).toISOString();

const said = (id: string, when: number, text: string): DisplayItem => ({
  id,
  kind: 'assistant',
  text,
  cwd: '/work',
  at: at(when),
});

const call = (
  id: string,
  when: number,
  title: string,
  done: boolean,
): DisplayItem => ({
  id,
  kind: 'tool',
  title,
  text: '',
  cwd: '/work',
  done,
  at: at(when),
});

const running = { phase: 'running', activityStartedAt: 100_000 } as const;

test('agent activity reads back to the first agent row from before the operation', () => {
  assert.deepEqual(
    agentActivity({
      ...running,
      items: [
        call('old/a/left', 150_000, 'left running', false),
        said('old/a/answer', 90_000, 'the earlier answer'),
        said('turn/a/first', 110_000, 'first\nmessage'),
        call('turn/a/done', 120_000, 'git status', true),
        said('turn/a/second', 130_000, ' second\n\nmessage '),
        call('turn/a/older', 135_000, 'pnpm test', false),
        call('turn/a/newer', 140_000, 'pnpm lint', false),
      ],
    }),
    {
      quietSince: 140_000,
      doing: 'RUNNING pnpm lint',
      message: { text: 'second message', at: 130_000 },
    },
  );
});

test('agent activity counts quiet time from the operation’s start until the agent shows something', () => {
  assert.deepEqual(
    agentActivity({
      ...running,
      items: [
        call('old/a/left', 150_000, 'left running', false),
        said('old/a/answer', 99_999, 'the earlier answer'),
      ],
    }),
    { quietSince: 100_000, doing: undefined, message: undefined },
  );
});

test('agent activity skips rows that are not the agent’s own without stopping at them', () => {
  const shell: DisplayItem = {
    ...call('turn/a/shell', 170_000, 'ls', false),
    shell: true,
  };

  assert.deepEqual(
    agentActivity({
      ...running,
      items: [
        said('turn/a/said', 120_000, 'merging main'),
        // a familiar's row, a notice with no time, the user's steer, their `!` command and a spell cast
        call('3f2a', 150_000, 'Familiar started review', false),
        { id: 'n1', kind: 'notice', text: 'Watching', cwd: '/work' },
        {
          id: 'u1',
          kind: 'user',
          text: 'status?',
          cwd: '/work',
          at: at(160_000),
        },
        shell,
        {
          id: 'spell/s1',
          kind: 'notice',
          cast: true,
          text: 'Cast `x`',
          cwd: '/work',
          at: at(180_000),
        },
      ],
    }),
    {
      quietSince: 120_000,
      doing: undefined,
      message: { text: 'merging main', at: 120_000 },
    },
  );
});

test("agent activity passes on reasoning only while it is newer than the agent's rows", () => {
  const items = [said('turn/a/said', 120_000, 'merging main')];

  const reasonedAt = (reasoned: number, rows: DisplayItem[]) =>
    agentActivity({ ...running, items: rows, reasonedAt: reasoned });

  assert.equal(reasonedAt(150_000, items)?.reasonedAt, 150_000);
  assert.ok(!('reasonedAt' in reasonedAt(120_000, items)!));
  assert.ok(!('reasonedAt' in reasonedAt(110_000, items)!));
  assert.ok(!('reasonedAt' in reasonedAt(99_000, [])!));
  assert.equal(reasonedAt(100_001, [])?.reasonedAt, 100_001);
});

test('agent activity covers the running phase and nothing else', () => {
  const state = { activityStartedAt: 100_000, items: [] };

  for (const phase of phaseSchema.options)
    assert.equal(
      agentActivity({ ...state, phase }) !== undefined,
      phase === 'running',
      phase,
    );
});
