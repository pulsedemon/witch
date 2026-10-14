import { setTimeout } from 'node:timers';
import process from 'node:process';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// modes that a prompt can't reach come from the command line
const mode = process.argv[2] ?? '';
let model = 'model-a';
let effort = 'low';
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
const file = (name) => join(process.cwd(), name);
const session = () => ({
  thread: { id: 'native-thread' },
  model,
  cwd: process.cwd(),
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  reasoningEffort: effort,
});
const finish = (status, error = null) =>
  notify('turn/completed', {
    threadId: 'native-thread',
    turn: { id: 'turn-1', status, error },
  });
// a held event waits for the test's release file after its reply is out
const held = async () => {
  writeFileSync(file('replied'), 'yes');
  while (!existsSync(file('release'))) await delay(5);
};
let skillAdded = false;
let usageMicros = 0;
const window = (usedPercent, windowDurationMins, resetsAt) => ({
  usedPercent,
  windowDurationMins,
  resetsAt,
});
const skill = (name, fields) => ({
  name,
  path: `/skills/${name}/SKILL.md`,
  enabled: true,
  ...fields,
});
for await (const line of lines) {
  const request = JSON.parse(line);
  const reply = (result) => send({ id: request.id, result });
  if (request.method === 'initialize') {
    if (mode === 'hang-on-init') {
      // bounded, so an ignored abort fails the test instead of hanging it
      setTimeout(() => process.exit(1), 5000);
      continue;
    }
    if (mode === 'exit-on-init')
      process.stderr.write('init exit text\n', () => process.exit(1));
    else reply({ userAgent: 'fixture' });
  }
  if (request.method === 'config/read')
    reply({
      config: {
        sandbox_workspace_write: { writable_roots: ['/already-allowed'] },
      },
    });
  if (request.method === 'model/list') {
    const second = request.params.cursor === 'page-2';
    reply({
      data: [
        {
          id: second ? 'model-b' : 'model-a',
          model: second ? 'model-b' : 'model-a',
          displayName: second ? 'B' : 'A',
          description: 'fixture',
          supportedReasoningEfforts: [
            { reasoningEffort: second ? 'high' : 'low' },
          ],
        },
      ],
      nextCursor: second ? null : 'page-2',
    });
  }
  if (request.method === 'skills/list') {
    writeFileSync(file('skills.json'), JSON.stringify(request));
    reply({
      data: [
        {
          cwd: process.cwd(),
          errors: [],
          skills: [
            skill('review', {
              description: 'review description',
              shortDescription: 'review short',
              interface: { shortDescription: 'review interface' },
            }),
            skill('off', { description: 'disabled', enabled: false }),
            skill('legacy', {
              description: 'legacy description',
              shortDescription: 'legacy short',
            }),
            { ...skill('review', { description: 'duplicate' }), path: '/x' },
            skill('bare', { description: 'bare description' }),
            ...(skillAdded
              ? [skill('later', { description: 'added later' })]
              : []),
          ],
        },
      ],
    });
  }
  if (request.method === 'account/rateLimits/read' && mode === 'no-limits')
    send({
      id: request.id,
      error: { message: 'rate limits need a ChatGPT login' },
    });
  else if (request.method === 'account/rateLimits/read')
    reply({
      rateLimits: {
        limitId: 'codex',
        primary: window(12, 300, 2000000000),
        secondary: window(40, 10080, 2000500000),
      },
    });
  if (request.method === 'account/usage/read')
    reply({
      summary: {},
      threadUsage: {
        threadId: request.params.threadId,
        estimatedUsageUsdMicros: usageMicros,
      },
    });
  if (request.method === 'thread/resume')
    send({
      id: request.id,
      error: {
        message: `no rollout found for thread id ${request.params.threadId}`,
      },
    });
  if (request.method === 'thread/start') {
    writeFileSync(file('start.json'), JSON.stringify(request));
    model = request.params.model ?? model;
    reply(session());
  }
  if (request.method === 'thread/settings/update') {
    if (request.params.model === 'exit') process.exit(1);
    const previous = `${model}/${effort}`;
    model = request.params.model;
    // the server can't clear effort, so an omitted one stays in force
    effort = request.params.effort ?? effort;
    reply({});
    if (model === 'held') await held();
    // as Codex does, only a change is notified
    if (`${model}/${effort}` !== previous)
      notify('thread/settings/updated', {
        threadId: 'native-thread',
        threadSettings:
          model === 'bad-settings' ? { model: 5 } : { model, effort },
      });
  }
  if (request.method === 'thread/read') {
    const threads = {
      'child-thread': ['native-thread', 'Euclid', 'explorer'],
      'grandchild-thread': ['child-thread', 'Hypatia', null],
    };
    const thread = threads[request.params.threadId];
    if (thread) {
      const [parentThreadId, agentNickname, agentRole] = thread;
      reply({
        thread: { parentThreadId, agentNickname, agentRole, preview: '' },
      });
    } else
      send({ id: request.id, error: { code: -32600, message: 'no thread' } });
  }
  if (request.method === 'turn/start') {
    const prompt = request.params.input[0].text;
    writeFileSync(file('prompt.json'), JSON.stringify(request));
    reply({ turn: { id: 'turn-1' } });
    if (prompt === 'hold') continue;
    if (prompt === 'exit when idle') {
      finish('completed');
      process.stdout.write('', () => process.exit(1));
      continue;
    }
    if (prompt === 'add skill') {
      skillAdded = true;
      notify('skills/changed', {});
      finish('completed');
      continue;
    }
    if (prompt === 'usage') {
      const tokens = (threadId, totalTokens) =>
        notify('thread/tokenUsage/updated', {
          threadId,
          turnId: 'turn-1',
          tokenUsage: {
            total: { totalTokens: 900000 },
            last: { totalTokens },
            modelContextWindow: 256000,
          },
        });
      tokens('native-thread', 64000);
      tokens('subagent-thread', 200000);
      const diff = (body, turnId = 'turn-1', threadId = 'native-thread') =>
        notify('turn/diff/updated', {
          threadId,
          turnId,
          diff: `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n${body}`,
        });
      diff('+one\n');
      // the turn's diff grows, and a content line can start like a header
      diff(' kept\n-old\n+one\n+++ added\n');
      // a later turn adds to the total, its second file's headers do not, and another thread's turn does not
      diff(
        '+two\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n',
        'turn-2',
      );
      diff('+three\n+four\n-five\n', 'subagent-turn', 'subagent-thread');
      const limits = (limitId, primary) =>
        notify('account/rateLimits/updated', {
          rateLimits: { limitId, primary, secondary: null },
        });
      limits('codex', window(15, 300, 2000000100));
      limits('other', window(99, 300, 2000000100));
      usageMicros = 1500000;
      finish('completed');
      continue;
    }
    if (prompt === 'familiar-work') {
      const item = (method, threadId, fields) =>
        notify(method, {
          threadId,
          turnId: `${threadId}-turn`,
          item: fields,
        });
      notify('turn/started', {
        threadId: 'worker-thread',
        turn: { id: 'worker-thread-turn', status: 'inProgress' },
      });
      const command = {
        type: 'commandExecution',
        id: 'w-1',
        command: 'pnpm test',
        cwd: process.cwd(),
      };
      item('item/started', 'worker-thread', command);
      item('item/completed', 'worker-thread', command);
      item('item/started', 'worker-thread', {
        type: 'imageView',
        id: 'w-2',
        path: join(process.cwd(), 'a.png'),
      });
      const message = { type: 'agentMessage', id: 'w-3', text: '' };
      item('item/started', 'worker-thread', message);
      item('item/completed', 'worker-thread', { ...message, text: 'Done.' });
      // a thread that never started a turn here is no familiar
      item('item/started', 'ghost-thread', { ...command, id: 'g-1' });
      notify('turn/completed', {
        threadId: 'worker-thread',
        turn: { id: 'worker-thread-turn', status: 'completed' },
      });
      // the finished thread is sent more input
      notify('turn/started', {
        threadId: 'worker-thread',
        turn: { id: 'worker-thread-turn-2', status: 'inProgress' },
      });
      finish('completed');
      continue;
    }
    if (prompt === 'familiars') {
      const turn = (method, threadId, status) =>
        notify(method, { threadId, turn: { id: `${threadId}-turn`, status } });
      send({
        id: 95,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'child-thread',
          turnId: 'child-thread-turn',
          itemId: 'child-tool',
          command: 'ls',
          cwd: process.cwd(),
        },
      });
      notify('serverRequest/resolved', {
        threadId: 'child-thread',
        requestId: 95,
      });
      turn('turn/started', 'child-thread', 'inProgress');
      notify('item/agentMessage/delta', {
        threadId: 'child-thread',
        turnId: 'child-thread-turn',
        itemId: 'child-message',
        delta: 'Child text.',
      });
      notify('model/rerouted', {
        threadId: 'child-thread',
        turnId: 'child-thread-turn',
        fromModel: model,
        toModel: 'model-child',
        reason: 'highRiskCyberActivity',
      });
      turn('turn/started', 'grandchild-thread', 'inProgress');
      turn('turn/completed', 'grandchild-thread', 'interrupted');
      turn('turn/started', 'failed-thread', 'inProgress');
      turn('turn/completed', 'failed-thread', 'failed');
      turn('turn/started', 'done-thread', 'inProgress');
      turn('turn/completed', 'done-thread', 'completed');
      turn('turn/completed', 'child-thread', 'completed');
      // the finished child is sent more input
      turn('turn/started', 'child-thread', 'inProgress');
      notify('turn/completed', { threadId: 'stray-thread', turn: null });
      notify('item/agentMessage/delta', {
        threadId: 'native-thread',
        itemId: 'message-1',
        delta: 'Parent text.',
      });
      finish('completed');
      continue;
    }
    if (prompt === 'malformed') {
      for (let count = 0; count < 2; count++)
        notify('item/agentMessage/delta', { itemId: 7, delta: 'bad' });
      finish('completed');
      continue;
    }
    if (prompt === 'null-turn') {
      notify('turn/completed', { threadId: 'native-thread', turn: null });
      continue;
    }
    if (prompt === 'in-progress') {
      finish('inProgress');
      continue;
    }
    if (prompt === 'failed') {
      finish('failed', { message: 'native failure' });
      continue;
    }
    if (prompt === 'reroute') {
      notify('model/rerouted', {
        threadId: 'native-thread',
        turnId: 'turn-1',
        fromModel: model,
        toModel: 'model-c',
        reason: 'highRiskCyberActivity',
      });
      finish('completed');
      continue;
    }
    if (prompt === 'error') {
      const error = (message) => ({
        message,
        codexErrorInfo: null,
        additionalDetails: null,
      });
      for (const [willRetry, message] of [
        [true, 'retrying'],
        [false, 'native error'],
      ])
        notify('error', {
          threadId: 'native-thread',
          turnId: 'turn-1',
          willRetry,
          error: error(message),
        });
      finish('failed', error('native error'));
      continue;
    }
    if (prompt === 'tool') {
      const item = {
        type: 'commandExecution',
        id: 'cmd-1',
        command: 'ls',
        cwd: '/elsewhere',
      };
      notify('item/started', {
        item: { type: 'userMessage', id: 'user-1', content: [] },
      });
      notify('item/completed', {
        item: {
          type: 'reasoning',
          id: 'reasoning-1',
          summary: [],
          content: [],
        },
      });
      notify('item/started', { item: { ...item, aggregatedOutput: null } });
      notify('item/commandExecution/outputDelta', {
        itemId: 'cmd-1',
        delta: 'a.md\n',
      });
      notify('item/completed', {
        item: { ...item, aggregatedOutput: 'a.md\n' },
      });
      finish('completed');
      continue;
    }
    if (prompt === 'tool-items') {
      for (const item of [
        {
          type: 'fileChange',
          id: 'patch-1',
          changes: [
            { path: 'a.md', kind: { type: 'update' }, diff: '' },
            { path: 'b.md', kind: { type: 'add' }, diff: '' },
          ],
          status: 'completed',
        },
        {
          type: 'mcpToolCall',
          id: 'mcp-1',
          server: 'browser',
          tool: 'screenshot',
          arguments: { url: 'https://example.com' },
          result: {
            content: [
              { type: 'text', text: 'Captured.' },
              { type: 'image', data: 'iVBORw==', mimeType: 'image/png' },
            ],
          },
        },
        { type: 'imageView', id: 'view-1', path: '/shots/a.png' },
      ])
        notify('item/completed', { item });
      finish('completed');
      continue;
    }
    if (prompt === 'unknown-request') {
      send({ id: 92, method: 'item/unknown/request', params: {} });
      continue;
    }
    if (prompt === 'bad-request') {
      send({
        id: 90,
        method: 'item/tool/requestUserInput',
        params: { questions: 'not a list' },
      });
      continue;
    }
    if (prompt === 'grandchild') {
      const grandchild = spawn('/bin/sleep', ['3'], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      writeFileSync(file('grandchild.pid'), String(grandchild.pid));
      process.exit(1);
    }
    if (prompt === 'question') {
      send({
        id: 88,
        method: 'item/tool/requestUserInput',
        params: {
          questions: [
            {
              id: 'value',
              header: 'Value',
              question: 'Private value?',
              isOther: false,
              isSecret: true,
              options: null,
            },
          ],
        },
      });
      continue;
    }
    if (prompt === 'withdrawn') {
      send({
        id: 93,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'native-thread',
          turnId: 'turn-1',
          itemId: 'tool-1',
          command: 'write withdrawn.txt',
          cwd: process.cwd(),
        },
      });
      notify('serverRequest/resolved', {
        threadId: 'native-thread',
        requestId: 93,
      });
      await held();
      finish('completed');
      continue;
    }
    if (prompt === 'permissions') {
      send({
        id: 91,
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'native-thread',
          turnId: 'turn-1',
          itemId: 'tool-1',
          permissions: { network: { enabled: true }, fileSystem: null },
        },
      });
      continue;
    }
    if (prompt === 'file change') {
      send({
        id: 94,
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'native-thread',
          turnId: 'turn-1',
          itemId: 'patch-1',
          reason: 'write a.md',
        },
      });
      continue;
    }
    if (prompt === 'elicitation') {
      send({
        id: 89,
        method: 'mcpServer/elicitation/request',
        params: {
          message: 'Provide a label',
          requestedSchema: {
            type: 'object',
            properties: { label: { type: 'string' } },
          },
        },
      });
      continue;
    }
    send({
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'native-thread',
        turnId: 'turn-1',
        itemId: 'tool-1',
        command: 'write approved.txt',
        cwd: process.cwd(),
      },
    });
  }
  if (request.id === 77 && request.result) {
    if (request.result.decision === 'accept')
      writeFileSync(file('approved.txt'), 'approved');
    notify('item/agentMessage/delta', {
      itemId: 'message-1',
      delta: 'Finished.',
    });
    notify('item/completed', {
      item: { type: 'agentMessage', id: 'message-1', text: 'Finished.' },
    });
    finish('completed');
  }
  if ([88, 89, 91, 94].includes(request.id) && request.result) {
    writeFileSync(
      file(`response-${request.id}.json`),
      JSON.stringify(request.result),
    );
    finish('completed');
  }
  if ([90, 92].includes(request.id) && request.error) {
    writeFileSync(
      file(`error-${request.id}.json`),
      JSON.stringify(request.error),
    );
    finish('completed');
  }
  if (request.method === 'turn/interrupt') {
    reply({});
    await held();
    finish('interrupted');
  }
}
