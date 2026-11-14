import assert from 'node:assert/strict';

import { join } from 'node:path';

import { test } from 'vitest';

import { writeJson } from '../src/persistence/json.js';

import type { AgentEvent } from '../src/agents/types.js';

import { fixture, close } from './fixtures/codex-adapter.js';

import { within } from './fixtures/within.js';

test('native async question messages produce one shared request with choices and free-text questions', async () => {
  const events: AgentEvent[] = [];

  const { session, cwd } = await fixture((event) => events.push(event), {
    mode: 'file-approvals',
  });

  try {
    const sending = session.send('hold');

    await session.skills();

    const item = {
      type: 'agentMessage',
      id: 'choices',
      text: 'Which target?\n- Preview\n- Production',
      phase: 'final_answer',
      delivery: 'async',
      questions: [
        { title: 'Which target?', options: ['Preview', 'Production'] },
        { title: 'Any constraints?', options: null },
        { title: 'Who owns it?' },
      ],
    };

    const params = { threadId: 'native-thread', turnId: 'turn-1', item };

    const frames = [
      { method: 'item/started', params },
      { method: 'item/completed', params },
      {
        method: 'item/completed',
        params: {
          ...params,
          item: { ...item, id: 'empty', text: 'Continuing.', questions: [] },
        },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'native-thread',
          turn: { id: 'turn-1', status: 'completed', error: null },
        },
      },
    ];

    await writeJson(join(cwd, 'events-1.json'), frames);

    assert.equal(
      (await within(sending, 3000, 'the question turn')).status,
      'completed',
    );

    assert.deepEqual(
      events.filter((event) => event.type === 'request'),
      [
        {
          type: 'request',
          request: {
            id: 'question/choices',
            kind: 'question',
            title: 'Questions',
            detail: '',
            questions: [
              {
                id: '0',
                title: 'Which target?',
                options: ['Preview', 'Production'],
              },
              { id: '1', title: 'Any constraints?', options: [] },
              { id: '2', title: 'Who owns it?', options: [] },
            ],
            replyAsPrompt: true,
          },
        },
      ],
    );
  } finally {
    await close(session, cwd);
  }
});
