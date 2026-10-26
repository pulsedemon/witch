import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ClaudeTask } from '../src/agents/claude-task.js';
import type { FamiliarProgress } from '../src/agents/familiar-report.js';

const init = {
  type: 'system',
  subtype: 'init',
  session_id: 'review',
  model: 'native-model',
};
const success = {
  type: 'result',
  subtype: 'success',
  session_id: 'review',
  is_error: false,
  result: 'Reviewed.',
  permission_denials: [],
};
const read = {
  type: 'assistant',
  session_id: 'review',
  parent_tool_use_id: null,
  message: {
    content: [
      {
        type: 'tool_use',
        id: 'read-1',
        name: 'Read',
        input: { file_path: '/work/plan.md' },
      },
    ],
  },
};

test('observed init and unique top-level tool uses supply identity and activity until process exit', () => {
  const events: FamiliarProgress[] = [];
  const review = new ClaudeTask('/work', (progress) => events.push(progress));
  review.message(init);
  review.message(read);
  review.message(read);
  review.message({ ...read, parent_tool_use_id: 'nested-parent' });
  review.message({ ...read, agent_id: 'nested-agent' });
  review.message({ ...init, session_id: 'foreign', model: 'wrong-model' });
  review.message({ ...init, model: 'refreshed-model' });
  review.message(success);
  assert.deepEqual(events, [
    { status: 'running', model: 'native-model', tools: 0, activity: undefined },
    {
      status: 'running',
      model: 'native-model',
      tools: 1,
      activity: 'Read  ./plan.md',
    },
    {
      status: 'running',
      model: 'refreshed-model',
      tools: 1,
      activity: 'Read  ./plan.md',
    },
  ]);
  assert.deepEqual(review.closed(0, null), {
    status: 'completed',
    model: 'refreshed-model',
    tools: 1,
    activity: 'Read  ./plan.md',
    report: 'Reviewed.',
  });
});

test('native permission denials remain in the final report even when the review itself succeeds', () => {
  const review = new ClaudeTask('/work', () => {});
  review.message(init);
  review.message({
    ...success,
    permission_denials: [
      {
        tool_name: 'Write',
        tool_use_id: 'denied-1',
        tool_input: { file_path: '/work/forbidden.txt' },
      },
    ],
  });
  assert.equal(
    review.closed(0, null).report,
    'Reviewed.\n\nPermission denied: Write  ./forbidden.txt',
  );
});

test('native session model switches and reversions change displayed identity while local fallback leaves it alone', () => {
  const events: FamiliarProgress[] = [];
  const review = new ClaudeTask('/work', (progress) => events.push(progress));
  review.message(init);
  const change = {
    type: 'system',
    subtype: 'model_refusal_fallback',
    session_id: 'review',
    direction: 'retry',
    scope: 'session',
    original_model: 'native-model',
    fallback_model: 'actual-fallback',
  };
  review.message({ ...change, scope: 'local' });
  review.message(change);
  review.message({ ...change, direction: 'sticky' });
  review.message({ ...change, direction: 'revert' });
  assert.deepEqual(
    events.map((progress) => progress.model),
    ['native-model', 'actual-fallback', 'native-model'],
  );
});

for (const [name, frames, code, signal, status, report] of [
  [
    'missing result',
    [init],
    0,
    null,
    'failed',
    'Claude exited without a final result.',
  ],
  [
    'nonzero exit',
    [init, success],
    2,
    null,
    'failed',
    'Reviewed.\n\nClaude exited with code 2.',
  ],
  [
    'signal after result',
    [init, success],
    null,
    'SIGTERM',
    'stopped',
    'Reviewed.\n\nClaude task stopped (SIGTERM).',
  ],
  [
    'error flag on success',
    [init, { ...success, is_error: true }],
    0,
    null,
    'failed',
    'Reviewed.\n\nClaude task failed.',
  ],
  [
    'native error result',
    [
      init,
      {
        ...success,
        subtype: 'error_during_execution',
        is_error: true,
        result: undefined,
        errors: ['Permission policy blocked required work.'],
      },
    ],
    0,
    null,
    'failed',
    'Permission policy blocked required work.\n\nClaude task failed.',
  ],
  [
    'missing init',
    [success],
    0,
    null,
    'failed',
    'Reviewed.\n\nClaude did not report its native model.',
  ],
] as const)
  test(`${name} cannot become successful completion`, () => {
    const review = new ClaudeTask('/work', () => {});
    for (const frame of frames) review.message(frame);
    assert.deepEqual(review.closed(code, signal), {
      status,
      model: frames[0] === init ? 'native-model' : undefined,
      tools: 0,
      activity: undefined,
      report,
    });
  });

test('malformed required protocol fails even if a later result claims success', () => {
  const review = new ClaudeTask('/work', () => {});
  review.message({ ...init, model: null });
  review.message(init);
  review.message(success);
  const result = review.closed(0, null);
  assert.equal(result.status, 'failed');
  assert.match(result.report!, /^Reviewed\.\n\nInvalid Claude task stream:/);
});
