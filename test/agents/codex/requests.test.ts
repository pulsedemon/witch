import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseRequest } from '../../../src/agents/codex/requests.js';

const proposals = new Map();

test('a native question keeps its text as the title and its option labels as choices', () => {
  const request = parseRequest(
    {
      id: 7,
      method: 'item/tool/requestUserInput',
      params: {
        questions: [
          {
            id: 'target',
            header: 'Target',
            question: 'Which target?',
            isSecret: false,
            options: [
              { label: 'Preview', description: 'staging slot' },
              { label: 'Production', description: 'live slot' },
            ],
          },
        ],
      },
    },
    proposals,
  );

  assert.deepEqual(request?.questions, [
    {
      id: 'target',
      title: 'Which target?',
      secret: false,
      options: ['Preview', 'Production'],
    },
  ]);
});

test('an MCP elicitation keeps its sign-in url', () => {
  const request = parseRequest(
    {
      id: 8,
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'docs',
        threadId: 'thread-1',
        mode: 'url',
        elicitationId: 'sign-in',
        message: 'Sign in to the docs server',
        url: 'https://docs.example/oauth/start',
      },
    },
    proposals,
  );

  assert.equal(request?.url, 'https://docs.example/oauth/start');
});

test('a request title prefers reason, then message, then command, then the method', () => {
  const method = 'item/commandExecution/requestApproval';

  const cases = [
    [{ reason: 'why', message: 'what', command: 'rm -r out' }, 'why'],
    [{ message: 'what', command: 'rm -r out' }, 'what'],
    [{ command: 'rm -r out' }, 'rm -r out'],
    [{}, method],
  ] as const;

  for (const [params, title] of cases)
    assert.equal(
      parseRequest({ id: 9, method, params }, proposals)?.title,
      title,
    );
});
