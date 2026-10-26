import { setTimeout } from 'node:timers';
import process from 'node:process';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const familiar = process.env.WITCH_CODEX_FAMILIAR_FIXTURE;
if (familiar) {
  writeFileSync(
    'launched.json',
    JSON.stringify({
      pid: process.pid,
      argv: process.argv.slice(2),
      mark: process.env.WITCH_JOBS,
    }),
  );
  process.on('SIGTERM', () =>
    process.exit(familiar === 'nonzero-close' ? 2 : 0),
  );
}
// modes that a prompt can't reach come from the command line
const mode = familiar ? '' : (process.argv[2] ?? '');
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
let lastPrompt = '';
/** a `!` command of `hold` runs until an interrupt or the test's release. */
let shellHeld = false;
const shellItem = (method, command, fields) =>
  notify(method, {
    threadId: 'native-thread',
    turnId: 'turn-shell',
    item: {
      type: 'commandExecution',
      id: 'shell-1',
      command: `/bin/zsh -lc '${command}'`,
      source: 'userShell',
      cwd: process.cwd(),
      ...fields,
    },
  });
const finishShell = (status) =>
  notify('turn/completed', {
    threadId: 'native-thread',
    turn: { id: 'turn-shell', status, error: null },
  });
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
let brewTurn = 0;
let terminalReads = 0;
let questionTurn = 0;
const finishQuestion = () => {
  notify('item/completed', {
    threadId: 'native-thread',
    turnId: `turn-${questionTurn}`,
    item: {
      type: 'agentMessage',
      id: `answer-${questionTurn}`,
      text: 'Implemented preview.',
    },
  });
  notify('turn/completed', {
    threadId: 'native-thread',
    turn: { id: `turn-${questionTurn}`, status: 'completed', error: null },
  });
};
const reportedTerminals = new Set();
const waitFor = async (name) => {
  while (!existsSync(file(name))) {
    if (existsSync(file('exit'))) process.exit(1);
    await delay(5);
  }
};
if (['brews', 'file-approvals', 'compaction'].includes(mode))
  void (async () => {
    for (let index = 1; ; index++) {
      await waitFor(`events-${index}.json`);
      for (const message of JSON.parse(
        readFileSync(file(`events-${index}.json`), 'utf8'),
      )) {
        if (
          message.method === 'item/started' &&
          message.params.item?.type === 'commandExecution' &&
          message.params.item.processId
        )
          reportedTerminals.add(
            `${message.params.threadId}/${message.params.item.processId}`,
          );
        send(message);
      }
    }
  })();
for await (const line of lines) {
  const request = JSON.parse(line);
  if (mode === 'catalog') appendFileSync(file('wire.jsonl'), `${line}\n`);
  if (mode === 'file-approvals' && request.method === undefined) {
    writeFileSync(file(`response-${request.id}.json`), JSON.stringify(request));
    continue;
  }

  const reply = (result) => send({ id: request.id, result });
  if (request.method === 'thread/inject_items') {
    writeFileSync(file('context.json'), JSON.stringify(request.params));
    if (mode === 'context-error')
      send({
        id: request.id,
        error: { code: -32603, message: 'Context rejected' },
      });
    else if (mode === 'context-exit') process.exit(1);
    else if (mode === 'context-held')
      void (async () => {
        await waitFor('release-context');
        reply({});
      })();
    else reply({});
    continue;
  }
  if (request.method === 'turn/start' && mode === 'context-start-error') {
    writeFileSync(file('prompt.json'), JSON.stringify(request));
    send({
      id: request.id,
      error: { code: -32603, message: 'Turn response lost' },
    });
    continue;
  }
  if (request.method === 'thread/compact/start') {
    writeFileSync(file('compact.json'), JSON.stringify(request.params));
    reply({});
  }
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
  if (request.method === 'thread/backgroundTerminals/list') {
    if (mode !== 'brews') reply({ data: [], nextCursor: null });
    else {
      const index = ++terminalReads;
      writeFileSync(file(`list-${index}.json`), JSON.stringify(request));
      void (async () => {
        await waitFor(`list-reply-${index}.json`);
        send({
          id: request.id,
          ...JSON.parse(readFileSync(file(`list-reply-${index}.json`), 'utf8')),
        });
        writeFileSync(file(`list-replied-${index}`), '');
      })();
    }
    continue;
  }
  if (request.method === 'thread/backgroundTerminals/terminate') {
    appendFileSync(
      file('terminated.jsonl'),
      `${JSON.stringify(request.params)}\n`,
    );
    if (existsSync(file('hold-termination')))
      await waitFor('release-termination');
    reply({
      terminated: reportedTerminals.delete(
        `${request.params.threadId}/${request.params.processId}`,
      ),
    });
    continue;
  }
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
  if (
    request.method === 'thread/resume' &&
    request.params.threadId !== 'native-thread'
  )
    send({
      id: request.id,
      error: {
        message: `no rollout found for thread id ${request.params.threadId}`,
      },
    });
  if (
    request.method === 'thread/start' ||
    (request.method === 'thread/resume' &&
      request.params.threadId === 'native-thread')
  ) {
    writeFileSync(file('connect.json'), JSON.stringify(request));
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
      'child-thread': [
        'native-thread',
        'Euclid',
        'explorer',
        '/root/inspect_config',
      ],
      'grandchild-thread': [
        'child-thread',
        'Hypatia',
        null,
        '/root/inspect_config/check_defaults',
      ],
    };
    const thread = threads[request.params.threadId];
    if (thread) {
      const [parentThreadId, agentNickname, agentRole, agentPath] = thread;
      reply({
        thread: {
          parentThreadId,
          agentNickname,
          agentRole,
          preview: '',
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: parentThreadId,
                depth: parentThreadId === 'native-thread' ? 1 : 2,
                agent_path: agentPath,
                agent_nickname: agentNickname,
                agent_role: agentRole,
              },
            },
          },
        },
      });
    } else
      send({ id: request.id, error: { code: -32600, message: 'no thread' } });
  }
  if (request.method === 'thread/shellCommand') {
    const { command } = request.params;
    writeFileSync(file('shell.json'), JSON.stringify(request));
    if (command === 'refuse') {
      send({
        id: request.id,
        error: { code: -32600, message: 'command must not be empty' },
      });
      continue;
    }
    reply({});
    if (command === 'die soon') {
      setTimeout(() => process.exit(1), 100);
      continue;
    }
    notify('turn/started', {
      threadId: 'native-thread',
      turn: { id: 'turn-shell', status: 'inProgress' },
    });
    shellItem('item/started', command, { status: 'inProgress' });
    if (command === 'hold') {
      shellHeld = true;
      // without a turn/started handler, close would wait on the interrupt forever, so the release ends the turn
      void held().then(() => {
        if (!shellHeld) return;
        shellHeld = false;
        finishShell('interrupted');
      });
      continue;
    }
    notify('item/commandExecution/outputDelta', {
      threadId: 'native-thread',
      turnId: 'turn-shell',
      itemId: 'shell-1',
      delta: 'hi\n',
    });
    shellItem('item/completed', command, {
      status: 'completed',
      exitCode: 0,
      aggregatedOutput: 'hi\n',
    });
    finishShell('completed');
    continue;
  }
  if (request.method === 'turn/interrupt' && shellHeld) {
    shellHeld = false;
    writeFileSync(file('interrupt.json'), JSON.stringify(request));
    reply({});
    shellItem('item/completed', 'hold', {
      status: 'failed',
      exitCode: -1,
      aggregatedOutput: 'command aborted by user',
    });
    finishShell('interrupted');
    continue;
  }
  if (request.method === 'turn/start') {
    const prompt = request.params.input[0].text;
    lastPrompt = prompt;
    writeFileSync(file('prompt.json'), JSON.stringify(request));
    if (familiar?.startsWith('question-')) {
      reply({ turn: { id: `turn-${++questionTurn}` } });
      if (questionTurn > 1) {
        writeFileSync(file('question-answer.json'), JSON.stringify(request));
        finishQuestion();
      } else {
        notify('item/completed', {
          threadId: 'native-thread',
          turnId: 'turn-1',
          item: {
            type: 'agentMessage',
            id: 'question',
            text: 'Which target?',
            phase: 'final_answer',
            delivery: 'async',
            questions: [
              { title: 'Which target?', options: ['preview', 'production'] },
            ],
          },
        });
        if (familiar !== 'question-during') finish('completed');
        if (familiar === 'question-exit')
          void waitFor('exit-question').then(() => process.exit(3));
      }
      continue;
    }
    if (mode === 'brews') {
      const turn = { id: `turn-${++brewTurn}`, status: 'inProgress' };
      reply({ turn });
      notify('turn/started', { threadId: 'native-thread', turn });
      writeFileSync(file(`turn-${brewTurn}.json`), JSON.stringify(request));
      continue;
    }
    reply({ turn: { id: 'turn-1' } });
    if (familiar && prompt !== 'hold') {
      notify('model/rerouted', {
        threadId: 'native-thread',
        toModel: 'observed-codex',
      });
      for (const id of ['first', 'first', 'second'])
        notify('item/started', {
          threadId: 'native-thread',
          turnId: 'turn-1',
          item: {
            id,
            type: 'commandExecution',
            processId: null,
            command: 'cat source.ts',
            cwd: process.cwd(),
            source: 'unifiedExecStartup',
            status: 'inProgress',
            commandActions: [],
          },
        });
    }
    if (
      [
        'hold',
        'die on interrupt',
        'die after interrupt',
        'refuse interrupt',
      ].includes(prompt)
    )
      continue;
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
          diff: body
            ? `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n${body}`
            : '',
        });
      const first = ' kept\n-old\n+one\n+++ added\n';
      const second =
        '+two\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n';
      diff('+one\n');
      // the turn's diff grows, and a content line can start like a header
      diff(first);
      // a later turn adds to the total, its second file's headers do not, and another thread's turn does not
      diff(second, 'turn-2');
      diff('+three\n+four\n-five\n', 'subagent-turn', 'subagent-thread');
      diff('+one\n');
      diff('', 'turn-2');
      diff('');
      diff(first);
      diff(second, 'turn-2');
      diff(second, 'turn-2');
      const limits = (limitId, primary) =>
        notify('account/rateLimits/updated', {
          rateLimits: { limitId, primary, secondary: null },
        });
      limits('codex', window(15, 300, 2000000100));
      limits('other', window(99, 300, 2000000100));
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
      // its prompt and its thinking are no tool calls
      item('item/started', 'worker-thread', {
        type: 'userMessage',
        id: 'w-0',
        content: [],
      });
      item('item/started', 'worker-thread', {
        type: 'reasoning',
        id: 'w-r',
        summary: [],
        content: [],
      });
      const command = {
        type: 'commandExecution',
        id: 'w-1',
        command: 'pnpm test',
        cwd: process.cwd(),
      };
      item('item/started', 'worker-thread', command);
      item('item/completed', 'worker-thread', {
        ...command,
        status: 'completed',
      });
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
      // and starts again before that turn's last item and end arrive
      notify('turn/started', {
        threadId: 'worker-thread',
        turn: { id: 'worker-thread-turn-3', status: 'inProgress' },
      });
      notify('item/started', {
        threadId: 'worker-thread',
        turnId: 'worker-thread-turn-2',
        item: { ...command, id: 'w-4' },
      });
      notify('turn/completed', {
        threadId: 'worker-thread',
        turn: { id: 'worker-thread-turn-2', status: 'completed' },
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
    if (prompt === 'familiar-restart') {
      // the familiars, named by now, are sent more input
      for (const threadId of ['child-thread', 'grandchild-thread'])
        notify('turn/started', {
          threadId,
          turn: { id: `${threadId}-turn-2`, status: 'inProgress' },
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
    if (prompt === 'turn text') {
      for (const [itemId, delta] of [
        ['message-z', 'alpha draft'],
        ['message-a', 'bravo'],
        ['message-a', ' tail'],
      ])
        notify('item/agentMessage/delta', { itemId, delta });
      notify('item/completed', {
        item: { type: 'agentMessage', id: 'message-z', text: 'alpha final' },
      });
      notify('item/agentMessage/delta', {
        itemId: 'message-m',
        delta: 'discard',
      });
      notify('item/completed', {
        item: { type: 'agentMessage', id: 'message-m', text: '' },
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
      notify('item/started', {
        threadId: 'native-thread',
        turnId: 'turn-1',
        item: { ...item, status: 'inProgress', aggregatedOutput: null },
      });
      notify('item/commandExecution/outputDelta', {
        threadId: 'native-thread',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        delta: 'a.md\n',
      });
      notify('item/completed', {
        threadId: 'native-thread',
        turnId: 'turn-1',
        item: { ...item, status: 'completed', aggregatedOutput: 'a.md\n' },
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
            {
              path: join(process.cwd(), 'a.md'),
              kind: { type: 'update' },
              diff: '',
            },
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
          extra: 'tool metadata',
          result: {
            content: [
              { type: 'text', text: 'Captured.' },
              {
                type: 'image',
                data: 'iVBORw==',
                mimeType: 'image/png',
                extra: 'image metadata',
              },
              // deliberately invalid image data must remain visible in the tool text
              { type: 'image', data: 42, mimeType: 'image/png' },
              { type: 'text', text: 'Other.', data: 'literal' },
              null,
              [false, 3, 'nested'],
            ],
          },
        },
        {
          type: 'mcpToolCall',
          id: 'mcp-2',
          server: 'files',
          tool: 'read',
          arguments: { path: join(process.cwd(), 'c.txt') },
        },
        {
          type: 'dynamicToolCall',
          id: 'dynamic-1',
          tool: 'read',
          arguments: { path: join(process.cwd(), 'd.txt') },
          status: 'completed',
        },
        { type: 'imageView', id: 'view-1', path: '/shots/a.png' },
      ])
        notify('item/completed', { item });
      finish('completed');
      continue;
    }
    if (prompt === 'file-changes') {
      const at = (name) => join(process.cwd(), name);
      const patch = {
        type: 'fileChange',
        id: 'patch-1',
        changes: [
          {
            path: at('a.txt'),
            kind: { type: 'update', move_path: null },
            diff: '@@ -3,3 +3,3 @@\n gamma\n-delta\n+DELTA\n epsilon\n',
          },
          {
            path: at('b.txt'),
            kind: { type: 'add' },
            diff: 'new one\nnew two\n',
          },
          {
            path: at('c.txt'),
            kind: { type: 'delete' },
            diff: 'remove me\nsecond line\n',
          },
          {
            path: at('d.txt'),
            kind: { type: 'update', move_path: at('e.txt') },
            diff: `@@ -1 +1 @@\n-x\n+y\n\n\nMoved to: ${at('e.txt')}`,
          },
        ],
      };
      notify('item/started', { item: { ...patch, status: 'inProgress' } });
      notify('item/completed', { item: { ...patch, status: 'completed' } });
      notify('item/completed', {
        item: {
          type: 'fileChange',
          id: 'patch-2',
          changes: [{ path: at('f.txt'), kind: { type: 'add' }, diff: 'f\n' }],
          status: 'declined',
        },
      });
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
    const text = familiar
      ? 'Completed implementation.\n'.repeat(5000)
      : 'Finished.';
    notify('item/agentMessage/delta', {
      itemId: 'message-1',
      delta: text,
    });
    notify('item/completed', {
      item: { type: 'agentMessage', id: 'message-1', text },
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
  // Codex refuses a turn that has ended, which a prompt of `refused` stands in for
  if (request.method === 'turn/steer') {
    if (familiar === 'question-during') {
      writeFileSync(file('question-answer.json'), JSON.stringify(request));
      reply({ turnId: request.params.expectedTurnId });
      finishQuestion();
      continue;
    }
    writeFileSync(file('steer.json'), JSON.stringify(request));
    if (request.params.input[0].text !== 'refused')
      reply({ turnId: request.params.expectedTurnId });
    else
      send({
        id: request.id,
        error: { code: -32600, message: 'no active turn to steer' },
      });
  }
  if (request.method === 'turn/interrupt') {
    if (familiar) {
      reply({});
      finish('interrupted');
      continue;
    }
    if (mode === 'brews') {
      writeFileSync(file('interrupt.json'), JSON.stringify(request));
      void (async () => {
        while (
          !existsSync(file('allow-interrupt')) &&
          !existsSync(file('release'))
        )
          await delay(5);
        reply({});
        notify('turn/completed', {
          threadId: 'native-thread',
          turn: { id: `turn-${brewTurn}`, status: 'interrupted', error: null },
        });
      })();
      continue;
    }
    if (lastPrompt === 'die on interrupt') process.exit(1);
    if (lastPrompt === 'refuse interrupt') {
      send({
        id: request.id,
        error: { code: -32600, message: 'no active turn to interrupt' },
      });
      await held();
      finish('completed');
      continue;
    }
    reply({});
    if (lastPrompt === 'die after interrupt') {
      process.stdout.write('', () => process.exit(1));
      continue;
    }
    await held();
    finish('interrupted');
  }
}
