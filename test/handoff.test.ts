import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentSession, TurnResult } from '../src/agents/types.js';
import { handoff, transcriptContext } from '../src/core/handoff.js';
import type { Memory } from '../src/memory/memory.js';
import { initialSnapshot } from '../src/core/snapshot.js';
import type { ConversationRecord, DisplayItem } from '../src/core/state.js';
import { record } from './fixtures/coordinator.js';

const items: DisplayItem[] = [
  { id: 'u1', kind: 'user', text: 'migrate the store', cwd: '/w' },
  { id: 'a1', kind: 'assistant', title: 'claude', text: 'started', cwd: '/w' },
  {
    id: 't1',
    kind: 'tool',
    title: 'Edit',
    path: 'src/store.ts',
    text: 'full output',
    done: true,
    cwd: '/w',
  },
];

/** a host whose source answers the summary request with `summary`, recording what happens in order. */
function stubHost(summary: TurnResult, activity = false) {
  const conversation: ConversationRecord = {
    ...record('c', '/w', 'claude'),
    lastTurn: { id: 'turn', status: 'failed' },
    ...(activity
      ? {
          activity: {
            id: 'handoff',
            agent: 'claude',
            kind: 'handoff',
            baseRevision: 'r',
            startedAt: new Date().toISOString(),
          },
        }
      : {}),
  };
  const events: string[] = [];
  const host = {
    conversation,
    snapshot: { ...initialSnapshot([]), items },
    memory: {} as Memory,
    cancelled: () => false,
    closed: () => false,
    session: () => undefined,
    send: (_prompt: string, kind: 'turn' | 'handoff') => {
      events.push(`send ${kind}`);
      return Promise.resolve(
        kind === 'handoff'
          ? summary
          : { status: 'completed' as const, text: '' },
      );
    },
    connect: () => Promise.resolve({} as AgentSession),
    select: () =>
      Promise.resolve({
        id: 'codex-session',
        model: 'gpt-6.1-astra',
        hasHistory: false,
      }),
    disconnect: () => Promise.resolve(),
    save: () => {
      events.push(`save ${conversation.handoff?.activated ?? 'none'}`);
      return Promise.resolve();
    },
    publish: () => {},
    activated: () => events.push('activated'),
  };
  return { host, conversation, events };
}

const selection = { agent: 'codex', id: 'gpt-6.1-astra' };

test('a failed summary activates with transcript context and announces activation before the continuation', async () => {
  const { host, conversation, events } = stubHost({
    status: 'failed',
    text: '',
    error: 'weekly limit',
  });
  await handoff(host, selection);
  assert.equal(conversation.agent, 'codex');
  assert.equal(conversation.handoff?.summary, transcriptContext(items, []));
  assert.deepEqual(events.slice(-4), [
    'save true',
    'activated',
    'send turn',
    'save true',
  ]);
});

test('without summarizing, the source is never asked', async () => {
  const { host, conversation, events } = stubHost({
    status: 'completed',
    text: 'unused',
  });
  await handoff(host, selection, { summarize: false });
  assert.ok(!events.includes('send handoff'));
  assert.equal(conversation.handoff?.summary, transcriptContext(items, []));
  assert.equal(conversation.agent, 'codex');
});

test('a summary that leaves memory pending, or is interrupted, keeps the source', async () => {
  for (const [result, activity] of [
    [{ status: 'failed', text: '', error: 'weekly limit' }, true],
    [{ status: 'interrupted', text: '' }, false],
  ] as const) {
    const { host, conversation, events } = stubHost(result, activity);
    await assert.rejects(handoff(host, selection));
    assert.equal(conversation.agent, 'claude');
    assert.equal(conversation.handoff, undefined);
    assert.ok(!events.includes('activated'));
  }
});

test('transcript context keeps the newest rows, tool titles and paths with their state, and skips an unread prompt', () => {
  const context = transcriptContext(
    [
      ...items,
      {
        id: 't2',
        kind: 'tool',
        title: 'Bash git push',
        text: 'partial',
        done: false,
        cwd: '/w',
      },
      { id: 'n1', kind: 'notice', text: 'a notice', cwd: '/w' },
      { id: 'u2', kind: 'user', text: 'also update docs', cwd: '/w' },
    ],
    ['also update docs'],
  );
  assert.equal(
    context,
    [
      'The previous runtime could not summarize, so Witch rebuilt this from the conversation transcript.',
      'User: migrate the store',
      'claude: started',
      'Tool: Edit src/store.ts',
      'Tool (unfinished): Bash git push',
    ].join('\n\n'),
  );

  const long = Array.from({ length: 40 }, (_, index): DisplayItem => ({
    id: `u${index}`,
    kind: 'user',
    text: `${index} ${'x'.repeat(2000)}`,
    cwd: '/w',
  }));
  const capped = transcriptContext(long, []);
  assert.ok(capped.length <= 60_000 + 200);
  assert.match(capped, /Earlier rows are omitted\./);
  assert.ok(capped.endsWith(long.at(-1)!.text));
  assert.ok(!capped.includes(`User: 0 x`));
});

test('an unread prompt skips only its own newest row, so an earlier identical request stays', () => {
  const context = transcriptContext(
    [
      { id: 'u1', kind: 'user', text: 'run the migration', cwd: '/w' },
      {
        id: 'a1',
        kind: 'assistant',
        title: 'claude',
        text: 'on it',
        cwd: '/w',
      },
      { id: 'u2', kind: 'user', text: 'run the migration', cwd: '/w' },
    ],
    ['run the migration'],
  );
  assert.equal(
    context,
    [
      'The previous runtime could not summarize, so Witch rebuilt this from the conversation transcript.',
      'User: run the migration',
      'claude: on it',
    ].join('\n\n'),
  );
});

test('a newest row over the limit keeps its start instead of leaving no context', () => {
  const paste = `migrate the store ${'x'.repeat(70_000)}`;
  const context = transcriptContext(
    [
      { id: 'u1', kind: 'user', text: 'earlier', cwd: '/w' },
      { id: 'u2', kind: 'user', text: paste, cwd: '/w' },
    ],
    [],
  );
  assert.match(
    context,
    /Earlier rows are omitted\.\n\nUser: migrate the store x/,
  );
  assert.ok(context.endsWith(' [truncated]'));
  assert.ok(!context.includes('User: earlier'));
});
